'use client';

import { useState } from 'react';
import Link from 'next/link';
import { mutate } from 'swr';
import {
  CaretLeft, Copy, Check, CheckCircle, WarningCircle, XCircle, Play, Pause,
  PaperPlaneTilt, EnvelopeSimple, Globe, Plus, X,
} from '@phosphor-icons/react';
import { useApi, useRole, atLeast } from '@/lib/useApi';
import { apiFetch, ApiError } from '@/lib/api';
import type {
  GrowSendingDomain, GrowSendingDomainProvider, GrowVerifyDomainResponse, GrowMailbox,
  GrowTestSendResponse,
} from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { SkeletonCard } from '@/components/ui/Skeleton';
import { toneSoft, type Tone } from '@/components/ui/tone';

const DOMAINS_KEY = '/grow/sending-domains';
const MAILBOXES_KEY = '/grow/mailboxes';

const PROVIDERS: Array<{ value: GrowSendingDomainProvider; label: string }> = [
  { value: 'spacemail', label: 'Spacemail' },
  { value: 'google', label: 'Google Workspace' },
  { value: 'microsoft', label: 'Microsoft 365' },
  { value: 'other', label: 'Other' },
];

const inputCls =
  'min-h-[42px] w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';
const labelCls = 'flex flex-col gap-1 text-sm text-muted-foreground';

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard permission denied or unavailable — the value is still
          // selectable text on screen, so this is a convenience, not the
          // only way to get it.
        }
      }}
      className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
    >
      {copied ? <Check size={12} weight="bold" className="text-success" /> : <Copy size={12} />}
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

function RecordStatusIcon({ ok }: { ok: boolean | null }) {
  if (ok === null) return <span className="h-2 w-2 rounded-full bg-muted-foreground/30" />;
  return ok
    ? <CheckCircle size={16} weight="fill" className="text-success" />
    : <XCircle size={16} weight="fill" className="text-destructive" />;
}

