-- =============================================================================
-- Venturelyx :: 001_platform_core
-- Tenancy, identity, RBAC, job queue, credential vault, audit.
--
-- Run as superuser. The application connects as venturelyx_app (created below),
-- which is deliberately NOT the owner of these tables so that FORCE RLS applies.
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE SCHEMA IF NOT EXISTS app;

-- -----------------------------------------------------------------------------
-- Tenant context. Set per-transaction with SET LOCAL — never SET.
-- SET LOCAL is transaction-scoped, so a pooled connection cannot leak context
-- into the next request.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.current_org() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_org', true), '')::uuid
$$;

-- NOTE: the GUC is app.user_id, NOT app.current_user.
-- `current_user` is a reserved SQL keyword and `SET LOCAL app.current_user = ...`
-- fails to parse. Verified against PostgreSQL 16.
CREATE OR REPLACE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app.is_staff() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('app.is_staff', true), ''), 'off')::boolean
$$;

-- updated_at maintenance
CREATE OR REPLACE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- -----------------------------------------------------------------------------
-- Organizations (tenants)
-- -----------------------------------------------------------------------------
CREATE TYPE app.org_status AS ENUM ('prospect','onboarding','active','paused','churned');

CREATE TABLE organizations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            citext NOT NULL UNIQUE,
  name            text   NOT NULL,
  legal_name      text,
  status          app.org_status NOT NULL DEFAULT 'prospect',
  vertical        text,                      -- 'pool_service', 'hvac', 'ecommerce'
  website_url     text,
  timezone        text   NOT NULL DEFAULT 'America/New_York',
  currency        char(3) NOT NULL DEFAULT 'USD',
  -- module enablement: {"scaleseo": true, "operate": true, "ai_team": false}
  modules         jsonb  NOT NULL DEFAULT '{}'::jsonb,
  settings        jsonb  NOT NULL DEFAULT '{}'::jsonb,
  onboarded_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX ON organizations (status) WHERE deleted_at IS NULL;

-- -----------------------------------------------------------------------------
-- Identity. Users are global; membership grants access to an org.
-- A Venturelyx staff member is a user with is_platform_staff = true.
-- -----------------------------------------------------------------------------
CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              citext NOT NULL UNIQUE,
  email_verified_at  timestamptz,
  password_hash      text,                   -- argon2id; null = SSO/invite pending
  full_name          text   NOT NULL DEFAULT '',
  phone              text,
  avatar_url         text,
  is_platform_staff  boolean NOT NULL DEFAULT false,
  totp_secret_enc    bytea,                  -- encrypted at rest, see vault notes
  totp_enabled_at    timestamptz,
  recovery_codes_enc bytea,
  last_login_at      timestamptz,
  failed_logins      int NOT NULL DEFAULT 0,
  locked_until       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);

CREATE TYPE app.member_role AS ENUM ('owner','admin','manager','staff','viewer');

CREATE TABLE memberships (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        app.member_role NOT NULL DEFAULT 'viewer',
  invited_by  uuid REFERENCES users(id),
  invited_at  timestamptz,
  accepted_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);
CREATE INDEX ON memberships (user_id);

CREATE TABLE sessions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id          uuid REFERENCES organizations(id) ON DELETE CASCADE,
  token_hash      text NOT NULL UNIQUE,      -- sha256 of the opaque token
  ip              inet,
  user_agent      text,
  mfa_satisfied   boolean NOT NULL DEFAULT false,
  expires_at      timestamptz NOT NULL,
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX ON sessions (expires_at);

-- -----------------------------------------------------------------------------
-- Credential vault. Third-party tokens (Google, Stripe, Meta, SMTP).
-- Ciphertext only — AES-256-GCM, key from env, never in the database.
-- Same pattern already proven in the GeoDyn admin portal.
-- -----------------------------------------------------------------------------
CREATE TABLE integrations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider       text NOT NULL,              -- 'google_search_console','stripe','gbp'
  external_id    text,                       -- property id, account id
  display_name   text,
  status         text NOT NULL DEFAULT 'disconnected',
  scopes         text[] NOT NULL DEFAULT '{}',
  credential_enc bytea,                      -- AES-256-GCM ciphertext
  credential_iv  bytea,
  credential_tag bytea,
  expires_at     timestamptz,
  last_sync_at   timestamptz,
  last_error     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, provider, external_id)
);

-- -----------------------------------------------------------------------------
-- Job queue. SELECT ... FOR UPDATE SKIP LOCKED.
-- Shared by Node scheduler and Python workers — no bridge required.
-- NOTE: this is the *task queue*. Field service work orders are `work_orders`.
-- -----------------------------------------------------------------------------
CREATE TYPE app.job_state AS ENUM ('queued','running','succeeded','failed','cancelled','dead');

