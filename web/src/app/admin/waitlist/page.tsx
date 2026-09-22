'use client';

import { useState } from 'react';
import { mutate } from 'swr';
import { DownloadSimple } from '@phosphor-icons/react';
import { useApi } from '@/lib/useApi';
import { apiFetch, ApiError } from '@/lib/api';
import { API_BASE } from '@/lib/config';
import { PageHeader } from '@/components/Primitives';
import { Card } from '@/components/ui/Card';
import { SkeletonCard } from '@/components/ui/Skeleton';
import type { WaitlistEntry, WaitlistStatus } from '@/lib/types';

const STATUSES: Array<WaitlistStatus | 'all'> = ['all', 'new', 'contacted', 'converted'];

function fmt(d: string): string {
  return new Date(d).toLocaleString();
}

function Row({ entry, swrKey }: { entry: WaitlistEntry; swrKey: string }) {
  const [notes, setNotes] = useState(entry.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save(patch: Partial<Pick<WaitlistEntry, 'status' | 'notes'>>) {
    setSaving(true);
    setErr(null);
    try {
      await apiFetch(`/admin/waitlist/${entry.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      await mutate(swrKey);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <tr className="border-b border-border align-top last:border-0">
      <td className="px-4 py-3">{entry.email}</td>
      <td className="px-4 py-3 text-muted-foreground">{entry.business_name ?? '—'}</td>
      <td className="px-4 py-3 text-muted-foreground">{entry.interest ?? '—'}</td>
      <td className="px-4 py-3 text-muted-foreground">{entry.source_page ?? '—'}</td>
      <td className="px-4 py-3">
        <select
          value={entry.status}
          disabled={saving}
          onChange={(e) => save({ status: e.target.value as WaitlistStatus })}
          className="rounded-lg border border-border bg-background px-2 py-1 text-sm"
        >
          <option value="new">new</option>
          <option value="contacted">contacted</option>
          <option value="converted">converted</option>
        </select>
      </td>
      <td className="px-4 py-3">
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => notes !== (entry.notes ?? '') && save({ notes })}
          rows={2}
          className="w-48 rounded-lg border border-border bg-background px-2 py-1 text-sm"
        />
        {err && <p className="mt-1 text-xs text-destructive">{err}</p>}
      </td>
      <td className="px-4 py-3 text-muted-foreground">{fmt(entry.created_at)}</td>
    </tr>
  );
}

export default function AdminWaitlistPage() {
  const [status, setStatus] = useState<WaitlistStatus | 'all'>('all');
  const key = status === 'all' ? '/admin/waitlist' : `/admin/waitlist?status=${status}`;
  const { data: entries, isLoading, error } = useApi<WaitlistEntry[]>(key);

  return (
    <div>
      <PageHeader
        eyebrow="Staff only"
        title="Waitlist"
        subtitle={entries ? `${entries.length} entries` : undefined}
        actions={
          <a
            href={`${API_BASE}/admin/waitlist/export.csv`}
            className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-border px-3 text-sm font-medium hover:bg-muted"
          >
            <DownloadSimple size={16} /> Export CSV
          </a>
        }
      />

      <div className="mb-4 flex gap-2">
        {STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={`rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide ${
              status === s ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {isLoading && <SkeletonCard />}
      {error && <p className="text-sm text-destructive">Could not load the waitlist.</p>}
      {entries && (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Business</th>
                <th className="px-4 py-3">Interested in</th>
                <th className="px-4 py-3">Source</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Notes</th>
                <th className="px-4 py-3">Submitted</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => <Row key={e.id} entry={e} swrKey={key} />)}
              {entries.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">No entries yet.</td></tr>
              )}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
