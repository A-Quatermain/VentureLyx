-- Venturelyx :: 022_transactional_email
--
-- Password reset was the literal gap that made this launch-blocking: no
-- token table existed, so there was no way to recover a locked-out
-- account short of a manual DB fix. Token tables follow the exact pattern
-- sessions already uses (lib/auth.ts's hashToken/newSessionToken) — the
-- raw token goes in the email link, only its sha256 hash is ever stored,
-- so a DB read alone can never produce a usable token.
--
-- org_invites is keyed by email, not user_id — the whole point of an
-- invite is reaching someone who may not have a Venturelyx account yet.
-- memberships.invited_by/invited_at (001_platform_core.sql) already model
-- an accepted invite's provenance; this is the pending-state table that
-- was missing in front of it.
--
-- email_log has no org_id on every row by design (a password reset or a
-- waitlist confirmation isn't tenant-scoped — the recipient has no org
-- yet, or is between orgs) — platform-only RLS, same shape as stripe_events
-- (021_stripe_billing.sql).

BEGIN;

CREATE TABLE password_reset_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON password_reset_tokens (user_id);

CREATE TABLE email_verification_tokens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON email_verification_tokens (user_id);

CREATE TABLE org_invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email       citext NOT NULL,
  role        app.member_role NOT NULL DEFAULT 'viewer',
  token_hash  text NOT NULL UNIQUE,
  invited_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at  timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON org_invites (org_id);
-- One live (unaccepted, unexpired) invite per (org, email) — re-inviting
-- replaces rather than piling up duplicate pending rows.
CREATE UNIQUE INDEX org_invites_pending_idx ON org_invites (org_id, email) WHERE accepted_at IS NULL;

CREATE TABLE email_log (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  to_address         citext NOT NULL,
  template           text NOT NULL,   -- 'password_reset','email_verification','org_invite','billing_receipt','billing_payment_failed','waitlist_confirmation'
  status             text NOT NULL CHECK (status IN ('sent','failed')),
  provider_message_id text,
  error              text,
  user_id            uuid REFERENCES users(id) ON DELETE SET NULL,
  org_id             uuid REFERENCES organizations(id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON email_log (created_at DESC);
CREATE INDEX ON email_log (status, created_at DESC);

-- Platform-only — none of these four are meaningfully tenant-scoped (a
-- password reset token belongs to a user, not an org membership query),
-- same reasoning as stripe_events. apply_tenant_rls() below only touches
-- org_invites (the one table here with an org_id column); the other three
-- get this policy directly.
ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON password_reset_tokens USING (app.is_staff()) WITH CHECK (app.is_staff());

ALTER TABLE email_verification_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_verification_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON email_verification_tokens USING (app.is_staff()) WITH CHECK (app.is_staff());

ALTER TABLE email_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON email_log USING (app.is_staff()) WITH CHECK (app.is_staff());

CALL app.apply_tenant_rls();

COMMIT;
