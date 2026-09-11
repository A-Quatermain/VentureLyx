'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { mutate } from 'swr';
import { MagnifyingGlass, UploadSimple, Trash, ProhibitInset, X } from '@phosphor-icons/react';
import { useApi, useRole, atLeast } from '@/lib/useApi';
import { apiFetch, ApiError } from '@/lib/api';
import type {
  GrowContactListItem, GrowEnrollmentState, GrowCampaign, OrgProfile,
  GrowContactIdsResponse, GrowBulkDeleteContactsResponse, GrowBulkSuppressResponse,
  GrowBulkEnrollmentDeleteResponse,
} from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { SkeletonCard } from '@/components/ui/Skeleton';
import { toneSoft, type Tone } from '@/components/ui/tone';
import { GrowClearAllContactsDialog } from '@/components/GrowClearAllContactsDialog';

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

const CONTACTS_KEY_PREFIX = '/grow/contacts';

function contactsKey(params: URLSearchParams) {
  return `${CONTACTS_KEY_PREFIX}?${params.toString()}`;
}

export default function GrowContactsPage() {
  const router = useRouter();
  const role = useRole();
  const canEdit = atLeast(role, 'staff');
  const canDelete = atLeast(role, 'manager');

  const [tier, setTier] = useState('');
  const [region, setRegion] = useState('');
  const [contactRank, setContactRank] = useState('');
  const [enrollmentState, setEnrollmentState] = useState<GrowEnrollmentState | ''>('');
  const [campaignId, setCampaignId] = useState('');
  const [suppressedOnly, setSuppressedOnly] = useState(false);
  const [page, setPage] = useState(1);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeTone, setNoticeTone] = useState<Tone>('muted');
  const [clearAllOpen, setClearAllOpen] = useState(false);

  const params = new URLSearchParams();
  if (tier.trim()) params.set('tier', tier.trim());
  if (region.trim()) params.set('region', region.trim());
  if (contactRank.trim()) params.set('contact_rank', contactRank.trim());
  if (enrollmentState) params.set('enrollment_state', enrollmentState);
  if (campaignId) params.set('campaign_id', campaignId);
  if (suppressedOnly) params.set('suppressed', 'true');
  params.set('page', String(page));

  const key = contactsKey(params);
  const { data: contacts, isLoading, error } = useApi<GrowContactListItem[]>(key);
  const { data: campaigns } = useApi<GrowCampaign[]>('/grow/campaigns');
  const { data: org } = useApi<OrgProfile>('/orgs/current');

  function resetPage() { setPage(1); }
  function clearSelection() { setSelected(new Set()); }

  function updateFilter(fn: () => void) {
    fn();
    resetPage();
    clearSelection();
    setNotice(null);
  }

  function say(message: string, tone: Tone = 'muted') {
    setNotice(message);
    setNoticeTone(tone);
  }

  function toggleOne(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAllOnPage() {
    if (!contacts) return;
    setSelected((s) => {
      const allOnPageSelected = contacts.every((c) => s.has(c.id));
      const next = new Set(s);
      if (allOnPageSelected) {
        contacts.forEach((c) => next.delete(c.id));
      } else {
        contacts.forEach((c) => next.add(c.id));
      }
      return next;
    });
  }

  async function selectAllMatching() {
    const idParams = new URLSearchParams(params);
    idParams.delete('page');
    try {
      const res = await apiFetch<GrowContactIdsResponse>(`/grow/contacts/ids?${idParams.toString()}`);
      setSelected(new Set(res.ids));
      say(res.truncated
        ? `Selected the first ${res.ids.length.toLocaleString()} matching contacts (there are more — narrow the filter to reach the rest).`
        : `Selected all ${res.ids.length.toLocaleString()} matching contact${res.ids.length === 1 ? '' : 's'}.`);
    } catch (err) {
      say(err instanceof ApiError ? err.message : 'Could not select all matching contacts.', 'destructive');
    }
  }

  async function refresh() {
    await mutate(key);
  }

  async function onDeleteOne(c: GrowContactListItem) {
    if (!window.confirm(`Delete ${c.email}? This can't be undone.`)) return;
    try {
      await apiFetch(`/grow/contacts/${c.id}`, { method: 'DELETE' });
      await refresh();
      say(`Deleted ${c.email}.`, 'success');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'has_message_history') {
        const suppress = window.confirm(`${err.message}\n\nSuppress ${c.email} instead?`);
        if (suppress) await onSuppressOne(c, false);
        return;
      }
      say(err instanceof ApiError ? err.message : `Could not delete ${c.email}.`, 'destructive');
    }
  }

  async function onSuppressOne(c: GrowContactListItem, confirmFirst = true) {
    if (confirmFirst && !window.confirm(`Suppress ${c.email}? No campaign in this org will ever email it again.`)) return;
    try {
      await apiFetch(`/grow/contacts/${c.id}/suppress`, { method: 'POST' });
      await refresh();
      say(`Suppressed ${c.email}.`, 'success');
    } catch (err) {
      say(err instanceof ApiError ? err.message : `Could not suppress ${c.email}.`, 'destructive');
    }
  }

  async function onUnsuppressOne(c: GrowContactListItem) {
    if (!c.suppression_id) return;
    if (!window.confirm(`Remove the suppression on ${c.email}? It will be eligible to receive mail again.`)) return;
    try {
      await apiFetch(`/grow/suppressions/${c.suppression_id}`, { method: 'DELETE' });
      await refresh();
      say(`Un-suppressed ${c.email}.`, 'success');
    } catch (err) {
      say(err instanceof ApiError ? err.message : `Could not un-suppress ${c.email}.`, 'destructive');
    }
  }

  async function onRemoveFromCampaignOne(c: GrowContactListItem) {
    if (!c.enrollment_id) return;
    if (!window.confirm(`Remove ${c.email} from this campaign? The contact itself is kept.`)) return;
    try {
      await apiFetch(`/grow/enrollments/${c.enrollment_id}`, { method: 'DELETE' });
      await refresh();
      say(`Removed ${c.email} from this campaign.`, 'success');
    } catch (err) {
      say(err instanceof ApiError ? err.message : `Could not remove ${c.email} from this campaign.`, 'destructive');
    }
  }

  async function onBulkDelete() {
    const count = selected.size;
    if (!window.confirm(`Delete ${count} contact${count === 1 ? '' : 's'}? This can't be undone. Any with send history will be skipped and reported.`)) return;
    setBulkBusy(true);
    try {
      const res = await apiFetch<GrowBulkDeleteContactsResponse>('/grow/contacts/bulk-delete', {
        method: 'POST', body: JSON.stringify({ ids: [...selected] }),
      });
      clearSelection();
      await refresh();
      say(
        res.blocked.length > 0
          ? `Deleted ${res.deleted}. ${res.blocked.length} skipped (send history on record) — suppress those instead.`
          : `Deleted ${res.deleted} contact${res.deleted === 1 ? '' : 's'}.`,
        res.blocked.length > 0 ? 'warning' : 'success',
      );
    } catch (err) {
      say(err instanceof ApiError ? err.message : 'Could not delete these contacts.', 'destructive');
    } finally {
      setBulkBusy(false);
    }
  }

  async function onBulkSuppress() {
    const count = selected.size;
    if (!window.confirm(`Suppress ${count} contact${count === 1 ? '' : 's'}? No campaign in this org will ever email them again.`)) return;
    setBulkBusy(true);
    try {
      const res = await apiFetch<GrowBulkSuppressResponse>('/grow/contacts/bulk-suppress', {
        method: 'POST', body: JSON.stringify({ ids: [...selected] }),
      });
      clearSelection();
      await refresh();
      say(
        res.alreadySuppressed > 0
          ? `Suppressed ${res.suppressed} (${res.alreadySuppressed} already were).`
          : `Suppressed ${res.suppressed} contact${res.suppressed === 1 ? '' : 's'}.`,
        'success',
      );
    } catch (err) {
      say(err instanceof ApiError ? err.message : 'Could not suppress these contacts.', 'destructive');
    } finally {
      setBulkBusy(false);
    }
  }

  async function onBulkRemoveFromCampaign() {
    if (!campaignId) return;
    const count = selected.size;
    const name = campaigns?.find((c) => c.id === campaignId)?.name ?? 'this campaign';
    if (!window.confirm(`Remove ${count} contact${count === 1 ? '' : 's'} from "${name}"? Each contact itself is kept.`)) return;
    setBulkBusy(true);
    try {
      const res = await apiFetch<GrowBulkEnrollmentDeleteResponse>(`/grow/campaigns/${campaignId}/remove-contacts`, {
        method: 'POST', body: JSON.stringify({ ids: [...selected] }),
      });
      clearSelection();
      await refresh();
      say(`Removed ${res.removed} from "${name}"${res.ungated > 0 ? ` (${res.ungated} gated enrollment(s) freed up)` : ''}.`, 'success');
    } catch (err) {
      say(err instanceof ApiError ? err.message : 'Could not remove these contacts from the campaign.', 'destructive');
    } finally {
      setBulkBusy(false);
    }
  }

  const isFiltered = !!tier.trim() || !!region.trim() || !!contactRank.trim() || !!enrollmentState || !!campaignId || suppressedOnly;
  const allOnPageSelected = !!contacts && contacts.length > 0 && contacts.every((c) => selected.has(c.id));

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
          {canDelete && org && (
            <Button variant="ghost" onClick={() => setClearAllOpen(true)} className="text-destructive hover:bg-destructive/10">
              <Trash size={14} weight="bold" className="mr-1.5 inline" /> Clear all
            </Button>
          )}
        </div>
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap gap-1 rounded-full border border-border bg-surface p-1 shadow-sm">
            <button
              onClick={() => updateFilter(() => setEnrollmentState(''))}
              className={`rounded-full px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                enrollmentState === '' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              All
            </button>
            {ENROLLMENT_STATES.map((s) => (
              <button
                key={s}
                onClick={() => updateFilter(() => setEnrollmentState(s))}
                className={`rounded-full px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                  enrollmentState === s ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <button
            onClick={() => updateFilter(() => setSuppressedOnly((v) => !v))}
            className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
              suppressedOnly
                ? 'border-destructive bg-destructive/10 text-destructive'
                : 'border-border text-muted-foreground hover:bg-muted'
            }`}
          >
            <ProhibitInset size={12} weight="bold" /> Suppressed only
          </button>
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm text-muted-foreground">
            Tier
            <input
              value={tier}
              onChange={(e) => updateFilter(() => setTier(e.target.value))}
              placeholder="e.g. A"
              className="min-h-[38px] w-28 rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-muted-foreground">
            Region
            <input
              value={region}
              onChange={(e) => updateFilter(() => setRegion(e.target.value))}
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
              onChange={(e) => updateFilter(() => setContactRank(e.target.value))}
              className="min-h-[38px] w-24 rounded-lg border border-border bg-background px-3 text-sm font-mono tabular-nums text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-muted-foreground">
            Campaign
            <select
              value={campaignId}
              onChange={(e) => updateFilter(() => setCampaignId(e.target.value))}
              className="min-h-[38px] w-56 rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            >
              <option value="">Any campaign</option>
              {campaigns?.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          {!campaignId && (
            <p className="max-w-xs pb-2.5 text-xs text-muted-foreground">
              Pick a campaign to enable &ldquo;remove from campaign&rdquo; on the contacts it applies to.
            </p>
          )}
        </div>
      </Card>

      {selected.size > 0 && (
        <Card className="flex flex-wrap items-center justify-between gap-3 border-primary/40 bg-primary/5 p-3">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="font-medium">{selected.size.toLocaleString()} selected</span>
            <button onClick={selectAllMatching} className="text-primary hover:underline">
              Select all matching this filter
            </button>
            <button onClick={clearSelection} className="text-muted-foreground hover:underline">
              Clear selection
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {canEdit && (
              <Button variant="ghost" onClick={onBulkSuppress} disabled={bulkBusy}>
                <ProhibitInset size={14} weight="bold" className="mr-1.5 inline" /> Suppress
              </Button>
            )}
            {canEdit && (
              <Button
                variant="ghost"
                onClick={onBulkRemoveFromCampaign}
                disabled={bulkBusy || !campaignId}
                title={campaignId ? undefined : 'Filter by a campaign first'}
              >
                <X size={14} weight="bold" className="mr-1.5 inline" /> Remove from campaign
              </Button>
            )}
            {canDelete && (
              <Button variant="attention" onClick={onBulkDelete} disabled={bulkBusy}>
                <Trash size={14} weight="bold" className="mr-1.5 inline" /> Delete
              </Button>
            )}
          </div>
        </Card>
      )}

      {notice && (
        <p className={`-mt-2 rounded-lg px-3 py-2 text-sm ${toneSoft[noticeTone]}`}>{notice}</p>
      )}

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
          <table className="w-full min-w-[960px] text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th className="w-10 px-4 py-2">
                  <input
                    type="checkbox"
                    checked={allOnPageSelected}
                    onChange={toggleAllOnPage}
                    className="h-4 w-4 rounded border-border"
                    aria-label="Select all on this page"
                  />
                </th>
                <th className="px-4 py-2 font-medium">Contact</th>
                <th className="px-4 py-2 font-medium">Entity</th>
                <th className="px-4 py-2 font-medium">Location</th>
                <th className="px-4 py-2 text-right font-medium">Rank</th>
                <th className="px-4 py-2 font-medium">Tier</th>
                <th className="px-4 py-2 font-medium">Status</th>
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
                  <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      checked={selected.has(c.id)}
                      onChange={() => toggleOne(c.id)}
                      className="h-4 w-4 rounded border-border"
                      aria-label={`Select ${c.email}`}
                    />
                  </td>
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
                    <div className="flex flex-col gap-1">
                      {c.suppression_reason && (
                        <span
                          title={c.suppression_created_at ? new Date(c.suppression_created_at).toLocaleString() : undefined}
                          className={`w-fit rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${toneSoft.destructive}`}
                        >
                          Suppressed · {c.suppression_reason.replace('_', ' ')}
                        </span>
                      )}
                      {c.latest_enrollment_state ? (
                        <span className={`w-fit rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${toneSoft[ENROLLMENT_TONE[c.latest_enrollment_state]]}`}>
                          {c.latest_enrollment_state}
                        </span>
                      ) : !c.suppression_reason ? (
                        <span className="text-xs text-muted-foreground">not enrolled</span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right" onClick={(e) => e.stopPropagation()}>
                    <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-xs">
                      {canEdit && (
                        c.suppression_reason === 'manual' ? (
                          <button onClick={() => onUnsuppressOne(c)} className="text-primary hover:underline">
                            Un-suppress
                          </button>
                        ) : !c.suppression_reason ? (
                          <button onClick={() => onSuppressOne(c)} className="text-muted-foreground hover:text-destructive hover:underline">
                            Suppress
                          </button>
                        ) : null
                      )}
                      {canEdit && campaignId && c.enrollment_id && (
                        <button onClick={() => onRemoveFromCampaignOne(c)} className="text-muted-foreground hover:text-destructive hover:underline">
                          Remove from campaign
                        </button>
                      )}
                      {canDelete && (
                        <button onClick={() => onDeleteOne(c)} className="text-muted-foreground hover:text-destructive hover:underline">
                          Delete
                        </button>
                      )}
                      <span className="font-medium text-primary">Preview →</span>
                    </div>
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

      {org && (
        <GrowClearAllContactsDialog
          open={clearAllOpen}
          onOpenChange={setClearAllOpen}
          orgName={org.name}
          onCleared={(deleted) => {
            clearSelection();
            refresh();
            say(`Cleared ${deleted} contact${deleted === 1 ? '' : 's'}.`, 'success');
          }}
        />
      )}
    </div>
  );
}
