'use client';

import { useApi } from '@/lib/useApi';
import type { SummaryResponse, Signal } from '@/lib/types';
import { NextMoveCard } from '@/components/NextMoveCard';
import { SignalsList } from '@/components/SignalsList';
import { ModuleRail } from '@/components/ModuleRail';
import { RevenueCard } from '@/components/RevenueCard';
import { ScaleSeoHealthCard } from '@/components/ScaleSeoHealthCard';
import { StatStrip } from '@/components/ui/StatStrip';
import { Card } from '@/components/ui/Card';
import { Skeleton, SkeletonCard } from '@/components/ui/Skeleton';

export default function HomePage() {
  const { data: summary, error: summaryError, isLoading: summaryLoading } =
    useApi<SummaryResponse>('/command/summary');
  const { data: signals } = useApi<Signal[]>('/command/signals');

  if (summaryLoading) return <HomeSkeleton />;

  if (summaryError || !summary) {
    return (
      <div className="p-4">
        <Card>
          <p className="text-sm text-alert">
            {summaryError instanceof Error ? summaryError.message : 'Could not load Command Center.'}
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <NextMoveCard opportunity={summary.opportunities[0]} />

      <StatStrip
        stats={[
          { label: 'New leads (7d)', value: String(summary.leads.new_leads) },
          { label: 'Jobs today', value: `${summary.work.today_done}/${summary.work.today_total}` },
          { label: 'Site health', value: summary.seo?.health != null ? String(summary.seo.health) : '—' },
        ]}
      />

      <div className="grid grid-cols-1 gap-4 g2:grid-cols-2 dt:grid-cols-3">
        <RevenueCard
          collected={summary.money.collected}
          outstanding={summary.money.outstanding}
          channels={summary.channels}
        />
        {signals ? (
          <SignalsList signals={signals} />
        ) : (
          <Card className="p-0">
            <SkeletonCard rows={3} />
          </Card>
        )}
        <ScaleSeoHealthCard seo={summary.seo} />
      </div>

      <ModuleRail />
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-4">
      <Skeleton className="h-32 w-full rounded-card" />
      <div className="grid grid-cols-3 gap-2">
        <Skeleton className="h-16 rounded-card" />
        <Skeleton className="h-16 rounded-card" />
        <Skeleton className="h-16 rounded-card" />
      </div>
      <div className="grid grid-cols-1 gap-4 g2:grid-cols-2 dt:grid-cols-3">
        <Skeleton className="h-40 rounded-card" />
        <Skeleton className="h-40 rounded-card" />
        <Skeleton className="h-40 rounded-card" />
      </div>
      <Skeleton className="h-24 w-full rounded-card" />
    </div>
  );
}
