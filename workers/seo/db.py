"""
Venturelyx :: worker database layer.

The single rule this module exists to enforce:

    Workers connect as venturelyx_app (RLS applies). Job CLAIMING runs in staff
    mode because the queue spans tenants. Everything after the claim runs with
    app.current_org set and staff mode OFF, so a bug in crawl code cannot write
    into the wrong tenant.

SET LOCAL is transaction-scoped. It cannot leak into the next unit of work even
on a pooled connection. Never use plain SET.
"""
from __future__ import annotations

import contextlib
import logging
import os
import threading
from typing import Any, Iterator

import psycopg
from psycopg.rows import dict_row

log = logging.getLogger("vx.db")

DSN = os.environ["DB_DSN"]
WORKER_ID = os.environ.get("WORKER_ID") or f"seo-{os.uname().nodename}-{os.getpid()}"


def connect() -> psycopg.Connection:
    # application_name goes in the DSN. PostgreSQL's SET does not accept bind
    # parameters -- "SET application_name = %s" becomes "SET ... = $1" and the
    # server rejects it with a syntax error.
    conn = psycopg.connect(DSN, row_factory=dict_row, autocommit=False,
                           application_name=WORKER_ID)
    return conn


@contextlib.contextmanager
def staff_tx(conn: psycopg.Connection) -> Iterator[psycopg.Cursor]:
    """Cross-tenant transaction. ONLY for queue claiming and scheduling.

    Anything that touches tenant data belongs in tenant_tx().
    """
    with conn.transaction():
        cur = conn.cursor()
        # set_config(name, value, is_local) -- SET LOCAL cannot take bind
        # parameters ("SET LOCAL x = $1" is a syntax error). set_config is a
        # normal function, so parameters work. is_local=true gives identical
        # transaction-scoped semantics.
        cur.execute("SELECT set_config('app.is_staff', 'on', true)")
        yield cur


@contextlib.contextmanager
def tenant_tx(conn: psycopg.Connection, org_id: str) -> Iterator[psycopg.Cursor]:
    """Tenant-scoped transaction. RLS confines every statement to org_id.

    If crawl code accidentally targets another tenant's row, Postgres returns
    zero rows or rejects the write. That is the safety net, not the app logic.
    """
    if not org_id:
        raise ValueError("tenant_tx requires an org_id")
    with conn.transaction():
        cur = conn.cursor()
        cur.execute("SELECT set_config('app.current_org', %s, true)", (str(org_id),))
        cur.execute("SELECT set_config('app.is_staff', 'off', true)")
        yield cur


# ---------------------------------------------------------------------------
# Job queue — SELECT ... FOR UPDATE SKIP LOCKED
# ---------------------------------------------------------------------------

CLAIM_SQL = """
UPDATE job_queue
   SET state        = 'running',
       locked_by    = %(worker)s,
       locked_at    = now(),
       heartbeat_at = now(),
       started_at   = COALESCE(started_at, now()),
       attempts     = attempts + 1
 WHERE id = (
     SELECT id FROM job_queue
      WHERE state = 'queued'
        AND run_after <= now()
        AND kind = ANY(%(kinds)s)
      ORDER BY priority, run_after
        FOR UPDATE SKIP LOCKED
      LIMIT 1
 )
RETURNING id, org_id, kind, payload, attempts, max_attempts;
"""


def claim_job(conn: psycopg.Connection, kinds: list[str]) -> dict[str, Any] | None:
    with staff_tx(conn) as cur:
        cur.execute(CLAIM_SQL, {"worker": WORKER_ID, "kinds": kinds})
        return cur.fetchone()


def touch_heartbeat(conn: psycopg.Connection, job_id: int) -> None:
    """Refreshes one job's heartbeat_at — see HeartbeatThread below, which
    is what actually calls this during a real job now (worker.py wraps
    every job generically); nothing else should need to call it directly.
    Was named heartbeat() and called manually from inside run_crawl_job's
    own on_progress callback — renamed and moved to match
    workers/leadsource/db.py's identical fix, so both workers' queue
    layers stay the same shape (the whole point of fixing this
    platform-wide rather than per-crawl)."""
    with staff_tx(conn) as cur:
        cur.execute(
            "UPDATE job_queue SET heartbeat_at = now() WHERE id = %s", (job_id,)
        )


