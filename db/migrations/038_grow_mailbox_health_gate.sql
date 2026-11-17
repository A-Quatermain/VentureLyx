-- Venturelyx :: 038_grow_mailbox_health_gate
--
-- Warmup health gate (docs/specs/grow-warmup-coach-spec.md section 3).
-- Additive: grow_mailbox_daily_cap() keeps exactly the same signature and
-- stays a cheap, deterministic function of (m, on_day) — reading
-- health_steps_down off the row it's already handed is free; nothing here
-- adds a subquery, a join, or a live bounce/complaint computation inside
-- the hot path (mailboxCapacity()/claimDue() both call this per mailbox,
-- every planning tick and every send tick).
--
-- health_steps_down: how many 5/day steps are currently being held below
-- the warmup ramp's own cap. 0 = healthy. Set immediately (no delay) the
-- moment growMailboxHealth.ts's evaluator finds the bounce or complaint
-- rate over BOUNCE_PAUSE_RATE/COMPLAINT_PAUSE_RATE (1 step) or over 2x
-- either (2 steps) — protection is never deferred. Recovery is the
-- opposite: at most one step per confirmed-healthy week, tracked via
-- health_healthy_since (reset to NULL the moment it's unhealthy again, set
-- to the time it was FIRST seen healthy otherwise) so a mailbox can't snap
-- back to full capacity just because the one worst day finally rolled out
-- of the 7-day window.
--
-- health_reason / health_evaluated_at exist purely for the Mailbox
-- capacity card (routes/grow.ts's /grow/stats) to show WHY a mailbox is
-- held down, and when that was last checked, without the frontend having
-- to re-derive the bounce/complaint math itself.

BEGIN;

ALTER TABLE grow_mailboxes
  ADD COLUMN health_steps_down   smallint NOT NULL DEFAULT 0 CHECK (health_steps_down >= 0),
  ADD COLUMN health_reason       text,
  ADD COLUMN health_healthy_since timestamptz,
  ADD COLUMN health_evaluated_at  timestamptz;

CREATE OR REPLACE FUNCTION grow_mailbox_daily_cap(m grow_mailboxes, on_day date)
RETURNS int LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN m.status <> 'active' AND m.status <> 'warming' THEN 0
        WHEN m.warmup_started_on IS NULL THEN 0
        ELSE GREATEST(0,
            LEAST(
                m.steady_cap,
                5 * (1 + GREATEST(0, (on_day - m.warmup_started_on)) / 7)
            ) - 5 * m.health_steps_down
        )
    END;
$$;

COMMIT;
