'use client';

import { useState, useEffect, Fragment } from 'react';
import Link from 'next/link';
import { mutate } from 'swr';
import { Tray, CaretDown, Warning, ArrowsClockwise, PaperPlaneTilt } from '@phosphor-icons/react';
import { useApi, useRole, atLeast } from '@/lib/useApi';
import { apiFetch, ApiError } from '@/lib/api';
import type {
  GrowCampaign, GrowMessage, GrowMessageStatus, GrowBounceSummary, GrowBounceType,
  GrowRecoverableMessage, GrowResendResult, GrowFallbackDraft, GrowFallbackDraftSendResult,
  GrowGenerateDraftsResult, GrowMailbox, GrowAlternateChannelSettings,
} from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { SkeletonCard } from '@/components/ui/Skeleton';
import { toneSoft, type Tone } from '@/components/ui/tone';

const BOUNCE_TYPE_TONE: Record<GrowBounceType, Tone> = {
  hard: 'destructive', block: 'warning', soft: 'muted', unknown: 'muted',
};
function BounceSummaryBar({ campaignId }: { campaignId: string }) {
  const params = new URLSearchParams();
  if (campaignId) params.set('campaign_id', campaignId);
  const { data } = useApi<GrowBounceSummary>(`/grow/messages/bounce-summary?${params.toString()}`);
  if (!data || data.total === 0) return null;

  const parts = [
    { type: 'hard' as const, count: data.hard, noun: data.hard === 1 ? 'bad address' : 'bad addresses' },
    { type: 'block' as const, count: data.block, noun: 'blocked' },
    { type: 'soft' as const, count: data.soft, noun: 'temporary' },
    { type: 'unknown' as const, count: data.unknown, noun: 'other' },
  ].filter((p) => p.count > 0);

  return (
    <Card className="flex flex-wrap items-center gap-2 p-3">
      {parts.map((p) => (
        <span key={p.type} className={`rounded-full px-2.5 py-1 text-xs font-medium ${toneSoft[BOUNCE_TYPE_TONE[p.type]]}`}>
          {p.count} {p.noun}
        </span>
      ))}
    </Card>
  );
}

