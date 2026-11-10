"""
Venturelyx :: competitor crawl job.

docs/specs/scaleseo-competitors.md. Crawls a domain the org does NOT own —
crawler.py's engine (crawl_site/SiteConfig) already takes an arbitrary url
and needs no changes for that; what's different here is everything AROUND
it: fixed conservative defaults instead of a seo_sites row's own config, a
pre-flight full-site robots.txt check that owned-site crawls don't need
(crawl_site never refuses to fetch the start URL itself — reasonable for a
site you own, wrong for one you don't), and a slim, separate persistence
path (seo_competitor_crawls, see 037_scaleseo_competitor_crawls.sql) instead
of persist()'s seo_sites-keyed tables. Scoring is fully reused, unchanged,
from scoring.py — "local" here is exactly compute_ai_visibility()'s number,
just under the name this comparison view calls it.
"""
from __future__ import annotations

import asyncio
import json
import logging
import xml.etree.ElementTree as ET
from urllib.parse import urljoin
from statistics import mean

import httpx

import db
from crawler import SiteConfig, crawl_site, _fetch_robots, _blocked
from scoring import compute_ai_visibility, compute_scores, detect_issues, detect_visibility_issues

log = logging.getLogger("vx.worker.competitors")

MAX_PAGES = 25
CONCURRENCY = 1
DELAY_MS = 600  # politer than an owned-site crawl — this is someone else's server
TIMEOUT_S = 20
MAX_CRAWLS_KEPT = 2
SUMMARY_PAGE_CAP = 25  # == MAX_PAGES; kept as its own constant since they answer different questions


def load_competitor(conn, org_id: str, competitor_id: str) -> dict | None:
    with db.tenant_tx(conn, org_id) as cur:
        cur.execute("SELECT * FROM seo_competitors WHERE id = %s", (competitor_id,))
        return cur.fetchone()


async def _root_blocked_by_robots(base: str) -> tuple[bool, list[str]]:
    """Owned-site crawls never check the start URL against robots.txt — fine
    for your own site. For a domain you don't own, Disallow: / (or the exact
    path) on the HOMEPAGE means don't fetch anything at all, not even once
    to look. crawler.py's own _fetch_robots/_blocked are reused as-is
    (leading underscore is just this package's convention, not an ABI)."""
    async with httpx.AsyncClient(
        headers={"User-Agent": SiteConfig.user_agent}, timeout=10, follow_redirects=True,
    ) as client:
        rules = await _fetch_robots(client, base)
    return _blocked(base, rules, []), rules


async def _count_sitemap_pages(base: str) -> int | None:
    """Best-effort /sitemap.xml fetch — never blocks or fails the crawl.
    Namespace-agnostic <loc> count; a sitemap INDEX (pointing at further
    sitemaps rather than pages) still returns a count, just of index entries
    rather than real pages — summary.sitemap_is_index flags that distinction
    so nothing downstream mistakes it for a page total."""
    try:
        async with httpx.AsyncClient(
            headers={"User-Agent": SiteConfig.user_agent}, timeout=10, follow_redirects=True,
        ) as client:
            r = await client.get(urljoin(base, "/sitemap.xml"))
        if r.status_code != 200:
            return None
        root = ET.fromstring(r.content)
        tag = root.tag.rsplit("}", 1)[-1]
        locs = [el for el in root.iter() if el.tag.rsplit("}", 1)[-1] == "loc"]
        return {"count": len(locs), "is_index": tag == "sitemapindex"}
    except Exception as e:
        log.debug("sitemap.xml unavailable for %s: %s", base, e)
        return None


