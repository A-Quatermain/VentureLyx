/**
 * Venturelyx :: Stripe key live/test detection — one place every prefix
 * check agrees with (lib/stripe.ts's IS_STRIPE_LIVE_MODE,
 * scripts/stripeCatalog.ts's live-key guard, routes/adminBilling.ts's
 * masked key status).
 *
 * A Restricted key (rk_live_.../rk_test_...) is still a real secret key for
 * this purpose — Stripe's "Full access except sensitive operations" key
 * type, not a different mode from a Standard key (sk_). Checking only
 * sk_live_ would misreport an rk_live_ account as test mode.
 */
export function stripeKeyMode(value: string | undefined | null): 'live' | 'test' | null {
  if (!value) return null;
  if (/^(sk|rk|pk)_live_/.test(value)) return 'live';
  if (/^(sk|rk|pk)_test_/.test(value)) return 'test';
  return null;
}
