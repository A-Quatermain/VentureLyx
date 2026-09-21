'use client';

import { useRouter } from 'next/navigation';
import {
  TrendUp, Users, CurrencyDollar, MagnifyingGlass, Briefcase, Sparkle, ArrowUpRight,
  Wallet, Star, Target, FunnelSimple,
} from '@phosphor-icons/react';
import { AreaChart, Area, ResponsiveContainer, Tooltip, XAxis } from 'recharts';
import { useApi } from '@/lib/useApi';
import type { SummaryResponse, Signal, Lead, MeResponse, Opportunity, RevenueTrendPoint } from '@/lib/types';
import { formatMoney } from '@/lib/format';
import { AIStreamPanel } from '@/components/AIStreamPanel';
import { PageHeader, Stagger, StaggerItem } from '@/components/Primitives';
import { Card } from '@/components/ui/Card';
import { Skeleton, ShimmerBlock } from '@/components/ui/Skeleton';
import { signalSeverityLabel } from '@/components/ui/tone';

function Metric({
  label,
  value,
  sub,
  icon: Icon,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: typeof CurrencyDollar;
}) {
  return (
    <StaggerItem>
      <Card className="p-5">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
            <Icon size={16} weight="duotone" className="text-primary" />
          </div>
        </div>
        <div className="font-mono text-3xl font-semibold tabular-nums tracking-tight">{value}</div>
        {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
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

export default function CommandCenter() {
  const router = useRouter();
  const { data: summary, error, isLoading } = useApi<SummaryResponse>('/command/summary');
  const { data: signals, isLoading: signalsLoading } = useApi<Signal[]>('/command/signals');
  const { data: leads } = useApi<Lead[]>('/operate/leads');
  const { data: me } = useApi<MeResponse>('/auth/me');
  const { data: revenueTrend } = useApi<RevenueTrendPoint[]>('/command/revenue-trend');

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

  return (
    <div>
      <PageHeader
        eyebrow={summary.org.vertical ? `${orgName} · ${summary.org.vertical}` : orgName}
        title="Command Center"
        subtitle="Everything reporting into one place. Here's what's driving your growth right now."
      />

      <Stagger className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Metric
          label="Revenue"
          value={formatMoney(summary.money.collected)}
          sub="collected this month"
          icon={CurrencyDollar}
        />
        <Metric label="New Leads" value={String(summary.leads.new_leads)} sub={`${summary.leads.stale} stale`} icon={TrendUp} />
        <Metric label="Customers" value={String(customers)} sub="lifecycle: customer" icon={Users} />
        <Metric
          label="Jobs"
          value={String(summary.work.today_total)}
          sub={`${summary.work.today_done} done today`}
          icon={Briefcase}
        />
        <Metric
          label="SEO Score"
          value={summary.seo?.health != null ? String(summary.seo.health) : '—'}
          sub={summary.seo?.health ? 'of 100' : 'run a scan'}
          icon={MagnifyingGlass}
        />
        <Metric
          label="Reviews"
          value={summary.reputation.avg_rating ?? '—'}
          sub={`${summary.reputation.review_count} review${summary.reputation.review_count === 1 ? '' : 's'}`}
          icon={Star}
        />
        <Metric label="Expenses" value={formatMoney(summary.expenses.this_month)} sub="this month" icon={Wallet} />
        <Metric
          label="Growth Score"
          value={summary.seo?.health != null ? String(summary.seo.health) : '—'}
          sub="sales, reputation & visibility"
          icon={Sparkle}
        />
      </Stagger>

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
                <p className="px-6 py-8 text-sm text-white/80">You&apos;re all caught up. Nice work.</p>
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
                  This chart fills in as payments come through Operate.
                </p>
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
