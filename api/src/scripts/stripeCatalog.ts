/**
 * Venturelyx :: Stripe catalog setup.
 *
 *   npx tsx src/scripts/stripeCatalog.ts
 *
 * Idempotent: safe to re-run. Finds-or-creates each Product (matched on
 * metadata.product_key, not name) and each Price (matched on lookup_key —
 * never by amount or id). A price's amount is immutable once created, so if
 * a price for a lookup_key already exists, this script leaves it alone and
 * WARNS if its amount no longer matches CATALOG below, rather than silently
 * creating a second price. Application code never hardcodes a Stripe price
 * id — every call site resolves one of the lookup_keys below through
 * lib/stripe.ts's resolvePrice(), read from Stripe at request time.
 *
 * v2 catalog (this file replaces the old $279/mo single-plan + à la carte
 * add-on + volume-tier model wholesale — nothing in OLD_PRODUCT_KEYS below
 * is kept side by side with the new one; see the chat response this
 * shipped with for why that's safe: nothing was ever live). Four plans:
 *
 *   platform        $129/mo,  no setup fee
 *   growth_partner   $349/mo,  no setup fee
 *   launch_growth    $750 one-time setup + $499/mo
 *   founding         $750 one-time setup + $399/mo for the first 12 months,
 *                     then reverts to launch_growth's own $499/mo price —
 *                     literally the same price object, not a duplicate.
 *                     The revert is implemented as a Stripe Subscription
 *                     Schedule with two phases, built at checkout time
 *                     (routes/growthScans.ts), not here — this script only
 *                     creates the two flat prices founding needs.
 *
 * Refuses to run against a live secret key (sk_live_...) — test mode only
 * until the person running this explicitly passes --allow-live.
 */
import Stripe from 'stripe';
import { CATALOG, type ProductSpec, type PriceSpec } from '../lib/stripeCatalogSpec.js';
import { stripeKeyMode } from '../lib/stripeKeyMode.js';

const secretKey = process.env.STRIPE_SECRET_KEY;
if (!secretKey) {
  console.error('FATAL: STRIPE_SECRET_KEY is not set');
  process.exit(1);
}

const stripe = new Stripe(secretKey);

// Prefix (sk_live_/rk_live_ vs sk_test_/rk_test_) is only a hint, logged for
// a fast heads-up — the real gate below asks Stripe itself via
// balance.retrieve().livemode. A string prefix is not something that gets
// to decide whether this script is allowed to write to a real Stripe
// account; only Stripe's own answer does.
const prefixHint = stripeKeyMode(secretKey);

/** Authoritative — see lib/stripe.ts's fetchAuthoritativeLiveMode() for why
 *  this doesn't just reuse that export: this script intentionally keeps its
 *  own Stripe client (this file's own header explains why) rather than
 *  importing lib/stripe.ts, which has its own top-level side effects. */
async function isLiveAccount(): Promise<boolean> {
  const balance = await stripe.balance.retrieve();
  return balance.livemode;
}

// Every product/lookup_key from the v2 catalog this one replaces. Deactivated,
// not deleted — Stripe doesn't allow deleting a Price or a Product that has
// ever had a Price, and deactivating is the documented way to retire one.
// Existing (test-mode only, never real) subscriptions on these keep working
// until they're canceled; nothing new can be priced against them again.
const OLD_LOOKUP_KEYS = [
  'plan_single_monthly', 'plan_single_annual',
  'volume_tier1_monthly', 'volume_tier1_annual',
  'volume_tier2_monthly', 'volume_tier2_annual',
  'volume_tier3_monthly', 'volume_tier3_annual',
  'module_scaleseo_monthly', 'module_scaleseo_annual',
  'module_operate_monthly', 'module_operate_annual',
  'module_reviews_monthly', 'module_reviews_annual',
  'module_grow_monthly', 'module_grow_annual',
];
const OLD_PRODUCT_KEYS = ['plan_single', 'volume_tier', 'module_scaleseo', 'module_operate', 'module_reviews', 'module_grow'];

async function findOrCreateProduct(spec: ProductSpec): Promise<Stripe.Product> {
  const existing = await stripe.products.list({ active: true, limit: 100 });
  const match = existing.data.find((p) => p.metadata.product_key === spec.productKey);
  if (match) return match;

  return stripe.products.create({
    name: spec.productName,
    description: spec.description,
    metadata: { product_key: spec.productKey },
  });
}

