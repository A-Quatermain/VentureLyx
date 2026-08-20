'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useApi } from '@/lib/useApi';
import type { Lead, OperateMoneyResponse } from '@/lib/types';
import { formatMoney } from '@/lib/format';
import { StatStrip } from '@/components/ui/StatStrip';
import { Skeleton } from '@/components/ui/Skeleton';

// Our real parties.lifecycle values (migration 002's own documented
// convention), not ref-1's contacted/proposal/won — those don't exist in
// our schema.
const STAGES = [
  { key: 'new', label: 'New' },
  { key: 'working', label: 'Working' },
  { key: 'qualified', label: 'Qualified' },
  { key: 'customer', label: 'Customer' },
  { key: 'lost', label: 'Lost' },
  { key: 'dormant', label: 'Dormant' },
] as const;

const TABS = ['Pipeline', 'Money'] as const;

function relativeTime(iso: string | null): string {
  if (!iso) return 'No activity yet';
  const hours = Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000);
  if (hours < 1) return 'Active just now';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function OperatePage() {
  const [tab, setTab] = useState<(typeof TABS)[number]>('Pipeline');
  const { data: leads, isLoading: leadsLoading } = useApi<Lead[]>('/operate/leads');
  const { data: money, isLoading: moneyLoading } = useApi<OperateMoneyResponse>('/operate/money');

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-1 font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">Operate</p>
          <h1 className="font-display text-3xl font-black tracking-tighter sm:text-4xl">Pipeline &amp; Money</h1>
        </div>
        <div className="flex items-center gap-4">
          <Link href="/operate/catalog" className="text-sm text-primary">
            Catalog →
          </Link>
          <div className="flex border border-border">
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`border-r border-border px-5 py-2.5 text-sm font-medium transition-colors last:border-r-0 ${
                  tab === t ? 'bg-foreground text-background' : 'hover:bg-muted'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
      </div>

      {tab === 'Pipeline' ? (
        <Pipeline leads={leads ?? []} loading={leadsLoading} />
      ) : (
        <Money leads={leads ?? []} money={money} leadsLoading={leadsLoading} moneyLoading={moneyLoading} />
      )}
    </div>
  );
}

function Pipeline({ leads, loading }: { leads: Lead[]; loading: boolean }) {
  if (loading) {
    return (
      <div className="flex gap-4 overflow-x-auto pb-4">
        {STAGES.map((s) => (
          <Skeleton key={s.key} className="h-[70vh] w-72 shrink-0 rounded-none" />
        ))}
      </div>
    );
  }

  return (
    <>
      <p className="text-sm text-muted-foreground">
        <span className="font-mono font-bold text-foreground">{leads.length}</span> leads across the pipeline
        {/* Read-only this pass — no deal-value field exists on parties yet
            (that's `deals`, not built), and stage-advance needs a write
            endpoint that's deliberately not part of this rebuild. */}
      </p>
      <div className="flex gap-4 overflow-x-auto pb-4">
        {STAGES.map((stage) => {
          const items = leads.filter((l) => l.lifecycle === stage.key);
          return (
            <div key={stage.key} className="min-h-[70vh] w-72 shrink-0 border border-border bg-surface">
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <span className="font-display text-sm font-bold uppercase tracking-wide">{stage.label}</span>
                <span className="font-mono text-xs text-muted-foreground">{items.length}</span>
              </div>
              <div className="space-y-3 p-3">
                {items.map((lead) => (
                  <div key={lead.id} className="border border-border bg-background p-3">
                    <p className="text-sm font-semibold">{lead.display_name}</p>
                    {lead.city && <p className="text-xs text-muted-foreground">{lead.city}</p>}
                    <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
                      <span className="text-xs text-muted-foreground">{lead.channel ?? lead.source ?? '—'}</span>
                      <span className="text-xs text-muted-foreground">{relativeTime(lead.last_activity_at)}</span>
                    </div>
                  </div>
                ))}
                {items.length === 0 && <p className="px-1 py-4 text-xs text-muted-foreground/60">Empty</p>}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function Money({
  leads,
  money,
  leadsLoading,
  moneyLoading,
}: {
  leads: Lead[];
  money: OperateMoneyResponse | undefined;
  leadsLoading: boolean;
  moneyLoading: boolean;
}) {
  return (
    <div className="space-y-4">
      <StatStrip
        stats={[
          { label: 'Leads to work', value: String(leads.length) },
          { label: 'Overdue invoices', value: String(money?.overdue.length ?? 0) },
          { label: 'Upcoming', value: money ? formatMoney(money.upcoming.total) : '—' },
        ]}
      />

      <div className="grid grid-cols-1 gap-4 g2:grid-cols-2">
        <div className="border border-border bg-surface">
          <p className="p-4 pb-2 font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">Money owed to you</p>
          {moneyLoading ? (
            <div className="p-4">
              <Skeleton className="h-20 rounded-none" />
            </div>
          ) : money && (money.overdue.length > 0 || money.upcoming.count > 0) ? (
            <div className="divide-y divide-border">
              {money.overdue.map((inv) => (
                <div key={inv.number} className="flex items-center justify-between px-4 py-3">
                  <div>
                    <p className="text-sm font-semibold">{inv.display_name}</p>
                    <p className="text-xs text-muted-foreground">
                      Invoice {inv.number} · {inv.days_overdue}d overdue
                    </p>
                  </div>
                  <span data-numeric className="font-mono text-sm font-bold">
                    {formatMoney(inv.owed)}
                  </span>
                </div>
              ))}
              {money.upcoming.count > 0 && (
                <div className="flex items-center justify-between px-4 py-3">
                  <div>
                    <p className="text-sm font-semibold">
                      {money.upcoming.count} invoice{money.upcoming.count === 1 ? '' : 's'} not yet due
                    </p>
                    <p className="text-xs text-muted-foreground">Due within 30 days</p>
                  </div>
                  <span data-numeric className="font-mono text-sm font-bold">
                    {formatMoney(money.upcoming.total)}
                  </span>
                </div>
              )}
            </div>
          ) : (
            <p className="px-4 pb-4 text-sm text-muted-foreground">Nothing owed right now.</p>
          )}
        </div>

        <div className="border border-border bg-surface">
          <p className="p-4 pb-2 font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">
            Where your customers are
          </p>
          {leadsLoading ? (
            <div className="p-4">
              <Skeleton className="h-20 rounded-none" />
            </div>
          ) : (
            <CityBreakdown leads={leads} />
          )}
        </div>
      </div>
    </div>
  );
}

function CityBreakdown({ leads }: { leads: Lead[] }) {
  const counts = new Map<string, number>();
  for (const lead of leads) {
    if (!lead.city) continue;
    counts.set(lead.city, (counts.get(lead.city) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, 4);
  const restCount = sorted.slice(4).reduce((sum, [, n]) => sum + n, 0);
  const restAreas = sorted.length - 4;

  if (sorted.length === 0) {
    return <p className="px-4 pb-4 text-sm text-muted-foreground">No leads with a city on file yet.</p>;
  }

  return (
    <div className="divide-y divide-border">
      {top.map(([city, count]) => (
        <div key={city} className="flex items-center justify-between px-4 py-3">
          <span className="text-sm">{city}</span>
          <span className="font-mono text-sm">{count}</span>
        </div>
      ))}
      {restAreas > 0 && (
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-sm">
            {restAreas} other area{restAreas === 1 ? '' : 's'}
          </span>
          <span className="font-mono text-sm">{restCount}</span>
        </div>
      )}
    </div>
  );
}
