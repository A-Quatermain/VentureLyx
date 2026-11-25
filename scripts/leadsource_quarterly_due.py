#!/usr/bin/env python3
"""
Venturelyx :: queue the quarterly LeadSource backfill.

    python3 scripts/leadsource_quarterly_due.py --due

Cron-invoked once per quarter (see the crontab entry this ships with —
03:00 UTC on the 1st of Jan/Apr/Jul/Oct, two hours before the daily
ingest's 05:00 UTC slot, so a ~90-minute backfill run never overlaps it).
Same split as leadsource_due.py: this only enqueues, worker.py claims and
runs it. dedupe_key is keyed on the calendar quarter, so a retried cron
tick the same quarter is a no-op, not a second multi-gigabyte download.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import date

import psycopg
from psycopg.rows import dict_row


def current_quarter_key(today: date) -> str:
    q = (today.month - 1) // 3 + 1
    return f"{today.year}Q{q}"


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

    quarter = current_quarter_key(date.today())
    dedupe_key = f"leadsource.quarterly_backfill:{quarter}"

    cur.execute(
        """INSERT INTO job_queue (org_id, kind, payload, dedupe_key, priority)
           VALUES (NULL, 'leadsource.quarterly_backfill', %s, %s, 90)
           ON CONFLICT DO NOTHING RETURNING id""",
        (json.dumps({"quarter": quarter, "trigger": "cron"}), dedupe_key),
    )
    row = cur.fetchone()
    if row:
        print(f"queued #{row['id']}  quarter={quarter}")
    else:
        print(f"skipped — already queued or run for {quarter}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
