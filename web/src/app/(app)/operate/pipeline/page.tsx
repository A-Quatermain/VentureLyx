'use client';

import { useState } from 'react';
import Link from 'next/link';
import { mutate } from 'swr';
import { Briefcase, Stack } from '@phosphor-icons/react';
import { useApi } from '@/lib/useApi';
import { apiFetch, ApiError } from '@/lib/api';
import type { PipelineBoard, PipelineDeal } from '@/lib/types';
import { formatMoney } from '@/lib/format';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { PageHeader } from '@/components/Primitives';

const PIPELINE_KEY = '/operate/pipeline';

export default function PipelinePage() {
  const { data, isLoading } = useApi<PipelineBoard>(PIPELINE_KEY);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function moveDeal(dealId: string, stage: string) {
    if (!data) return;
    const deal = data.deals.find((d) => d.id === dealId);
    if (!deal || deal.stage === stage) return;

    // Optimistic: the board should feel instant, not wait on a round trip
    // for something as simple as a column change.
    const optimistic: PipelineBoard = {
      ...data,
      deals: data.deals.map((d) => (d.id === dealId ? { ...d, stage } : d)),
    };
    await mutate(PIPELINE_KEY, optimistic, { revalidate: false });

    try {
      await apiFetch(`/operate/pipeline/deals/${dealId}/stage`, {
        method: 'PATCH',
        body: JSON.stringify({ stage }),
      });
      await mutate(PIPELINE_KEY);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not move this deal.');
      await mutate(PIPELINE_KEY); // revert to server truth
    }
  }

  if (isLoading || !data) {
    return (
      <div className="p-4">
        <PageHeader eyebrow="Operate" title="Pipeline" subtitle="Every deal, from new lead to won." />
        <div className="flex gap-4 overflow-x-auto pb-2">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-[70vh] w-72 shrink-0 rounded-xl bg-muted" />
          ))}
        </div>
      </div>
    );
  }

  const { pipeline, deals } = data;
  const totalValue = deals.reduce((sum, d) => sum + (d.value ? Number(d.value) : 0), 0);

  return (
    <div className="p-4">
      <PageHeader
        eyebrow="Operate"
        title="Pipeline"
        subtitle="Every deal, from new lead to won. Drag a card to move it."
        actions={
          <div className="flex items-center gap-2 rounded-xl border border-border bg-surface px-4 py-2.5 shadow-sm">
            <Briefcase size={16} weight="duotone" className="text-primary" />
            <span className="font-mono text-sm font-semibold tabular-nums" data-numeric>
              {formatMoney(String(totalValue))}
            </span>
            <span className="text-xs text-muted-foreground">
              · {deals.length} open deal{deals.length === 1 ? '' : 's'}
            </span>
          </div>
        }
      />
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}

      <div className="flex gap-4 overflow-x-auto pb-2">
        {pipeline.stages.map((stage) => {
          const items = deals.filter((d) => d.stage === stage.key);
          const stageValue = items.reduce((sum, d) => sum + (d.value ? Number(d.value) : 0), 0);
          return (
            <div
              key={stage.key}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const dealId = e.dataTransfer.getData('text/plain');
                if (dealId) void moveDeal(dealId, stage.key);
                setDraggingId(null);
              }}
              className="min-h-[70vh] w-72 shrink-0 rounded-xl border border-border bg-surface shadow-sm"
            >
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <span className="text-sm font-semibold">{stage.label}</span>
                <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-xs tabular-nums text-muted-foreground">
                  {items.length}
                </span>
              </div>
              {items.length > 0 && (
                <div className="border-b border-border px-4 py-1.5 text-xs text-muted-foreground">
                  {formatMoney(String(stageValue))}
                </div>
              )}
              <div className="space-y-3 p-3">
                {items.map((deal) => (
                  <DealCard key={deal.id} deal={deal} dragging={draggingId === deal.id} onDragStart={setDraggingId} />
                ))}
                {items.length === 0 && <p className="px-1 py-4 text-xs text-muted-foreground/60">Empty</p>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DealCard({
  deal, dragging, onDragStart,
}: {
  deal: PipelineDeal;
  dragging: boolean;
  onDragStart: (id: string | null) => void;
}) {
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', deal.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart(deal.id);
      }}
      onDragEnd={() => onDragStart(null)}
      className={`cursor-grab rounded-lg border border-border bg-background p-3 shadow-sm active:cursor-grabbing ${
        dragging ? 'opacity-40' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <Link href={`/operate/customers/${deal.party_id}`} className="text-sm font-semibold hover:underline">
          {deal.party_name}
        </Link>
        <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase text-primary">
          {deal.source}
        </span>
      </div>
      <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
        <Stack size={12} /> {deal.title}
      </p>
      <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
        <span className="font-mono text-xs font-medium tabular-nums" data-numeric>
          {deal.value ? formatMoney(deal.value) : '—'}
        </span>
        <span className="text-xs text-muted-foreground">
          {deal.days_in_stage === 0 ? 'today' : `${deal.days_in_stage}d in stage`}
        </span>
      </div>
    </div>
  );
}
