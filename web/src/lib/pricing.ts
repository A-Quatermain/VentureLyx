/**
 * Venturelyx :: pricing — single source of truth for the landing page's
 * pricing section.
 *
 * Four real tiers (replaces the earlier empty-TIERS/"waitlist only"
 * placeholder — see git history for that version's own reasoning, which
 * no longer applies now that real pricing exists). Platform is the only
 * self-service tier (ctaHref -> /register); the other three are sales-
 * assisted and route through the Free Growth Scan lead-gen funnel instead
 * of straight to Stripe — nobody reaches a $750 checkout without a staff
 * member generating it first (see routes/growthScans.ts).
 */
export interface PricingTier {
  key: string;
  name: string;
  price: string;
  cadence: string;
  setupFee?: string;
  description: string;
  features: string[];
  ctaLabel: string;
  ctaHref: string;
  featured?: boolean;
}

export const TIERS: PricingTier[] = [
  {
    key: 'platform',
    name: 'Platform',
    price: '$129',
    cadence: 'mo',
    description: 'The Command Center for one business, self-serve.',
    features: ['Operate: CRM, scheduling, quotes & invoices', 'Command Center dashboard', 'Self-service signup'],
    ctaLabel: 'Get started',
    ctaHref: '/get-started',
  },
  {
    key: 'growth_partner',
    name: 'Growth Partner',
    price: '$349',
    cadence: 'mo',
    description: 'Platform plus managed SEO and reputation growth.',
    features: ['Everything in Platform', 'ScaleSEO: crawl, rank tracking, content', 'Reviews: request & response automation'],
    ctaLabel: 'Get your free Growth Scan',
    ctaHref: '/growth-scan',
  },
  {
    key: 'launch_growth',
    name: 'Launch & Growth',
    price: '$499',
    cadence: 'mo',
    setupFee: '$750 setup',
    description: 'The full white-glove build-and-grow engagement.',
    features: ['Every module, including Grow and AI Team', 'Dedicated onboarding', 'Full-service setup'],
    ctaLabel: 'Get your free Growth Scan',
    ctaHref: '/growth-scan',
    featured: true,
  },
  {
    key: 'founding',
    name: 'Founding Business',
    price: '$399',
    cadence: 'mo for 12 months',
    setupFee: '$750 setup',
    description: 'Launch & Growth at a limited-time founding rate.',
    features: ['Everything in Launch & Growth', 'Founding-member rate for your first year', 'Reverts to standard Launch & Growth pricing after'],
    ctaLabel: 'Get your free Growth Scan',
    ctaHref: '/growth-scan',
  },
];
