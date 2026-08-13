'use client';

import { useApi } from '@/lib/useApi';
import type { SummaryResponse, Signal, Lead, MeResponse } from '@/lib/types';
import { NextMoveCard } from '@/components/NextMoveCard';
import { WorthDoingCard } from '@/components/WorthDoingCard';
import { NewLeadsCard } from '@/components/NewLeadsCard';
import { ModuleRail } from '@/components/ModuleRail';
import { RevenueCard } from '@/components/RevenueCard';
import { ScaleSeoHealthCard } from '@/components/ScaleSeoHealthCard';
import { StatStrip } from '@/components/ui/StatStrip';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export default function HomePage() {
  const { data: summary, error: summaryError, isLoading: summaryLoading } =
    useApi<SummaryResponse>('/command/summary');
  const { data: signals } = useApi<Signal[]>('/command/signals');
  const { data: leads } = useApi<Lead[]>('/operate/leads');
  const { data: me } = useApi<MeResponse>('/auth/me');

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

  const firstName = me?.user?.name?.split(' ')[0];
  const remainingOpportunities = summary.opportunities.slice(1);

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-ink-3">
          {new Date().toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long' })}
        </p>
        <p className="font-display text-2xl font-extrabold text-deepwater">
          {greeting()}{firstName ? `, ${firstName}` : ''}
        </p>
        <p className="mt-1 text-sm text-ink-2">Here&apos;s where the business stands today.</p>
      </div>

      <NextMoveCard opportunity={summary.opportunities[0]} />

      <StatStrip
        stats={[
          {
            label: 'Jobs done today',
            value: `${summary.work.today_done}/${summary.work.today_total}`,
          },
          { label: 'New leads', value: String(summary.leads.new_leads) },
          { label: 'Site health', value: summary.seo?.health != null ? String(summary.seo.health) : '—' },
        ]}
      />

      <div className="grid grid-cols-1 gap-4 g2:grid-cols-2 dt:grid-cols-3">
        <div className="dt:col-span-2">
          <RevenueCard
            collected={summary.money.collected}
            outstanding={summary.money.outstanding}
            lastMonth={summary.money.last_month}
            channels={summary.channels}
          />
        </div>
        <ScaleSeoHealthCard seo={summary.seo} />

        <WorthDoingCard opportunities={remainingOpportunities} signals={signals ?? []} />
        <div className="dt:col-span-2">
          <NewLeadsCard leads={leads ?? []} />
        </div>
      </div>

      <ModuleRail leadCount={leads?.length} seoHealth={summary.seo?.health} />
    </div>
  );
}

function HomeSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="space-y-2">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-7 w-48" />
      </div>
      <Skeleton className="h-32 w-full rounded-card" />
      <div className="grid grid-cols-3 gap-2">
        <Skeleton className="h-16 rounded-card" />
        <Skeleton className="h-16 rounded-card" />
        <Skeleton className="h-16 rounded-card" />
      </div>
      <div className="grid grid-cols-1 gap-4 g2:grid-cols-2 dt:grid-cols-3">
        <Skeleton className="h-40 rounded-card dt:col-span-2" />
        <Skeleton className="h-40 rounded-card" />
        <Skeleton className="h-40 rounded-card" />
        <Skeleton className="h-40 rounded-card dt:col-span-2" />
      </div>
      <Skeleton className="h-24 w-full rounded-card" />
    </div>
  );
}
