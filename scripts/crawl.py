#!/usr/bin/env python3
"""
Venturelyx :: queue a crawl.

    python3 scripts/crawl.py --site nppools
    python3 scripts/crawl.py --all-due
    python3 scripts/crawl.py --status
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import psycopg
from psycopg.rows import dict_row


def main() -> int:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--site", help="seo_sites.key, e.g. nppools")
    g.add_argument("--all-due", action="store_true", help="every enabled site past next_crawl_at")
    g.add_argument("--status", action="store_true", help="show queue + last crawls")
    args = ap.parse_args()

    dsn = os.environ.get("DB_DSN")
    if not dsn:
        print("FATAL: DB_DSN not set", file=sys.stderr)
        return 1

    conn = psycopg.connect(dsn, row_factory=dict_row, autocommit=True)
    cur = conn.cursor()

    if args.status:
        print("=== queue ===")
        cur.execute(
            """SELECT id, kind, state, attempts, priority,
                      to_char(run_after,'MM-DD HH24:MI') AS run_after,
                      left(coalesce(last_error,''), 60) AS err
                 FROM job_queue ORDER BY id DESC LIMIT 15"""
        )
        for r in cur.fetchall():
            print(f"  #{r['id']:<5} {r['kind']:<12} {r['state']:<10} "
                  f"try={r['attempts']} at={r['run_after']} {r['err']}")

        print("\n=== last crawl per site ===")
        cur.execute(
            """SELECT s.key, c.status, c.pages_crawled,
                      to_char(c.started_at,'MM-DD HH24:MI') AS started,
                      sc.health, sc.critical_issues, sc.high_issues
                 FROM seo_sites s
                 LEFT JOIN LATERAL (
                   SELECT * FROM seo_crawls WHERE site_id = s.id
                   ORDER BY started_at DESC LIMIT 1) c ON true
                 LEFT JOIN seo_scores sc ON sc.crawl_id = c.id
                WHERE s.enabled ORDER BY s.key"""
        )
        for r in cur.fetchall():
            if r["status"] is None:
                print(f"  {r['key']:16s} never crawled")
            else:
                print(f"  {r['key']:16s} {r['status']:<8} pages={r['pages_crawled']:<4} "
                      f"health={r['health']} crit={r['critical_issues']} "
                      f"high={r['high_issues']}  {r['started']}")
        return 0

    if args.site:
        cur.execute(
            "SELECT id, org_id, key, url FROM seo_sites WHERE key = %s", (args.site,)
        )
        sites = cur.fetchall()
        if not sites:
            print(f"No site with key '{args.site}'", file=sys.stderr)
            return 1
    else:
        cur.execute(
            """SELECT id, org_id, key, url FROM seo_sites
                WHERE enabled AND (next_crawl_at IS NULL OR next_crawl_at <= now())"""
        )
        sites = cur.fetchall()
        if not sites:
            print("Nothing due.")
            return 0

    for s in sites:
        cur.execute(
            """INSERT INTO job_queue (org_id, kind, payload, dedupe_key, priority)
               VALUES (%s,'seo.crawl',%s,%s,50)
               ON CONFLICT DO NOTHING RETURNING id""",
            (s["org_id"],
             json.dumps({"site_id": str(s["id"]), "trigger": "manual"}),
             f"seo.crawl:{s['id']}"),
        )
        r = cur.fetchone()
        if r:
            print(f"queued #{r['id']}  {s['key']}  {s['url']}")
        else:
            print(f"skipped  {s['key']} — a crawl is already queued or running")
    return 0


if __name__ == "__main__":
    sys.exit(main())
