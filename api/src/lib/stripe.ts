/**
 * Venturelyx :: shared Stripe client + price-by-lookup_key resolution.
 *
 * Every call site resolves a price through resolvePrice(lookupKey) —
 * never a hardcoded Stripe price id. Catalog is defined once, in
 * scripts/stripeCatalog.ts (the source of truth for what SHOULD exist in
 * Stripe); this file only reads what actually does.
 */
import Stripe from 'stripe';

const secretKey = process.env.STRIPE_SECRET_KEY;
if (!secretKey) {
  console.error('FATAL: STRIPE_SECRET_KEY is not set');
  process.exit(1);
}

export const IS_STRIPE_LIVE_MODE = secretKey.startsWith('sk_live_');

export const stripe = new Stripe(secretKey, {
  apiVersion: '2026-09-30.endive', // whatever this stripe npm version was built against — see its own type error if this ever drifts
});

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
