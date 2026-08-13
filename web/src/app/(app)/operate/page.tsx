'use client';

import { useApi } from '@/lib/useApi';
import type { Lead, OperateMoneyResponse } from '@/lib/types';
import { formatMoney } from '@/lib/format';
import { Card } from '@/components/ui/Card';
import { Row } from '@/components/ui/Row';
import { StatStrip } from '@/components/ui/StatStrip';
import { SkeletonCard } from '@/components/ui/Skeleton';
import { IconUsers, IconDollar, IconClock } from '@/components/ui/icons';

function relativeTime(iso: string | null): string {
  if (!iso) return 'No activity yet';
  const hours = Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000);
  if (hours < 1) return 'Active just now';
  if (hours < 24) return `Active ${hours}h ago`;
  return `Active ${Math.round(hours / 24)}d ago`;
}

export default function OperatePage() {
  const { data: leads, isLoading: leadsLoading } = useApi<Lead[]>('/operate/leads');
  const { data: money, isLoading: moneyLoading } = useApi<OperateMoneyResponse>('/operate/money');

  return (
    <div className="flex flex-col gap-4 p-4">
      <p className="font-display text-lg font-bold text-deepwater">Operate</p>

      <StatStrip
        stats={[
          { label: 'Leads to work', value: String(leads?.length ?? 0) },
          { label: 'Overdue invoices', value: String(money?.overdue.length ?? 0) },
          { label: 'Upcoming', value: money ? formatMoney(money.upcoming.total) : '—' },
        ]}
      />

      <div className="grid grid-cols-1 gap-4 g2:grid-cols-2 dt:grid-cols-3">
        <Card className="p-0">
          <p className="p-4 pb-2 text-xs font-medium text-ink-3">LEADS NEEDING ATTENTION</p>
          {leadsLoading ? (
            <SkeletonCard />
          ) : leads && leads.length > 0 ? (
            <div className="divide-y divide-line-2">
              {leads.map((lead) => (
                <Row
                  key={lead.id}
                  icon={<IconUsers width={16} height={16} />}
                  tone="pool"
                  title={lead.display_name}
                  subtitle={[lead.city, lead.channel].filter(Boolean).join(' · ') || lead.lifecycle}
                  value={<span className="text-xs text-ink-3">{relativeTime(lead.last_activity_at)}</span>}
                />
              ))}
            </div>
          ) : (
            <p className="px-4 pb-4 text-sm text-ink-2">
              No leads need attention right now — new and stale leads show up here.
            </p>
          )}
        </Card>

        <Card className="p-0">
          <p className="p-4 pb-2 text-xs font-medium text-ink-3">MONEY OWED TO YOU</p>
          {moneyLoading ? (
            <SkeletonCard />
          ) : money && (money.overdue.length > 0 || money.upcoming.count > 0) ? (
            <div className="divide-y divide-line-2">
              {money.overdue.map((inv) => (
                <Row
                  key={inv.number}
                  icon={<IconDollar width={16} height={16} />}
                  tone="alert"
                  title={inv.display_name}
                  subtitle={`Invoice ${inv.number} · ${inv.days_overdue}d overdue`}
                  value={
                    <span data-numeric className="font-mono text-sm text-ink">
                      {formatMoney(inv.owed)}
                    </span>
                  }
                />
              ))}
              {money.upcoming.count > 0 && (
                <Row
                  icon={<IconClock width={16} height={16} />}
                  tone="ink"
                  title={`${money.upcoming.count} invoice${money.upcoming.count === 1 ? '' : 's'} not yet due`}
                  subtitle="Due within 30 days"
                  value={
                    <span data-numeric className="font-mono text-sm text-ink">
                      {formatMoney(money.upcoming.total)}
                    </span>
                  }
                />
              )}
            </div>
          ) : (
            <p className="px-4 pb-4 text-sm text-ink-2">
              Nothing owed right now — overdue and upcoming invoices show up here.
            </p>
          )}
        </Card>

        <Card className="p-0">
          <p className="p-4 pb-2 text-xs font-medium text-ink-3">WHERE YOUR CUSTOMERS ARE</p>
          {leadsLoading ? <SkeletonCard /> : <CityBreakdown leads={leads ?? []} />}
        </Card>
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
    return <p className="px-4 pb-4 text-sm text-ink-2">No leads with a city on file yet.</p>;
  }

  return (
    <div className="divide-y divide-line-2">
      {top.map(([city, count]) => (
        <Row key={city} title={city} value={<span className="font-mono text-sm text-ink">{count}</span>} />
      ))}
      {restAreas > 0 && (
        <Row
          title={`${restAreas} other area${restAreas === 1 ? '' : 's'}`}
          value={<span className="font-mono text-sm text-ink">{restCount}</span>}
        />
      )}
    </div>
  );
}
