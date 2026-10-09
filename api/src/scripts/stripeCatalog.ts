/**
 * Venturelyx :: Stripe catalog setup.
 *
 *   npx tsx src/scripts/stripeCatalog.ts
 *
 * Idempotent: safe to re-run. Finds-or-creates each Product (matched on
 * metadata.product_key, not name — a product can be renamed in the
 * Dashboard without this script losing track of it) and each Price
 * (matched on lookup_key, Stripe's own documented mechanism for exactly
 * this — never by amount or id). A price's amount is immutable once
 * created (Stripe doesn't allow editing it), so if a price for a
 * lookup_key already exists, this script leaves it alone and WARNS if its
 * amount no longer matches CATALOG below, rather than silently creating a
 * second price or pretending the drift isn't real. Application code never
 * hardcodes a Stripe price id — every call site resolves one of the
 * lookup_keys below through lib/stripeCatalog.ts's resolvePrice(), read
 * from Stripe at request time.
 *
 * Refuses to run against a live secret key (sk_live_...) — test mode only
 * until the person running this explicitly passes --allow-live. That flag
 * is not a suggestion to flip casually: every price in CATALOG becomes a
 * real, billable Stripe object the moment this runs live.
 */
import Stripe from 'stripe';

const secretKey = process.env.STRIPE_SECRET_KEY;
if (!secretKey) {
  console.error('FATAL: STRIPE_SECRET_KEY is not set');
  process.exit(1);
}
if (secretKey.startsWith('sk_live_') && !process.argv.includes('--allow-live')) {
  console.error(
    'FATAL: STRIPE_SECRET_KEY looks like a LIVE key. This script is test-mode only until ' +
    'explicitly told otherwise — re-run with --allow-live if that is really intended.',
  );
  process.exit(1);
}

const stripe = new Stripe(secretKey);

interface PriceSpec {
  lookupKey: string;
  unitAmountCents: number;
  interval: 'month' | 'year';
}

interface ProductSpec {
  productKey: string;
  productName: string;
  description: string;
  prices: PriceSpec[];
}

// All amounts in whole US cents. Annual = 10x monthly (two months free),
// per the brief — computed here, not independently re-typed, so a monthly
// price change can't silently drift from its own annual counterpart.
function monthlyAndAnnual(productKey: string, monthlyCents: number): PriceSpec[] {
  return [
    { lookupKey: `${productKey}_monthly`, unitAmountCents: monthlyCents, interval: 'month' },
    { lookupKey: `${productKey}_annual`, unitAmountCents: monthlyCents * 10, interval: 'year' },
  ];
}

export const CATALOG: ProductSpec[] = [
  {
    productKey: 'plan_single',
    productName: 'Venturelyx — Single Business Plan',
    description: 'Every module, one business.',
    prices: monthlyAndAnnual('plan_single', 27_900),
  },
  {
    productKey: 'module_scaleseo',
    productName: 'Venturelyx — ScaleSEO add-on',
    description: 'À la carte ScaleSEO module.',
    prices: monthlyAndAnnual('module_scaleseo', 9_900),
  },
  {
    productKey: 'module_operate',
    productName: 'Venturelyx — Operate add-on',
    description: 'À la carte Operate module.',
    prices: monthlyAndAnnual('module_operate', 8_900),
  },
  {
    productKey: 'module_reviews',
    productName: 'Venturelyx — Reviews add-on',
    description: 'À la carte Reviews module.',
    prices: monthlyAndAnnual('module_reviews', 4_900),
  },
  {
    productKey: 'module_grow',
    productName: 'Venturelyx — Grow add-on',
    description: 'À la carte Grow module.',
    prices: monthlyAndAnnual('module_grow', 7_900),
  },
  {
    // One product, three tier prices — not three products — since these are
    // one purchasable concept ("this business's seat, priced by how many
    // businesses the owner already has") rather than three different
    // things. lib/stripeCatalog.ts's volume tier resolver picks which of
    // the three lookup_keys applies from the owner's current org count.
    productKey: 'volume_tier',
    productName: 'Venturelyx — Additional Business',
    description: 'Per-business pricing for an owner running more than one Venturelyx business.',
    prices: [
      ...monthlyAndAnnual('volume_tier1', 22_900), // 2-4 businesses
      ...monthlyAndAnnual('volume_tier2', 18_900), // 5-9 businesses
      ...monthlyAndAnnual('volume_tier3', 14_900), // 10+ businesses
    ],
  },
];

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
        `this script will NOT change it. To actually reprice, create a new price under a new ` +
        `lookup_key and migrate subscriptions deliberately, or retire this lookup_key and mint a ` +
        `replacement by hand.`,
      );
    } else {
      console.log(`ok    ${spec.lookupKey} (unchanged, usd ${spec.unitAmountCents}/${spec.interval})`);
    }
    return;
  }

  const created = await stripe.prices.create({
    product: product.id,
    currency: 'usd',
    unit_amount: spec.unitAmountCents,
    recurring: { interval: spec.interval },
    lookup_key: spec.lookupKey,
  });
  console.log(`new   ${spec.lookupKey} -> ${created.id} (usd ${spec.unitAmountCents}/${spec.interval})`);
}

async function main() {
  console.log(`Stripe catalog setup — ${secretKey!.startsWith('sk_live_') ? 'LIVE MODE' : 'test mode'}\n`);
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
  // Stripe's list endpoint caps lookup_keys at 10 per call.
  for (let i = 0; i < allKeys.length; i += 10) {
    const batch = allKeys.slice(i, i + 10);
    const prices = await stripe.prices.list({ lookup_keys: batch, limit: 100 });
    for (const key of batch) {
      const p = prices.data.find((x) => x.lookup_key === key);
      console.log(p
        ? `  ${key.padEnd(24)} ${p.id}  usd ${((p.unit_amount ?? 0) / 100).toFixed(2)}/${p.recurring?.interval}`
        : `  ${key.padEnd(24)} MISSING`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