// The reasoning panel ADDS to the row below it — it never replaces a
// column. Spans the full table width, rendered as its own <tr> directly
// after the message's normal row, only while that row is expanded.
function BounceReasonPanel({ message }: { message: GrowMessage }) {
  const type = message.bounce_type;
  return (
    <tr className="border-b border-border bg-muted/20 last:border-0">
      <td colSpan={8} className="px-4 py-3">
        <div className="flex flex-col gap-2 pl-6">
          <div className="flex items-center gap-2">
            {type && message.category && (
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${toneSoft[BOUNCE_TYPE_TONE[type]]}`}>
                {message.category}
              </span>
            )}
            {message.explanation && <p className="text-xs text-muted-foreground">{message.explanation}</p>}
          </div>
          {message.action && (
            <div className="rounded-lg bg-muted/50 p-2 text-xs">
              <span className="font-medium">Recommended action: </span>{message.action}
            </div>
          )}
          {message.bounce_reason_raw && (
            <details className="rounded-lg border border-border p-2">
              <summary className="cursor-pointer text-xs text-muted-foreground">Raw server response</summary>
              <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">
                {message.bounce_reason_raw}
              </pre>
            </details>
          )}
        </div>
      </td>
    </tr>
  );
}

const RECOVERABLE_KEY = '/grow/messages/recoverable';
const BOUNCE_SUMMARY_KEY = '/grow/messages/bounce-summary?';

// Bulk actions (resend / generate draft / send draft) return one result per
// id — printing one line per id doesn't scale past a handful (a 30-row
// batch that all fails the same way printed 30 identical lines, with no
// aggregate at all). Groups by outcome + exact reason instead: "28 failed:
// AI provider unavailable" reads at a glance; 30 copies of the same
// sentence don't.
function summarizeOutcomes(items: Array<{ ok: boolean; reason?: string | null }>, okLabel: string): string[] {
  const okCount = items.filter((i) => i.ok).length;
  const lines: string[] = [];
  if (okCount > 0) lines.push(`${okCount} ${okLabel}`);
  const byReason = new Map<string, number>();
  for (const item of items) {
    if (item.ok) continue;
    const key = item.reason ?? 'unknown error';
    byReason.set(key, (byReason.get(key) ?? 0) + 1);
  }
  for (const [reason, count] of byReason) {
    lines.push(`${count} failed: ${reason}`);
  }
  return lines;
}

function ResultSummary({
  items, attemptedCount, okLabel,
}: {
  items: Array<{ ok: boolean; reason?: string | null }>;
  attemptedCount: number;
  okLabel: string;
}) {
  const lines = summarizeOutcomes(items, okLabel);
  return (
    <>
      <p className="text-xs font-medium">{attemptedCount} attempted</p>
      {lines.map((line) => (
        <p key={line} className={`text-xs ${line.startsWith('0') || line.includes('failed') ? 'text-destructive' : 'text-success'}`}>
          {line}
        </p>
      ))}
    </>
  );
}

// Spec: call out `unknown` distinctly — it means the classifier couldn't
// extract a DSN code at all, NOT that the address is fine.
function ReasonCell({ m }: { m: GrowRecoverableMessage }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${toneSoft[BOUNCE_TYPE_TONE[m.bounce_type]]}`}>
          {m.category}
        </span>
        {m.bounce_type === 'unknown' && (
          <span className="inline-flex items-center gap-1 rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-warning">
            <Warning size={10} weight="bold" /> needs a human look
          </span>
        )}
      </div>
      <p className="max-w-xs text-xs text-muted-foreground">{m.explanation}</p>
    </div>
  );
}

function DraftStatusChip({ status }: { status: GrowRecoverableMessage['draft_status'] }) {
  if (status === 'draft') return <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-primary">draft ready</span>;
  if (status === 'sent') return <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-success">sent via alt. channel</span>;
  if (status === 'skipped_adhoc') return <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">draft copied</span>;
  if (status === 'failed') return <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-destructive">send failed</span>;
  return null;
}

function RecoverableBucket({ canManage }: { canManage: boolean }) {
  const { data: messages, isLoading, error } = useApi<GrowRecoverableMessage[]>(RECOVERABLE_KEY);
  const { data: summary } = useApi<GrowBounceSummary>(`${BOUNCE_SUMMARY_KEY}`);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [resending, setResending] = useState(false);
  const [resendReport, setResendReport] = useState<GrowResendResult['results'] | null>(null);
  const [showDrafts, setShowDrafts] = useState(false);
  const [showGenerate, setShowGenerate] = useState(false);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  // "Respecting the active filter" — this bucket only ever shows the
  // currently-fetched Recoverable rows (never Permanent ones), so select-
  // all here always means every SELECTABLE row visible right now. Excludes
  // suppressed rows — every action on one refuses ("suppression always
  // wins"), so select-all pulling them in just fills the batch with rows
  // that can't do anything.
  const selectableMessages = (messages ?? []).filter((m) => !m.suppressed);
  function toggleAll() {
    setSelected((prev) => (
      prev.size === selectableMessages.length
        ? new Set()
        : new Set(selectableMessages.map((m) => m.id))
    ));
  }

  async function onResend() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    setResending(true);
    setResendReport(null);
    let result: GrowResendResult;
    try {
      result = await apiFetch<GrowResendResult>('/grow/messages/resend', {
        method: 'POST',
        body: JSON.stringify({ message_ids: ids }),
      });
    } catch (err) {
      // A failure HERE means the request itself never completed — every
      // id gets the same reason, there's nothing more specific to report.
      setResendReport(ids.map((id) => ({ id, ok: false, reason: err instanceof ApiError ? err.message : 'Could not reach the server — try again.' })));
      setResending(false);
      return;
    }
    // The real, per-id aggregated result — shown now, and never clobbered
    // by anything that happens after. A stale badge count from a failed
    // refresh below is a cosmetic problem; silently replacing "3 skipped:
    // suppressed" with a generic "Resend failed" is not.
    setResendReport(result.results);
    setSelected(new Set());
    try {
      await Promise.all([mutate(RECOVERABLE_KEY), mutate((k: string) => k.startsWith(BOUNCE_SUMMARY_KEY))]);
    } catch {
      // Result already shown correctly; list/badge just stay stale until next load.
    }
    setResending(false);
  }

  if (isLoading) return <SkeletonCard />;
  if (error) return <p className="p-4 text-sm text-destructive">Could not load the recoverable bucket.</p>;
  if (!messages || messages.length === 0) {
    return (
      <Card className="flex flex-col items-center gap-2 px-4 py-12 text-center">
        <Tray size={24} className="text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Nothing recoverable right now — nicely clean.</p>
      </Card>
    );
  }

  const selectedList = messages.filter((m) => selected.has(m.id));
  const anyResendable = selectedList.some((m) => m.resendable);

  return (
    <div className="flex flex-col gap-3">
      {canManage && !!summary?.drafts_ready && (
        <Card className="flex flex-wrap items-center gap-3 border-primary/40 bg-primary/5 p-3">
          <PaperPlaneTilt size={16} weight="bold" className="text-primary" />
          <p className="text-sm">
            <span className="font-semibold">{summary.drafts_ready}</span> alternate-channel draft
            {summary.drafts_ready === 1 ? '' : 's'} ready — written automatically, nothing sends until you review.
          </p>
          <Button onClick={() => setShowDrafts(true)} className="ml-auto">Review drafts</Button>
        </Card>
      )}

      {canManage && selected.size > 0 && (
        <Card className="flex flex-wrap items-center gap-3 p-3">
          <p className="text-sm font-medium">{selected.size} of {selectableMessages.length} selected</p>
          <Button onClick={onResend} disabled={resending || !anyResendable} className="ml-auto">
            <ArrowsClockwise size={14} weight="bold" className="mr-1 inline" /> {resending ? 'Resending…' : 'Resend'}
          </Button>
          <Button variant="ai" onClick={() => setShowGenerate(true)}>
            <PaperPlaneTilt size={14} weight="bold" className="mr-1 inline" /> Generate draft
          </Button>
        </Card>
      )}

      {resendReport && (
        <Card className="flex flex-col gap-1 p-3">
          <ResultSummary items={resendReport} attemptedCount={resendReport.length} okLabel="resent" />
        </Card>
      )}

      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[960px] text-left text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              {canManage && (
                <th className="w-10 px-4 py-2">
                  <input
                    type="checkbox"
                    checked={selectableMessages.length > 0 && selected.size === selectableMessages.length}
                    onChange={toggleAll}
                    disabled={selectableMessages.length === 0}
                    aria-label={`Select all ${selectableMessages.length} actionable rows`}
                    className="h-4 w-4 rounded border-border accent-[hsl(var(--primary))]"
                  />
                </th>
              )}
              <th className="px-4 py-2 font-medium">Contact</th>
              <th className="px-4 py-2 font-medium">Mailbox</th>
              <th className="px-4 py-2 font-medium">Campaign</th>
              <th className="px-4 py-2 text-right font-medium">Step</th>
              <th className="px-4 py-2 font-medium">Reason</th>
              <th className="px-4 py-2 font-medium">Bounced</th>
              <th className="px-4 py-2 text-right font-medium">Attempts</th>
              <th className="px-4 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {messages.map((m) => (
              <tr key={m.id} className="border-b border-border last:border-0 align-top">
                {canManage && (
                  <td className="px-4 py-3">
                    <input
                      type="checkbox"
                      checked={selected.has(m.id)}
                      onChange={() => toggle(m.id)}
                      disabled={m.suppressed}
                      title={m.suppressed ? 'Suppressed org-wide — no action can be taken on this contact' : undefined}
                      className="h-4 w-4 rounded border-border accent-[hsl(var(--primary))] disabled:cursor-not-allowed disabled:opacity-30"
                    />
                  </td>
                )}
                <td className="px-4 py-3">
                  <p className="font-medium">{m.contact.email}</p>
                  <p className="text-xs text-muted-foreground">
                    {[m.contact.contact_name, m.contact.entity_name].filter(Boolean).join(' · ') || '—'}
                  </p>
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">{m.mailbox_address}</td>
                <td className="px-4 py-3 text-muted-foreground">{m.campaign_name}</td>
                <td className="px-4 py-3 text-right font-mono tabular-nums" data-numeric>{m.step_no}</td>
                <td className="px-4 py-3"><ReasonCell m={m} /></td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {m.bounced_at
                    ? new Date(m.bounced_at).toLocaleDateString()
                    : m.created_at
                      ? `${new Date(m.created_at).toLocaleDateString()} (sent — bounce time unknown)`
                      : 'unknown'}
                </td>
                <td className="px-4 py-3 text-right font-mono tabular-nums text-muted-foreground" data-numeric>{m.attempts}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-col items-start gap-1">
                    {m.suppressed ? (
                      <span
                        title="Suppression always wins — no resend, draft, or send can act on this contact"
                        className="rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-destructive"
                      >
                        suppressed — not actionable
                      </span>
                    ) : m.needs_manual ? (
                      <span className="rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-warning">needs manual</span>
                    ) : (
                      <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-success">resendable</span>
                    )}
                    <DraftStatusChip status={m.draft_status} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {showDrafts && <DraftReviewDrawer onClose={() => setShowDrafts(false)} />}
      {showGenerate && (
        <GenerateDraftModal
          messageIds={Array.from(selected)}
          // Clearing the selection is a close-time concern, not a
          // generate-time one — doing it from onDone (fired the moment
          // results come back) fed this component's own `messageIds` prop
          // back down as [] while the result screen was still showing,
          // which is exactly why the header read "0 contacts selected"
          // right under a results list for the batch that was actually run.
          onClose={() => { setShowGenerate(false); setSelected(new Set()); }}
          onDone={() => Promise.all([mutate(RECOVERABLE_KEY), mutate((k: string) => k.startsWith(BOUNCE_SUMMARY_KEY))])}
        />
      )}
    </div>
  );
}