function SendingDomainCard({ domain, canEdit }: { domain: GrowSendingDomain; canEdit: boolean }) {
  const [verifying, setVerifying] = useState(false);
  const [result, setResult] = useState<GrowVerifyDomainResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onVerify() {
    setVerifying(true);
    setError(null);
    try {
      const res = await apiFetch<GrowVerifyDomainResponse>(`/grow/sending-domains/${domain.id}/verify`, {
        method: 'POST',
      });
      setResult(res);
      await mutate(DOMAINS_KEY);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not verify this domain.');
    } finally {
      setVerifying(false);
    }
  }

  const checkFor = (type: 'SPF' | 'DKIM' | 'DMARC') => result?.checks.find((c) => c.type === type) ?? null;

  return (
    <li className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{domain.domain}</p>
          <p className="text-xs text-muted-foreground">
            {PROVIDERS.find((p) => p.value === domain.provider)?.label ?? domain.provider}
            {domain.verified_at && ` · last checked ${new Date(domain.verified_at).toLocaleString()}`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <RecordStatusIcon ok={domain.spf_ok} /> SPF
            <RecordStatusIcon ok={domain.dkim_ok} /> DKIM
            <RecordStatusIcon ok={domain.dmarc_ok} /> DMARC
          </div>
          {canEdit && (
            <Button variant="ghost" onClick={onVerify} disabled={verifying}>
              {verifying ? 'Checking…' : 'Verify'}
            </Button>
          )}
        </div>
      </div>

      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

      {result?.subdomain_warning && (
        <Card className="mt-3 flex items-start gap-2 border-warning/40 bg-warning/5 p-3">
          <WarningCircle size={16} weight="fill" className="mt-0.5 shrink-0 text-warning" />
          <p className="text-xs text-warning">{result.subdomain_warning}</p>
        </Card>
      )}

      <div className="mt-3 flex flex-col gap-3">
        {domain.expected_records.map((rec) => {
          const check = checkFor(rec.type);
          return (
            <div key={rec.type} className="rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {rec.type} ({rec.kind})
                </span>
                {check && (
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${toneSoft[check.ok ? 'success' : 'destructive']}`}>
                    {check.ok ? 'OK' : 'Needs attention'}
                  </span>
                )}
              </div>
              <p className="mt-1 font-mono text-xs text-foreground">{rec.name}</p>
              {rec.value && (
                <div className="mt-1.5 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs">{rec.value}</code>
                  <CopyButton text={rec.value} />
                </div>
              )}
              <p className="mt-1.5 text-xs text-muted-foreground">{rec.instructions}</p>
              {check && !check.ok && (
                <div className="mt-2 rounded-lg bg-destructive/5 p-2 text-xs text-destructive">
                  <p>{check.note}</p>
                  {check.found.length > 0 && (
                    <p className="mt-1">
                      <span className="font-medium">Found:</span>{' '}
                      <code className="break-all">{check.found.join(' | ')}</code>
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </li>
  );
}

function AddDomainForm({ canEdit }: { canEdit: boolean }) {
  const [domain, setDomain] = useState('');
  const [provider, setProvider] = useState<GrowSendingDomainProvider>('other');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!canEdit) return null;

  async function onAdd() {
    if (!domain.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await apiFetch(DOMAINS_KEY, { method: 'POST', body: JSON.stringify({ domain: domain.trim(), provider }) });
      await mutate(DOMAINS_KEY);
      setDomain('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add this domain.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border-b border-border p-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className={`${labelCls} flex-1`}>
          Domain
          <input
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            placeholder="mail.example.com"
            className={inputCls}
          />
        </label>
        <label className={labelCls}>
          Provider
          <select value={provider} onChange={(e) => setProvider(e.target.value as GrowSendingDomainProvider)} className={inputCls}>
            {PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </label>
        <Button onClick={onAdd} disabled={busy || !domain.trim()}>
          <Plus size={14} weight="bold" className="mr-1.5 inline" /> {busy ? 'Adding…' : 'Add domain'}
        </Button>
      </div>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

function TestSendRow({ mailbox, canEdit }: { mailbox: GrowMailbox; canEdit: boolean }) {
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<GrowTestSendResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!canEdit) return null;

  async function onSend() {
    if (!to.trim()) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await apiFetch<GrowTestSendResponse>(`/grow/mailboxes/${mailbox.id}/test-send`, {
        method: 'POST',
        body: JSON.stringify({ to: to.trim() }),
      });
      setResult(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not run this test.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2">
      {!open ? (
        <Button variant="ghost" onClick={() => setOpen(true)}>
          <PaperPlaneTilt size={14} weight="bold" className="mr-1.5 inline" /> Send test email
        </Button>
      ) : (
        <Card className="p-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
              Send test to
              <input
                type="email"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="you@example.com"
                className={inputCls}
              />
            </label>
            <Button onClick={onSend} disabled={busy || !to.trim()}>{busy ? 'Sending…' : 'Send'}</Button>
            <Button variant="ghost" onClick={() => { setOpen(false); setResult(null); setError(null); }}>
              <X size={14} />
            </Button>
          </div>

          {error && <p className="mt-2 text-xs text-destructive">{error}</p>}

          {result && (
            <div className="mt-3 flex flex-col gap-2 text-xs">
              <div className={`rounded-lg p-2 ${result.smtp.ok ? 'bg-success/5' : 'bg-destructive/5'}`}>
                <p className={`font-medium ${result.smtp.ok ? 'text-success' : 'text-destructive'}`}>
                  SMTP send: {result.smtp.ok ? 'sent' : 'failed'}
                </p>
                {result.smtp.messageId && <p className="mt-0.5 text-muted-foreground">Message-ID: {result.smtp.messageId}</p>}
                {result.smtp.response && <p className="mt-0.5 font-mono text-muted-foreground">{result.smtp.response}</p>}
                {result.smtp.error && <p className="mt-0.5 text-destructive">{result.smtp.error}</p>}
              </div>
              <div className={`rounded-lg p-2 ${result.imap.ok ? 'bg-success/5' : 'bg-destructive/5'}`}>
                <p className={`font-medium ${result.imap.ok ? 'text-success' : 'text-destructive'}`}>
                  IMAP connectivity: {result.imap.ok ? 'connected' : 'failed'}
                </p>
                <p className="mt-0.5 text-muted-foreground">
                  This confirms the mailbox's IMAP credentials work and INBOX is reachable — it does not wait
                  for or confirm that a reply was actually received.
                </p>
                {result.imap.messageCount !== null && (
                  <p className="mt-0.5 text-muted-foreground">{result.imap.messageCount} message(s) currently in INBOX.</p>
                )}
                {result.imap.error && <p className="mt-0.5 text-destructive">{result.imap.error}</p>}
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

const MAILBOX_STATUS_TONE: Record<string, Tone> = {
  warming: 'warning', active: 'success', paused: 'muted', disabled: 'destructive',
};

function MailboxRow({ mailbox, canEdit }: { mailbox: GrowMailbox; canEdit: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggleStatus() {
    const next = mailbox.status === 'paused' ? 'active' : 'paused';
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/grow/mailboxes/${mailbox.id}`, { method: 'PATCH', body: JSON.stringify({ status: next }) });
      await mutate(MAILBOXES_KEY);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update this mailbox.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{mailbox.address}</p>
          <p className="text-xs text-muted-foreground">
            {mailbox.from_name} · {mailbox.domain} · {mailbox.smtp_host}:{mailbox.smtp_port}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <p className="font-mono text-sm tabular-nums" data-numeric>{mailbox.daily_cap}/day</p>
            {mailbox.steady_cap_date && mailbox.daily_cap < mailbox.steady_cap && (
              <p className="text-[11px] text-muted-foreground">
                reaches {mailbox.steady_cap}/day on {new Date(mailbox.steady_cap_date).toLocaleDateString()}
              </p>
            )}
          </div>
          <span className={`rounded-full px-2.5 py-1 text-xs font-medium uppercase tracking-wide ${toneSoft[MAILBOX_STATUS_TONE[mailbox.status] ?? 'muted']}`}>
            {mailbox.status}
          </span>
          {canEdit && (mailbox.status === 'paused' || mailbox.status === 'active' || mailbox.status === 'warming') && (
            <Button variant="ghost" onClick={toggleStatus} disabled={busy}>
              {mailbox.status === 'paused'
                ? <><Play size={14} weight="bold" className="mr-1 inline" /> Resume</>
                : <><Pause size={14} weight="bold" className="mr-1 inline" /> Pause</>}
            </Button>
          )}
        </div>
      </div>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      <TestSendRow mailbox={mailbox} canEdit={canEdit} />
    </li>
  );
}

function AddMailboxDrawer({
  domains, open, onOpenChange,
}: {
  domains: GrowSendingDomain[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const initial = {
    domain_id: domains[0]?.id ?? '', address: '', from_name: '', reply_to: '',
    smtp_host: '', smtp_port: '465', imap_host: '', imap_port: '993',
    username: '', password: '', steady_cap: '25',
  };
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  async function onSave() {
    if (!form.domain_id || !form.address || !form.from_name || !form.smtp_host || !form.username || !form.password) {
      setError('Fill in every required field.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(MAILBOXES_KEY, {
        method: 'POST',
        body: JSON.stringify({
          domain_id: form.domain_id,
          address: form.address.trim(),
          from_name: form.from_name.trim(),
          reply_to: form.reply_to.trim() || null,
          smtp_host: form.smtp_host.trim(),
          smtp_port: Number(form.smtp_port),
          imap_host: form.imap_host.trim() || null,
          imap_port: form.imap_host.trim() ? Number(form.imap_port) : null,
          username: form.username.trim(),
          password: form.password,
          steady_cap: Number(form.steady_cap),
        }),
      });
      await mutate(MAILBOXES_KEY);
      setForm(initial);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add this mailbox.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-foreground/40" onClick={() => onOpenChange(false)} />
      <div className="relative flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-border bg-surface p-6 shadow-xl">
        <div className="mb-6 flex items-center justify-between">
          <p className="font-display text-lg font-bold">Add mailbox</p>
          <button onClick={() => onOpenChange(false)} className="text-muted-foreground hover:text-foreground">
            <X size={16} weight="bold" />
          </button>
        </div>
        <div className="flex flex-1 flex-col gap-4">
          <label className={labelCls}>
            Sending domain<span className="text-primary"> *</span>
            <select value={form.domain_id} onChange={(e) => setForm({ ...form, domain_id: e.target.value })} className={inputCls}>
              <option value="" disabled>Choose a domain</option>
              {domains.map((d) => <option key={d.id} value={d.id}>{d.domain}</option>)}
            </select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className={labelCls}>
              Address<span className="text-primary"> *</span>
              <input type="email" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} className={inputCls} placeholder="you@mail.example.com" />
            </label>
            <label className={labelCls}>
              From name<span className="text-primary"> *</span>
              <input value={form.from_name} onChange={(e) => setForm({ ...form, from_name: e.target.value })} className={inputCls} />
            </label>
          </div>
          <label className={labelCls}>
            Reply-to
            <input type="email" value={form.reply_to} onChange={(e) => setForm({ ...form, reply_to: e.target.value })} className={inputCls} />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className={labelCls}>
              SMTP host<span className="text-primary"> *</span>
              <input value={form.smtp_host} onChange={(e) => setForm({ ...form, smtp_host: e.target.value })} className={inputCls} />
            </label>
            <label className={labelCls}>
              SMTP port
              <input type="number" value={form.smtp_port} onChange={(e) => setForm({ ...form, smtp_port: e.target.value })} className={`${inputCls} font-mono tabular-nums`} />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className={labelCls}>
              IMAP host
              <input value={form.imap_host} onChange={(e) => setForm({ ...form, imap_host: e.target.value })} className={inputCls} />
            </label>
            <label className={labelCls}>
              IMAP port
              <input type="number" value={form.imap_port} onChange={(e) => setForm({ ...form, imap_port: e.target.value })} className={`${inputCls} font-mono tabular-nums`} />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className={labelCls}>
              Username<span className="text-primary"> *</span>
              <input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} className={inputCls} />
            </label>
            <label className={labelCls}>
              Password<span className="text-primary"> *</span>
              <input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className={inputCls} autoComplete="new-password" />
            </label>
          </div>
          <label className={labelCls}>
            Steady-state daily cap
            <input type="number" value={form.steady_cap} onChange={(e) => setForm({ ...form, steady_cap: e.target.value })} className={`${inputCls} w-32 font-mono tabular-nums`} />
          </label>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <div className="mt-6 flex justify-end gap-2 border-t border-border pt-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={onSave} disabled={busy}>{busy ? 'Adding…' : 'Add mailbox'}</Button>
        </div>
      </div>
    </div>
  );
}

export default function GrowSendingPage() {
  const role = useRole();
  const canEdit = atLeast(role, 'staff');
  const { data: domains, isLoading: domainsLoading, error: domainsError } = useApi<GrowSendingDomain[]>(DOMAINS_KEY);
  const { data: mailboxes, isLoading: mailboxesLoading, error: mailboxesError } = useApi<GrowMailbox[]>(MAILBOXES_KEY);
  const [addingMailbox, setAddingMailbox] = useState(false);

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <Link href="/grow" className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <CaretLeft size={14} weight="bold" /> Grow
          </Link>
          <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">Sending setup</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            A campaign can't start without a verified domain and at least one active mailbox.
          </p>
        </div>
      </div>

      <Card className="p-0">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Globe size={16} className="text-muted-foreground" />
          <p className="text-sm font-semibold">Sending domains</p>
        </div>
        <AddDomainForm canEdit={canEdit} />
        {domainsLoading ? (
          <SkeletonCard />
        ) : domainsError ? (
          <p className="p-4 text-sm text-destructive">Could not load sending domains.</p>
        ) : !domains || domains.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No sending domains yet — add one above.</p>
        ) : (
          <ul className="divide-y divide-border">
            {domains.map((d) => <SendingDomainCard key={d.id} domain={d} canEdit={canEdit} />)}
          </ul>
        )}
      </Card>

      <Card className="p-0">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <EnvelopeSimple size={16} className="text-muted-foreground" />
            <p className="text-sm font-semibold">Mailboxes</p>
          </div>
          {canEdit && (domains?.length ?? 0) > 0 && (
            <Button onClick={() => setAddingMailbox(true)}>
              <Plus size={14} weight="bold" className="mr-1.5 inline" /> Add mailbox
            </Button>
          )}
        </div>
        {mailboxesLoading ? (
          <SkeletonCard />
        ) : mailboxesError ? (
          <p className="p-4 text-sm text-destructive">Could not load mailboxes.</p>
        ) : !domains || domains.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">Add a sending domain first — a mailbox belongs to one.</p>
        ) : !mailboxes || mailboxes.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No mailboxes yet — add one to start sending.</p>
        ) : (
          <ul className="divide-y divide-border">
            {mailboxes.map((m) => <MailboxRow key={m.id} mailbox={m} canEdit={canEdit} />)}
          </ul>
        )}
      </Card>

      <AddMailboxDrawer domains={domains ?? []} open={addingMailbox} onOpenChange={setAddingMailbox} />
    </div>
  );
}
