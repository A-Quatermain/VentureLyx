-- Venturelyx :: 011_grow_sender_profiles
--
-- Sender identity for Grow outreach: website, phone, product links, and the
-- physical mailing address CAN-SPAM requires in every commercial email.
-- GROW_MAILING_ADDRESS lived in .env (api/src/routes/grow.ts,
-- sender.js/scheduler.js in /opt/outreach/src) — a single env var for the
-- whole deployment can't be right once more than one org sends through
-- this app, and a legal requirement belongs in data the owner can see and
-- edit, not a server config file only an operator can touch.
--
-- One row per org (like grow_import_profiles): this is identity, not a
-- log — editing it always replaces the current value, there's no history
-- to keep. product_urls is jsonb (a variable-length list of {label, url}
-- pairs) rather than a side table since it's small, wholly owned by this
-- one row, and read as a unit every time (never queried by label at the
-- SQL level — that lookup happens in application code against the merge
-- field {{product_url:<label>}}).

BEGIN;

CREATE TABLE grow_sender_profiles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  website_url     text,
  phone           text,
  -- Full physical postal address, CAN-SPAM §7704(a)(5) — free text rather
  -- than structured street/city/state/zip columns: it's rendered as-is
  -- into the unsubscribe footer, never parsed or geocoded.
  mailing_address text,
  product_urls    jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id)
);

CALL app.apply_tenant_rls();

CREATE TRIGGER grow_sender_profiles_touch BEFORE UPDATE ON grow_sender_profiles
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

COMMIT;
