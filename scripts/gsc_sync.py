#!/usr/bin/env python3
"""
Venturelyx :: queue a Google Search Console sync.

    python3 scripts/gsc_sync.py --all-due
    python3 scripts/gsc_sync.py --org <org_id>
    python3 scripts/gsc_sync.py --status

Same shape as scripts/crawl.py: connects with the superuser DSN (cross-tenant
by design — this is a maintenance script run from cron on the host, not
through the app role), inserts job_queue rows for the worker to claim.
Run once daily; GSC data lags 2-3 days anyway, so there is nothing to gain
from running it more often (see workers/seo/gsc.py's window).
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date

import psycopg
from psycopg.rows import dict_row


def main() -> int:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--org", help="organizations.id to sync")
    g.add_argument("--all-due", action="store_true", help="every org with a connected GSC integration")
    g.add_argument("--status", action="store_true", help="show connected integrations + last sync")
    args = ap.parse_args()

    dsn = os.environ.get("DB_DSN")
    if not dsn:
        print("FATAL: DB_DSN not set", file=sys.stderr)
        return 1

    conn = psycopg.connect(dsn, row_factory=dict_row, autocommit=True)
    cur = conn.cursor()

    if args.status:
        cur.execute(
            """SELECT o.name, i.external_id, i.status, i.last_sync_at, left(coalesce(i.last_error,''), 80) AS err
                 FROM integrations i
                 JOIN organizations o ON o.id = i.org_id
                WHERE i.provider = 'google_search_console'
                ORDER BY o.name"""
        )
        rows = cur.fetchall()
        if not rows:
            print("No Search Console connections yet.")
            return 0
        for r in rows:
            synced = r["last_sync_at"].strftime("%Y-%m-%d %H:%M") if r["last_sync_at"] else "never"
            print(f"  {r['name']:<24} {r['status']:<10} {r['external_id']:<40} last={synced} {r['err']}")
        return 0

    if args.org:
        cur.execute(
            """SELECT i.org_id FROM integrations i
                WHERE i.org_id = %s AND i.provider = 'google_search_console' AND i.status = 'connected'""",
            (args.org,),
        )
        orgs = cur.fetchall()
        if not orgs:
            print(f"No connected Search Console integration for org {args.org}", file=sys.stderr)
            return 1
    else:
        cur.execute(
            """SELECT org_id FROM integrations
                WHERE provider = 'google_search_console' AND status = 'connected'"""
        )
        orgs = cur.fetchall()
        if not orgs:
            print("Nothing due.")
            return 0

    today = date.today().isoformat()
    for o in orgs:
        org_id = o["org_id"]
        cur.execute(
            """INSERT INTO job_queue (org_id, kind, payload, dedupe_key, priority)
               VALUES (%s,'seo.gsc_sync',%s,%s,60)
               ON CONFLICT DO NOTHING RETURNING id""",
            (org_id, json.dumps({"trigger": "schedule"}), f"seo.gsc_sync:{org_id}:{today}"),
        )
        r = cur.fetchone()
        if r:
            print(f"queued #{r['id']}  org={org_id}")
        else:
            print(f"skipped  org={org_id} — already queued or synced today")
    return 0


if __name__ == "__main__":
    sys.exit(main())
