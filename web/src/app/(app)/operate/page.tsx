'use client';

import Link from 'next/link';
import { CalendarBlank, Percent, Receipt, Briefcase } from '@phosphor-icons/react';
import { useApi } from '@/lib/useApi';
import type { Lead, OperateMoneyResponse, ScheduledJob, SummaryResponse } from '@/lib/types';
import { formatMoney } from '@/lib/format';
import { Card } from '@/components/ui/Card';
import { PageHeader } from '@/components/Primitives';
import { Skeleton } from '@/components/ui/Skeleton';

// Same lifecycle → display-stage mapping as Command Center's Sales Pipeline
// funnel — real parties.lifecycle values, friendlier labels. lost/dormant
// are deliberately excluded from this active Kanban view.
const STAGES = [
  { key: 'new', label: 'New Lead' },
  { key: 'working', label: 'Contacted' },
  { key: 'qualified', label: 'Quoted' },
  { key: 'customer', label: 'Won' },
] as const;

function relativeTime(iso: string | null): string {
  if (!iso) return 'No activity yet';
  const hours = Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000);
  if (hours < 1) return 'Active just now';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function OperatePage() {
  const { data: leads, isLoading: leadsLoading } = useApi<Lead[]>('/operate/leads');
  const { data: money } = useApi<OperateMoneyResponse>('/operate/money');
  const { data: schedule } = useApi<ScheduledJob[]>('/operate/schedule');
  const { data: summary } = useApi<SummaryResponse>('/command/summary');

  const activeLeads = (leads ?? []).filter((l) => STAGES.some((s) => s.key === l.lifecycle));
  const won = activeLeads.filter((l) => l.lifecycle === 'customer').length;
  const conversionRate = activeLeads.length > 0 ? Math.round((won / activeLeads.length) * 100) : null;

  return (
    <div>
      <PageHeader
        eyebrow="Operate"
        title="Pipeline"
        subtitle="Every lead, from first contact to won customer."
        actions={
          <div className="flex items-center gap-4">
            <Link href="/operate/leads" className="text-sm font-medium text-primary hover:underline">
              Leads →
            </Link>
            <Link href="/operate/pipeline" className="text-sm font-medium text-primary hover:underline">
              Pipeline board →
            </Link>
            <Link href="/operate/customers" className="text-sm font-medium text-primary hover:underline">
              Customers →
            </Link>
            <Link href="/operate/jobs" className="text-sm font-medium text-primary hover:underline">
              Jobs →
            </Link>
            <Link href="/operate/invoices" className="text-sm font-medium text-primary hover:underline">
              Invoices →
            </Link>
            <Link href="/operate/catalog" className="text-sm font-medium text-primary hover:underline">
              Catalog →
            </Link>
            <Link href="/operate/import" className="text-sm font-medium text-primary hover:underline">
              Import your data →
            </Link>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1fr_320px]">
        <Kanban leads={activeLeads} loading={leadsLoading} />

        <div className="flex flex-col gap-4">
          <Card className="p-5">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Total Pipeline Value
              </span>
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
                <Briefcase size={16} weight="duotone" className="text-primary" />
              </div>
            </div>
            <div className="font-mono text-3xl font-semibold tabular-nums tracking-tight">
              {summary ? formatMoney(summary.pipeline.pipeline_value) : '—'}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {summary ? `${summary.pipeline.open_deals} open deal${summary.pipeline.open_deals === 1 ? '' : 's'}` : ''}
            </div>
          </Card>

          <Card className="p-5">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Conversion Rate</span>
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
                <Percent size={16} weight="duotone" className="text-primary" />
              </div>
            </div>
            <div className="font-mono text-3xl font-semibold tabular-nums tracking-tight">
              {conversionRate != null ? `${conversionRate}%` : '—'}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {activeLeads.length > 0 ? `${won} of ${activeLeads.length} leads won` : 'No leads yet'}
            </div>
          </Card>

          <Card className="p-0">
            <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <CalendarBlank size={16} className="text-muted-foreground" />
                <p className="text-sm font-semibold">Job Scheduling</p>
              </div>
              <Link href="/operate/jobs" className="text-xs font-medium text-primary hover:underline">All jobs →</Link>
            </div>
            {!schedule ? (
              <div className="space-y-2 p-4">
                <Skeleton className="h-10 rounded-lg bg-muted" />
                <Skeleton className="h-10 rounded-lg bg-muted" />
              </div>
            ) : schedule.length === 0 ? (
              <div className="p-4">
                <p className="text-sm text-muted-foreground">No jobs scheduled yet.</p>
                <Link href="/operate/jobs" className="mt-1 inline-block text-xs font-medium text-primary hover:underline">
                  Schedule your first job →
                </Link>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {schedule.map((job) => {
                  const d = job.scheduled_start ? new Date(job.scheduled_start) : null;
                  return (
                    <li key={job.id} className="flex items-center gap-3 px-4 py-3">
                      <div className="flex w-11 shrink-0 flex-col items-center justify-center rounded-lg bg-primary/10 py-1">
                        <span className="text-[10px] font-medium uppercase text-primary">
                          {d ? d.toLocaleDateString(undefined, { month: 'short' }) : '—'}
                        </span>
                        <span className="font-mono text-sm font-semibold text-primary">{d ? d.getDate() : '—'}</span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{job.title}</p>
                        <p className="truncate text-xs text-muted-foreground">{job.display_name}</p>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <Card className="p-0">
            <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
              <div className="flex items-center gap-2">
                <Receipt size={16} className="text-muted-foreground" />
                <p className="text-sm font-semibold">Invoices Summary</p>
              </div>
              <Link href="/operate/invoices" className="text-xs font-medium text-primary hover:underline">All invoices →</Link>
            </div>
            {!money ? (
              <div className="space-y-2 p-4">
                <Skeleton className="h-10 rounded-lg bg-muted" />
              </div>
            ) : money.overdue.length === 0 && money.upcoming.count === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">Nothing owed right now.</p>
            ) : (
              <div className="divide-y divide-border">
                {money.overdue.slice(0, 4).map((inv) => (
                  <div key={inv.number} className="flex items-center justify-between px-4 py-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{inv.display_name}</p>
                      <p className="text-xs text-destructive">{inv.days_overdue}d overdue</p>
                    </div>
                    <span className="shrink-0 font-mono text-sm font-semibold tabular-nums" data-numeric>
                      {formatMoney(inv.owed)}
                    </span>
                  </div>
                ))}
                {money.upcoming.count > 0 && (
                  <div className="flex items-center justify-between px-4 py-3">
                    <p className="text-sm text-muted-foreground">
                      {money.upcoming.count} not yet due
                    </p>
                    <span className="shrink-0 font-mono text-sm font-semibold tabular-nums" data-numeric>
                      {formatMoney(money.upcoming.total)}
                    </span>
                  </div>
                )}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function Kanban({ leads, loading }: { leads: Lead[]; loading: boolean }) {
  if (loading) {
    return (
      <div className="flex gap-4 overflow-x-auto pb-2">
        {STAGES.map((s) => (
          <Skeleton key={s.key} className="h-[70vh] w-72 shrink-0 rounded-xl bg-muted" />
        ))}
      </div>
    );
  }

  return (
    <div className="flex gap-4 overflow-x-auto pb-2">
      {STAGES.map((stage) => {
        const items = leads.filter((l) => l.lifecycle === stage.key);
        return (
          <div key={stage.key} className="min-h-[70vh] w-72 shrink-0 rounded-xl border border-border bg-surface shadow-sm">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <span className="text-sm font-semibold">{stage.label}</span>
              <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-xs tabular-nums text-muted-foreground">
                {items.length}
              </span>
            </div>
            <div className="space-y-3 p-3">
              {items.map((lead) => (
                <div key={lead.id} className="rounded-lg border border-border bg-background p-3 shadow-sm">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-semibold">{lead.display_name}</p>
                    {(lead.channel ?? lead.source) && (
                      <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase text-primary">
                        {lead.channel ?? lead.source}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">{lead.deal_title ?? 'No service on file'}</p>
                  <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
                    <span className="font-mono text-xs font-medium tabular-nums" data-numeric>
                      {lead.deal_value ? formatMoney(lead.deal_value) : '—'}
                    </span>
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
  );
}
