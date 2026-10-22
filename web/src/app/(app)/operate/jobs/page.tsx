'use client';

import { useState } from 'react';
import { mutate } from 'swr';
import Link from 'next/link';
import { CalendarPlus, Briefcase } from '@phosphor-icons/react';
import { useApi, useRole, atLeast } from '@/lib/useApi';
import { apiFetch, ApiError } from '@/lib/api';
import type { WorkOrderListItem, WorkOrderStatus } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { PageHeader } from '@/components/Primitives';
import { JobDrawer } from '@/components/JobDrawer';

const TABS: Array<{ key: WorkOrderStatus | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'dispatched', label: 'Dispatched' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'complete', label: 'Complete' },
  { key: 'cancelled', label: 'Cancelled' },
];

const STATUS_TONE: Record<WorkOrderStatus, string> = {
  scheduled: 'bg-primary/10 text-primary',
  dispatched: 'bg-primary/10 text-primary',
  in_progress: 'bg-warning/10 text-warning',
  complete: 'bg-success/10 text-success',
  cancelled: 'bg-muted text-muted-foreground',
};

// The status a single click should move a job to next — cancellation is a
// separate, deliberate action (a select), not something "advance" should
// ever land on by accident.
const NEXT_STATUS: Partial<Record<WorkOrderStatus, WorkOrderStatus>> = {
  scheduled: 'dispatched',
  dispatched: 'in_progress',
  in_progress: 'complete',
};

function formatDateTime(iso: string | null): string {
  if (!iso) return 'Not scheduled';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function JobsPage() {
  const role = useRole();
  const canEdit = atLeast(role, 'staff');
  const [tab, setTab] = useState<WorkOrderStatus | 'all'>('all');
  const [adding, setAdding] = useState(false);
  const key = `/operate/jobs${tab !== 'all' ? `?status=${tab}` : ''}`;
  const { data: jobs, isLoading } = useApi<WorkOrderListItem[]>(key);

  async function advance(job: WorkOrderListItem) {
    const next = NEXT_STATUS[job.status];
    if (!next) return;
    try {
      await apiFetch(`/operate/jobs/${job.id}/status`, { method: 'POST', body: JSON.stringify({ status: next }) });
      await mutate((k: string) => typeof k === 'string' && k.startsWith('/operate/jobs'), undefined, { revalidate: true });
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Could not update this job.');
    }
  }

  async function cancel(job: WorkOrderListItem) {
    if (!confirm(`Cancel "${job.title}"?`)) return;
    try {
      await apiFetch(`/operate/jobs/${job.id}/status`, { method: 'POST', body: JSON.stringify({ status: 'cancelled' }) });
      await mutate((k: string) => typeof k === 'string' && k.startsWith('/operate/jobs'), undefined, { revalidate: true });
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Could not cancel this job.');
    }
  }

  return (
    <div className="p-4">
      <PageHeader
        eyebrow="Operate"
        title="Jobs"
        subtitle="Every scheduled, in-progress, and completed job."
        actions={canEdit && (
          <Button onClick={() => setAdding(true)}>
            <CalendarPlus size={14} weight="bold" className="mr-1.5 inline" /> New job
          </Button>
        )}
      />

      <div className="mb-4 flex w-fit gap-1 rounded-full border border-border bg-surface p-1 shadow-sm">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === t.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-20 rounded-xl bg-muted" />
          <Skeleton className="h-20 rounded-xl bg-muted" />
        </div>
      ) : !jobs || jobs.length === 0 ? (
        <Card className="p-8 text-center">
          <Briefcase size={28} className="mx-auto mb-2 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {tab === 'all' ? 'No jobs scheduled yet.' : `No ${TABS.find((t) => t.key === tab)?.label.toLowerCase()} jobs.`}
          </p>
          {canEdit && tab === 'all' && (
            <Button onClick={() => setAdding(true)} className="mt-3">
              <CalendarPlus size={14} weight="bold" className="mr-1.5 inline" /> Schedule your first job
            </Button>
          )}
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {jobs.map((job) => (
            <Card key={job.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold">{job.title}</p>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${STATUS_TONE[job.status]}`}>
                    {job.status.replace(/_/g, ' ')}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  <Link href={`/operate/customers/${job.party_id}`} className="hover:underline">{job.party_name}</Link>
                  {' · '}{formatDateTime(job.scheduled_start)}
                </p>
              </div>
              {canEdit && job.status !== 'complete' && job.status !== 'cancelled' && (
                <div className="flex shrink-0 items-center gap-2">
                  {NEXT_STATUS[job.status] && (
                    <Button variant="ghost" onClick={() => advance(job)}>
                      Mark {NEXT_STATUS[job.status]!.replace(/_/g, ' ')}
                    </Button>
                  )}
                  <Button variant="ghost" onClick={() => cancel(job)} className="text-destructive">
                    Cancel
                  </Button>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      <JobDrawer open={adding} onOpenChange={setAdding} />
    </div>
  );
}
