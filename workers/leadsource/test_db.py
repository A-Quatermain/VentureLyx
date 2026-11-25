"""
Venturelyx :: job_queue primitives — repeatable verification script.

    docker exec vx-leadsource-worker python test_db.py

Covers the reaper fix (Phase 4 follow-up): a job that runs long but
keeps heartbeating is never reclaimed, reap_stalled only touches kinds
the caller actually owns, and a job that keeps going stale anyway is
capped at max_attempts and marked dead rather than reclaimed forever.
Uses disposable job_queue rows directly (kind is plain text, no FK — see
001_platform_core.sql), torn down in `finally`.
"""
from __future__ import annotations

import sys
import time

import db

passed = 0
failed = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global passed, failed
    if ok:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name}" + (f" — {detail}" if detail else ""))


def make_running_job(conn, kind: str, heartbeat_minutes_ago: float, attempts: int = 1, max_attempts: int = 5) -> int:
    with db.staff_tx(conn) as cur:
        cur.execute(
            """INSERT INTO job_queue (kind, state, attempts, max_attempts, started_at, heartbeat_at)
               VALUES (%s, 'running', %s, %s, now(), now() - (interval '1 minute' * %s))
             RETURNING id""",
            (kind, attempts, max_attempts, heartbeat_minutes_ago),
        )
        return cur.fetchone()["id"]


def job_state(conn, job_id: int) -> dict:
    with db.staff_tx(conn) as cur:
        cur.execute("SELECT state, last_error FROM job_queue WHERE id = %s", (job_id,))
        return cur.fetchone()


def main() -> int:
    print("job_queue primitives verification\n")

    # Fake, namespaced kinds — never real KINDS values. A 'queued' row of
    # a REAL kind this container's own live worker.py main loop polls for
    # can get claimed and actually run before this script's own `finally`
    # deletes it (confirmed live: a real 'seo.crawl' kind row created by
    # an earlier draft of this test got picked up and run by the actual
    # worker mid-test). Fake kinds can never match any claim_job(KINDS)
    # call, in this process or any other, so there's no such race.
    OWNED_KIND = "test.vx_db_owned_kind"
    UNOWNED_KIND = "test.vx_db_unowned_kind"

    conn = db.connect()
    job_ids: list[int] = []
    try:
        # 1. A stale-heartbeat job of a kind the reaper owns gets reclaimed.
        j1 = make_running_job(conn, OWNED_KIND, heartbeat_minutes_ago=45)
        job_ids.append(j1)
        db.reap_stalled(conn, [OWNED_KIND], stale_minutes=30)
        check("a stale job of an owned kind is reclaimed to 'queued'", job_state(conn, j1)["state"] == "queued")

        # 2. A stale-heartbeat job of a kind NOT in the caller's list is left alone — the actual fix.
        j2 = make_running_job(conn, UNOWNED_KIND, heartbeat_minutes_ago=45)
        job_ids.append(j2)
        db.reap_stalled(conn, [OWNED_KIND], stale_minutes=30)
        check("a stale job of an UNOWNED kind is never touched (the real Phase 4 bug)", job_state(conn, j2)["state"] == "running")

        # 3. A job with a FRESH heartbeat is never reclaimed no matter how long it's been running.
        j3 = make_running_job(conn, OWNED_KIND, heartbeat_minutes_ago=0.1)
        job_ids.append(j3)
        with db.staff_tx(conn) as cur:
            cur.execute("UPDATE job_queue SET started_at = now() - interval '2 hours' WHERE id = %s", (j3,))
        db.reap_stalled(conn, [OWNED_KIND], stale_minutes=30)
        check("a job running 2 hours but heartbeating recently is never reclaimed", job_state(conn, j3)["state"] == "running")

        # 4. A stale job already at max_attempts is marked dead, not requeued forever.
        j4 = make_running_job(conn, OWNED_KIND, heartbeat_minutes_ago=45, attempts=5, max_attempts=5)
        job_ids.append(j4)
        db.reap_stalled(conn, [OWNED_KIND], stale_minutes=30)
        state4 = job_state(conn, j4)
        check("a stale job at its attempts cap is marked 'dead', not requeued", state4["state"] == "dead", str(state4))
        check("the dead job's error names the real reason", "reclaimed too many times" in (state4["last_error"] or ""))

        # 5. HeartbeatThread actually advances heartbeat_at while running, on its own connection.
        j5 = make_running_job(conn, OWNED_KIND, heartbeat_minutes_ago=0)
        job_ids.append(j5)
        with db.staff_tx(conn) as cur:
            cur.execute("SELECT heartbeat_at FROM job_queue WHERE id = %s", (j5,))
            before = cur.fetchone()["heartbeat_at"]
        with db.HeartbeatThread(db.connect, j5, interval_s=1):
            time.sleep(2.5)
        with db.staff_tx(conn) as cur:
            cur.execute("SELECT heartbeat_at FROM job_queue WHERE id = %s", (j5,))
            after = cur.fetchone()["heartbeat_at"]
        check("HeartbeatThread advances heartbeat_at while the job is running", after > before, f"before={before} after={after}")
        db.reap_stalled(conn, [OWNED_KIND], stale_minutes=30)
        check("a job HeartbeatThread just kept fresh is not reclaimed immediately after", job_state(conn, j5)["state"] == "running")
    finally:
        with db.staff_tx(conn) as cur:
            cur.execute("DELETE FROM job_queue WHERE id = ANY(%s)", (job_ids,))
        conn.close()

    print(f"\n{passed} passed, {failed} failed.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
