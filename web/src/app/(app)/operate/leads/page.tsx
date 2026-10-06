'use client';

import { useState } from 'react';
import Link from 'next/link';
import { mutate } from 'swr';
import { ChatCircleText, Robot, User } from '@phosphor-icons/react';
import { useApi } from '@/lib/useApi';
import { apiFetch, ApiError } from '@/lib/api';
import type { Lead, ReplyTag } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { PageHeader } from '@/components/Primitives';

const TAG_FILTERS: Array<{ key: ReplyTag | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'interested', label: 'Interested' },
  { key: 'question', label: 'Question' },
  { key: 'not_now', label: 'Not now' },
  { key: 'not_a_fit', label: 'Not a fit' },
];

const TAG_TONE: Record<ReplyTag, string> = {
  interested: 'bg-success/10 text-success',
  question: 'bg-primary/10 text-primary',
  not_now: 'bg-muted text-muted-foreground',
  not_a_fit: 'bg-destructive/10 text-destructive',
};

function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const hours = Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function LeadsPage() {
  const [tag, setTag] = useState<ReplyTag | 'all'>('all');
  const key = `/operate/leads?sort=recent${tag !== 'all' ? `&tag=${tag}` : ''}`;
  const { data: leads, isLoading } = useApi<Lead[]>(key);
  const [workingId, setWorkingId] = useState<string | null>(null);

  async function startWorking(id: string) {
    setWorkingId(id);
    try {
      await apiFetch(`/operate/leads/${id}/start-working`, { method: 'POST' });
      await mutate((k: string) => typeof k === 'string' && k.startsWith('/operate/leads'), undefined, { revalidate: true });
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Could not start working this lead.');
    } finally {
      setWorkingId(null);
    }
  }

  return (
    <div className="p-4">
      <PageHeader
        eyebrow="Operate"
        title="Leads"
        subtitle="Campaign replies and manually-added leads, newest first. Work the interested ones first."
      />

      <div className="mb-4 flex w-fit gap-1 rounded-full border border-border bg-surface p-1 shadow-sm">
        {TAG_FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setTag(f.key)}
            className={`whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              tag === f.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-24 rounded-xl bg-muted" />
          <Skeleton className="h-24 rounded-xl bg-muted" />
          <Skeleton className="h-24 rounded-xl bg-muted" />
        </div>
      ) : !leads || leads.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-sm text-muted-foreground">
            {tag === 'all' ? 'No leads yet.' : `No leads tagged "${TAG_FILTERS.find((f) => f.key === tag)?.label}".`}
          </p>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {leads.map((lead) => (
            <Card key={lead.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/operate/customers/${lead.id}`} className="text-sm font-semibold hover:underline">
                      {lead.display_name}
                    </Link>
                    {lead.reply_tag && (
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${TAG_TONE[lead.reply_tag]}`}>
                        {lead.reply_tag_source === 'ai' ? <Robot size={11} weight="bold" /> : <User size={11} weight="bold" />}
                        {lead.reply_tag.replace(/_/g, ' ')}
                      </span>
                    )}
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                      {lead.lifecycle}
                    </span>
                  </div>
                  {lead.last_reply_body ? (
                    <div className="mt-2 flex items-start gap-1.5 rounded-lg bg-muted/50 p-2.5">
                      <ChatCircleText size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
                      <p className="line-clamp-2 text-sm text-foreground">{lead.last_reply_body}</p>
                    </div>
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {lead.source ? `From ${lead.source}` : 'No reply on file'}
                    </p>
                  )}
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {lead.owner_name ? `Working: ${lead.owner_name} · ` : ''}
                    {relativeTime(lead.last_reply_at ?? lead.last_activity_at)}
                  </p>
                </div>
                {!lead.owner_user_id && (
                  <Button
                    variant="ghost"
                    disabled={workingId === lead.id}
                    onClick={() => startWorking(lead.id)}
                    className="shrink-0"
                  >
                    {workingId === lead.id ? 'Starting…' : 'Start working this'}
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