// The manual half of Part C, restored alongside the automatic one — the
// automatic path only ever fires on a NEW bounce classification, so a
// bounce already sitting here before an org enables it had no other way
// to ever get a draft. Calls the same Outreach Writer pipeline as the
// automatic path (lib/growFallbackDraft.ts), triggered on demand. Does
// NOT require grow_alternate_channel_settings to exist — if it does,
// its sender is just the starting default here, fully overridable.
function GenerateDraftModal({
  messageIds, onClose, onDone,
}: {
  messageIds: string[];
  onClose: () => void;
  onDone: () => unknown;
}) {
  const { data: mailboxes } = useApi<GrowMailbox[]>('/grow/mailboxes');
  const { data: settings } = useApi<GrowAlternateChannelSettings>('/grow/alternate-channel/settings');
  const [senderMode, setSenderMode] = useState<'mailbox' | 'adhoc'>('mailbox');
  const [mailboxId, setMailboxId] = useState('');
  const [adhocAddress, setAdhocAddress] = useState('');
  const [generating, setGenerating] = useState(false);
  const [result, setResult] = useState<GrowGenerateDraftsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The generated drafts themselves, shown and edited right here — before
  // this, Generate wrote a row and the only way to read, edit or send it
  // was to leave this modal, find it again in the separate drafts list,
  // and start over there. Local `resolved` tracks which of these the user
  // has already sent/discarded from inside this same modal, independent
  // of the shared drafts list possibly refetching mid-session.
  const [drafts, setDrafts] = useState<GrowFallbackDraft[]>([]);
  const [edits, setEdits] = useState<Record<string, { subject?: string; intro_body?: string }>>({});
  const [resolved, setResolved] = useState<Record<string, 'sent' | 'discarded' | 'failed' | 'skipped_adhoc'>>({});
  const [busyDraftId, setBusyDraftId] = useState<string | null>(null);
  // Snapshot, not a live read of the prop — the parent clears its selection
  // on modal close, and messageIds is derived straight from that selection,
  // so reading it live after results come back would show 0 regardless of
  // what was actually attempted.
  const [attemptedCount] = useState(messageIds.length);

  // Settings (if saved) are only ever a starting default here — never
  // required, always overridable, matching "let me choose inline" when
  // nothing's configured.
  useEffect(() => {
    if (!settings) return;
    if (settings.sender_adhoc_address) { setSenderMode('adhoc'); setAdhocAddress(settings.sender_adhoc_address); }
    else if (settings.sender_mailbox_id) { setSenderMode('mailbox'); setMailboxId(settings.sender_mailbox_id); }
  }, [settings]);

  async function onGenerate() {
    if (senderMode === 'mailbox' && !mailboxId) { setError('Pick a mailbox.'); return; }
    if (senderMode === 'adhoc' && !adhocAddress.trim()) { setError('Enter an address.'); return; }
    setGenerating(true);
    setError(null);
    let res: GrowGenerateDraftsResult;
    try {
      res = await apiFetch<GrowGenerateDraftsResult>('/grow/fallback-drafts/generate', {
        method: 'POST',
        body: JSON.stringify({
          message_ids: messageIds,
          sender: senderMode === 'mailbox' ? { mailbox_id: mailboxId } : { adhoc_address: adhocAddress.trim() },
        }),
      });
    } catch (err) {
      // A failure HERE means the generate request itself never completed —
      // there's genuinely nothing more specific to tell the user.
      setError(err instanceof ApiError ? err.message : 'Could not reach the server — try again.');
      setGenerating(false);
      return;
    }
    // The real, per-id aggregated result (success/suppressed/AI-provider-
    // failure, each distinguishable) — set now, and nothing after this
    // point is allowed to replace it with a generic message. Before this
    // fix, a failure in the SECOND call below (fetching the generated
    // drafts' own content) landed in the same catch block and overwrote
    // this with "Could not generate drafts.", discarding a perfectly good
    // aggregated result the user had every right to see.
    setResult(res);
    const draftIds = new Set(res.results.filter((r) => r.ok && r.draft_id).map((r) => r.draft_id!));
    if (draftIds.size > 0) {
      try {
        const allDrafts = await apiFetch<GrowFallbackDraft[]>('/grow/fallback-drafts');
        setDrafts(allDrafts.filter((d) => draftIds.has(d.id)));
      } catch {
        // The drafts were created fine (res.results already shows that) —
        // just couldn't fetch their content to edit inline right now.
      }
    }
    await onDone();
    setGenerating(false);
  }

  function editDraft(id: string, field: 'subject' | 'intro_body', value: string) {
    setEdits((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }));
  }

  async function onSendDraft(draft: GrowFallbackDraft) {
    setBusyDraftId(draft.id);
    try {
      const edit = edits[draft.id];
      const res = await apiFetch<GrowFallbackDraftSendResult>('/grow/fallback-drafts/send', {
        method: 'POST',
        body: JSON.stringify({ draft_ids: [draft.id], edits: edit ? { [draft.id]: edit } : undefined }),
      });
      const outcome = res.results[0];
      setResolved((prev) => ({ ...prev, [draft.id]: outcome?.status === 'failed' ? 'failed' : (outcome?.status ?? 'sent') }));
    } catch {
      setResolved((prev) => ({ ...prev, [draft.id]: 'failed' }));
    } finally {
      setBusyDraftId(null);
    }
  }

  async function onDiscardDraft(draft: GrowFallbackDraft) {
    setBusyDraftId(draft.id);
    try {
      await apiFetch('/grow/fallback-drafts/discard', { method: 'POST', body: JSON.stringify({ draft_ids: [draft.id] }) });
      setResolved((prev) => ({ ...prev, [draft.id]: 'discarded' }));
    } finally {
      setBusyDraftId(null);
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-16">
      <Card className={`w-full p-6 ${result ? 'max-w-2xl' : 'max-w-lg'}`}>
        <div className="flex items-center justify-between">
          <p className="font-display text-lg font-bold tracking-tight">Generate alternate-channel draft</p>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          {attemptedCount} contact{attemptedCount === 1 ? '' : 's'} selected. Drafts the same way the automatic
          path does — review and send separately, nothing goes out from here.
        </p>

        {result ? (
          <div className="mt-4 flex flex-col gap-3">
            {drafts.length > 0 && (
              <div className="flex flex-col gap-3">
                {drafts.map((d) => {
                  const status = resolved[d.id];
                  const busy = busyDraftId === d.id;
                  return (
                    <Card key={d.id} className="flex flex-col gap-2 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-medium">{d.email}</p>
                          <p className="text-xs text-muted-foreground">
                            {[d.contact_name, d.entity_name].filter(Boolean).join(' · ') || '—'} · via {d.sender_address}
                          </p>
                        </div>
                        {status === 'sent' && <span className="rounded-full bg-success/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-success">sent</span>}
                        {status === 'skipped_adhoc' && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">copy &amp; send yourself</span>}
                        {status === 'discarded' && <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">discarded</span>}
                        {status === 'failed' && <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-destructive">failed</span>}
                      </div>
                      {!status && (
                        <>
                          <input
                            value={edits[d.id]?.subject ?? d.subject}
                            onChange={(e) => editDraft(d.id, 'subject', e.target.value)}
                            className="w-full rounded-lg border border-border bg-surface px-2 py-1 text-sm"
                          />
                          <textarea
                            value={edits[d.id]?.intro_body ?? d.intro_body}
                            onChange={(e) => editDraft(d.id, 'intro_body', e.target.value)}
                            rows={4}
                            className="w-full rounded-lg border border-border bg-surface px-2 py-1 text-xs"
                          />
                          <div className="flex justify-end gap-2">
                            <Button variant="ghost" onClick={() => onDiscardDraft(d)} disabled={busy}>Discard</Button>
                            <Button onClick={() => onSendDraft(d)} disabled={busy}>{busy ? 'Working…' : 'Send'}</Button>
                          </div>
                        </>
                      )}
                    </Card>
                  );
                })}
              </div>
            )}
            <ResultSummary
              items={result.results.filter((r) => !r.ok)}
              attemptedCount={attemptedCount}
              okLabel="ready"
            />
            <Button variant="ghost" className="mt-1" onClick={onClose}>Done</Button>
          </div>
        ) : (
          <>
            <div className="mt-4">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Alternate sender</p>
              <p className="mt-1 text-xs text-muted-foreground">
                This is for reaching a known contact through a warmer channel — not a way around a block.
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => setSenderMode('mailbox')}
                  className={`rounded-full px-3 py-1.5 text-xs font-medium ${senderMode === 'mailbox' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
                >
                  Configured mailbox
                </button>
                <button
                  type="button"
                  onClick={() => setSenderMode('adhoc')}
                  className={`rounded-full px-3 py-1.5 text-xs font-medium ${senderMode === 'adhoc' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
                >
                  Type an address
                </button>
              </div>
              {senderMode === 'mailbox' ? (
                <select
                  value={mailboxId}
                  onChange={(e) => setMailboxId(e.target.value)}
                  className="mt-2 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
                >
                  <option value="">Select a mailbox…</option>
                  {mailboxes?.map((m) => <option key={m.id} value={m.id}>{m.address}</option>)}
                </select>
              ) : (
                <input
                  value={adhocAddress}
                  onChange={(e) => setAdhocAddress(e.target.value)}
                  placeholder="you@personaladdress.com"
                  className="mt-2 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
                />
              )}
            </div>

            {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

            <div className="mt-4 flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
              <Button variant="ai" onClick={onGenerate} disabled={generating}>
                {generating ? 'Generating…' : `Generate ${messageIds.length} draft${messageIds.length === 1 ? '' : 's'}`}
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}

// Alternate-channel drafts are written automatically (growWorker.ts calls
// lib/growFallbackDraft.ts the moment a recoverable bounce is classified,
// per the org's own Grow settings) — this is the one required human step:
// review, edit if needed, and click Send. Lists every ready draft org-wide,
// not just ones tied to whatever's selected in the table above.
function DraftReviewDrawer({ onClose }: { onClose: () => void }) {
  const { data: drafts, isLoading } = useApi<GrowFallbackDraft[]>('/grow/fallback-drafts');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [edits, setEdits] = useState<Record<string, { subject?: string; intro_body?: string }>>({});
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<GrowFallbackDraftSendResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function edit(id: string, field: 'subject' | 'intro_body', value: string) {
    setEdits((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }));
  }

  async function onSend() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (ids.length > 200) {
      setError('200 is the hard max for one send — narrow your selection.');
      return;
    }
    setSending(true);
    setError(null);
    try {
      const relevantEdits = Object.fromEntries(ids.filter((id) => edits[id]).map((id) => [id, edits[id]]));
      const res = await apiFetch<GrowFallbackDraftSendResult>('/grow/fallback-drafts/send', {
        method: 'POST',
        body: JSON.stringify({ draft_ids: ids, edits: relevantEdits }),
      });
      setResult(res);
      await Promise.all([mutate('/grow/fallback-drafts'), mutate(RECOVERABLE_KEY), mutate((k: string) => k.startsWith(BOUNCE_SUMMARY_KEY))]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not send.');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-16">
      <Card className="w-full max-w-3xl p-6">
        <div className="flex items-center justify-between">
          <p className="font-display text-lg font-bold tracking-tight">Alternate-channel drafts</p>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>

        <p className="mt-3 flex items-start gap-2 rounded-lg bg-warning/10 p-3 text-xs text-warning">
          <Warning size={14} weight="bold" className="mt-0.5 shrink-0" />
          This reaches a known contact through a warmer channel — it is <strong>not</strong> a way around a block,
          and never a retry-until-it-lands tool. Default selection is capped at 50; the hard max for one send is 200.
        </p>

        {result ? (
          <div className="mt-4 flex flex-col gap-1">
            <ResultSummary
              items={result.results.map((r) => ({
                ok: r.status === 'sent',
                reason: r.status === 'skipped_adhoc' ? 'copied for manual send (ad-hoc address)' : r.reason ?? 'unknown error',
              }))}
              attemptedCount={result.results.length}
              okLabel="sent"
            />
            <Button variant="ghost" className="mt-3" onClick={onClose}>Done</Button>
          </div>
        ) : isLoading ? (
          <SkeletonCard />
        ) : !drafts || drafts.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">No drafts waiting right now.</p>
        ) : (
          <>
            <div className="mt-4 flex flex-col gap-3">
              {drafts.map((d) => (
                <Card key={d.id} className="flex flex-col gap-2 p-3">
                  <div className="flex items-start gap-3">
                    <input
                      type="checkbox"
                      checked={selected.has(d.id)}
                      onChange={() => toggle(d.id)}
                      className="mt-1 h-4 w-4 rounded border-border accent-[hsl(var(--primary))]"
                    />
                    <div className="flex-1">
                      <p className="text-sm font-medium">{d.email}</p>
                      <p className="text-xs text-muted-foreground">
                        {[d.contact_name, d.entity_name].filter(Boolean).join(' · ') || '—'} · {d.campaign_name} · via {d.sender_address}
                      </p>
                      <input
                        value={edits[d.id]?.subject ?? d.subject}
                        onChange={(e) => edit(d.id, 'subject', e.target.value)}
                        className="mt-2 w-full rounded-lg border border-border bg-surface px-2 py-1 text-sm"
                      />
                      <textarea
                        value={edits[d.id]?.intro_body ?? d.intro_body}
                        onChange={(e) => edit(d.id, 'intro_body', e.target.value)}
                        rows={3}
                        className="mt-1 w-full rounded-lg border border-border bg-surface px-2 py-1 text-xs"
                      />
                    </div>
                  </div>
                </Card>
              ))}
            </div>

            {error && <p className="mt-3 text-sm text-destructive">{error}</p>}

            <div className="mt-4 flex items-center justify-between">
              <button onClick={() => setSelected(new Set(drafts.slice(0, 50).map((d) => d.id)))} className="text-xs font-medium text-primary hover:underline">
                Select first 50
              </button>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={onClose}>Cancel</Button>
                <Button onClick={onSend} disabled={sending || selected.size === 0}>
                  {sending ? 'Sending…' : `Approve and send to ${selected.size}`}
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}


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
  const role = useRole();
  const canManage = atLeast(role, 'staff');
  const [status, setStatus] = useState<GrowMessageStatus | ''>('');
  const [bucket, setBucket] = useState<'permanent' | 'recoverable'>('recoverable');
  const [page, setPage] = useState(1);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const params = new URLSearchParams();
  if (status) params.set('status', status);
  params.set('page', String(page));

  const { data: messages, isLoading, error } = useApi<GrowMessage[]>(`/grow/messages?${params.toString()}`);
  const { data: campaigns } = useApi<GrowCampaign[]>('/grow/campaigns');
  const { data: summary } = useApi<GrowBounceSummary>(`${BOUNCE_SUMMARY_KEY}`);
  const hasCampaigns = !!campaigns && campaigns.length > 0;

  // Permanent vs Recoverable split (docs/specs/grow-recoverable-bucket.md
  // Part A) — a client-side filter on the existing list for Permanent
  // (hard-bounce behavior is otherwise completely unchanged), a dedicated
  // richer endpoint for Recoverable (see RecoverableBucket).
  const showingBounced = status === 'bounced';
  const visibleMessages = showingBounced && bucket === 'permanent'
    ? messages?.filter((m) => m.bounce_type === 'hard')
    : messages;

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

      {showingBounced && <BounceSummaryBar campaignId="" />}

      {showingBounced && (
        <div className="flex gap-1">
          <button
            onClick={() => setBucket('recoverable')}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              bucket === 'recoverable' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            Recoverable
            {!!summary?.recoverable && (
              <span className="rounded-full bg-black/10 px-1.5 text-[10px] tabular-nums dark:bg-white/15">{summary.recoverable}</span>
            )}
          </button>
          <button
            onClick={() => setBucket('permanent')}
            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
              bucket === 'permanent' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            Permanent
            {!!summary?.permanent && (
              <span className="rounded-full bg-black/10 px-1.5 text-[10px] tabular-nums dark:bg-white/15">{summary.permanent}</span>
            )}
          </button>
        </div>
      )}

      {showingBounced && bucket === 'recoverable' ? (
        <RecoverableBucket canManage={canManage} />
      ) : (
        <>
      <Card className="overflow-x-auto p-0">
        {isLoading ? (
          <SkeletonCard />
        ) : error ? (
          <p className="p-4 text-sm text-destructive">Could not load the queue.</p>
        ) : !visibleMessages || visibleMessages.length === 0 ? (
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
          <table className="w-full min-w-[880px] text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">Subject</th>
                <th className="px-4 py-2 font-medium">Mailbox</th>
                <th className="px-4 py-2 font-medium">Domain</th>
                <th className="px-4 py-2 text-right font-medium">Step</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Scheduled</th>
                <th className="px-4 py-2 font-medium">Sent</th>
                <th className="px-4 py-2 text-right font-medium">Attempts</th>
              </tr>
            </thead>
            <tbody>
              {visibleMessages!.map((m) => {
                const bounced = m.status === 'bounced';
                const expanded = bounced && expandedId === m.id;
                return (
                  <Fragment key={m.id}>
                    <tr className="border-b border-border last:border-0">
                      <td className="max-w-xs truncate px-4 py-3">
                        {bounced ? (
                          <button
                            onClick={() => setExpandedId(expanded ? null : m.id)}
                            className="flex w-full items-center gap-1.5 text-left"
                          >
                            <CaretDown
                              size={12} weight="bold"
                              className={`shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`}
                            />
                            <span className="min-w-0 truncate">{m.subject}</span>
                          </button>
                        ) : (
                          m.subject
                        )}
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{m.mailbox_address ?? '—'}</td>
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
                    {expanded && <BounceReasonPanel message={m} />}
                  </Fragment>
                );
              })}
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
      </>
      )}
    </div>
  );
}
