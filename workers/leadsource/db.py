"""
Venturelyx :: LeadSource worker database layer.

Two separate connections, deliberately: DB_DSN (venturelyx_app — the same
role every other worker and the API use) for job-queue claiming and the
per-org fan-out into leadsource_leads (RLS-scoped, same staff_tx/tenant_tx
split workers/seo/db.py already established); RAW_DB_DSN
(venturelyx_leadsource_worker — 040_leadsource.sql's own restricted role)
for the ONE write this process makes that nothing else is allowed to:
upserting leadsource_raw_records. That table has no RLS (nothing to scope
by — it's shared, not tenant data), so "worker-write-only, app read-only"
is enforced by which ROLE the connection authenticates as, not by a GUC.
Never use the raw connection for anything else, and never use the normal
connection to write leadsource_raw_records — it no longer has the grant
to, and would fail loudly if it tried, which is the point.
"""
from __future__ import annotations

import contextlib
import logging
import os
import threading
from typing import Iterator

import psycopg
from psycopg.rows import dict_row

log = logging.getLogger("vx.leadsource.db")

DSN = os.environ["DB_DSN"]
RAW_DSN = os.environ["RAW_DB_DSN"]
WORKER_ID = os.environ.get("WORKER_ID") or f"leadsource-{os.uname().nodename}-{os.getpid()}"


def connect() -> psycopg.Connection:
    return psycopg.connect(DSN, row_factory=dict_row, autocommit=False, application_name=WORKER_ID)


def connect_raw() -> psycopg.Connection:
    return psycopg.connect(RAW_DSN, row_factory=dict_row, autocommit=False, application_name=f"{WORKER_ID}-raw")


@contextlib.contextmanager
def staff_tx(conn: psycopg.Connection) -> Iterator[psycopg.Cursor]:
    """Cross-tenant — queue claim, and reading which orgs have leadsource
    enabled (organizations isn't tenant-scoped the way a per-org table is,
    but this stays consistent with workers/seo/db.py's own convention of
    naming the cross-tenant mode explicitly rather than leaving it implicit)."""
    with conn.transaction():
        cur = conn.cursor()
        cur.execute("SELECT set_config('app.is_staff', 'on', true)")
        yield cur


@contextlib.contextmanager
def tenant_tx(conn: psycopg.Connection, org_id: str) -> Iterator[psycopg.Cursor]:
    """Tenant-scoped — the fan-out INSERT into leadsource_leads for one org."""
    if not org_id:
        raise ValueError("tenant_tx requires an org_id")
    with conn.transaction():
        cur = conn.cursor()
        cur.execute("SELECT set_config('app.current_org', %s, true)", (str(org_id),))
        cur.execute("SELECT set_config('app.is_staff', 'off', true)")
        yield cur


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


def claim_job(conn: psycopg.Connection, kinds: list[str]):
    with staff_tx(conn) as cur:
        cur.execute(CLAIM_SQL, {"worker": WORKER_ID, "kinds": kinds})
        return cur.fetchone()


def finish_job(conn: psycopg.Connection, job_id: int, error: str | None = None) -> None:
    with staff_tx(conn) as cur:
        if error is None:
            cur.execute(
                "UPDATE job_queue SET state='succeeded', finished_at=now(), last_error=NULL WHERE id=%s",
                (job_id,),
            )
        else:
            cur.execute(
                """UPDATE job_queue
                      SET state = CASE WHEN attempts >= max_attempts THEN 'dead'::app.job_state ELSE 'queued'::app.job_state END,
                          run_after = now() + (interval '1 minute' * power(3, attempts)),
                          last_error = %s,
                          finished_at = CASE WHEN attempts >= max_attempts THEN now() ELSE NULL END,
                          locked_by = NULL, locked_at = NULL
                    WHERE id = %s""",
                (error[:4000], job_id),
            )


def touch_heartbeat(conn: psycopg.Connection, job_id: int) -> None:
    """Refreshes one job's heartbeat_at — see HeartbeatThread below, which
    is what actually calls this during a real job; nothing else should
    need to call it directly."""
    with staff_tx(conn) as cur:
        cur.execute("UPDATE job_queue SET heartbeat_at = now() WHERE id = %s", (job_id,))


class HeartbeatThread:
    """Keeps one job's heartbeat_at fresh for as long as it's running,
    on its own connection (psycopg connections aren't safe to share across
    threads) — wrap the whole of run_job() in this, once, in the worker
    loop, and every job kind gets heartbeating for free with no changes
    to what the job itself does internally. This is the fix for a bug
    confirmed live in Phase 4: a job with no heartbeat update for
    stale_minutes looks dead to reap_stalled() even though the process
    running it never crashed — the quarterly backfill's own ~72-minute
    run got reclaimed by the (unrelated, differently-scoped-before-this-fix)
    seo-worker's own reaper at the 30-minute mark while still genuinely
    in progress.

        with db.HeartbeatThread(conn_factory, job["id"]):
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


def reap_stalled(conn: psycopg.Connection, kinds: list[str], stale_minutes: int = 30) -> int:
    """Only reclaims 'running' jobs whose KIND this worker actually owns
    (job_queue is shared across every worker type; without this, one
    worker's reaper can reclaim a job that belongs to, and is still
    genuinely being run by, a completely different worker — exactly what
    happened to the quarterly backfill, see HeartbeatThread's own header)
    and only when its heartbeat has actually gone stale (a job that's
    heartbeating normally, however long it runs, is never touched here).

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
