"""
Venturelyx :: LeadSource worker.

    claim (staff mode) -> download+parse+upsert raw (restricted role)
                        -> fan out into each enabled org's leads (tenant mode)

One job kind: leadsource.ingest. Enqueued once/workday by
scripts/leadsource_due.py (host cron, after the Sunbiz file posts), not
scheduled from inside this process — same split as workers/seo's own
crawl jobs (cron enqueues, the worker just claims and runs whatever's
queued).
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import sys
import time
import traceback

import db
import ingest

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)-7s %(name)s %(message)s")
log = logging.getLogger("vx.leadsource.worker")

KINDS = ["leadsource.ingest"]
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "30"))
_stop = False


def _handle_signal(signum, _frame):
    global _stop
    log.info("signal %s received; finishing current job then exiting", signum)
    _stop = True


def run_job(conn, job: dict) -> None:
    raw_conn = db.connect_raw()
    try:
        result = ingest.run_ingest(conn, raw_conn)
        log.info("ingest result: %s", json.dumps(result))
    finally:
        raw_conn.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true")
    args = ap.parse_args()

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    conn = db.connect()
    log.info("leadsource-worker ready, kinds=%s", KINDS)
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
                time.sleep(POLL_SECONDS)
                continue

            idle = 0
            log.info("claimed job %s kind=%s", job["id"], job["kind"])
            try:
                run_job(conn, job)
                db.finish_job(conn, job["id"])
            except Exception:
                err = traceback.format_exc()
                log.error("job %s failed:\n%s", job["id"], err)
                db.finish_job(conn, job["id"], error=err)

            if args.once:
                return 0
        except Exception as e:
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