async function findOrCreatePrice(product: Stripe.Product, spec: PriceSpec): Promise<void> {
  const existing = await stripe.prices.list({ lookup_keys: [spec.lookupKey], limit: 1 });
  const current = existing.data[0];

  if (current) {
    if (current.unit_amount !== spec.unitAmountCents || current.currency !== 'usd') {
      console.warn(
        `WARN  ${spec.lookupKey}: existing price is ${current.currency} ${current.unit_amount} ` +
        `but CATALOG now says usd ${spec.unitAmountCents}. Prices are immutable in Stripe — ` +
        `this script will NOT change it. Create a new price under a new lookup_key to reprice.`,
      );
    } else {
      console.log(`ok    ${spec.lookupKey} (unchanged, usd ${spec.unitAmountCents}${spec.interval ? `/${spec.interval}` : ' one-time'})`);
    }
    return;
  }

  const created = await stripe.prices.create({
    product: product.id,
    currency: 'usd',
    unit_amount: spec.unitAmountCents,
    ...(spec.interval ? { recurring: { interval: spec.interval } } : {}),
    lookup_key: spec.lookupKey,
  });
  console.log(`new   ${spec.lookupKey} -> ${created.id} (usd ${spec.unitAmountCents}${spec.interval ? `/${spec.interval}` : ' one-time'})`);
}

async function deactivateOldCatalog(): Promise<void> {
  console.log('Deactivating v1 catalog (plan_single / volume_tier / module_* — never had a live subscriber)...\n');

  for (let i = 0; i < OLD_LOOKUP_KEYS.length; i += 10) {
    const batch = OLD_LOOKUP_KEYS.slice(i, i + 10);
    const prices = await stripe.prices.list({ lookup_keys: batch, active: true, limit: 100 });
    for (const price of prices.data) {
      await stripe.prices.update(price.id, { active: false });
      console.log(`  deactivated price ${price.lookup_key} (${price.id})`);
    }
  }

  const products = await stripe.products.list({ active: true, limit: 100 });
  for (const product of products.data) {
    if (OLD_PRODUCT_KEYS.includes(product.metadata.product_key ?? '')) {
      await stripe.products.update(product.id, { active: false });
      console.log(`  deactivated product ${product.metadata.product_key} (${product.id})`);
    }
  }
  console.log('');
}

async function main() {
  const live = await isLiveAccount();
  if ((prefixHint === 'live') !== live) {
    console.warn(
      `WARN  key prefix looked like "${prefixHint ?? 'unrecognized'}" but Stripe's own ` +
      `balance.retrieve().livemode says ${live} — trusting Stripe, not the prefix.`,
    );
  }
  if (live && !process.argv.includes('--allow-live')) {
    console.error(
      'FATAL: Stripe reports this key is LIVE (balance.retrieve().livemode === true). This ' +
      'script is test-mode only until explicitly told otherwise — re-run with --allow-live if that is really intended.',
    );
    process.exit(1);
  }

  console.log(`Stripe catalog setup — ${live ? 'LIVE MODE' : 'test mode'} (confirmed via Stripe's own livemode field)\n`);

  if (!process.argv.includes('--skip-deactivate')) {
    await deactivateOldCatalog();
  }

  for (const productSpec of CATALOG) {
    const product = await findOrCreateProduct(productSpec);
    console.log(`product ${productSpec.productKey} -> ${product.id}`);
    for (const priceSpec of productSpec.prices) {
      await findOrCreatePrice(product, priceSpec);
    }
    console.log('');
  }

  console.log('Reading the full catalog back by lookup_key (what application code will actually see):\n');
  const allKeys = CATALOG.flatMap((p) => p.prices.map((pr) => pr.lookupKey));
  for (let i = 0; i < allKeys.length; i += 10) {
    const batch = allKeys.slice(i, i + 10);
    const prices = await stripe.prices.list({ lookup_keys: batch, limit: 100 });
    for (const key of batch) {
      const p = prices.data.find((x) => x.lookup_key === key);
      console.log(p
        ? `  ${key.padEnd(24)} ${p.id}  usd ${((p.unit_amount ?? 0) / 100).toFixed(2)}${p.recurring ? `/${p.recurring.interval}` : ' one-time'}`
        : `  ${key.padEnd(24)} MISSING`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
