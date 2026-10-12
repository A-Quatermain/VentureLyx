-- Venturelyx :: 024_growth_scan_intake_fields
--
-- Two small additions 023 missed: the intake form needs its own bearer
-- token (created at "approve for intake" time, before any business data
-- exists to key off), and resend-payment-link needs the checkout URL
-- stored directly rather than re-fetching it from Stripe on every resend
-- (Stripe Checkout Session urls are only guaranteed valid for the life of
-- the session object itself, which this already tracks by id).

BEGIN;

ALTER TABLE deal_intakes
  ADD COLUMN intake_token_hash text,
  ADD COLUMN intake_token_expires_at timestamptz;
CREATE UNIQUE INDEX ON deal_intakes (intake_token_hash) WHERE intake_token_hash IS NOT NULL;

ALTER TABLE deal_checkout_sessions
  ADD COLUMN checkout_url text;

COMMIT;
