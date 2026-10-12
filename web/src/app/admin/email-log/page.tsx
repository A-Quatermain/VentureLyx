'use client';

import { useState } from 'react';
import { useApi } from '@/lib/useApi';
import { PageHeader } from '@/components/Primitives';
import { Card } from '@/components/ui/Card';
import { SkeletonCard } from '@/components/ui/Skeleton';

interface EmailLogRow {
  id: string;
  to_address: string;
  template: string;
  status: 'sent' | 'failed';
  error: string | null;
  org_id: string | null;
  created_at: string;
}

const STATUSES: Array<'all' | 'sent' | 'failed'> = ['all', 'sent', 'failed'];

function fmt(d: string): string {
  return new Date(d).toLocaleString();
}

export default function EmailLogPage() {
  const [status, setStatus] = useState<'all' | 'sent' | 'failed'>('all');
  const key = `/admin/email-log${status === 'all' ? '' : `?status=${status}`}`;
  const { data, isLoading } = useApi<EmailLogRow[]>(key);

  return (
    <div>
      <PageHeader eyebrow="Admin" title="Email Log" subtitle="Every transactional email this system has sent or tried to send." />

      <div className="mb-4 flex gap-2">
        {STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={`rounded-full px-3 py-1 text-sm font-medium ${
              status === s ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/70'
            }`}
          >
            {s === 'all' ? 'All' : s === 'sent' ? 'Sent' : 'Failed'}
          </button>
        ))}
      </div>

      <Card className="overflow-x-auto p-0">
        {isLoading ? (
          <SkeletonCard />
        ) : !data || data.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No emails logged yet.</p>
        ) : (
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2">Sent</th>
                <th className="px-4 py-2">To</th>
                <th className="px-4 py-2">Template</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Error</th>
              </tr>
            </thead>
            <tbody>
              {data.map((row) => (
                <tr key={row.id} className="border-b border-border last:border-0">
                  <td className="whitespace-nowrap px-4 py-3 text-muted-foreground">{fmt(row.created_at)}</td>
                  <td className="px-4 py-3">{row.to_address}</td>
                  <td className="px-4 py-3 text-muted-foreground">{row.template}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      row.status === 'sent' ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive'
                    }`}>
                      {row.status}
                    </span>
                  </td>
                  <td className="max-w-xs truncate px-4 py-3 text-xs text-destructive">{row.error ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
