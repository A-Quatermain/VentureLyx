-- Venturelyx :: 013_grow_campaign_dates
--
-- start_date/end_date for grow_campaigns. Both nullable — a campaign with
-- neither set behaves exactly as before (send window/daily target/domain
-- caps are the only constraints). Once set, the schedule projection
-- (api/src/lib/growSchedule.ts) treats them as hard bounds on which
-- calendar days it simulates a send happening on, the same way the
-- (not-yet-built) worker's planTick would refuse to queue anything outside
-- them.
--
-- 009_grow.sql and 012_grow_campaign_archive.sql are already applied and
-- immutable, so this is a fresh ALTER rather than an edit to either.

BEGIN;

ALTER TABLE grow_campaigns ADD COLUMN start_date date;
ALTER TABLE grow_campaigns ADD COLUMN end_date date;

ALTER TABLE grow_campaigns ADD CONSTRAINT grow_campaigns_date_range_check
  CHECK (start_date IS NULL OR end_date IS NULL OR end_date >= start_date);

COMMIT;