class HeartbeatThread:
    """Keeps one job's heartbeat_at fresh for as long as it's running, on
    its own connection (psycopg connections aren't safe to share across
    threads) — wrap the whole of run_job() in this, once, in the worker
    loop, and every job kind gets heartbeating for free with no
    per-job-kind wiring. Fixes a bug confirmed live in Phase 4 of
    LeadSource's build: a job with no heartbeat update for stale_minutes
    looks dead to reap_stalled() even though the process running it never
    crashed — in that case, this worker's own reaper reclaimed a
    different worker's still-genuinely-running job, because reap_stalled
    wasn't scoped by kind either (also fixed, below).

        with db.HeartbeatThread(db.connect, job["id"]):
            run_job(conn, job)

    conn_factory is a zero-arg callable (e.g. db.connect) rather than an
    existing connection, specifically so this can open its own."""

    def __init__(self, conn_factory, job_id: int, interval_s: int = 60):
        self._conn_factory = conn_factory
        self._job_id = job_id
        self._interval_s = interval_s
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True, name=f"heartbeat-{job_id}")

    def _run(self) -> None:
        conn = self._conn_factory()
        try:
            while not self._stop.wait(self._interval_s):
                try:
                    touch_heartbeat(conn, self._job_id)
                except Exception as e:
                    log.warning("heartbeat update failed for job %s, reconnecting: %s", self._job_id, e)
                    try:
                        conn.close()
                    except Exception:
                        pass
                    conn = self._conn_factory()
        finally:
            conn.close()

    def __enter__(self) -> "HeartbeatThread":
        self._thread.start()
        return self

    def __exit__(self, *exc_info) -> None:
        self._stop.set()
        self._thread.join(timeout=self._interval_s + 5)


def finish_job(conn: psycopg.Connection, job_id: int, error: str | None = None) -> None:
    """Mark terminal. Retries back off exponentially; exhausted jobs go 'dead'
    rather than 'failed' so they are visibly stuck instead of silently retried
    forever."""
    with staff_tx(conn) as cur:
        if error is None:
            cur.execute(
                """UPDATE job_queue
                      SET state='succeeded', finished_at=now(), last_error=NULL
                    WHERE id=%s""",
                (job_id,),
            )
        else:
            cur.execute(
                """UPDATE job_queue
                      SET state = CASE WHEN attempts >= max_attempts
                                       THEN 'dead'::app.job_state
                                       ELSE 'queued'::app.job_state END,
                          run_after = now() + (interval '1 minute' * power(3, attempts)),
                          last_error = %s,
                          finished_at = CASE WHEN attempts >= max_attempts
                                             THEN now() ELSE NULL END,
                          locked_by = NULL, locked_at = NULL
                    WHERE id = %s""",
                (error[:4000], job_id),
            )


def reap_stalled(conn: psycopg.Connection, kinds: list[str], stale_minutes: int = 30) -> int:
    """Requeue jobs whose worker died mid-crawl (no heartbeat) — but only
    jobs of a KIND THIS WORKER OWNS (job_queue is shared across every
    worker type; without this scope, this worker's reaper can reclaim a
    job belonging to, and still genuinely being run by, a completely
    different worker — confirmed live: this exact reaper once reclaimed
    LeadSource's quarterly backfill mid-download) and only once its
    heartbeat has actually gone stale (a job that's heartbeating
    normally, however long it runs, is never touched here).

    A job that keeps going stale anyway (its own heartbeat never
    arriving — e.g. the process that claimed it was killed outright) is
    requeued and retried like any other failure, respecting the same
    max_attempts cap finish_job() already enforces on its own failure
    path; once that cap is hit, it's marked 'dead' with a clear reason
    instead of being reclaimed forever."""
    with staff_tx(conn) as cur:
        cur.execute(
            """UPDATE job_queue
                  SET state = CASE WHEN attempts >= max_attempts THEN 'dead'::app.job_state ELSE 'queued'::app.job_state END,
                      locked_by = NULL, locked_at = NULL,
                      finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
                      last_error = CASE
                        WHEN attempts >= max_attempts THEN 'dead: reclaimed too many times in a row (heartbeat kept going stale)'
                        ELSE 'reclaimed: worker heartbeat stopped'
                      END
                WHERE state = 'running' AND kind = ANY(%(kinds)s)
                  AND heartbeat_at < now() - (interval '1 minute' * %(stale_minutes)s)
             RETURNING id""",
            {"kinds": kinds, "stale_minutes": stale_minutes},
        )
        rows = cur.fetchall()
    if rows:
        log.warning("reaped %d stalled job(s) of kinds %s", len(rows), kinds)
    return len(rows)


def enqueue(
    conn: psycopg.Connection,
    kind: str,
    org_id: str | None,
    payload: dict,
    dedupe_key: str | None = None,
    priority: int = 100,
) -> int | None:
    """Insert a job. Returns None when dedupe_key collides with a live job."""
    import json

    with staff_tx(conn) as cur:
        cur.execute(
            """INSERT INTO job_queue (org_id, kind, payload, dedupe_key, priority)
               VALUES (%s, %s, %s, %s, %s)
               ON CONFLICT DO NOTHING
               RETURNING id""",
            (org_id, kind, json.dumps(payload), dedupe_key, priority),
        )
        row = cur.fetchone()
        return row["id"] if row else None
