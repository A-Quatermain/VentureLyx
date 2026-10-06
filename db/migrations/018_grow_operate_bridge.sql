-- Venturelyx :: 018_grow_operate_bridge
--
-- Schema support for the Grow -> Operate CRM bridge: a real IMAP reply
-- poller (grow_mailboxes.imap_last_uid is its watermark — 009_grow.sql's
-- party_id column on grow_contacts and the 'reply'/'auto_reply' values in
-- grow_events.type were already reserved for this, nothing new needed
-- there), plus AI reply classification, overridable by a human, stored on
-- both the party (current/effective tag) and the specific timeline event
-- (what was said about THAT reply, which an override does not rewrite).
--
-- Everything else this bridge needs already exists: party_contacts.opted_out_at
-- (do-not-contact), attribution_touches (source), deals/pipelines (pipeline
-- board), parties.owner_user_id ("start working this").

BEGIN;

-- Per-mailbox IMAP polling watermark. NULL means "never polled" — the first
-- poll records the mailbox's current highest UID without classifying
-- anything older, so turning this on doesn't flood every lead's timeline
-- with years of backdated inbox history on day one.
ALTER TABLE grow_mailboxes ADD COLUMN imap_last_uid bigint;

CREATE TYPE app.reply_tag AS ENUM ('interested', 'not_now', 'not_a_fit', 'question');

-- The party's CURRENT, effective classification — from the AI, until a
-- human overrides it. reply_tag_source distinguishes the two so the lead
-- list can show "AI: interested" vs "interested" without a second column
-- per tag. The AI's original call is never lost even after an override —
-- it stays on the timeline_events row it was written against.
ALTER TABLE parties ADD COLUMN reply_tag app.reply_tag;
ALTER TABLE parties ADD COLUMN reply_tag_source text CHECK (reply_tag_source IN ('ai', 'human'));

COMMIT;
