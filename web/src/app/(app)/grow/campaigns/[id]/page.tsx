'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { mutate } from 'swr';
import {
  CaretLeft, Play, Pause, Plus, Trash, ClipboardText, Sparkle,
  WarningCircle,
} from '@phosphor-icons/react';
import { useApi, useRole, atLeast } from '@/lib/useApi';
import { apiFetch, ApiError } from '@/lib/api';
import type {
  GrowCampaign, GrowSequenceStep, GrowSequenceGenerateResponse, GrowSenderProfile, GrowSendingReadiness,
  OrgProfile,
} from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { SequenceAssistBar } from '@/components/SequenceAssistBar';
import { GrowSendWindowCard } from '@/components/GrowSendWindowCard';
import { GrowDomainCapsTable } from '@/components/GrowDomainCapsTable';
import { GrowScheduleProjection } from '@/components/GrowScheduleProjection';
import { toneSoft, type Tone } from '@/components/ui/tone';

const CAMPAIGN_STATUS_TONE: Record<GrowCampaign['status'], Tone> = {
  draft: 'muted',
  running: 'success',
  paused: 'warning',
  stopped: 'destructive',
  done: 'primary',
  archived: 'muted',
};

interface StepDraft {
  step_no: number;
  delay_days: number;
  applies_to_rank: number | null;
  subject_tmpl: string;
  body_tmpl: string;
}

type StepField = 'subject_tmpl' | 'body_tmpl';

interface ActiveAssist {
  stepIndex: number;
  field: StepField;
  start: number;
  end: number;
  text: string;
  fullValue: string;
}

const CAMPAIGNS_KEY = '/grow/campaigns';
const stepsKey = (id: string) => `/grow/campaigns/${id}/steps`;

