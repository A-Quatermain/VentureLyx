'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  TrendUp, Users, CurrencyDollar, MagnifyingGlass, Briefcase, Sparkle, ArrowUpRight,
  Wallet, Star, Target, FunnelSimple, X,
} from '@phosphor-icons/react';
import { AreaChart, Area, ResponsiveContainer, Tooltip, XAxis } from 'recharts';
import { useApi } from '@/lib/useApi';
import type {
  SummaryResponse, Signal, Lead, MeResponse, Opportunity, RevenueTrendPoint, SetupProgress, GrowthScoreBreakdown,
} from '@/lib/types';
import { formatMoney } from '@/lib/format';
import { AIStreamPanel } from '@/components/AIStreamPanel';
import { SetupChecklist } from '@/components/SetupChecklist';
import { PageHeader, Stagger, StaggerItem } from '@/components/Primitives';
import { Card } from '@/components/ui/Card';
import { Skeleton, ShimmerBlock } from '@/components/ui/Skeleton';
import { signalSeverityLabel } from '@/components/ui/tone';

// The Insights Analyst's metric keys — exactly the set api/src/routes/ai.ts's
// /ai/metric-explanation/stream accepts.
export type InsightMetric = 'revenue' | 'leads' | 'customers' | 'jobs' | 'expenses' | 'reviews' | 'seo' | 'growth_score';

function Metric({
  label,
  value,
  sub,
  icon: Icon,
  href,
  emptyLabel,
  insight,
  onExplain,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: typeof CurrencyDollar;
  // Opt-in, additive: omitted on every tile that hasn't been given one, so
  // those render exactly as before. href links the tile into its module;
  // emptyLabel — shown instead of `sub`, only when passed — is this tile's
  // version of the Revenue Trend card's own empty state ("No revenue
  // recorded yet."), for the one specific case the value is genuinely
  // empty rather than a real zero worth reading as-is (SEO Score's "—"/
  // "run a scan" already did this; this is the same idea on the rest).
  href?: string;
  emptyLabel?: string;
  // Also opt-in/additive: a tile with no `insight` renders with no "Explain"
  // affordance at all, exactly as before.
  insight?: InsightMetric;
  onExplain?: (metric: InsightMetric) => void;
}) {
  const body = (
    <Card className={href ? 'p-5 transition hover:border-primary/40 hover:shadow-sm' : 'p-5'}>
      <div className="mb-3 flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
        <div className="flex items-center gap-1">
          {insight && onExplain && (
            <button
              type="button"
              title="Ask the Insights Analyst"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onExplain(insight);
              }}
              className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/60 transition hover:bg-primary/10 hover:text-primary"
            >
              <Sparkle size={13} weight="fill" />
            </button>
          )}
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
            <Icon size={16} weight="duotone" className="text-primary" />
          </div>
        </div>
      </div>
      <div className="font-mono text-3xl font-semibold tabular-nums tracking-tight">{value}</div>
      {emptyLabel ? (
        <div className="mt-1 text-xs text-muted-foreground/70">{emptyLabel}</div>
      ) : (
        sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>
      )}
    </Card>
  );
  return (
    <StaggerItem>
      {href ? <Link href={href} className="block">{body}</Link> : body}
    </StaggerItem>
  );
}

