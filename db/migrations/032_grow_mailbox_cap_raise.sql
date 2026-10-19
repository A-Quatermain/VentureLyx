-- Venturelyx :: 032_grow_mailbox_cap_raise
--
-- Raises the per-mailbox daily cap default from 25 to 50. steady_cap is
-- the warmup ramp's ceiling (grow_mailbox_daily_cap(), 009_grow.sql) --
-- this does not touch that function or any enforcement logic, only the
-- value every mailbox on the platform is currently sitting at.
--
-- Every grow_mailboxes row today is still at the old default (25) --
-- confirmed before writing this migration. The WHERE clause only bumps
-- rows still at that old default, so a mailbox an admin had already
-- customized to something else would be left alone (none exist today,
-- but this keeps the migration honest if that ever changes before it
-- runs).
--
-- Note for whoever reads this later: raising steady_cap does NOT mean
-- every mailbox jumps to 50/day today. grow_mailbox_daily_cap() still
-- ramps 5/day-per-week from warmup_started_on regardless of the ceiling
-- -- a mailbox that had already plateaued at the old 25 ceiling for
-- weeks is still only as far along the ramp as its warmup_started_on
-- says, so raising the ceiling reveals whatever that ramped value
-- actually is today (which may be well under 50) and it keeps climbing
-- +5/week from there until it reaches the new ceiling.

BEGIN;

ALTER TABLE grow_mailboxes ALTER COLUMN steady_cap SET DEFAULT 50;

UPDATE grow_mailboxes SET steady_cap = 50 WHERE steady_cap = 25;

COMMIT;
