#!/usr/bin/env python3
"""
Venturelyx :: queue the daily LeadSource ingest.

    python3 scripts/leadsource_due.py --due

Cron-invoked, once per workday, after the Sunbiz file posts (observed in
Phase 1: ~22:00-23:00 Eastern) — same split as scripts/crawl.py: this
script only enqueues, workers/leadsource/worker.py claims and runs it.
dedupe_key is keyed on the target workday, so a second run the same day
(a retried cron tick, say) is a no-op, not a duplicate ingest.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date, timedelta

import psycopg
from psycopg.rows import dict_row


def most_recent_workday(today: date) -> date:
    d = today - timedelta(days=1)
    while d.weekday() >= 5:  # 5=Sat, 6=Sun
        d -= timedelta(days=1)
    return d


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--due", action="store_true", required=True)
    ap.parse_args()

    dsn = os.environ.get("DB_DSN")
    if not dsn:
        print("FATAL: DB_DSN not set", file=sys.stderr)
        return 1

    conn = psycopg.connect(dsn, row_factory=dict_row, autocommit=True)
    cur = conn.cursor()

    target = most_recent_workday(date.today())
    dedupe_key = f"leadsource.ingest:{target.strftime('%Y%m%d')}"

    cur.execute(
        """INSERT INTO job_queue (org_id, kind, payload, dedupe_key, priority)
           VALUES (NULL, 'leadsource.ingest', %s, %s, 80)
           ON CONFLICT DO NOTHING RETURNING id""",
        (json.dumps({"target_date": target.isoformat(), "trigger": "cron"}), dedupe_key),
    )
    row = cur.fetchone()
    if row:
        print(f"queued #{row['id']}  target_date={target.isoformat()}")
    else:
        print(f"skipped — already queued or run for {target.isoformat()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
