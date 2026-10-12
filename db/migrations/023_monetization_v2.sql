-- Venturelyx :: 023_monetization_v2
--
-- Three-tier pricing + Founding Business offer, the Growth Scan prospect
-- funnel, and client intake/payment-gate state. Deliberately minimal:
-- reuses the existing parties/deals/pipelines CRM and organizations.status
-- rather than building a parallel lead system (see the chat response this
-- shipped with for the full design rationale).
--
-- organizations.status stays coarse: 'prospect' covers every pre-payment
-- substage (new scan through payment_pending); 'onboarding'/'active' only
-- apply once a deal is actually paid. The granular substage
-- (new_scan -> ... -> paid -> onboarding -> active_customer) lives in
-- deals.stage against a new "Growth Scan Funnel" pipeline, seeded below —
-- no schema change needed there, pipelines.stages is already jsonb.
--
-- prospect_archived_at marks a stale lead dormant without deleting
-- anything: scan history, deal history, and the organization row itself
-- all survive. Nulling it restores the lead to the active leads view.

BEGIN;

ALTER TABLE organizations ADD COLUMN prospect_archived_at timestamptz;
CREATE INDEX ON organizations (status) WHERE prospect_archived_at IS NULL;

-- -----------------------------------------------------------------------------
-- Client intake. One row per deal, collected only after staff approve a
-- prospect for intake (or, for the self-service Platform plan, immediately).
-- Deliberately no credentials/access fields — those are collected
-- separately during onboarding, never here.
-- -----------------------------------------------------------------------------
CREATE TABLE deal_intakes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  deal_id           uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  business_name     text,
  primary_contact   text,
  contact_email     citext,
  phone             text,
  website_url       text,
  address_line1     text,
  address_line2     text,
  city              text,
  region            text,
  postal_code       text,
  service_area      text,
  business_category text,
  main_services     text,
  current_crm       text,
  website_platform  text,
  gbp_status        text,
  social_accounts   text,
  primary_goals     text,
  biggest_problem   text,
  preferred_onboarding_date date,
  submitted_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deal_id)
);

-- -----------------------------------------------------------------------------
-- Admin-generated Stripe Checkout Sessions for a deal. The amounts here are
-- the server-trusted, admin-approved numbers — Stripe Checkout is created
-- FROM these, never from anything a browser submits. This is also what
-- makes Create/Regenerate/Resend/View Status possible without re-trusting
-- client input on every click.
-- -----------------------------------------------------------------------------
CREATE TABLE deal_checkout_sessions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  deal_id                   uuid NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  plan_key                  text NOT NULL,   -- 'platform'|'growth_partner'|'launch_growth'|'founding'
  setup_fee_cents           int NOT NULL DEFAULT 0,
  monthly_cents             int NOT NULL,
  stripe_checkout_session_id text,
  stripe_subscription_id    text,
  status                    text NOT NULL DEFAULT 'open',  -- open|completed|expired|canceled
  created_by                uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  completed_at              timestamptz,
  expires_at                timestamptz
);
CREATE INDEX ON deal_checkout_sessions (deal_id, created_at DESC);
CREATE UNIQUE INDEX ON deal_checkout_sessions (stripe_checkout_session_id) WHERE stripe_checkout_session_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Platform-wide admin settings. Operational toggles only — dollar amounts
-- stay sourced from Stripe via lookup_key (lib/stripe.ts's own rule), never
-- duplicated here as numbers that could drift from what Stripe actually
-- charges. No org_id: this is platform-global, staff-only in both
-- directions, same shape as stripe_events/waitlist (migrations 021/015).
-- -----------------------------------------------------------------------------
CREATE TABLE platform_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE platform_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform_settings USING (app.is_staff()) WITH CHECK (app.is_staff());

INSERT INTO platform_settings (key, value) VALUES
  ('founding_business_offer_enabled', 'true'::jsonb),
  ('self_service_requires_approval', 'false'::jsonb),
  ('stale_prospect_days', '90'::jsonb);

-- -----------------------------------------------------------------------------
-- The Growth Scan Funnel pipeline. Reuses the existing deals/pipelines
-- tables verbatim — this is data, not a schema change. is_default stays
-- false: this pipeline is specifically for scan-sourced leads, not the
-- general-purpose default a staff member gets when creating an ad hoc deal.
-- -----------------------------------------------------------------------------
INSERT INTO pipelines (id, org_id, name, stages, is_default)
SELECT gen_random_uuid(), o.id, 'Growth Scan Funnel',
  '[
    {"key":"new_scan","label":"New Scan","probability":5,"is_won":false,"is_lost":false},
    {"key":"active_prospect","label":"Active Prospect","probability":10,"is_won":false,"is_lost":false},
    {"key":"growth_review","label":"Growth Review","probability":25,"is_won":false,"is_lost":false},
    {"key":"proposal","label":"Proposal","probability":40,"is_won":false,"is_lost":false},
    {"key":"approved_for_intake","label":"Approved for Intake","probability":60,"is_won":false,"is_lost":false},
    {"key":"intake_started","label":"Intake Started","probability":70,"is_won":false,"is_lost":false},
    {"key":"payment_pending","label":"Payment Pending","probability":85,"is_won":false,"is_lost":false},
    {"key":"paid","label":"Paid","probability":95,"is_won":false,"is_lost":false},
    {"key":"onboarding","label":"Onboarding","probability":98,"is_won":false,"is_lost":false},
    {"key":"active_customer","label":"Active Customer","probability":100,"is_won":true,"is_lost":false}
  ]'::jsonb,
  false
FROM organizations o
WHERE NOT EXISTS (SELECT 1 FROM pipelines p WHERE p.org_id = o.id AND p.name = 'Growth Scan Funnel');

COMMIT;

-- deal_intakes/deal_checkout_sessions have org_id, so apply_tenant_rls()
-- below gives them the standard tenant_isolation policy automatically —
-- org members + staff, exactly right for both: the prospect themselves has
-- no membership yet (see the chat response's "no user/membership for
-- anonymous scan submissions" decision), so pre-conversion these are only
-- ever reached through staff/platform routes anyway.
BEGIN;
CALL app.apply_tenant_rls();

CREATE TRIGGER deal_intakes_touch BEFORE UPDATE ON deal_intakes
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
COMMIT;
