'use client';

import { useRouter } from 'next/navigation';
import {
  TrendUp, Users, CurrencyDollar, MagnifyingGlass, Kanban, Sparkle, ArrowUpRight,
  Wallet, Briefcase, Star,
} from '@phosphor-icons/react';
import { AreaChart, Area, ResponsiveContainer, Tooltip, XAxis } from 'recharts';
import { useApi } from '@/lib/useApi';
import type { SummaryResponse, Signal, Lead, MeResponse, Opportunity, RevenueTrendPoint } from '@/lib/types';
import { formatMoney } from '@/lib/format';
import { GrowthGauge } from '@/components/GrowthGauge';
import { AIStreamPanel } from '@/components/AIStreamPanel';
import { PageHeader, Stagger, StaggerItem } from '@/components/Primitives';
import { Skeleton, ShimmerBlock } from '@/components/ui/Skeleton';
import { toneOutline, signalSeverityLabel, type Tone } from '@/components/ui/tone';

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
    <StaggerItem className="border border-border bg-surface p-5 transition-transform hover:-translate-y-0.5">
      <div className="mb-3 flex items-center justify-between">
        <span className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">{label}</span>
        <Icon size={18} weight="duotone" className="text-muted-foreground" />
      </div>
      <div className="font-mono text-3xl font-bold tracking-tighter">{value}</div>
      {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
    </StaggerItem>
  );
}

type Action =
  | { kind: 'opportunity'; id: string; title: string; detail: string; module: string; priority: 'high' }
  | { kind: 'signal'; id: string; title: string; detail: string; module: string; priority: 'high' | 'medium' | 'low' };

const PRIORITY_TONE: Record<Action['priority'], Tone> = {
  high: 'destructive',
  medium: 'primary',
  low: 'muted',
};

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

const RANK_ORDER: Record<Action['priority'], number> = { high: 0, medium: 1, low: 2 };

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
      <div className="border border-border bg-surface p-6">
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : 'Could not load Command Center.'}
        </p>
      </div>
    );
  }

  const orgName = me?.organizations?.find((o) => o.id === me.currentOrgId)?.name ?? 'Your Business';
  const customers = (leads ?? []).filter((l) => l.lifecycle === 'customer').length;
  const actions = toActions(summary.opportunities, signals ?? [])
    .sort((a, b) => RANK_ORDER[a.priority] - RANK_ORDER[b.priority])
    .slice(0, 8);

  const hasRevenue = (revenueTrend ?? []).some((p) => Number(p.amount) > 0);

  return (
    <div>
      <PageHeader
        eyebrow={summary.org.vertical ? `${orgName} · ${summary.org.vertical}` : orgName}
        title="Command Center"
        subtitle="Everything reporting into one place. Here's what's driving your growth right now."
      />

      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-12 flex flex-col items-center justify-center border border-border bg-surface p-6 md:col-span-4">
          <GrowthGauge score={summary.seo?.health ?? null} />
          <p className="mt-4 max-w-[220px] text-center text-xs text-muted-foreground">
            A single number for how healthy your business is across sales, reputation &amp; visibility.
          </p>
        </div>

        <div className="col-span-12 border border-border bg-surface md:col-span-8">
          <div className="flex items-center gap-2 border-b border-border px-6 py-4">
            <Sparkle size={18} weight="fill" className="text-primary" />
            <h3 className="font-display font-bold tracking-tight">Next Best Actions</h3>
          </div>
          {signalsLoading && !signals ? (
            <div className="space-y-3 p-4">
              {[0, 1, 2].map((i) => (
                <ShimmerBlock key={i} className="h-16" />
              ))}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {actions.length === 0 && (
                <p className="px-6 py-8 text-sm text-muted-foreground">You&apos;re all caught up. Nice work.</p>
              )}
              {actions.map((a, i) => (
                <div
                  key={`${a.kind}-${a.id}`}
                  onClick={() => router.push(`/${a.module}`)}
                  className="group flex cursor-pointer items-start gap-4 px-6 py-4 transition-colors hover:bg-muted"
                >
                  <span className="mt-0.5 w-4 font-mono text-xs text-muted-foreground">{i + 1}</span>
                  <span className={`mt-0.5 shrink-0 border px-1.5 py-0.5 font-mono text-[10px] uppercase ${toneOutline[PRIORITY_TONE[a.priority]]}`}>
                    {a.priority}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">{a.title}</p>
                    <p className="mt-0.5 text-sm text-muted-foreground">{a.detail}</p>
                  </div>
                  <ArrowUpRight
                    size={16}
                    weight="bold"
                    className="mt-0.5 shrink-0 text-muted-foreground transition-colors group-hover:text-primary"
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <Stagger className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Metric
          label="Revenue (paid)"
          value={formatMoney(summary.money.collected)}
          sub="this month"
          icon={CurrencyDollar}
        />
        <Metric label="Outstanding" value={formatMoney(summary.money.outstanding)} sub="unpaid invoices" icon={Wallet} />
        <Metric label="New Leads" value={String(summary.leads.new_leads)} sub={`${summary.leads.stale} stale`} icon={TrendUp} />
        <Metric label="Customers" value={String(customers)} sub="lifecycle: customer" icon={Users} />
        <Metric
          label="Pipeline"
          value={formatMoney(summary.pipeline.pipeline_value)}
          sub={`${summary.pipeline.open_deals} open deal${summary.pipeline.open_deals === 1 ? '' : 's'}`}
          icon={Briefcase}
        />
        <Metric
          label="SEO Score"
          value={summary.seo?.health != null ? String(summary.seo.health) : '—'}
          sub={summary.seo?.health ? 'of 100' : 'run a scan'}
          icon={MagnifyingGlass}
        />
        <Metric
          label="Reputation"
          value={summary.reputation.avg_rating ?? '—'}
          sub={`${summary.reputation.review_count} review${summary.reputation.review_count === 1 ? '' : 's'}`}
          icon={Star}
        />
        <Metric
          label="Open Jobs"
          value={String(summary.work.today_total)}
          sub={`${summary.work.today_done} done today`}
          icon={Kanban}
        />
      </Stagger>

      <div className="mt-4 border border-border bg-surface p-6">
        <p className="mb-4 font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">Revenue trend</p>
        {!revenueTrend ? (
          <Skeleton className="h-56 w-full rounded-none bg-muted" />
        ) : !hasRevenue ? (
          <div className="flex h-56 flex-col items-center justify-center text-center">
            <p className="text-sm text-muted-foreground">No revenue recorded yet.</p>
            <p className="mt-1 max-w-xs text-xs text-muted-foreground/70">
              This chart fills in as payments come through Operate — nothing to show until then.
            </p>
          </div>
        ) : (
          <div className="h-56">
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
                    borderRadius: 0,
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
      <Skeleton className="mb-8 h-10 w-64 rounded-none bg-muted" />
      <div className="grid grid-cols-12 gap-4">
        <Skeleton className="col-span-12 h-64 rounded-none bg-muted md:col-span-4" />
        <ShimmerBlock className="col-span-12 h-64 md:col-span-8" />
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-none bg-muted" />
        ))}
      </div>
      <Skeleton className="mt-4 h-64 w-full rounded-none bg-muted" />
    </div>
  );
}
