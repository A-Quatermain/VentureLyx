"""
Venturelyx :: SEO worker.

    claim (staff mode)  ->  crawl  ->  persist (tenant mode)

Run continuously as a container, or one-shot with --once for testing.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import signal
import sys
import time
import traceback

import psycopg

import db
from crawler import SiteConfig, crawl_site
from scoring import compute_scores, detect_issues, signal_rows

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)-7s %(name)s %(message)s",
)
log = logging.getLogger("vx.worker")

KINDS = ["seo.crawl"]
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "10"))
_stop = False


def _handle_signal(signum, _frame):
    global _stop
    log.info("signal %s received; finishing current job then exiting", signum)
    _stop = True


# ---------------------------------------------------------------------------

def load_site(conn, org_id: str, site_id: str) -> dict | None:
    with db.tenant_tx(conn, org_id) as cur:
        cur.execute("SELECT * FROM seo_sites WHERE id = %s", (site_id,))
        return cur.fetchone()


def persist(conn, org_id: str, site: dict, out, issues, scores, job_id: int, trigger: str) -> int:
    """Everything lands in ONE tenant transaction. A crawl is atomic: either the
    whole snapshot is queryable or none of it is. Partial crawls would make the
    health trend lie."""
    site_id = site["id"]

    with db.tenant_tx(conn, org_id) as cur:
        cur.execute(
            """INSERT INTO seo_crawls (org_id, site_id, job_id, status, pages_crawled,
                                       rendered, trigger, finished_at)
               VALUES (%s,%s,%s,'ok',%s,%s,%s, now()) RETURNING id""",
            (org_id, site_id, job_id, scores["pages"], out.rendered, trigger),
        )
        crawl_id = cur.fetchone()["id"]

        page_rows = [
            (org_id, crawl_id, site_id, p.url, p.status_code, p.redirect_to,
             p.redirect_hops, p.title, len(p.title) if p.title else None,
             p.meta_description, len(p.meta_description) if p.meta_description else None,
             p.h1, p.h1_count, p.canonical, p.meta_robots, p.indexable, p.word_count,
             p.links_out_int, p.links_out_ext, p.images_total, p.images_no_alt,
             p.schema_types or None, p.content_hash, p.response_ms, p.depth)
            for p in out.pages
        ]
        if page_rows:
            cur.executemany(
                """INSERT INTO seo_pages
                   (org_id, crawl_id, site_id, url, status_code, redirect_to, redirect_hops,
                    title, title_len, meta_description, meta_desc_len, h1, h1_count,
                    canonical, meta_robots, indexable, word_count, links_out_int,
                    links_out_ext, images_total, images_no_alt, schema_types,
                    content_hash, response_ms, depth)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                page_rows,
            )

        link_rows = [
            (org_id, crawl_id, site_id, l.from_url, l.to_url, l.anchor, l.is_internal, l.status_code)
            for l in out.links
        ]
        if link_rows:
            cur.executemany(
                """INSERT INTO seo_links
                   (org_id, crawl_id, site_id, from_url, to_url, anchor, is_internal, status_code)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
                link_rows,
            )

        # Signals first, so issues can carry signal_id.
        sig_ids: dict[str, int] = {}
        for row in signal_rows(issues, str(site_id), site["name"]):
            cur.execute(
                """INSERT INTO signals (org_id, module, signal_type, severity, entity_type,
                                        entity_id, summary, detail, dedupe_key)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT (org_id, dedupe_key) WHERE dedupe_key IS NOT NULL
                                                      AND resolved_at IS NULL
                   DO UPDATE SET summary = EXCLUDED.summary,
                                 detail  = EXCLUDED.detail,
                                 detected_at = now()
                   RETURNING id, signal_type""",
                (org_id, row["module"], row["signal_type"], row["severity"],
                 row["entity_type"], row["entity_id"], row["summary"],
                 json.dumps(row["detail"]), row["dedupe_key"]),
            )
            r = cur.fetchone()
            if r:
                sig_ids[r["signal_type"].removeprefix("seo.")] = r["id"]

        issue_rows = [
            (org_id, crawl_id, site_id, sig_ids.get(i.code), i.url, i.code,
             i.severity, i.detail, i.auto_fixable)
            for i in issues
        ]
        if issue_rows:
            cur.executemany(
                """INSERT INTO seo_issues
                   (org_id, crawl_id, site_id, signal_id, url, code, severity, detail, auto_fixable)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
                issue_rows,
            )

        cur.execute(
            """INSERT INTO seo_scores (org_id, crawl_id, site_id, health, technical,
                                       content, performance, pages, broken_links,
                                       critical_issues, high_issues)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (org_id, crawl_id, site_id, scores["health"], scores["technical"],
             scores["content"], scores["performance"], scores["pages"],
             scores["broken_links"], scores["critical_issues"], scores["high_issues"]),
        )

        # Resolve signals for issue codes that no longer appear — a fixed problem
        # must leave the owner's list on its own.
        live = [f"seo.{c}" for c in {i.code for i in issues}]
        cur.execute(
            """UPDATE signals SET resolved_at = now()
                WHERE module='scaleseo' AND entity_id = %s
                  AND resolved_at IS NULL AND NOT (signal_type = ANY(%s))""",
            (site_id, live or [""]),
        )

        interval = {"daily": "1 day", "weekly": "7 days"}.get(site["crawl_schedule"])
        cur.execute(
            f"""UPDATE seo_sites
                   SET last_crawl_at = now()
                       {", next_crawl_at = now() + interval '" + interval + "'" if interval else ""}
                 WHERE id = %s""",
            (site_id,),
        )

    return crawl_id


def run_job(conn, job: dict) -> None:
    org_id = str(job["org_id"])
    payload = job["payload"] or {}
    site_id = payload.get("site_id")
    if not site_id:
        raise ValueError("payload.site_id is required for seo.crawl")

    site = load_site(conn, org_id, site_id)
    if not site:
        raise ValueError(f"seo_sites {site_id} not visible for org {org_id}")

    cfg = SiteConfig(
        url=site["url"],
        max_pages=site["max_pages"],
        concurrency=site["concurrency"],
        delay_ms=site["delay_ms"],
        timeout_s=site["timeout_s"],
        respect_robots=site["respect_robots"],
        render=site["render"],
        user_agent=site["user_agent"] or SiteConfig.user_agent,
        exclude_paths=list(site["exclude_paths"] or []),
    )

    log.info("crawl start site=%s url=%s max_pages=%s", site["key"], cfg.url, cfg.max_pages)
    t0 = time.perf_counter()

    last_beat = [time.time()]

    def progress(n: int):
        if time.time() - last_beat[0] > 20:
            db.heartbeat(conn, job["id"])
            last_beat[0] = time.time()
            log.info("  ... %d pages", n)

    out = asyncio.run(crawl_site(cfg, on_progress=progress))
    issues = detect_issues(out, cfg.url)
    scores = compute_scores(out, issues)

    crawl_id = persist(conn, org_id, site, out, issues, scores, job["id"],
                       payload.get("trigger", "schedule"))

    log.info(
        "crawl done site=%s crawl_id=%s pages=%d links=%d issues=%d health=%d (%.1fs)",
        site["key"], crawl_id, len(out.pages), len(out.links), len(issues),
        scores["health"], time.perf_counter() - t0,
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true", help="process one job then exit")
    args = ap.parse_args()

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    conn = db.connect()
    log.info("worker %s ready, kinds=%s", db.WORKER_ID, KINDS)
    idle = 0

    while not _stop:
        try:
            db.reap_stalled(conn)
            job = db.claim_job(conn, KINDS)
            if not job:
                if args.once:
                    log.info("no queued jobs")
                    return 0
                idle += 1
                if idle % 30 == 1:
                    log.debug("idle")
                time.sleep(POLL_SECONDS)
                continue

            idle = 0
            log.info("claimed job %s kind=%s attempt=%s", job["id"], job["kind"], job["attempts"])
            try:
                run_job(conn, job)
                db.finish_job(conn, job["id"])
            except Exception:
                err = traceback.format_exc()
                log.error("job %s failed:\n%s", job["id"], err)
                db.finish_job(conn, job["id"], error=err)

            if args.once:
                return 0

        except (psycopg.OperationalError, psycopg.InterfaceError) as e:
            log.error("database error, reconnecting in 5s: %s", e)
            try:
                conn.close()
            except Exception:
                pass
            time.sleep(5)
            conn = db.connect()

    log.info("worker stopped cleanly")
    return 0


if __name__ == "__main__":
    sys.exit(main())