export default function GrowCampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const role = useRole();
  // UI gating only — requireRole('staff')/'manager' on the API is what
  // actually enforces this; a stale/wrong client-side role read still fails
  // gracefully server-side, it just wouldn't show these controls first.
  const canEdit = atLeast(role, 'staff');
  const canDelete = atLeast(role, 'manager');

  const { data: campaigns, isLoading: campaignLoading, error: campaignError } =
    useApi<GrowCampaign[]>(CAMPAIGNS_KEY);
  const { data: steps, isLoading: stepsLoading, error: stepsError } =
    useApi<GrowSequenceStep[]>(stepsKey(id));
  const { data: senderProfile } = useApi<GrowSenderProfile>('/grow/sender-profile');
  const { data: readiness } = useApi<GrowSendingReadiness>('/grow/sending-readiness');
  const { data: org } = useApi<OrgProfile>('/orgs/current');
  const campaign = campaigns?.find((c) => c.id === id);
  const knownProductLabels = new Set((senderProfile?.product_urls ?? []).map((p) => p.label));

  const [draft, setDraft] = useState<StepDraft[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [activeAssist, setActiveAssist] = useState<ActiveAssist | null>(null);

  useEffect(() => {
    if (steps) {
      setDraft(steps.map((s) => ({
        step_no: s.step_no,
        delay_days: s.delay_days,
        applies_to_rank: s.applies_to_rank,
        subject_tmpl: s.subject_tmpl,
        body_tmpl: s.body_tmpl,
      })));
    }
  }, [steps]);

  if (campaignLoading || stepsLoading || !draft) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <Skeleton className="h-10 w-80 rounded-lg bg-muted" />
        <Skeleton className="h-20 rounded-xl bg-muted" />
        <Skeleton className="h-96 rounded-xl bg-muted" />
      </div>
    );
  }
  if (campaignError || stepsError || !campaign) {
    return (
      <div className="p-4">
        <Card className="p-4">
          <p className="text-sm text-destructive">Could not load this campaign.</p>
        </Card>
      </div>
    );
  }

  function updateStep(i: number, patch: Partial<StepDraft>) {
    setDraft((d) => d && d.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  }

  function addStep() {
    setDraft((d) => {
      const nextNo = d && d.length > 0 ? Math.max(...d.map((s) => s.step_no)) + 1 : 1;
      return [...(d ?? []), { step_no: nextNo, delay_days: 3, applies_to_rank: null, subject_tmpl: '', body_tmpl: '' }];
    });
  }

  function removeStep(i: number) {
    setDraft((d) => d && d.filter((_, idx) => idx !== i));
  }

  async function onSaveSteps() {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      await apiFetch(stepsKey(id), { method: 'PATCH', body: JSON.stringify({ steps: draft }) });
      await mutate(stepsKey(id));
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'Could not save these steps.');
    } finally {
      setSaving(false);
    }
  }

  async function onSetStatus(status: 'running' | 'paused') {
    setStatusBusy(true);
    setStatusError(null);
    try {
      await apiFetch(`/grow/campaigns/${id}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      await mutate(CAMPAIGNS_KEY);
    } catch (err) {
      setStatusError(err instanceof ApiError ? err.message : 'Could not update this campaign.');
    } finally {
      setStatusBusy(false);
    }
  }

  async function onDelete() {
    if (!campaign) return;
    if (!window.confirm(`Delete "${campaign.name}"? This can't be undone.`)) return;
    setDeleting(true);
    setDeleteError(null);
    setDeleteNotice(null);
    try {
      const res = await apiFetch<{ archived: boolean; campaign: GrowCampaign | null }>(
        `/grow/campaigns/${id}`, { method: 'DELETE' },
      );
      await mutate(CAMPAIGNS_KEY);
      if (res.archived) {
        setDeleteNotice('This campaign has already sent mail, so it was archived instead of deleted — its send log is kept for the record.');
      } else {
        router.push('/grow');
      }
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : 'Could not delete this campaign.');
    } finally {
      setDeleting(false);
    }
  }

  async function onGenerate() {
    if (draft && draft.length > 0) {
      const ok = window.confirm('Replace the current sequence with an AI-generated draft? Unsaved edits will be lost.');
      if (!ok) return;
    }
    setGenerating(true);
    setGenerateError(null);
    setActiveAssist(null);
    try {
      const res = await apiFetch<GrowSequenceGenerateResponse>(`/grow/campaigns/${id}/sequence/generate`, {
        method: 'POST',
      });
      setDraft(res.steps);
    } catch (err) {
      setGenerateError(err instanceof ApiError ? err.message : 'Could not generate a sequence.');
    } finally {
      setGenerating(false);
    }
  }

  // {{unsubscribe_footer}} is never eligible for AI assist — blocking the
  // selection here (rather than only after the model responds) means the
  // token can't be sent for rewriting in the first place.
  function handleSelect(stepIndex: number, field: StepField, el: HTMLInputElement | HTMLTextAreaElement) {
    const { selectionStart, selectionEnd, value } = el;
    if (selectionStart == null || selectionEnd == null || selectionEnd - selectionStart < 3) {
      if (activeAssist?.stepIndex === stepIndex && activeAssist.field === field) setActiveAssist(null);
      return;
    }
    const text = value.slice(selectionStart, selectionEnd);
    if (text.includes('{{unsubscribe_footer}}')) {
      setActiveAssist(null);
      return;
    }
    setActiveAssist({ stepIndex, field, start: selectionStart, end: selectionEnd, text, fullValue: value });
  }

  function applyAssist(newText: string) {
    if (!activeAssist) return;
    const { stepIndex, field, start, end } = activeAssist;
    setDraft((d) => d && d.map((s, idx) => {
      if (idx !== stepIndex) return s;
      const current = s[field];
      return { ...s, [field]: current.slice(0, start) + newText + current.slice(end) };
    }));
    setActiveAssist(null);
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/grow"
            className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <CaretLeft size={14} weight="bold" /> Grow
          </Link>
          {org && (
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{org.name}</p>
          )}
          <div className="flex items-center gap-3">
            <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">{campaign.name}</h1>
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-semibold uppercase tracking-wide ${toneSoft[CAMPAIGN_STATUS_TONE[campaign.status]]}`}
            >
              {campaign.status}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canEdit && (
            <>
              {campaign.status === 'running' ? (
                <Button variant="ghost" onClick={() => onSetStatus('paused')} disabled={statusBusy}>
                  <Pause size={14} weight="bold" className="mr-1.5 inline" />
                  {statusBusy ? 'Pausing…' : 'Pause'}
                </Button>
              ) : campaign.status === 'draft' || campaign.status === 'paused' ? (
                <Button onClick={() => onSetStatus('running')} disabled={statusBusy || readiness?.ready === false}>
                  <Play size={14} weight="bold" className="mr-1.5 inline" />
                  {statusBusy ? 'Starting…' : 'Start'}
                </Button>
              ) : null}
            </>
          )}
          {canDelete && campaign.status !== 'archived' && (
            <Button variant="ghost" onClick={onDelete} disabled={deleting}>
              <Trash size={14} weight="bold" className="mr-1.5 inline" />
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
          )}
        </div>
      </div>
      {statusError && <p className="-mt-2 text-sm text-destructive">{statusError}</p>}
      {deleteError && <p className="-mt-2 text-sm text-destructive">{deleteError}</p>}
      {deleteNotice && (
        <Card className="flex items-start gap-3 border-warning/40 bg-warning/5 p-4">
          <Trash size={18} weight="fill" className="mt-0.5 shrink-0 text-warning" />
          <p className="text-sm text-warning">{deleteNotice}</p>
        </Card>
      )}

      {(campaign.status === 'draft' || campaign.status === 'paused') && readiness?.ready === false && (
        <Card className="flex items-start gap-3 border-warning/40 bg-warning/5 p-4">
          <WarningCircle size={20} weight="fill" className="mt-0.5 shrink-0 text-warning" />
          <div>
            <p className="text-sm font-medium text-warning">This org isn&apos;t ready to send yet</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {!readiness.hasVerifiedDomain && !readiness.hasActiveMailbox
                ? 'No fully verified sending domain (SPF, DKIM, and DMARC) and no active mailbox.'
                : !readiness.hasVerifiedDomain
                  ? 'No fully verified sending domain (SPF, DKIM, and DMARC) yet.'
                  : 'No active mailbox yet.'}{' '}
              <Link href="/grow/sending" className="font-medium text-primary hover:underline">
                Set up sending →
              </Link>
            </p>
          </div>
        </Card>
      )}

      <GrowSendWindowCard campaign={campaign} canEdit={canEdit} />

      <GrowScheduleProjection campaignId={id} pauseReason={campaign.pause_reason} />

      <GrowDomainCapsTable campaignId={id} canEdit={canEdit} />

      <Card className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
          <p className="text-sm font-semibold">Sequence steps</p>
          {canEdit && (
            <div className="flex flex-wrap items-center gap-3">
              {saved && <span className="text-xs text-success">Saved.</span>}
              {saveError && <span className="text-xs text-destructive">{saveError}</span>}
              {generateError && <span className="text-xs text-destructive">{generateError}</span>}
              {draft.length > 0 && (
                <Button variant="ai" onClick={onGenerate} disabled={generating}>
                  <Sparkle size={14} weight="fill" className="mr-1.5 inline" />
                  {generating ? 'Generating…' : 'Regenerate with AI'}
                </Button>
              )}
              <Button variant="ghost" onClick={addStep}>
                <Plus size={14} weight="bold" className="mr-1 inline" /> Add step
              </Button>
              <Button onClick={onSaveSteps} disabled={saving}>{saving ? 'Saving…' : 'Save changes'}</Button>
            </div>
          )}
        </div>
        {draft.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
              <ClipboardText size={22} weight="duotone" className="text-primary" />
            </div>
            <div>
              <p className="text-sm font-medium">This campaign has no sequence yet</p>
              <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                A step is one email: a subject, a body, and how many days after the previous step it sends.
                Add one for each rank you want to reach — a step with no rank set applies to everyone.
              </p>
            </div>
            {canEdit && (
              <div className="mt-1 flex items-center gap-2">
                <Button variant="ai" onClick={onGenerate} disabled={generating}>
                  <Sparkle size={14} weight="fill" className="mr-1.5 inline" />
                  {generating ? 'Generating…' : 'Generate with AI'}
                </Button>
                <Button variant="ghost" onClick={addStep}>
                  <Plus size={14} weight="bold" className="mr-1.5 inline" /> Add manually
                </Button>
              </div>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {draft.map((s, i) => (
              <li key={i} className="flex flex-col gap-3 p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 font-mono text-xs font-semibold text-primary">
                    {s.step_no}
                  </span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {s.applies_to_rank === null ? 'All ranks' : `Rank ${s.applies_to_rank} only`}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    sends <span className="font-mono tabular-nums" data-numeric>{s.delay_days}</span> day{s.delay_days === 1 ? '' : 's'} after the previous step
                  </span>
                  {canEdit && (
                    <Button variant="ghost" className="ml-auto !min-h-0 px-2 py-1" onClick={() => removeStep(i)}>
                      <Trash size={14} />
                    </Button>
                  )}
                </div>
                <div className="flex flex-wrap items-end gap-3 pl-10">
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    Step
                    <input
                      type="number"
                      min={1}
                      value={s.step_no}
                      disabled={!canEdit}
                      onChange={(e) => updateStep(i, { step_no: Number(e.target.value) })}
                      className="w-20 rounded-lg border border-border bg-background px-2 py-2 text-sm font-mono tabular-nums text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    Delay (days)
                    <input
                      type="number"
                      min={0}
                      value={s.delay_days}
                      disabled={!canEdit}
                      onChange={(e) => updateStep(i, { delay_days: Number(e.target.value) })}
                      className="w-24 rounded-lg border border-border bg-background px-2 py-2 text-sm font-mono tabular-nums text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    Rank
                    <input
                      type="number"
                      min={1}
                      placeholder="Any"
                      disabled={!canEdit}
                      value={s.applies_to_rank ?? ''}
                      onChange={(e) =>
                        updateStep(i, { applies_to_rank: e.target.value === '' ? null : Number(e.target.value) })
                      }
                      className="w-20 rounded-lg border border-border bg-background px-2 py-2 text-sm font-mono tabular-nums text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
                    />
                  </label>
                </div>
                <div className="pl-10">
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    Subject {canEdit && <span className="normal-case text-muted-foreground/70">— select text to ask AI to rewrite it</span>}
                    <input
                      value={s.subject_tmpl}
                      disabled={!canEdit}
                      onChange={(e) => updateStep(i, { subject_tmpl: e.target.value })}
                      onSelect={(e) => handleSelect(i, 'subject_tmpl', e.currentTarget)}
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
                    />
                  </label>
                  {activeAssist && activeAssist.stepIndex === i && activeAssist.field === 'subject_tmpl' && (
                    <SequenceAssistBar
                      selectedText={activeAssist.text}
                      fullValue={activeAssist.fullValue}
                      knownProductLabels={knownProductLabels}
                      onApply={applyAssist}
                      onClose={() => setActiveAssist(null)}
                    />
                  )}
                </div>
                <div className="pl-10">
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                    Body
                    <textarea
                      value={s.body_tmpl}
                      disabled={!canEdit}
                      rows={4}
                      onChange={(e) => updateStep(i, { body_tmpl: e.target.value })}
                      onSelect={(e) => handleSelect(i, 'body_tmpl', e.currentTarget)}
                      className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
                    />
                  </label>
                  {activeAssist && activeAssist.stepIndex === i && activeAssist.field === 'body_tmpl' && (
                    <SequenceAssistBar
                      selectedText={activeAssist.text}
                      fullValue={activeAssist.fullValue}
                      knownProductLabels={knownProductLabels}
                      onApply={applyAssist}
                      onClose={() => setActiveAssist(null)}
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
