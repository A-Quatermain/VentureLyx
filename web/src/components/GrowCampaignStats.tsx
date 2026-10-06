'use client';

import { ChartBar } from '@phosphor-icons/react';
import { useApi } from '@/lib/useApi';
import type { GrowCampaignStats as GrowCampaignStatsType } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { StatStrip } from '@/components/ui/StatStrip';
import { Skeleton } from '@/components/ui/Skeleton';

// Lifetime totals — the dashboard's "Sent today" tile is the only send
// count anywhere else in Grow, which says nothing about how a campaign has
// done since it started. Read from grow_messages (sent/remaining/failed, by
// step) and grow_events (replies, unsubscribes). The projected completion
// date already lives in GrowScheduleProjection just below this on the page
// (a capacity-aware simulation of what happens next); this is what's
// happened so far, not a second estimate.
export function GrowCampaignStats({ campaignId }: { campaignId: string }) {
  const { data, isLoading, error } = useApi<GrowCampaignStatsType>(`/grow/campaigns/${campaignId}/stats`);

  if (error) {
    return (
      <Card className="p-4">
        <p className="text-sm text-destructive">Could not load lifetime stats.</p>
      </Card>
    );
  }
  if (isLoading || !data) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Skeleton className="h-24 rounded-xl bg-muted" />
        <Skeleton className="h-24 rounded-xl bg-muted" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Lifetime</p>
        <StatStrip
          stats={[
            { label: 'Sent', value: String(data.sent) },
            { label: 'Remaining', value: String(data.remaining) },
            { label: 'Unsubscribed', value: String(data.unsubscribed) },
            { label: 'Replied', value: String(data.replied) },
          ]}
        />
      </div>

      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Contacts</p>
        <StatStrip
          stats={[
            { label: 'Enrolled', value: String(data.contacts.enrolled) },
            { label: 'Completed', value: String(data.contacts.completed) },
            { label: 'Pending', value: String(data.contacts.pending) },
          ]}
        />
      </div>

      <Card className="overflow-x-auto p-0">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <ChartBar size={16} className="text-muted-foreground" />
          <p className="text-sm font-semibold">By step</p>
        </div>
        {data.steps.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No messages queued yet.</p>
        ) : (
          <table className="w-full min-w-[480px] text-left text-sm">
            <thead>
              <tr className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2 font-medium">Step</th>
                <th className="px-4 py-2 text-right font-medium">Sent</th>
                <th className="px-4 py-2 text-right font-medium">Remaining</th>
                <th className="px-4 py-2 text-right font-medium">Replied</th>
                <th className="px-4 py-2 text-right font-medium">Unsubscribed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {data.steps.map((s) => (
                <tr key={s.step_no}>
                  <td className="px-4 py-3">Step {s.step_no}</td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums" data-numeric>
                    {s.sent}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums text-muted-foreground" data-numeric>
                    {s.remaining}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums" data-numeric>
                    {s.replied}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums" data-numeric>
                    {s.unsubscribed}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
