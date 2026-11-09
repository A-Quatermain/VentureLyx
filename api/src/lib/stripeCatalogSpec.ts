/**
 * Venturelyx :: Stripe catalog spec — pure data, zero side effects.
 *
 * Split out of scripts/stripeCatalog.ts so this can be imported from a
 * long-lived process (routes/adminBilling.ts's catalog-check) without
 * pulling in that script's top-level guards, which call process.exit(1)
 * outright (missing secret key, or a live key without --allow-live) —
 * exactly the kind of code that must never execute as a side effect of
 * importing one constant into the API server.
 *
 * v2 catalog, four plans — see scripts/stripeCatalog.ts's own header for
 * the full pricing rationale; this file is just the CATALOG table itself,
 * unchanged by the split.
 */

export interface PriceSpec {
  lookupKey: string;
  unitAmountCents: number;
  interval?: 'month'; // omitted => one-time price (used for setup fees)
}

export interface ProductSpec {
  productKey: string;
  productName: string;
  description: string;
  prices: PriceSpec[];
}

export const CATALOG: ProductSpec[] = [
  {
    productKey: 'platform',
    productName: 'Venturelyx — Platform',
    description: 'The Venturelyx Command Center for one business.',
    prices: [{ lookupKey: 'platform_monthly', unitAmountCents: 12_900, interval: 'month' }],
  },
  {
    productKey: 'growth_partner',
    productName: 'Venturelyx — Growth Partner',
    description: 'Platform plus ScaleSEO and Reviews, managed growth support.',
    prices: [{ lookupKey: 'growth_partner_monthly', unitAmountCents: 34_900, interval: 'month' }],
  },
  {
    productKey: 'launch_growth',
    productName: 'Venturelyx — Launch & Growth',
    description: 'The full white-glove build-and-grow engagement, every module.',
    prices: [
      { lookupKey: 'launch_growth_setup', unitAmountCents: 75_000 },
      { lookupKey: 'launch_growth_monthly', unitAmountCents: 49_900, interval: 'month' },
    ],
  },
  {
    productKey: 'founding',
    productName: 'Venturelyx — Founding Business',
    description: 'Launch & Growth at the limited-time founding rate for the first 12 months.',
    prices: [
      { lookupKey: 'founding_setup', unitAmountCents: 75_000 },
      { lookupKey: 'founding_monthly', unitAmountCents: 39_900, interval: 'month' },
    ],
  },
];
