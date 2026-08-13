'use client';

import { useApi } from '@/lib/useApi';
import type { Lead, OperateMoneyResponse } from '@/lib/types';
import { formatMoney } from '@/lib/format';
import { Card } from '@/components/ui/Card';
import { Row } from '@/components/ui/Row';
import { StatStrip } from '@/components/ui/StatStrip';
import { SkeletonCard } from '@/components/ui/Skeleton';
import { IconUsers, IconDollar } from '@/components/ui/icons';

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

      <div className="grid grid-cols-1 gap-4 g2:grid-cols-2">
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
          ) : money && money.overdue.length > 0 ? (
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
            </div>
          ) : (
            <p className="px-4 pb-4 text-sm text-ink-2">
              Nothing overdue — invoices past their due date show up here.
            </p>
          )}
        </Card>
      </div>
    </div>
  );
}
