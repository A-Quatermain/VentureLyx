'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { MagnifyingGlass, UploadSimple } from '@phosphor-icons/react';
import { useApi, useRole, atLeast } from '@/lib/useApi';
import type { GrowContactListItem, GrowEnrollmentState } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { SkeletonCard } from '@/components/ui/Skeleton';
import { toneSoft, type Tone } from '@/components/ui/tone';

const ENROLLMENT_STATES: GrowEnrollmentState[] =
  ['active', 'replied', 'bounced', 'unsubscribed', 'completed', 'held', 'failed'];

const ENROLLMENT_TONE: Record<GrowEnrollmentState, Tone> = {
  active: 'primary',
  replied: 'success',
  bounced: 'destructive',
  unsubscribed: 'muted',
  completed: 'success',
  held: 'warning',
  failed: 'destructive',
};

export default function GrowContactsPage() {
  const router = useRouter();
  const role = useRole();
  const canEdit = atLeast(role, 'staff');
  const [tier, setTier] = useState('');
  const [region, setRegion] = useState('');
  const [contactRank, setContactRank] = useState('');
  const [enrollmentState, setEnrollmentState] = useState<GrowEnrollmentState | ''>('');
  const [page, setPage] = useState(1);

  const params = new URLSearchParams();
  if (tier.trim()) params.set('tier', tier.trim());
  if (region.trim()) params.set('region', region.trim());
  if (contactRank.trim()) params.set('contact_rank', contactRank.trim());
  if (enrollmentState) params.set('enrollment_state', enrollmentState);
  params.set('page', String(page));

  const { data: contacts, isLoading, error } = useApi<GrowContactListItem[]>(`/grow/contacts?${params.toString()}`);

  function resetPage() { setPage(1); }

  const isFiltered = !!tier.trim() || !!region.trim() || !!contactRank.trim() || !!enrollmentState;

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="font-display text-lg font-bold tracking-tight">Contacts</p>
          <p className="text-sm text-muted-foreground">Every imported prospect, filterable by tier, region, rank, and enrollment.</p>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/grow" className="text-sm font-medium text-primary hover:underline">
            ← Grow
          </Link>
          {canEdit && (
            <Link href="/grow/contacts/import">
              <Button variant="ghost">
                <UploadSimple size={14} weight="bold" className="mr-1.5 inline" /> Import contacts
              </Button>
            </Link>
          )}
        </div>
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap gap-1 rounded-full border border-border bg-surface p-1 shadow-sm">
            <button
              onClick={() => { setEnrollmentState(''); resetPage(); }}
              className={`rounded-full px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                enrollmentState === '' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              All
            </button>
            {ENROLLMENT_STATES.map((s) => (
              <button
                key={s}
                onClick={() => { setEnrollmentState(s); resetPage(); }}
                className={`rounded-full px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                  enrollmentState === s ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm text-muted-foreground">
            Tier
            <input
              value={tier}
              onChange={(e) => { setTier(e.target.value); resetPage(); }}
              placeholder="e.g. A"
              className="min-h-[38px] w-28 rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-muted-foreground">
            Region
            <input
              value={region}
              onChange={(e) => { setRegion(e.target.value); resetPage(); }}
              placeholder="e.g. FL"
              className="min-h-[38px] w-28 rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-muted-foreground">
            Contact rank
            <input
              type="number"
              min={1}
              value={contactRank}
              onChange={(e) => { setContactRank(e.target.value); resetPage(); }}
              className="min-h-[38px] w-24 rounded-lg border border-border bg-background px-3 text-sm font-mono tabular-nums text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </label>
        </div>
      </Card>

      <Card className="overflow-x-auto p-0">
        {isLoading ? (
          <SkeletonCard />
        ) : error ? (
          <p className="p-4 text-sm text-destructive">Could not load contacts.</p>
        ) : !contacts || contacts.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
            <MagnifyingGlass size={24} className="text-muted-foreground" />
            {isFiltered ? (
              <p className="text-sm text-muted-foreground">No contacts match these filters.</p>
            ) : (
              <>
                <p className="text-sm font-medium">No contacts imported yet</p>
                <p className="max-w-sm text-sm text-muted-foreground">
                  Contacts arrive as a bulk import (a CSV or Excel file), not one at a time — upload your list,
                  map its columns, and preview what will import before committing to anything.
                </p>
                {canEdit && (
                  <Link href="/grow/contacts/import" className="mt-1">
                    <Button>
                      <UploadSimple size={14} weight="bold" className="mr-1.5 inline" /> Import contacts
                    </Button>
                  </Link>
                )}
              </>
            )}
          </div>
        ) : (
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">Contact</th>
                <th className="px-4 py-2 font-medium">Entity</th>
                <th className="px-4 py-2 font-medium">Location</th>
                <th className="px-4 py-2 text-right font-medium">Rank</th>
                <th className="px-4 py-2 font-medium">Tier</th>
                <th className="px-4 py-2 font-medium">Enrollment</th>
                <th className="px-4 py-2 font-medium" />
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr
                  key={c.id}
                  onClick={() => router.push(`/grow/contacts/${c.id}/preview`)}
                  className="cursor-pointer border-b border-border last:border-0 hover:bg-muted"
                >
                  <td className="px-4 py-3">
                    <p className="font-medium">{c.contact_name ?? c.first_name ?? c.email}</p>
                    <p className="text-xs text-muted-foreground">{c.email}{c.role ? ` · ${c.role}` : ''}</p>
                  </td>
                  <td className="max-w-[220px] truncate px-4 py-3 text-muted-foreground">{c.entity_name ?? '—'}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {[c.city, c.state ?? c.region].filter(Boolean).join(', ') || '—'}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums" data-numeric>{c.contact_rank}</td>
                  <td className="px-4 py-3 text-muted-foreground">{c.tier ?? '—'}</td>
                  <td className="px-4 py-3">
                    {c.latest_enrollment_state ? (
                      <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${toneSoft[ENROLLMENT_TONE[c.latest_enrollment_state]]}`}>
                        {c.latest_enrollment_state}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">not enrolled</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className="text-sm font-medium text-primary">Preview →</span>
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
          <Button variant="ghost" onClick={() => setPage((p) => p + 1)} disabled={!contacts || contacts.length < 50}>
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
