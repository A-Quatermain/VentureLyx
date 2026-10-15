-- Venturelyx :: 030_grow_breaker_rearm
--
-- A manual resume (routes/grow.ts's POST /grow/campaigns/:id/resume) sets
-- this to now() -- lib/growScheduler.ts's circuitBreaker() then only
-- counts sends/bounces/complaints from AFTER this watermark, so the
-- breaker re-checks the rate over the NEXT batch rather than immediately
-- re-tripping on the exact same cumulative history that just caused the
-- pause. An override pushes past one trip; it does not disable the
-- safety permanently -- a real, ongoing problem still re-pauses once
-- enough new sends land.

BEGIN;

ALTER TABLE grow_campaigns ADD COLUMN breaker_armed_at timestamptz;

COMMIT;
