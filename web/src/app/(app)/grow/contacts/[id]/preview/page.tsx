'use client';

import { use } from 'react';
import Link from 'next/link';
import { CaretLeft, WarningCircle, Megaphone, EnvelopeSimple } from '@phosphor-icons/react';
import { useApi } from '@/lib/useApi';
import type { GrowContactPreview } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';

export default function GrowContactPreviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const { data, isLoading, error } = useApi<GrowContactPreview>(`/grow/contacts/${id}/preview`);

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <Link
            href="/grow/contacts"
            className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <CaretLeft size={14} weight="bold" /> Contacts
          </Link>
          <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">Email preview</h1>
        </div>
      </div>

      {isLoading ? (
        <div className="flex flex-col gap-4">
          <Skeleton className="h-16 rounded-xl bg-muted" />
          <Skeleton className="h-72 rounded-xl bg-muted" />
        </div>
      ) : error ? (
        <Card className="p-4">
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : 'Could not load a preview for this contact.'}
          </p>
        </Card>
      ) : !data ? null : (
        <>
          {data.refused && (
            <Card className="flex items-start gap-3 border-destructive/40 bg-destructive/5 p-4">
              <WarningCircle size={20} weight="fill" className="mt-0.5 shrink-0 text-destructive" />
              <div>
                <p className="text-sm font-semibold text-destructive">This message would not send</p>
                <p className="mt-1 text-sm text-destructive">{data.refusal_reason}</p>
              </div>
            </Card>
          )}

          <Card className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-3">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                <Megaphone size={15} className="text-muted-foreground" />
              </div>
              <div className="min-w-0">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Campaign</p>
                <p className="truncate text-sm font-medium">{data.campaign_name}</p>
              </div>
            </div>
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                <span className="font-mono text-xs font-semibold text-muted-foreground" data-numeric>{data.step_no}</span>
              </div>
              <div className="min-w-0">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Step</p>
                <p className="text-sm font-medium">Step {data.step_no}</p>
              </div>
            </div>
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted">
                <EnvelopeSimple size={15} className="text-muted-foreground" />
              </div>
              <div className="min-w-0">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">To</p>
                <p className="truncate text-sm font-medium">{data.to}</p>
              </div>
            </div>
          </Card>

          <Card className="p-0">
            <div className="border-b border-border px-5 py-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Subject</p>
              <p className="mt-1 text-base font-semibold">{data.subject}</p>
            </div>
            <div className="px-5 py-5">
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{data.body}</p>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
