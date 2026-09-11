-- Venturelyx :: 012_grow_campaign_archive
--
-- Adds 'archived' to grow_campaigns.status. Deleting a campaign that has
-- already sent real mail would destroy the send log CAN-SPAM requires be
-- kept — grow_messages rows with status='sent' are the actual compliance
-- record, not just operational history — so the API refuses that delete
-- and archives the campaign instead. 'stopped' (already in the original
-- enum) means something different: a campaign someone manually halted
-- mid-run, which might still be revisited. 'archived' is the distinct,
-- one-way "retired, kept for the record" state this needs.
--
-- 009_grow.sql is already applied and immutable, so this is a fresh ALTER
-- rather than an edit to the original CHECK constraint.

BEGIN;

ALTER TABLE grow_campaigns DROP CONSTRAINT grow_campaigns_status_check;
ALTER TABLE grow_campaigns ADD CONSTRAINT grow_campaigns_status_check
  CHECK (status IN ('draft','running','paused','stopped','done','archived'));

COMMIT;
