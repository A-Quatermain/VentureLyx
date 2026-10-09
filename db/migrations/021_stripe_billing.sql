-- Venturelyx :: 021_stripe_billing
--
-- Three tables, one writer (api/src/routes/billing.ts's webhook handler —
-- checkout/portal never write subscription state directly, only Stripe's
-- own webhook events do, so this can never drift from what Stripe actually
-- thinks is true).
--
-- billing_customers: org_id -> stripe_customer_id. One row per org that
-- has ever started checkout, created lazily on first Checkout Session.
--
-- billing_subscriptions: current subscription state, mirrored from Stripe.
-- price_lookup_keys is an array, not a single key — a subscription can
-- carry the single-business plan OR a set of à la carte module add-ons
-- (lib/stripeCatalog.ts), never priced by Stripe price ID in application
-- code, only by the lookup_key(s) read back from Stripe at runtime.
--
-- stripe_events: every processed webhook event id, so a Stripe retry (its
-- own, or a replay from the CLI during testing) is a no-op the second time,
-- not a double-applied entitlement change.

BEGIN;

CREATE TABLE billing_customers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stripe_customer_id text NOT NULL UNIQUE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id)
);

CREATE TABLE billing_subscriptions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  stripe_subscription_id text NOT NULL UNIQUE,
  status               text NOT NULL,   -- Stripe's own subscription.status values verbatim: trialing|active|past_due|canceled|unpaid|incomplete|incomplete_expired|paused
  price_lookup_keys    text[] NOT NULL DEFAULT '{}',
  current_period_end   timestamptz,
  cancel_at            timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id)
);

CREATE TABLE stripe_events (
  stripe_event_id text PRIMARY KEY,
  event_type      text NOT NULL,
  processed_at    timestamptz NOT NULL DEFAULT now()
);
-- No org_id — a webhook event is platform-global (the customer/subscription
-- ids inside its payload are how the handler finds the right org), and this
-- table exists purely as an idempotency ledger, never queried per-tenant.
-- apply_tenant_rls() below skips any table with no org_id column, so this
-- one gets a direct platform-only policy instead.
ALTER TABLE stripe_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE stripe_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stripe_events USING (app.is_staff()) WITH CHECK (app.is_staff());

CALL app.apply_tenant_rls();

COMMIT;
