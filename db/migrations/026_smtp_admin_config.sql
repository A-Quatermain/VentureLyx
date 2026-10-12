-- Venturelyx :: 026_smtp_admin_config
--
-- Admin-UI-configurable SMTP, so transactional email doesn't require a
-- redeploy to set up or change. Singleton table (id fixed to 1, same
-- idiom as a one-row settings table) rather than reusing `integrations`
-- (009_grow.sql's own comment: that table already stores Grow's per-
-- mailbox SMTP credentials the same way, but it's org_id NOT NULL — this
-- credential is platform-wide, not tied to one tenant).
--
-- The password alone is encrypted at rest (AES-256-GCM via VAULT_KEY,
-- encryptSecret/decryptSecret — the same vault every other credential in
-- this app uses, lib/auth.ts). Host/port/username/from-address/from-name
-- are not secrets and stay plain. No GET route ever returns the
-- decrypted password — only a passwordConfigured boolean, same rule as
-- the BYO AI provider keys (routes/settings.ts).

BEGIN;

CREATE TABLE platform_smtp_config (
  id             int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  host           text,
  port           int NOT NULL DEFAULT 465,
  username       text,
  from_address   text,
  from_name      text,
  credential_enc bytea,
  credential_iv  bytea,
  credential_tag bytea,
  updated_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE platform_smtp_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_smtp_config FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform_smtp_config USING (app.is_staff()) WITH CHECK (app.is_staff());

COMMIT;
