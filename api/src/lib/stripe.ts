/**
 * Venturelyx :: shared Stripe client + price-by-lookup_key resolution.
 *
 * Every call site resolves a price through resolvePrice(lookupKey) —
 * never a hardcoded Stripe price id. Catalog is defined once, in
 * scripts/stripeCatalog.ts (the source of truth for what SHOULD exist in
 * Stripe); this file only reads what actually does.
 */
import Stripe from 'stripe';
import type { Querier } from './db.js';
import { stripeKeyMode } from './stripeKeyMode.js';

const secretKey = process.env.STRIPE_SECRET_KEY;
if (!secretKey) {
  console.error('FATAL: STRIPE_SECRET_KEY is not set');
  process.exit(1);
}

// Prefix-based HINT only (sk_live_/rk_live_ vs sk_test_/rk_test_) — fast and
// synchronous, but a string prefix is not something anything that WRITES to
// Stripe should ever trust on its own. Anywhere that matters (the admin
// panel's mode banner, stripeCatalog.ts's --allow-live guard) must call
// fetchAuthoritativeLiveMode() below instead, which asks Stripe itself.
export const IS_STRIPE_LIVE_MODE_HINT = stripeKeyMode(secretKey) === 'live';

export const stripe = new Stripe(secretKey, {
  apiVersion: '2026-09-30.endive', // whatever this stripe npm version was built against — see its own type error if this ever drifts
});

/** The only authoritative answer to "is this key live" — Stripe's own
 *  balance.livemode field, straight from the account the key actually
 *  belongs to. balance.retrieve() always returns exactly one object
 *  (never an empty list, unlike e.g. prices.list on a freshly-live
 *  account with nothing created yet), and read access to it is included
 *  in a Restricted key's "Full access except sensitive operations". */
export async function fetchAuthoritativeLiveMode(): Promise<boolean> {
  const balance = await stripe.balance.retrieve();
  return balance.livemode;
}

// Short-lived cache, not a correctness mechanism — a lookup_key's Stripe
// price id never changes once created (stripeCatalog.ts never recreates an
// existing lookup_key), so there is nothing to invalidate; this only saves
// a round trip on back-to-back calls in the same request burst (checkout
// resolving several line items at once).
const priceCache = new Map<string, { price: Stripe.Price; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60_000;

export async function resolvePrice(lookupKey: string): Promise<Stripe.Price> {
  const cached = priceCache.get(lookupKey);
  if (cached && cached.expiresAt > Date.now()) return cached.price;

  const result = await stripe.prices.list({ lookup_keys: [lookupKey], active: true, limit: 1 });
  const price = result.data[0];
  if (!price) {
    throw new Error(
      `No active Stripe price for lookup_key "${lookupKey}" — has ` +
      `"npm run stripe:catalog" been run against this Stripe account?`,
    );
  }
  priceCache.set(lookupKey, { price, expiresAt: Date.now() + CACHE_TTL_MS });
  return price;
}

export async function resolvePrices(lookupKeys: string[]): Promise<Stripe.Price[]> {
  return Promise.all(lookupKeys.map(resolvePrice));
}

/** Shared by routes/billing.ts (self-service checkout) and
 *  routes/growthScans.ts (admin-generated checkout) — both need "this org's
 *  Stripe customer, creating it on first use" and must not duplicate it.
 *
 * A cached id is verified, not trusted blindly: Stripe's customer
 * namespace is per-mode (test vs. live), so an id cached before a
 * test-to-live key flip never resolves again — caught live on 2026-11-05
 * when CampusPath/N&P Pools' pre-flip ids 404'd mid-checkout. Rather than
 * only recover after that failure, this checks up front and silently
 * recreates, so a stale id can never again surface as a checkout error. */
export async function getOrCreateStripeCustomer(
  q: Querier, orgId: string, orgName: string, email: string,
): Promise<string> {
  const existing = await q.one<{ stripe_customer_id: string }>(
    `SELECT stripe_customer_id FROM billing_customers WHERE org_id = $1`, [orgId],
  );
  if (existing) {
    try {
      await stripe.customers.retrieve(existing.stripe_customer_id);
      return existing.stripe_customer_id;
    } catch (err) {
      if (!(err instanceof Stripe.errors.StripeInvalidRequestError && err.code === 'resource_missing')) throw err;
      console.warn({ orgId, staleId: existing.stripe_customer_id }, 'getOrCreateStripeCustomer: cached id no longer resolves (mode mismatch?) — recreating');
    }
  }

  const customer = await stripe.customers.create({
    name: orgName,
    email,
    metadata: { org_id: orgId },
  });
  await q.exec(
    `INSERT INTO billing_customers (org_id, stripe_customer_id) VALUES ($1, $2)
     ON CONFLICT (org_id) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id`,
    [orgId, customer.id],
  );
  return customer.id;
}
