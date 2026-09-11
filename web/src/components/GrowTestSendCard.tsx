'use client';

import { useEffect, useState } from 'react';
import { MagnifyingGlass, PaperPlaneTilt, WarningCircle } from '@phosphor-icons/react';
import { useApi } from '@/lib/useApi';
import { apiFetch, ApiError } from '@/lib/api';
import type {
  GrowContactListItem, GrowSequenceStep, GrowMailbox,
  GrowCampaignTestSendRenderResponse, GrowCampaignTestSendResponse,
} from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { toneSoft } from '@/components/ui/tone';

const inputCls =
  'min-h-[42px] w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';
const labelCls = 'flex flex-col gap-1 text-sm text-muted-foreground';

// Exactly MERGE_FIELDS from api/src/routes/grow.ts — the merge tokens a
// real sequence step can actually reference. A hypothetical contact only
// needs to fill in what the step it's testing actually uses.
const MANUAL_FIELDS: Array<{ key: keyof ManualFields; label: string; placeholder: string }> = [
  { key: 'first_name', label: 'First name', placeholder: 'Alex' },
  { key: 'contact_name', label: 'Contact name', placeholder: 'Alex Rivera' },
  { key: 'role', label: 'Role', placeholder: 'Athletic Director' },
  { key: 'entity_name', label: 'Entity name', placeholder: 'Riviera Prep' },
  { key: 'region', label: 'Region', placeholder: 'South Florida' },
  { key: 'city', label: 'City', placeholder: 'Miami' },
  { key: 'enrollment', label: 'Enrollment', placeholder: '450' },
];

interface ManualFields {
  first_name: string;
  contact_name: string;
  role: string;
  entity_name: string;
  region: string;
  city: string;
  enrollment: string;
}

const BLANK_MANUAL: ManualFields = {
  first_name: '', contact_name: '', role: '', entity_name: '', region: '', city: '', enrollment: '',
};

