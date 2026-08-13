'use client';

import { useApi } from '@/lib/useApi';
import type { SummaryResponse, Signal } from '@/lib/types';
import { NextMoveCard } from '@/components/NextMoveCard';
import { SignalsList } from '@/components/SignalsList';
import { ModuleRail } from '@/components/ModuleRail';
import { MoneyValue } from '@/components/ui/MoneyValue';
import { Card } from '@/components/ui/Card';
import { formatMoney } from '@/lib/format';

export default function HomePage() {
  const { data: summary, error: summaryError, isLoading: summaryLoading } =
    useApi<SummaryResponse>('/command/summary');
  const { data: signals, isLoading: signalsLoading } = useApi<Signal[]>('/command/signals');

  if (summaryLoading) {
    return <div className="p-4 text-sm text-ink-2">Loading…</div>;
  }

  if (summaryError) {
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

  if (!summary) return null;

  return (
    <div className="flex flex-col gap-4 p-4">
      <NextMoveCard opportunity={summary.opportunities[0]} />

      <Card>
        <p className="text-xs font-medium text-ink-3">REVENUE THIS MONTH</p>
        <MoneyValue amount={summary.money.collected} source={summary.channels} size="lg" />
        <p data-numeric className="mt-2 font-mono text-xs text-ink-3">
          {Number(summary.money.outstanding) > 0
            ? `Money owed to you: ${formatMoney(summary.money.outstanding)}`
            : 'Nothing outstanding.'}
        </p>
      </Card>

      <SignalsList signals={signals ?? []} />
      {signalsLoading && <p className="text-xs text-ink-3">Loading signals…</p>}

      <ModuleRail />
    </div>
  );
}
