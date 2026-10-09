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
 * LOOKUP_KEY_MODULES assumption, stated plainly since it isn't fully
 * spelled out in the catalog's own pricing brief: the single-business plan
 * and every volume tier unlock the FULL module bundle (all of
 * BILLABLE_MODULES, ai_team included) — à la carte module add-ons unlock
 * only their own module. ai_team has no standalone à la carte price today,
 * so it's reachable only through the bundle. If that's wrong, this map is
 * the one place to fix it.
 */
import type { Querier } from './db.js';

export const BILLABLE_MODULES = ['operate', 'scaleseo', 'grow', 'ai_team', 'reviews'] as const;
export type BillableModule = (typeof BILLABLE_MODULES)[number];

const ALL_MODULES: BillableModule[] = [...BILLABLE_MODULES];

export const LOOKUP_KEY_MODULES: Record<string, BillableModule[]> = {
  plan_single_monthly: ALL_MODULES,
  plan_single_annual: ALL_MODULES,
  volume_tier1_monthly: ALL_MODULES,
  volume_tier1_annual: ALL_MODULES,
  volume_tier2_monthly: ALL_MODULES,
  volume_tier2_annual: ALL_MODULES,
  volume_tier3_monthly: ALL_MODULES,
  volume_tier3_annual: ALL_MODULES,
  module_scaleseo_monthly: ['scaleseo'],
  module_scaleseo_annual: ['scaleseo'],
  module_operate_monthly: ['operate'],
  module_operate_annual: ['operate'],
  module_reviews_monthly: ['reviews'],
  module_reviews_annual: ['reviews'],
  module_grow_monthly: ['grow'],
  module_grow_annual: ['grow'],
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
