/**
 * Venturelyx :: pricing — single source of truth for the landing page's
 * pricing section.
 *
 * NO REAL TIERS YET. Searched docs/, the whole repo, and git history for
 * actual pricing figures ("in docs") and found none — ROADMAP.md lists
 * "Stripe billing" as backlog with "Schema placeholder only," and the only
 * dollar figures anywhere (mockups/venturelyx-command.html) are an
 * illustrative revenue-opportunity example, not a subscription price.
 * Inventing tier names/prices to fill this in would be exactly the
 * fabricated statistic the landing page rewrite was told not to ship.
 *
 * TIERS is empty on purpose. page.tsx renders a waitlist-only pricing
 * section (no tier table) whenever it's empty, so this file is where real
 * tiers get added once they exist — fill in TIERS and the honest waitlist
 * copy is replaced automatically, no page.tsx changes needed.
 */
export interface PricingTier {
  key: string;
  name: string;
  price: string;
  cadence: string;
  description: string;
  features: string[];
  featured?: boolean;
}

// CTAs read "Join the waitlist" everywhere, not "Subscribe" or "Buy now" —
// Stripe isn't wired up. Do not change this until billing actually exists.
export const PRICING_CTA_LABEL = 'Join the waitlist';

export const TIERS: PricingTier[] = [];