CREATE TABLE job_queue (
  id             bigserial PRIMARY KEY,
  org_id         uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- null = platform job
  kind           text NOT NULL,              -- 'seo.crawl','seo.rank_check','ai.persona_run'
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  state          app.job_state NOT NULL DEFAULT 'queued',
  priority       smallint NOT NULL DEFAULT 100,   -- lower runs first
  run_after      timestamptz NOT NULL DEFAULT now(),
  attempts       int NOT NULL DEFAULT 0,
  max_attempts   int NOT NULL DEFAULT 5,
  locked_by      text,
  locked_at      timestamptz,
  heartbeat_at   timestamptz,
  last_error     text,
  dedupe_key     text,                       -- prevents duplicate scheduling
  started_at     timestamptz,
  finished_at    timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX job_queue_claim_idx
  ON job_queue (priority, run_after)
  WHERE state = 'queued';
CREATE UNIQUE INDEX job_queue_dedupe_idx
  ON job_queue (dedupe_key)
  WHERE dedupe_key IS NOT NULL AND state IN ('queued','running');
CREATE INDEX ON job_queue (state, heartbeat_at) WHERE state = 'running';

-- Reference claim pattern (workers implement this verbatim):
--
--   UPDATE job_queue SET state='running', locked_by=$1, locked_at=now(),
--          heartbeat_at=now(), started_at=now(), attempts=attempts+1
--   WHERE id = (
--     SELECT id FROM job_queue
--     WHERE state='queued' AND run_after <= now() AND kind = ANY($2)
--     ORDER BY priority, run_after
--     FOR UPDATE SKIP LOCKED LIMIT 1
--   ) RETURNING *;

-- -----------------------------------------------------------------------------
-- Audit log. Append-only. Every staff cross-tenant read lands here.
-- -----------------------------------------------------------------------------
CREATE TABLE audit_log (
  id           bigserial PRIMARY KEY,
  org_id       uuid REFERENCES organizations(id) ON DELETE SET NULL,
  actor_user   uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_type   text NOT NULL DEFAULT 'user',   -- user | system | ai_persona
  actor_label  text,
  action       text NOT NULL,                  -- 'party.update','integration.connect'
  entity_type  text,
  entity_id    uuid,
  staff_mode   boolean NOT NULL DEFAULT false,
  ip           inet,
  diff         jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (org_id, created_at DESC);
CREATE INDEX ON audit_log (entity_type, entity_id);
CREATE INDEX ON audit_log (staff_mode, created_at DESC) WHERE staff_mode;

-- -----------------------------------------------------------------------------
-- Files (MinIO pointers — never blobs in Postgres)
-- -----------------------------------------------------------------------------
CREATE TABLE files (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bucket      text NOT NULL,
  object_key  text NOT NULL,
  filename    text NOT NULL,
  mime_type   text,
  byte_size   bigint,
  checksum    text,
  purpose     text,                           -- 'report','screenshot','deliverable'
  uploaded_by uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bucket, object_key)
);
CREATE INDEX ON files (org_id, purpose);

COMMIT;

-- =============================================================================
-- Application role + RLS
-- =============================================================================
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'venturelyx_app') THEN
    -- Password is replaced by deploy from .env. Never rotated after init.
    CREATE ROLE venturelyx_app LOGIN PASSWORD 'CHANGE_ME_AT_DEPLOY' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public, app TO venturelyx_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO venturelyx_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO venturelyx_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO venturelyx_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO venturelyx_app;

-- audit_log is append-only for the application
REVOKE UPDATE, DELETE ON audit_log FROM venturelyx_app;

-- -----------------------------------------------------------------------------
-- Blanket RLS applier. Any table with an org_id column gets tenant isolation
-- automatically. Re-run after every migration — this is why forgetting a policy
-- on a new table cannot silently leak data.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE PROCEDURE app.apply_tenant_rls()
LANGUAGE plpgsql AS $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.relname AS tbl
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id' AND a.attnum > 0
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tbl);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t.tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t.tbl);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON public.%I
        USING (org_id = app.current_org() OR app.is_staff())
        WITH CHECK (org_id = app.current_org() OR app.is_staff())
    $p$, t.tbl);
    RAISE NOTICE 'RLS applied: %', t.tbl;
  END LOOP;
END $$;

CALL app.apply_tenant_rls();

-- organizations has no org_id; policy is on id
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organizations
  USING (id = app.current_org() OR app.is_staff())
  WITH CHECK (id = app.current_org() OR app.is_staff());

-- users/sessions are global; scoped by membership, not org_id
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY user_self_or_comember ON users
  USING (
    app.is_staff()
    OR id = app.current_user_id()
    OR EXISTS (SELECT 1 FROM memberships m
               WHERE m.user_id = users.id AND m.org_id = app.current_org())
  )
  WITH CHECK (app.is_staff() OR id = app.current_user_id());

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
-- apply_tenant_rls() adds tenant_isolation because sessions has org_id.
-- Permissive policies OR together, which would let any org member see every
-- other member's sessions. Drop it; session_self is the correct rule.
DROP POLICY IF EXISTS tenant_isolation ON sessions;
CREATE POLICY session_self ON sessions
  USING (app.is_staff() OR user_id = app.current_user_id())
  WITH CHECK (app.is_staff() OR user_id = app.current_user_id());

-- job_queue: workers run with is_staff on; org jobs still scoped
ALTER TABLE job_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_queue FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON job_queue;
CREATE POLICY queue_access ON job_queue
  USING (app.is_staff() OR org_id = app.current_org())
  WITH CHECK (app.is_staff() OR org_id = app.current_org());

COMMIT;

-- =============================================================================
-- updated_at triggers
-- =============================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organizations','users','memberships','integrations']
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_touch BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()', t, t);
  END LOOP;
END $$;
