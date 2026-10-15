-- Venturelyx :: 031_grow_bulk_remove
--
-- Lets staff pull contacts back out of a running campaign without
-- re-uploading the whole list, and lets a hard bounce do the same thing
-- automatically.
--
-- 'removed' is a new grow_enrollments.state: a staff-driven stop, distinct
-- from 'bounced'/'unsubscribed' (recipient-driven signals) and 'completed'/
-- 'failed' (the sequence's own terminal states) -- see routes/grow.ts's
-- POST /grow/campaigns/:id/contacts/bulk-remove.
--
-- auto_remove_hard_bounces (default on) lets an owner turn off the
-- worker's automatic suppress-and-cancel on a hard bounce, if they'd
-- rather review bounces manually first -- see growWorker.ts.

BEGIN;

ALTER TABLE grow_enrollments DROP CONSTRAINT grow_enrollments_state_check;
ALTER TABLE grow_enrollments ADD CONSTRAINT grow_enrollments_state_check
  CHECK (state = ANY (ARRAY[
    'active', 'replied', 'bounced', 'unsubscribed', 'completed', 'held', 'failed', 'removed'
  ]));

ALTER TABLE grow_campaigns ADD COLUMN auto_remove_hard_bounces boolean NOT NULL DEFAULT true;

COMMIT;
