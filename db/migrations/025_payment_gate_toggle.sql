-- Venturelyx :: 025_payment_gate_toggle
--
-- Administrative kill switch for the payment-enforcement gate
-- (plugins/context.ts's requireProvisioned) — turned OFF by default per
-- explicit instruction: until venturelyx.com is fully functional and every
-- module works end to end, no org should be locked out of anything for
-- not having paid. Everything underneath (Stripe catalog, checkout,
-- webhooks, org conversion) stays fully built and functional; only the
-- enforcement itself is suspended. Flip payment_gate_enabled back to true
-- (platform_settings) whenever the platform is ready, no redeploy needed.

BEGIN;

INSERT INTO platform_settings (key, value) VALUES
  ('payment_gate_enabled', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;
