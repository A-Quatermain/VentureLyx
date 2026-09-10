'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Tray } from '@phosphor-icons/react';
import { useApi } from '@/lib/useApi';
import type { GrowCampaign, GrowMessage, GrowMessageStatus } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { SkeletonCard } from '@/components/ui/Skeleton';
import { toneSoft, type Tone } from '@/components/ui/tone';

const STATUSES: GrowMessageStatus[] = ['queued', 'sending', 'sent', 'failed', 'bounced', 'cancelled'];

const STATUS_TONE: Record<GrowMessageStatus, Tone> = {
  queued: 'muted',
  sending: 'primary',
  sent: 'success',
  failed: 'destructive',
  bounced: 'destructive',
  cancelled: 'muted',
};

export default function GrowQueuePage() {
  const [status, setStatus] = useState<GrowMessageStatus | ''>('');
  const [page, setPage] = useState(1);

  const params = new URLSearchParams();
  if (status) params.set('status', status);
  params.set('page', String(page));

  const { data: messages, isLoading, error } = useApi<GrowMessage[]>(`/grow/messages?${params.toString()}`);
  const { data: campaigns } = useApi<GrowCampaign[]>('/grow/campaigns');
  const hasCampaigns = !!campaigns && campaigns.length > 0;

  function onFilter(s: GrowMessageStatus | '') {
    setStatus(s);
    setPage(1);
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="font-display text-lg font-bold tracking-tight">Queue</p>
          <p className="text-sm text-muted-foreground">Every message this campaign has scheduled or sent.</p>
        </div>
        <Link href="/grow" className="text-sm font-medium text-primary hover:underline">
          ← Grow
        </Link>
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap gap-1">
          <button
            onClick={() => onFilter('')}
            className={`rounded-full px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
              status === '' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            All
          </button>
          {STATUSES.map((s) => (
            <button
              key={s}
              onClick={() => onFilter(s)}
              className={`rounded-full px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                status === s ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </Card>

      <Card className="overflow-x-auto p-0">
        {isLoading ? (
          <SkeletonCard />
        ) : error ? (
          <p className="p-4 text-sm text-destructive">Could not load the queue.</p>
        ) : !messages || messages.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
            <Tray size={24} className="text-muted-foreground" />
            {status ? (
              <p className="text-sm text-muted-foreground">No messages match this filter.</p>
            ) : !hasCampaigns ? (
              <>
                <p className="text-sm font-medium">Nothing queued yet</p>
                <p className="max-w-sm text-sm text-muted-foreground">
                  Messages show up here once a campaign is running with enrolled contacts.
                </p>
                <Link href="/grow" className="mt-1 text-sm font-medium text-primary hover:underline">
                  Create your first campaign →
                </Link>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Nothing queued yet — a running campaign will start scheduling sends here.
              </p>
            )}
          </div>
        ) : (
          <table className="w-full min-w-[780px] text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">Subject</th>
                <th className="px-4 py-2 font-medium">Domain</th>
                <th className="px-4 py-2 text-right font-medium">Step</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Scheduled</th>
                <th className="px-4 py-2 font-medium">Sent</th>
                <th className="px-4 py-2 text-right font-medium">Attempts</th>
              </tr>
            </thead>
            <tbody>
              {messages.map((m) => (
                <tr key={m.id} className="border-b border-border last:border-0">
                  <td className="max-w-xs truncate px-4 py-3">{m.subject}</td>
                  <td className="px-4 py-3 text-muted-foreground">{m.recipient_domain}</td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums" data-numeric>{m.step_no}</td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${toneSoft[STATUS_TONE[m.status]]}`}>
                      {m.status}
                    </span>
                    {m.error && <p className="mt-0.5 max-w-[220px] truncate text-xs text-destructive">{m.error}</p>}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{new Date(m.scheduled_at).toLocaleString()}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {m.sent_at ? new Date(m.sent_at).toLocaleString() : '—'}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-muted-foreground" data-numeric>
                    {m.attempts}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">Page {page}</p>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>
            Prev
          </Button>
          <Button variant="ghost" onClick={() => setPage((p) => p + 1)} disabled={!messages || messages.length < 50}>
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