def _build_summary(out, sitemap: dict | None) -> dict:
    html_pages = [p for p in out.pages if p.content_hash and p.status_code == 200]

    schema_types: set[str] = set()
    for p in html_pages:
        schema_types.update(p.schema_types)

    weights = [p.html_bytes for p in html_pages if p.html_bytes is not None]
    speeds = [p.response_ms for p in html_pages if p.response_ms is not None]
    viewport_pages = sum(1 for p in html_pages if p.has_viewport_meta)

    return {
        "pages": [
            {"url": p.url, "title": p.title, "h1": p.h1, "word_count": p.word_count}
            for p in html_pages[:SUMMARY_PAGE_CAP]
        ],
        "schema_types": sorted(schema_types),
        "avg_page_weight_bytes": round(mean(weights)) if weights else None,
        "avg_response_ms": round(mean(speeds)) if speeds else None,
        "viewport_pages": viewport_pages,
        "pages_checked": len(html_pages),
        "sitemap_page_count": sitemap["count"] if sitemap else None,
        "sitemap_is_index": sitemap["is_index"] if sitemap else None,
        "robots_blocked_links": out.robots_blocked,
    }


def persist(
    conn, org_id: str, competitor_id: str, job_id: int | None,
    status: str, error: str | None, pages_crawled: int,
    scores: dict | None, summary: dict | None,
) -> None:
    with db.tenant_tx(conn, org_id) as cur:
        cur.execute(
            """INSERT INTO seo_competitor_crawls
                 (org_id, competitor_id, job_id, status, error, pages_crawled,
                  technical, content, local, performance, summary)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (
                org_id, competitor_id, job_id, status, error, pages_crawled,
                scores.get("technical") if scores else None,
                scores.get("content") if scores else None,
                scores.get("local") if scores else None,
                scores.get("performance") if scores else None,
                json.dumps(summary) if summary is not None else None,
            ),
        )
        # Keep only the latest MAX_CRAWLS_KEPT rows — a DELETE after every
        # insert, not a trigger; this worker is the only writer.
        cur.execute(
            """DELETE FROM seo_competitor_crawls
                WHERE competitor_id = %s
                  AND id NOT IN (
                    SELECT id FROM seo_competitor_crawls
                     WHERE competitor_id = %s
                     ORDER BY crawled_at DESC LIMIT %s
                  )""",
            (competitor_id, competitor_id, MAX_CRAWLS_KEPT),
        )


async def _run(base: str) -> tuple[str, str | None, int, dict | None, dict | None]:
    blocked, _rules = await _root_blocked_by_robots(base)
    if blocked:
        return "robots_blocked", None, 0, None, None

    cfg = SiteConfig(
        url=base, max_pages=MAX_PAGES, concurrency=CONCURRENCY, delay_ms=DELAY_MS,
        timeout_s=TIMEOUT_S, respect_robots=True, render=False, exclude_paths=[],
    )
    out = await crawl_site(cfg)
    issues = detect_issues(out, base) + detect_visibility_issues(out)
    scores = compute_scores(out, issues)
    scores["local"] = compute_ai_visibility(out, issues)
    sitemap = await _count_sitemap_pages(base)
    summary = _build_summary(out, sitemap)
    return "ok", None, scores["pages"], scores, summary


def run_competitor_crawl_job(conn, job: dict) -> None:
    org_id = str(job["org_id"])
    payload = job["payload"] or {}
    competitor_id = payload.get("competitor_id")
    if not competitor_id:
        raise ValueError("payload.competitor_id is required for seo.competitor_crawl")

    competitor = load_competitor(conn, org_id, competitor_id)
    if not competitor:
        raise ValueError(f"seo_competitors {competitor_id} not visible for org {org_id}")

    base = competitor["domain"]
    if not base.startswith(("http://", "https://")):
        base = f"https://{base}"
    base = base.rstrip("/")

    log.info("competitor crawl start competitor=%s domain=%s", competitor["name"], base)

    try:
        status, error, pages_crawled, scores, summary = asyncio.run(_run(base))
    except Exception as e:
        status, error, pages_crawled, scores, summary = "error", str(e)[:500], 0, None, None

    persist(conn, org_id, competitor_id, job["id"], status, error, pages_crawled, scores, summary)
    log.info(
        "competitor crawl done competitor=%s status=%s pages=%d",
        competitor["name"], status, pages_crawled,
    )
