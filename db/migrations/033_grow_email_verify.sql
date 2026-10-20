-- Venturelyx :: 033_grow_email_verify
--
-- Verify-on-import: every address is checked (syntax, MX, disposable-domain,
-- and optionally a third-party verification provider) before it's ever
-- enrolled -- see api/src/lib/growEmailVerify.ts and routes/grow.ts's
-- import/preview and import/commit handlers. 'invalid' addresses never reach
-- this table at all (excluded before insert, same bucket as any other
-- rejected row); these two columns record the verdict for everything that
-- DID get inserted, so a 'risky'/'unknown' row stays visible and filterable
-- after the one-time import summary is gone.
--
-- NULL verdict/reason means "never run through verification" -- every
-- contact created before this migration, and every contact
-- scripts/import-contacts.js's CLI path creates (that path is unchanged;
-- verification is wired into the web upload endpoints only).

BEGIN;

ALTER TABLE grow_contacts ADD COLUMN email_verify_verdict text
  CHECK (email_verify_verdict IS NULL OR email_verify_verdict IN ('valid', 'risky', 'unknown'));
ALTER TABLE grow_contacts ADD COLUMN email_verify_reason text;
ALTER TABLE grow_contacts ADD COLUMN is_role_address boolean NOT NULL DEFAULT false;

COMMIT;