// The one tile that doesn't fit Metric: no single module to link into (it
// blends three), and it needs a breakdown reveal Metric has no use for.
// Same Card shell and sizing as Metric, so it sits in the grid identically.
function GrowthScoreMetric({
  growthScore, onExplain,
}: {
  growthScore: GrowthScoreBreakdown;
  onExplain: (metric: InsightMetric) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasScore = growthScore.score != null;
  const breakdown = `Visibility ${growthScore.visibility ?? '—'} · Reputation ${growthScore.reputation ?? '—'} · Sales ${growthScore.sales ?? '—'}`;

  return (
    <StaggerItem>
      <Card
        className={hasScore ? 'cursor-pointer p-5' : 'p-5'}
        title={hasScore ? breakdown : undefined}
        onClick={hasScore ? () => setExpanded((v) => !v) : undefined}
      >
        <div className="mb-3 flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Growth Score</span>
          <div className="flex items-center gap-1">
            {hasScore && (
              <button
                type="button"
                title="Ask the Insights Analyst"
                onClick={(e) => {
                  e.stopPropagation();
                  onExplain('growth_score');
                }}
                className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground/60 transition hover:bg-primary/10 hover:text-primary"
              >
                <Sparkle size={13} weight="fill" />
              </button>
            )}
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
              <Sparkle size={16} weight="duotone" className="text-primary" />
            </div>
          </div>
        </div>
        <div className="font-mono text-3xl font-semibold tabular-nums tracking-tight">
          {hasScore ? growthScore.score : '—'}
        </div>
        <div className="mt-1 text-xs text-muted-foreground/70">
          {!hasScore
            ? 'Set up to see your growth score'
            : expanded
              ? breakdown
              : 'sales, reputation & visibility'}
        </div>
      </Card>
    </StaggerItem>
  );
}

type Action =
  | { kind: 'opportunity'; id: string; title: string; detail: string; module: string; priority: 'high' }
  | { kind: 'signal'; id: string; title: string; detail: string; module: string; priority: 'high' | 'medium' | 'low' };

const RANK_ORDER: Record<Action['priority'], number> = { high: 0, medium: 1, low: 2 };

function toActions(opportunities: Opportunity[], signals: Signal[]): Action[] {
  const fromOpportunities: Action[] = opportunities.map((o) => ({
    kind: 'opportunity',
    id: o.id,
    title: o.title,
    detail: o.est_value_monthly ? `${o.rationale} — worth ~${formatMoney(o.est_value_monthly)}/mo` : o.rationale,
    module: o.module,
    priority: 'high',
  }));
  const fromSignals: Action[] = signals.map((s) => ({
    kind: 'signal',
    id: String(s.id),
    title: s.summary,
    // s.detail is jsonb with a shape that varies per signal_type — never
    // render it directly (see the crash this caused: an object reaching a
    // JSX child). The module name is always a safe, real string.
    detail: s.module,
    module: s.module,
    priority: signalSeverityLabel(s.severity),
  }));
  return [...fromOpportunities, ...fromSignals];
}

const INSIGHT_LABEL: Record<InsightMetric, string> = {
  revenue: 'Revenue', leads: 'New Leads', customers: 'Customers', jobs: 'Jobs',
  expenses: 'Expenses', reviews: 'Reviews', seo: 'SEO Score', growth_score: 'Growth Score',
};

export default function CommandCenter() {
  const router = useRouter();
  const [explainMetric, setExplainMetric] = useState<InsightMetric | null>(null);
  const { data: summary, error, isLoading } = useApi<SummaryResponse>('/command/summary');
  const { data: signals, isLoading: signalsLoading } = useApi<Signal[]>('/command/signals');
  const { data: leads } = useApi<Lead[]>('/operate/leads');
  const { data: me } = useApi<MeResponse>('/auth/me');
  const { data: revenueTrend } = useApi<RevenueTrendPoint[]>('/command/revenue-trend');
  const { data: setupProgress } = useApi<SetupProgress>('/setup/progress');
  const setupIncomplete = !!setupProgress && setupProgress.done < setupProgress.total;

  if (isLoading) return <CommandCenterSkeleton />;

  if (error || !summary) {
    return (
      <Card className="p-6">
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : 'Could not load Command Center.'}
        </p>
      </Card>
    );
  }

  const orgName = me?.organizations?.find((o) => o.id === me.currentOrgId)?.name ?? 'Your Business';
  const customers = (leads ?? []).filter((l) => l.lifecycle === 'customer').length;
  const actions = toActions(summary.opportunities, signals ?? [])
    .sort((a, b) => RANK_ORDER[a.priority] - RANK_ORDER[b.priority])
    .slice(0, 3);

  const hasRevenue = (revenueTrend ?? []).some((p) => Number(p.amount) > 0);
  const funnel = summary.pipelineFunnel ?? [];
  const funnelMax = Math.max(1, ...funnel.map((f) => f.count));

  // organizations.modules: an absent key means enabled (same rule
  // api/src/lib/moduleAccess.ts enforces on writes) — only an explicit
  // `false` hides a tile. Growth Score itself is never hidden here since
  // it blends all three and already degrades to "—" with no data.
  const modules = summary.org.modules;
  const moduleOn = (key: string) => modules?.[key] !== false;
  const showOperateTiles = moduleOn('operate');
  const showScaleSeo = moduleOn('scaleseo');
  const showReviews = moduleOn('reviews');

  return (
    <div>
      <PageHeader
        eyebrow={summary.org.vertical ? `${orgName} · ${summary.org.vertical}` : orgName}
        title="Command Center"
        subtitle="Everything reporting into one place. Here's what's driving your growth right now."
      />

      <SetupChecklist />

      <Stagger className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {showOperateTiles && (
          <Metric
            label="Revenue"
            value={formatMoney(summary.money.collected)}
            sub="collected this month"
            emptyLabel={Number(summary.money.collected) === 0 ? 'No revenue yet' : undefined}
            icon={CurrencyDollar}
            href="/operate"
            insight="revenue"
            onExplain={setExplainMetric}
          />
        )}
        {showOperateTiles && (
          <Metric
            label="New Leads"
            value={String(summary.leads.new_leads)}
            sub={`${summary.leads.stale} stale`}
            icon={TrendUp}
            href="/operate/leads"
            insight="leads"
            onExplain={setExplainMetric}
          />
        )}
        {showOperateTiles && (
          <Metric
            label="Customers"
            value={String(customers)}
            sub="lifecycle: customer"
            emptyLabel={customers === 0 ? 'No customers yet — add customers' : undefined}
            icon={Users}
            href="/operate/customers"
            insight="customers"
            onExplain={setExplainMetric}
          />
        )}
        {showOperateTiles && (
          <Metric
            label="Jobs"
            value={String(summary.work.today_total)}
            sub={`${summary.work.today_done} done today`}
            emptyLabel={summary.work.today_total === 0 ? 'No jobs scheduled today' : undefined}
            icon={Briefcase}
            href="/operate"
            insight="jobs"
            onExplain={setExplainMetric}
          />
        )}
        {showScaleSeo && (
          <Metric
            label="SEO Score"
            value={summary.seo?.health != null ? String(summary.seo.health) : '—'}
            sub={summary.seo?.health ? 'of 100' : 'run a scan'}
            icon={MagnifyingGlass}
            href="/scaleseo"
            insight="seo"
            onExplain={setExplainMetric}
          />
        )}
        {showReviews && (
          <Metric
            label="Reviews"
            value={summary.reputation.avg_rating ?? '—'}
            sub={`${summary.reputation.review_count} review${summary.reputation.review_count === 1 ? '' : 's'}`}
            emptyLabel={summary.reputation.review_count === 0 ? 'No reviews yet' : undefined}
            icon={Star}
            href="/reviews"
            insight="reviews"
            onExplain={setExplainMetric}
          />
        )}
        {showOperateTiles && (
          <Metric
            label="Expenses"
            value={formatMoney(summary.expenses.this_month)}
            sub="this month"
            emptyLabel={Number(summary.expenses.this_month) === 0 ? 'No expenses logged yet' : undefined}
            icon={Wallet}
            href="/operate"
            insight="expenses"
            onExplain={setExplainMetric}
          />
        )}
        <GrowthScoreMetric growthScore={summary.growthScore} onExplain={setExplainMetric} />
      </Stagger>

      {explainMetric && (
        <div className="mt-4">
          <AIStreamPanel
            key={explainMetric}
            path="/ai/metric-explanation/stream"
            body={{ metric: explainMetric }}
            title={`Insights Analyst · ${INSIGHT_LABEL[explainMetric]}`}
            triggerLabel="Explain this"
            autoStart
          />
          <button
            type="button"
            onClick={() => setExplainMetric(null)}
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <X size={12} weight="bold" /> Close
          </button>
        </div>
      )}

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="overflow-hidden bg-gradient-to-br from-primary to-accent-deep text-white">
          <div className="flex items-center gap-2 border-b border-white/15 px-6 py-4">
            <Target size={18} weight="fill" />
            <h3 className="font-display font-semibold">Next Best Action</h3>
          </div>
          {signalsLoading && !signals ? (
            <div className="space-y-3 p-6">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-20 animate-pulse rounded-lg bg-white/10" />
              ))}
            </div>
          ) : (
            <div className="divide-y divide-white/10">
              {actions.length === 0 && (
                <p className="px-6 py-8 text-sm text-white/80">
                  {setupIncomplete
                    ? 'Finish the setup checklist below — recommendations show up here once there’s real data to work from.'
                    : 'You’re all caught up. Nice work.'}
                </p>
              )}
              {actions.map((a, i) => (
                <div key={`${a.kind}-${a.id}`} className="flex flex-col gap-3 px-6 py-5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 flex items-center gap-2">
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white/15 text-[11px] font-semibold">
                        {i + 1}
                      </span>
                      <p className="text-sm font-semibold">{a.title}</p>
                    </div>
                    <p className="text-sm text-white/75">{a.detail}</p>
                  </div>
                  <button
                    onClick={() => router.push(`/${a.module}`)}
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-white px-4 py-2 text-sm font-medium text-primary shadow-sm transition hover:bg-white/90"
                  >
                    Fix this for me
                    <ArrowUpRight size={14} weight="bold" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </Card>

        <div className="flex flex-col gap-4">
          <Card className="p-6">
            <p className="mb-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">Monthly revenue trend</p>
            {!revenueTrend ? (
              <Skeleton className="h-40 w-full rounded-xl bg-muted" />
            ) : !hasRevenue ? (
              <div className="flex h-40 flex-col items-center justify-center text-center">
                <p className="text-sm text-muted-foreground">No revenue recorded yet.</p>
                <p className="mt-1 max-w-xs text-xs text-muted-foreground/70">
                  This fills in once customers and their payments are on file.
                </p>
                <Link href="/operate/customers" className="mt-2 text-xs font-medium text-primary hover:underline">
                  Add your customers →
                </Link>
              </div>
            ) : (
              <div className="h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={revenueTrend}>
                    <defs>
                      <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <XAxis
                      dataKey="month"
                      stroke="hsl(var(--muted-fg))"
                      fontSize={12}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip
                      formatter={(value) => [formatMoney(String(value ?? 0)), 'Revenue']}
                      contentStyle={{
                        background: 'hsl(var(--card))',
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                      labelStyle={{ color: 'hsl(var(--fg))' }}
                    />
                    <Area
                      type="monotone"
                      dataKey={(p: RevenueTrendPoint) => Number(p.amount)}
                      stroke="hsl(var(--primary))"
                      strokeWidth={2}
                      fill="url(#revenueFill)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            )}
          </Card>

          <Card className="p-6">
            <div className="mb-4 flex items-center gap-2">
              <FunnelSimple size={16} className="text-muted-foreground" />
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Sales pipeline</p>
            </div>
            <div className="space-y-3">
              {funnel.map((stage) => (
                <div key={stage.stage}>
                  <div className="mb-1 flex items-baseline justify-between">
                    <span className="text-sm font-medium">{stage.stage}</span>
                    <span className="font-mono text-xs tabular-nums text-muted-foreground">
                      {stage.count} · {formatMoney(stage.value)}
                    </span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${Math.max(4, (stage.count / funnelMax) * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
              {funnel.every((f) => f.count === 0) && (
                <p className="pt-1 text-xs text-muted-foreground/70">
                  No leads in the pipeline yet — new leads will show up here by stage.
                </p>
              )}
            </div>
          </Card>
        </div>
      </div>

      <div className="mt-4">
        <AIStreamPanel
          path="/ai/growth-strategist/stream"
          title="AI Growth Strategist"
          triggerLabel="What should I do next?"
        />
      </div>
    </div>
  );
}

function CommandCenterSkeleton() {
  return (
    <div>
      <Skeleton className="mb-8 h-10 w-64 rounded-lg bg-muted" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-xl bg-muted" />
        ))}
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ShimmerBlock className="h-64" />
        <div className="flex flex-col gap-4">
          <Skeleton className="h-40 w-full rounded-xl bg-muted" />
          <Skeleton className="h-40 w-full rounded-xl bg-muted" />
        </div>
      </div>
    </div>
  );
}
