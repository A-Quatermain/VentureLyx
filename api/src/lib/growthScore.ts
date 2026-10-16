/**
 * Venturelyx :: Command Center Growth Score.
 *
 * Replaces the bug this exists to fix: the Growth Score tile in
 * web/src/app/(app)/home/page.tsx used to render summary.seo.health
 * directly — identical to the SEO Score tile right next to it, with no
 * reputation or sales signal in it at all. This blends three sub-scores
 * (0-100 each): Visibility (ScaleSEO), Reputation (Reviews), Sales
 * (Operate) — see routes/data.ts's GET /command/summary for where the
 * raw inputs are queried.
 *
 * Module-aware: a dimension is included only if its module is enabled
 * for the org (organizations.modules — missing key means enabled, same
 * rule as lib/moduleAccess.ts). The 0.30/0.30/0.40 composite weights
 * renormalize across whichever dimensions are included, so an org
 * without e.g. the Reviews module isn't penalized for a module it
 * doesn't have. A module that IS enabled but has no data yet (e.g.
 * Reviews on, zero reviews) is NOT excluded — it's a real, low score
 * that should drag the composite down, same as it would for a human
 * looking at an empty Reviews tab.
 */

export type ModuleMap = Record<string, boolean> | null;

export const moduleEnabled = (modules: ModuleMap, key: string): boolean => modules?.[key] !== false;

export interface GrowthScoreInputs {
  modules: ModuleMap;

  // Visibility (ScaleSEO)
  seoHealth: number | null;         // seo_scores.health for the primary site, null if no score exists yet
  marketTargetsTotal: number;       // count of market_targets rows for this org
  marketTargetsInTop20: number;     // of those, current_position <= 20
  gbpConnected: boolean;

  // Reputation (Reviews)
  reviewCount: number;
  avgRating: number | null;         // 0-5
  reviewsLast90d: number;
  repliedCount: number;             // response_status = 'published'

  // Sales / momentum (Operate)
  thisMonthRevenue: number;
  lastMonthRevenue: number;
  newLeads30d: number;
  dealsTotal: number;
  dealsWon: number;
  invoicedTotal: number;
  invoicedPaid: number;
}

export interface GrowthScoreResult {
  score: number | null;        // null => "—", not enough data anywhere to say
  visibility: number | null;   // null only when the ScaleSEO module itself is disabled
  reputation: number | null;   // null only when the Reviews module itself is disabled
  sales: number | null;        // null only when the Operate module itself is disabled
}

interface WeightedPart { weight: number; value: number }

/** Weighted mean, renormalized over whichever parts are actually present —
 *  the same "divide by the weights you actually used" rule the brief asks
 *  for at both the sub-score level (e.g. Visibility missing seo_health)
 *  and the composite level (a dimension excluded by its module toggle). */
function weightedAvg(parts: WeightedPart[]): number | null {
  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0);
  if (totalWeight <= 0) return null;
  const sum = parts.reduce((s, p) => s + p.weight * p.value, 0);
  return sum / totalWeight;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

export function computeGrowthScore(inputs: GrowthScoreInputs): GrowthScoreResult {
  const includeVisibility = moduleEnabled(inputs.modules, 'scaleseo');
  const includeReputation = moduleEnabled(inputs.modules, 'reviews');
  const includeSales = moduleEnabled(inputs.modules, 'operate');

  // --- Visibility: can customers find them -------------------------------
  let visibility: number | null = null;
  let visibilityHasData = false;
  if (includeVisibility) {
    const parts: WeightedPart[] = [];
    if (inputs.seoHealth != null) {
      parts.push({ weight: 0.60, value: inputs.seoHealth });
      visibilityHasData = true;
    }
    if (inputs.marketTargetsTotal > 0) {
      parts.push({ weight: 0.25, value: (inputs.marketTargetsInTop20 / inputs.marketTargetsTotal) * 100 });
      visibilityHasData = true;
    }
    // Whether Google Business is connected is always a real, computable
    // answer (yes or no) — never "missing data" the way a never-run SEO
    // scan is, so this weight is always present.
    parts.push({ weight: 0.15, value: inputs.gbpConnected ? 100 : 0 });
    visibility = weightedAvg(parts);
  }

  // --- Reputation: do they look trustworthy -------------------------------
  let reputation: number | null = null;
  let reputationHasData = false;
  if (includeReputation) {
    const hasReviews = inputs.reviewCount > 0;
    const volume = Math.min(inputs.reviewCount / 20, 1) * 100;
    const rating = hasReviews ? (inputs.avgRating ?? 0) / 5 * 100 : 0;
    const recency = Math.min(inputs.reviewsLast90d / 5, 1) * 100;
    const response = hasReviews ? (inputs.repliedCount / inputs.reviewCount) * 100 : 0;
    reputation = 0.40 * volume + 0.30 * rating + 0.20 * recency + 0.10 * response;
    reputationHasData = hasReviews;
  }

  // --- Sales / momentum: is the business actually growing -----------------
  let sales: number | null = null;
  let salesHasData = false;
  if (includeSales) {
    const revenueTrend = inputs.lastMonthRevenue > 0
      ? clamp(inputs.thisMonthRevenue / inputs.lastMonthRevenue, 0, 1.5) / 1.5 * 100
      : (inputs.thisMonthRevenue > 0 ? 70 : 0);
    const leadFlow = Math.min(inputs.newLeads30d / 20, 1) * 100;
    const conversion = inputs.dealsTotal > 0 ? (inputs.dealsWon / inputs.dealsTotal) * 100 : 0;

    const parts: WeightedPart[] = [
      { weight: 0.40, value: revenueTrend },
      { weight: 0.20, value: leadFlow },
      { weight: 0.25, value: conversion },
    ];
    if (inputs.invoicedTotal > 0) {
      parts.push({ weight: 0.15, value: (inputs.invoicedPaid / inputs.invoicedTotal) * 100 });
    }
    sales = weightedAvg(parts);
    salesHasData = inputs.thisMonthRevenue > 0 || inputs.lastMonthRevenue > 0
      || inputs.newLeads30d > 0 || inputs.dealsTotal > 0 || inputs.invoicedTotal > 0;
  }

  // --- Composite -----------------------------------------------------------
  const compositeParts: WeightedPart[] = [];
  if (visibility != null) compositeParts.push({ weight: 0.30, value: visibility });
  if (reputation != null) compositeParts.push({ weight: 0.30, value: reputation });
  if (sales != null) compositeParts.push({ weight: 0.40, value: sales });

  // Not "every included dimension happens to compute to a low number" —
  // specifically whether there's any real underlying signal (a scan ever
  // run, a review ever left, a lead/deal/invoice ever recorded) anywhere
  // in an included dimension. An enabled-but-never-touched module still
  // produces a real (low) sub-score above; this is only about whether the
  // composite is worth showing as a number at all versus "—".
  const hasAnyData = visibilityHasData || reputationHasData || salesHasData;
  const compositeRaw = hasAnyData ? weightedAvg(compositeParts) : null;

  return {
    score: compositeRaw != null ? Math.round(compositeRaw) : null,
    visibility: visibility != null ? Math.round(visibility) : null,
    reputation: reputation != null ? Math.round(reputation) : null,
    sales: sales != null ? Math.round(sales) : null,
  };
}
