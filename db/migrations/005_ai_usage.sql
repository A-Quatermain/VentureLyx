-- =============================================================================
-- 005_ai_usage.sql
--
-- Usage log for api/src/lib/ai.ts. One row per completed call (streaming or
-- not) — what feature asked, which provider/model actually served it (the
-- fallback can differ from the org's preference), and an approximate token
-- count for cost tracking. Append-only, like audit_log and timeline_events.
-- =============================================================================

BEGIN;

CREATE TABLE ai_usage (
  id            bigserial PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  feature       text NOT NULL,   -- 'seo_recommendations','next_best_action', ...
  provider      text NOT NULL,   -- 'anthropic' | 'openai'
  model         text NOT NULL,
  approx_tokens integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ai_usage (org_id, created_at DESC);
CREATE INDEX ON ai_usage (org_id, feature, created_at DESC);

-- Same append-only posture as audit_log: the application inserts, nothing
-- updates or deletes a usage row.
REVOKE UPDATE, DELETE ON ai_usage FROM venturelyx_app;

-- Picks up tenant_isolation automatically (org_id column present) — see
-- app.apply_tenant_rls() in 001_platform_core.sql.
CALL app.apply_tenant_rls();

COMMIT;
