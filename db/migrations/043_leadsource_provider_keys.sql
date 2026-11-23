-- Venturelyx :: 043_leadsource_provider_keys
--
-- Bring-your-own-key, per org, for optional website-search fallback
-- (Brave Search API — the only provider for now). The platform holds no
-- Brave key of its own; an org that wants the search_transient enrichment
-- path pastes its own key here. Encrypted with the same AES-256-GCM vault
-- every other third-party credential in this app uses
-- (api/src/lib/auth.ts::encryptSecret / workers/*/vault.py::decrypt_secret)
-- — key_enc/key_iv/key_tag mirrors integrations.credential_enc/iv/tag
-- (001_platform_core.sql) exactly, same column shapes, same reason.
--
-- Soft-revoke (revoked_at), same convention as operate_intake_keys
-- (039_operate_intake.sql) — never a hard delete, so "a key existed and
-- was removed" stays in the row's own history, not just the audit log.
-- The partial unique index (not a plain UNIQUE) is what lets an org add a
-- fresh key after revoking an old one for the same provider.

BEGIN;

CREATE TABLE leadsource_provider_keys (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider                text NOT NULL CHECK (provider = 'brave'), -- the only provider today; CHECK makes that explicit rather than implicit
  key_enc                 bytea NOT NULL,
  key_iv                  bytea NOT NULL,
  key_tag                 bytea NOT NULL,
  key_last4               text NOT NULL,
  status                  text NOT NULL DEFAULT 'untested' CHECK (status IN ('untested', 'ok', 'invalid', 'quota_exceeded')),
  monthly_search_cap      int NOT NULL DEFAULT 500,
  searches_this_month     int NOT NULL DEFAULT 0,
  searches_month_reset_at date NOT NULL DEFAULT date_trunc('month', now())::date,
  last_tested_at          timestamptz,
  last_error              text,
  created_by              uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  revoked_at              timestamptz
);
CREATE UNIQUE INDEX leadsource_provider_keys_org_provider_active_idx
  ON leadsource_provider_keys (org_id, provider) WHERE revoked_at IS NULL;

CALL app.apply_tenant_rls();

COMMIT;
