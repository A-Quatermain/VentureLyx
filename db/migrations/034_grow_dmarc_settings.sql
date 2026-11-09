-- Venturelyx :: 034_grow_dmarc_settings
--
-- Sending Setup's DMARC record has always been a fixed template
-- (v=DMARC1; p=quarantine; pct=100; rua=mailto:dmarc@<domain>, built in
-- lib/growSendingDomain.ts) — nobody could point aggregate reports at a
-- real, monitored mailbox, or move the policy past quarantine. These four
-- columns are the org's own DMARC choice per sending domain; SPF and DKIM
-- are untouched (SPF's include is provider-fixed, DKIM's key is generated
-- by the sending provider — neither has a "the org's own setting" to add).
--
-- dmarc_rua/dmarc_ruf start NULL ("never customized — show the old fixed
-- placeholder") rather than defaulting to a guessed address; dmarc_policy/
-- dmarc_pct get real defaults since every domain needs *some* value for
-- those the moment this column exists; a domain is "customized" once
-- dmarc_rua is set, same test the application code uses to decide whether
-- to show the placeholder or the org's real record.
--
-- Org-scoped as usual: grow_sending_domains already carries org_id with
-- its own tenant_isolation RLS policy (009_grow.sql) — adding columns to
-- an already-RLS-protected table needs no policy change.

BEGIN;

ALTER TABLE grow_sending_domains
  ADD COLUMN dmarc_rua    text,
  ADD COLUMN dmarc_ruf    text,
  ADD COLUMN dmarc_policy text NOT NULL DEFAULT 'quarantine'
             CHECK (dmarc_policy IN ('none', 'quarantine', 'reject')),
  ADD COLUMN dmarc_pct    int  NOT NULL DEFAULT 100
             CHECK (dmarc_pct BETWEEN 1 AND 100);

COMMIT;
