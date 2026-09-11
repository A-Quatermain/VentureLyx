-- Venturelyx :: 014_grow_sender_profile_brand
--
-- sender_name and contact_email on grow_sender_profiles. Two gaps found on
-- the first real test send:
--   - The From display name has nothing driving it but grow_mailboxes'
--     own from_name, typed in ad hoc when a mailbox was added — nothing
--     ties it to a consistent brand identity, and it's easy to type the
--     org's registered legal-ish name ("CampusPath Education") instead of
--     the shorter product name people actually reply to ("CampusPath").
--     sender_name gives {{sender_name}} a real merge-field source, the
--     same pattern sender_website/sender_phone already use.
--   - There was no way to put a reply contact email in body copy at all —
--     only the mailbox's own address, via the From header itself.
--
-- 011_grow_sender_profiles.sql is already applied and immutable, so this
-- is a fresh ALTER rather than an edit to it.

BEGIN;

ALTER TABLE grow_sender_profiles ADD COLUMN sender_name text;
ALTER TABLE grow_sender_profiles ADD COLUMN contact_email text;

COMMIT;
