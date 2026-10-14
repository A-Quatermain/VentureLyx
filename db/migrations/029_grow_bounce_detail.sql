-- Venturelyx :: 029_grow_bounce_detail
--
-- grow_messages already has `error` (text) for a synchronous send failure's
-- message, and `status = 'bounced'` for an async DSN report — but neither
-- path has ever kept the actual server response once classified, so an
-- owner looking at a bounce has never had anything to go on beyond
-- "bounced." These four columns are where api/src/lib/growBounceClassify.ts
-- (the one shared classifier routes/grow.ts and worker/growWorker.ts both
-- call) gets read from at display time and written to at capture time.
--
-- Org-scoped as usual: grow_messages already carries org_id with its own
-- tenant_isolation RLS policy (009_grow.sql) — adding columns to an
-- already-RLS-protected table needs no policy change.

BEGIN;

CREATE TYPE app.grow_bounce_type AS ENUM ('hard', 'soft', 'block', 'unknown');

ALTER TABLE grow_messages
  ADD COLUMN bounce_code text,
  ADD COLUMN bounce_type app.grow_bounce_type,
  ADD COLUMN bounce_reason_raw text,
  ADD COLUMN bounced_at timestamptz;

-- Drives both the campaign-level summary counts and the Bounced view's
-- default sort (most recent first).
CREATE INDEX grow_messages_bounce_idx ON grow_messages (campaign_id, bounce_type) WHERE status = 'bounced';

COMMIT;
