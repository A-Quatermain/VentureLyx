/**
 * Venturelyx :: subscription -> organizations.modules entitlements.
 *
 * The webhook (routes/billing.ts) is the ONLY writer of this mapping —
 * checkout and portal never touch organizations.modules directly, only
 * Stripe's own events, applied here, do. That's what keeps entitlements
 * from ever drifting out of sync with what Stripe actually thinks the
 * customer is paying for.
 *
 * BILLABLE_MODULES is every module key a Stripe price can grant — not the
 * full MODULE_KEYS list in routes/admin.ts, which also includes 'build'
 * and 'source' (not live yet, nothing to sell). A module outside this set
 * is untouched by billing entirely and keeps moduleAccess.ts's existing
 * "missing key = enabled" default.
 *
 * LOOKUP_KEY_MODULES, v2 catalog (4 tiers, confirmed): Platform is the
 * entry tier (Operate only). Growth Partner adds the two named growth
 * surfaces (ScaleSEO, Reviews). Launch & Growth and Founding Business are
 * both the full white-glove bundle, every module including Grow and AI
 * Team — Founding is priced differently (scripts/stripeCatalog.ts /
 * routes/growthScans.ts's Subscription Schedule), never featured
 * differently. Only recurring lookup_keys appear here: a one-time setup-fee
 * price (launch_growth_setup, founding_setup) is billed as an invoice item
 * alongside checkout, never as a subscription item, so it never shows up in
 * sub.items.data and has nothing to map.
 */
import type { Querier } from './db.js';

export const BILLABLE_MODULES = ['operate', 'scaleseo', 'grow', 'ai_team', 'reviews'] as const;
export type BillableModule = (typeof BILLABLE_MODULES)[number];

const ALL_MODULES: BillableModule[] = [...BILLABLE_MODULES];

export const LOOKUP_KEY_MODULES: Record<string, BillableModule[]> = {
  platform_monthly: ['operate'],
  growth_partner_monthly: ['operate', 'scaleseo', 'reviews'],
  launch_growth_monthly: ALL_MODULES,
  founding_monthly: ALL_MODULES,
};

export function modulesForLookupKeys(lookupKeys: string[]): Set<BillableModule> {
  const unlocked = new Set<BillableModule>();
  for (const key of lookupKeys) {
    for (const m of LOOKUP_KEY_MODULES[key] ?? []) unlocked.add(m);
  }
  return unlocked;
}

// Statuses that actually grant access. 'past_due' is deliberately included
// — the brief's own grace-period rule: a failed card shows a banner, it
// does not lock anything. 'trialing' (unused today, no trial configured in
// the catalog, but cost nothing to handle correctly if one is added later)
// also grants access. Everything else (canceled, unpaid, incomplete,
// incomplete_expired, paused) does not.
const ACCESS_GRANTING_STATUSES = new Set(['active', 'trialing', 'past_due']);

/**
 * Sets organizations.modules to exactly what this subscription's current
 * status + line items say it should be — every billable module explicitly
 * true or false, never left to the "missing key = enabled" default once an
 * org has a subscription at all. Idempotent: safe to call on every webhook
 * event for this subscription, not just transitions.
 */
export async function syncEntitlements(
  q: Querier, orgId: string, status: string, lookupKeys: string[],
): Promise<void> {
  const unlocked = ACCESS_GRANTING_STATUSES.has(status) ? modulesForLookupKeys(lookupKeys) : new Set<BillableModule>();

  const row = await q.one<{ modules: Record<string, boolean> | null }>(
    `SELECT modules FROM organizations WHERE id = $1`, [orgId],
  );
  const current = row?.modules ?? {};
  const next = { ...current };
  for (const m of BILLABLE_MODULES) {
    next[m] = unlocked.has(m);
  }

  await q.exec(`UPDATE organizations SET modules = $2, updated_at = now() WHERE id = $1`, [orgId, JSON.stringify(next)]);
}
