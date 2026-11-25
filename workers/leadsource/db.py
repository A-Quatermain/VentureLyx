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
    """Call periodically during a long-running job — reap_stalled() (in
    THIS file and workers/seo/db.py) reclaims ANY 'running' row whose
    heartbeat has gone stale, regardless of which worker owns it or what
    kind it is (job_queue has no per-kind reaping). A job that runs for
    tens of minutes without calling this looks dead to every worker's
    reaper after stale_minutes, even though the process claiming it never
    crashed — confirmed live in Phase 4: the quarterly backfill's own
    ~72-minute run got reclaimed by the unrelated seo-worker's reaper at
    the 30-minute mark while still genuinely in progress."""
    with staff_tx(conn) as cur:
        cur.execute("UPDATE job_queue SET heartbeat_at = now() WHERE id = %s", (job_id,))


def reap_stalled(conn: psycopg.Connection, stale_minutes: int = 30) -> int:
    with staff_tx(conn) as cur:
        cur.execute(
            """UPDATE job_queue
                  SET state='queued', locked_by=NULL, locked_at=NULL,
                      last_error='reclaimed: worker heartbeat stopped'
                WHERE state='running' AND heartbeat_at < now() - (interval '1 minute' * %s)
             RETURNING id""",
            (stale_minutes,),
        )
        rows = cur.fetchall()
    if rows:
        log.warning("reaped %d stalled job(s)", len(rows))
    return len(rows)