function useDebounced(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

export function GrowTestSendCard({ campaignId }: { campaignId: string }) {
  const [mode, setMode] = useState<'existing' | 'manual'>('existing');
  const [search, setSearch] = useState('');
  const [selectedContact, setSelectedContact] = useState<GrowContactListItem | null>(null);
  const [manual, setManual] = useState<ManualFields>(BLANK_MANUAL);
  const [stepId, setStepId] = useState('');
  const [mailboxId, setMailboxId] = useState('');
  const [to, setTo] = useState('');

  const [rendered, setRendered] = useState<GrowCampaignTestSendRenderResponse | null>(null);
  const [rendering, setRendering] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [sendResult, setSendResult] = useState<GrowCampaignTestSendResponse | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const debouncedSearch = useDebounced(search, 300);
  const searchKey = debouncedSearch.trim().length >= 2
    ? `/grow/contacts?q=${encodeURIComponent(debouncedSearch.trim())}`
    : null;
  const { data: searchResults, isLoading: searching } = useApi<GrowContactListItem[]>(searchKey);

  const { data: steps } = useApi<GrowSequenceStep[]>(`/grow/campaigns/${campaignId}/steps`);
  const { data: mailboxes } = useApi<GrowMailbox[]>('/grow/mailboxes');

  function resetOutcome() {
    setRendered(null);
    setRenderError(null);
    setSendResult(null);
    setSendError(null);
  }

  function body() {
    return {
      step_id: stepId,
      ...(mode === 'existing' && selectedContact
        ? { contact_id: selectedContact.id }
        : {
            manual: {
              first_name: manual.first_name || undefined,
              contact_name: manual.contact_name || undefined,
              role: manual.role || undefined,
              entity_name: manual.entity_name || undefined,
              region: manual.region || undefined,
              city: manual.city || undefined,
              enrollment: manual.enrollment || undefined,
            },
          }),
    };
  }

  const canRender = !!stepId && (mode === 'manual' || !!selectedContact);
  const canSend = canRender && !!mailboxId && !!to.trim();

  async function onRender() {
    setRendering(true);
    setRenderError(null);
    setSendResult(null);
    setSendError(null);
    try {
      const res = await apiFetch<GrowCampaignTestSendRenderResponse>(
        `/grow/campaigns/${campaignId}/test-send/render`,
        { method: 'POST', body: JSON.stringify(body()) },
      );
      setRendered(res);
    } catch (err) {
      setRenderError(err instanceof ApiError ? err.message : 'Could not render this step.');
    } finally {
      setRendering(false);
    }
  }

  async function onSend() {
    setSending(true);
    setSendError(null);
    try {
      const res = await apiFetch<GrowCampaignTestSendResponse>(
        `/grow/campaigns/${campaignId}/test-send`,
        { method: 'POST', body: JSON.stringify({ ...body(), mailbox_id: mailboxId, to: to.trim() }) },
      );
      setRendered(res);
      setSendResult(res);
    } catch (err) {
      setSendError(err instanceof ApiError ? err.message : 'Could not send this test message.');
    } finally {
      setSending(false);
    }
  }

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2">
        <PaperPlaneTilt size={16} className="text-muted-foreground" />
        <p className="text-sm font-semibold">Send test</p>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Renders a real sequence step through a real mailbox — subject prefixed with{' '}
        <span className="font-mono">[TEST]</span>. Never writes to the send log or touches an enrollment, so it
        won&apos;t count against a mailbox&apos;s daily cap.
      </p>

      <div className="mt-3 flex flex-col gap-3">
        <div className="flex gap-1 rounded-full border border-border bg-surface p-1 shadow-sm" style={{ width: 'fit-content' }}>
          {(['existing', 'manual'] as const).map((m) => (
            <button
              key={m}
              onClick={() => { setMode(m); resetOutcome(); }}
              className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                mode === m ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {m === 'existing' ? 'Existing contact' : 'Hypothetical contact'}
            </button>
          ))}
        </div>

        {mode === 'existing' ? (
          <div className="relative">
            <label className={labelCls}>
              Search contacts
              <div className="relative">
                <MagnifyingGlass size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <input
                  value={selectedContact ? (selectedContact.contact_name ?? selectedContact.first_name ?? selectedContact.email) : search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setSelectedContact(null);
                    resetOutcome();
                  }}
                  placeholder="Name or email"
                  className={`${inputCls} pl-8`}
                />
              </div>
            </label>
            {!selectedContact && searchKey && (
              <div className="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-border bg-surface shadow-md">
                {searching ? (
                  <p className="px-3 py-2 text-xs text-muted-foreground">Searching…</p>
                ) : !searchResults || searchResults.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-muted-foreground">No contacts match.</p>
                ) : (
                  <ul className="max-h-56 overflow-y-auto">
                    {searchResults.map((c) => (
                      <li key={c.id}>
                        <button
                          onClick={() => { setSelectedContact(c); setSearch(''); resetOutcome(); }}
                          className="flex w-full flex-col items-start px-3 py-2 text-left text-sm hover:bg-muted"
                        >
                          <span className="font-medium">{c.contact_name ?? c.first_name ?? c.email}</span>
                          <span className="text-xs text-muted-foreground">{c.email}{c.role ? ` · ${c.role}` : ''}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {MANUAL_FIELDS.map((f) => (
              <label key={f.key} className={labelCls}>
                {f.label}
                <input
                  value={manual[f.key]}
                  onChange={(e) => { setManual({ ...manual, [f.key]: e.target.value }); resetOutcome(); }}
                  placeholder={f.placeholder}
                  className={inputCls}
                />
              </label>
            ))}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-3">
          <label className={labelCls}>
            Sequence step
            <select
              value={stepId}
              onChange={(e) => { setStepId(e.target.value); resetOutcome(); }}
              className={inputCls}
            >
              <option value="">Choose a step…</option>
              {steps?.map((s) => (
                <option key={s.id} value={s.id}>
                  Step {s.step_no}{s.applies_to_rank !== null ? ` (rank ${s.applies_to_rank})` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className={labelCls}>
            Mailbox
            <select
              value={mailboxId}
              onChange={(e) => setMailboxId(e.target.value)}
              className={inputCls}
            >
              <option value="">Choose a mailbox…</option>
              {mailboxes?.map((m) => (
                <option key={m.id} value={m.id}>{m.address}</option>
              ))}
            </select>
          </label>
          <label className={labelCls}>
            Send to
            <input
              type="email"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="you@example.com"
              className={inputCls}
            />
          </label>
        </div>

        {(!steps || steps.length === 0) && (
          <p className="text-xs text-muted-foreground">This campaign has no sequence steps yet — add one below first.</p>
        )}
        {(!mailboxes || mailboxes.length === 0) && (
          <p className="text-xs text-muted-foreground">No mailboxes yet — add one in Sending setup first.</p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" onClick={onRender} disabled={!canRender || rendering}>
            {rendering ? 'Rendering…' : 'Render'}
          </Button>
          <Button onClick={onSend} disabled={!canSend || sending}>
            {sending ? 'Sending…' : 'Send test'}
          </Button>
        </div>
        {renderError && <p className="text-sm text-destructive">{renderError}</p>}
        {sendError && <p className="text-sm text-destructive">{sendError}</p>}

        {rendered && (
          <div className="rounded-lg border border-border p-3">
            {rendered.refused && (
              <div className="mb-2 flex items-start gap-2 rounded-lg bg-destructive/10 px-2.5 py-2 text-xs text-destructive">
                <WarningCircle size={14} weight="fill" className="mt-0.5 shrink-0" />
                <p>{rendered.refusal_reason}</p>
              </div>
            )}
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Subject</p>
            <p className="text-sm">{rendered.subject}</p>
            <p className="mt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Body</p>
            <pre className="whitespace-pre-wrap font-sans text-sm">{rendered.body}</pre>
          </div>
        )}

        {sendResult?.smtp && (
          <div className={`rounded-lg px-3 py-2.5 text-sm ${toneSoft[sendResult.smtp.ok ? 'success' : 'destructive']}`}>
            <p className="font-medium">{sendResult.smtp.ok ? 'Sent' : 'Send failed'}</p>
            {sendResult.smtp.messageId && <p className="mt-1 text-xs">Message ID: {sendResult.smtp.messageId}</p>}
            {sendResult.smtp.response && <p className="mt-1 font-mono text-xs">{sendResult.smtp.response}</p>}
            {sendResult.smtp.error && <p className="mt-1 font-mono text-xs">{sendResult.smtp.error}</p>}
          </div>
        )}
      </div>
    </Card>
  );
}
