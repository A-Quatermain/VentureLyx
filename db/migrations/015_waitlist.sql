-- Venturelyx :: 015_waitlist
--
-- Pre-signup interest capture from the marketing landing page (pricing
-- section, and any other "Join the waitlist" CTA) — collected before a
-- user account or organization exists, so this is deliberately NOT
-- org-scoped and does NOT go through app.apply_tenant_rls() (001/006):
-- there is no org_id to key a tenant_isolation policy on, and one shouldn't
-- exist here — a waitlist entry belongs to the platform, not a tenant.
--
-- RLS: staff-only, both directions. The public POST /v1/waitlist route
-- (api/src/routes/waitlist.ts) is unauthenticated by design (nobody has an
-- account yet), so it writes through withPlatform (lib/db.ts) — the same
-- staff-mode bypass session lookup already uses pre-auth — rather than
-- withTenant, which would have no org context to run in anyway.

BEGIN;

CREATE TABLE waitlist (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext NOT NULL,
  business_name text,
  website_url   text,
  phone         text,
  -- Free text, not an enum: "which plan or module they're interested in"
  -- is whatever the submitting CTA says (a pricing tier name today, maybe
  -- a module name from a module-section CTA later) — constraining it to a
  -- fixed list here would make adding a new CTA a migration.
  interest      text,
  source_page   text,
  status        text NOT NULL DEFAULT 'new'
                CHECK (status IN ('new', 'contacted', 'converted')),
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Idempotent on email: POST /v1/waitlist upserts ON CONFLICT (email) DO
  -- NOTHING, so a double submit (double-click, retry after a slow network)
  -- can't create duplicate rows or silently clobber a staff member's notes.
  UNIQUE (email)
);
CREATE INDEX ON waitlist (status, created_at DESC);

ALTER TABLE waitlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE waitlist FORCE ROW LEVEL SECURITY;
CREATE POLICY staff_only ON waitlist
  USING (app.is_staff())
  WITH CHECK (app.is_staff());

CREATE TRIGGER waitlist_touch BEFORE UPDATE ON waitlist
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

COMMIT;
