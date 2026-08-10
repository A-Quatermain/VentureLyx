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


def heartbeat(conn: psycopg.Connection, job_id: int) -> None:
    """Called periodically during long crawls so the reaper doesn't requeue us."""
    with staff_tx(conn) as cur:
        cur.execute(
            "UPDATE job_queue SET heartbeat_at = now() WHERE id = %s", (job_id,)
        )


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


def reap_stalled(conn: psycopg.Connection, stale_minutes: int = 30) -> int:
    """Requeue jobs whose worker died mid-crawl (no heartbeat)."""
    with staff_tx(conn) as cur:
        cur.execute(
            """UPDATE job_queue
                  SET state='queued', locked_by=NULL, locked_at=NULL,
                      last_error='reclaimed: worker heartbeat stopped'
                WHERE state='running'
                  AND heartbeat_at < now() - (interval '1 minute' * %s)
             RETURNING id""",
            (stale_minutes,),
        )
        rows = cur.fetchall()
    if rows:
        log.warning("reaped %d stalled job(s)", len(rows))
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
