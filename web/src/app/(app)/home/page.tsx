'use client';

import { useRouter } from 'next/navigation';
import {
  TrendUp, Users, CurrencyDollar, MagnifyingGlass, Kanban, Lightning, ArrowRight,
} from '@phosphor-icons/react';
import { useApi } from '@/lib/useApi';
import type { SummaryResponse, Signal, Lead, MeResponse, Opportunity } from '@/lib/types';
import { formatMoney } from '@/lib/format';
import { GrowthGauge } from '@/components/GrowthGauge';
import { Skeleton } from '@/components/ui/Skeleton';
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
    <div className="border border-border bg-surface p-6 transition-transform hover:-translate-y-0.5">
      <div className="mb-4 flex items-center justify-between">
        <span className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">{label}</span>
        <Icon size={18} weight="duotone" className="text-muted-foreground" />
      </div>
      <div className="font-mono text-3xl font-bold tracking-tighter sm:text-4xl">{value}</div>
      {sub && <div className="mt-2 text-xs text-muted-foreground">{sub}</div>}
    </div>
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

export default function CommandCenter() {
  const router = useRouter();
  const { data: summary, error, isLoading } = useApi<SummaryResponse>('/command/summary');
  const { data: signals } = useApi<Signal[]>('/command/signals');
  const { data: leads } = useApi<Lead[]>('/operate/leads');
  const { data: me } = useApi<MeResponse>('/auth/me');

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
  const actions = toActions(summary.opportunities, signals ?? []);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-1 font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
            Business Command Center
          </p>
          <h1 className="font-display text-3xl font-black tracking-tighter sm:text-4xl">{orgName}</h1>
        </div>
        <p className="max-w-sm text-sm text-muted-foreground">
          Everything reporting into one place. Here&apos;s what&apos;s driving your growth right now.
        </p>
      </div>

      <div className="grid grid-cols-12 gap-4">
        <div className="col-span-12 flex flex-col items-center justify-center border border-border bg-surface p-6 md:col-span-4">
          <GrowthGauge score={summary.seo?.health ?? null} />
          <p className="mt-4 max-w-[220px] text-center text-xs text-muted-foreground">
            A single number for how healthy your business is across sales, reputation &amp; visibility.
          </p>
        </div>

        <div className="col-span-12 grid grid-cols-2 gap-4 md:col-span-8 lg:grid-cols-3">
          <Metric
            label="Revenue (paid)"
            value={formatMoney(summary.money.collected)}
            sub={`${formatMoney(summary.money.outstanding)} outstanding`}
            icon={CurrencyDollar}
          />
          <Metric label="New Leads" value={String(summary.leads.new_leads)} sub={`${summary.leads.stale} stale`} icon={TrendUp} />
          <Metric label="Customers" value={String(customers)} sub="Lifecycle: customer" icon={Users} />
          <Metric
            label="SEO Score"
            value={summary.seo?.health != null ? String(summary.seo.health) : '—'}
            sub={summary.seo?.health ? 'of 100' : 'Run a scan'}
            icon={MagnifyingGlass}
          />
          <Metric
            label="Open Jobs"
            value={String(summary.work.today_total)}
            sub={`${summary.work.today_done} done today`}
            icon={Kanban}
          />
        </div>
      </div>

      <div className="border border-border bg-surface">
        <div className="flex items-center gap-2 border-b border-border px-6 py-4">
          <Lightning size={18} weight="fill" className="text-primary" />
          <h3 className="font-display font-bold tracking-tight">Next Best Actions</h3>
        </div>
        <div className="divide-y divide-border">
          {actions.length === 0 && <p className="px-6 py-8 text-sm text-muted-foreground">You&apos;re all caught up. Nice work.</p>}
          {actions.map((a) => (
            <div key={`${a.kind}-${a.id}`} className="group flex items-start justify-between gap-4 px-6 py-4">
              <div className="flex items-start gap-3">
                <span className={`mt-0.5 border px-1.5 py-0.5 font-mono text-[10px] uppercase ${toneOutline[PRIORITY_TONE[a.priority]]}`}>
                  {a.priority}
                </span>
                <div>
                  <p className="text-sm font-semibold">{a.title}</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">{a.detail}</p>
                </div>
              </div>
              <button
                onClick={() => router.push(`/${a.module}`)}
                className="inline-flex shrink-0 items-center gap-1.5 bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90"
              >
                Review <ArrowRight size={13} weight="bold" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function CommandCenterSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-10 w-64 rounded-none bg-muted" />
      <div className="grid grid-cols-12 gap-4">
        <Skeleton className="col-span-12 h-64 rounded-none bg-muted md:col-span-4" />
        <div className="col-span-12 grid grid-cols-2 gap-4 md:col-span-8 lg:grid-cols-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-32 rounded-none bg-muted" />
          ))}
        </div>
      </div>
      <Skeleton className="h-48 w-full rounded-none bg-muted" />
    </div>
  );
}
