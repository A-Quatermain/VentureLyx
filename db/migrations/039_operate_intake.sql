-- Venturelyx :: 039_operate_intake
--
-- Server-to-server lead intake for an org's own external website backend
-- (e.g. a site's existing booking/contact form, unchanged, forwarding
-- submissions here instead of to its own backend). ADDITIVE — no existing
-- table or route changes.
--
-- operate_intake_keys: one row per issued key. Only key_hash (sha256,
-- same scheme as sessions.token_hash) is ever stored — the raw key is
-- returned exactly once, at creation, and never again. key_prefix is the
-- first several characters of the raw key (never enough to reconstruct
-- it), kept only so an owner can tell two keys apart in a list without
-- re-displaying either secret.
--
-- operate_intake_log: UNIQUE(org_id, reference) IS the "same submission
-- retried twice never creates two leads" rule, enforced as a constraint,
-- not application logic that could be gotten wrong. party_id/deal_id are
-- what a repeat with the same reference hands back.

BEGIN;

CREATE TABLE operate_intake_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key_hash     text NOT NULL UNIQUE,
  key_prefix   text NOT NULL,
  label        text NOT NULL,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  last_used_at timestamptz
);
CREATE INDEX operate_intake_keys_org_idx ON operate_intake_keys (org_id) WHERE revoked_at IS NULL;

CREATE TABLE operate_intake_log (
  id          bigserial PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  reference   text NOT NULL,
  party_id    uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  deal_id     uuid REFERENCES deals(id) ON DELETE SET NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, reference)
);

CALL app.apply_tenant_rls();

COMMIT;
