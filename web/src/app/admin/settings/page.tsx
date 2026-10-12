'use client';

import { useState, useEffect, type FormEvent } from 'react';
import { useApi } from '@/lib/useApi';
import { apiFetch, ApiError } from '@/lib/api';
import { PageHeader } from '@/components/Primitives';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

const inputCls =
  'min-h-[42px] rounded-lg border border-border bg-background px-3 text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';
const labelCls = 'flex flex-col gap-1 text-sm text-muted-foreground';

interface PaymentGateStatus {
  enabled: boolean;
}

function PaymentGateCard() {
  const { data, isLoading } = useApi<PaymentGateStatus>('/admin/settings/payment-gate');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localEnabled, setLocalEnabled] = useState<boolean | null>(null);

  const enabled = localEnabled ?? data?.enabled ?? false;

  async function toggle(next: boolean) {
    setSaving(true);
    setError(null);
    setLocalEnabled(next);
    try {
      await apiFetch('/admin/settings/payment-gate', { method: 'PATCH', body: JSON.stringify({ enabled: next }) });
    } catch (err) {
      setLocalEnabled(!next);
      setError(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-6">
      <h2 className="font-display font-bold tracking-tight">Payment gate</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        While off, no business is locked out of Command Center, CRM, ScaleSEO, Reviews, Grow, or AI Team for not
        having paid — the Stripe catalog, checkout, and conversion flow stay fully working underneath, only the
        lockout itself is suspended. Turn this on once venturelyx.com and every module are fully working.
      </p>

      {isLoading ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <label className="mt-4 flex items-center justify-between rounded-lg border border-border px-4 py-3">
          <span>
            <span className="text-sm font-medium">{enabled ? 'Enforcing payment' : 'Enforcement is off'}</span>
            <span className="block text-xs text-muted-foreground">
              {enabled ? 'Unpaid businesses are locked out.' : 'Everyone has full access regardless of payment status.'}
            </span>
          </span>
          <input
            type="checkbox"
            checked={enabled}
            disabled={saving}
            onChange={(e) => toggle(e.target.checked)}
            className="h-6 w-6 rounded border-border accent-[hsl(var(--primary))]"
          />
        </label>
      )}
      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    </Card>
  );
}

interface SmtpStatus {
  host: string | null;
  port: number;
  username: string | null;
  fromAddress: string | null;
  fromName: string | null;
  passwordConfigured: boolean;
}

function SmtpCard() {
  const { data, isLoading } = useApi<SmtpStatus>('/admin/settings/smtp');
  const [host, setHost] = useState('');
  const [port, setPort] = useState(465);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fromAddress, setFromAddress] = useState('');
  const [fromName, setFromName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [testStatus, setTestStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [testError, setTestError] = useState<string | null>(null);

  async function sendTest() {
    setTestStatus('sending');
    setTestError(null);
    try {
      const result = await apiFetch<{ ok: boolean; error?: string }>('/admin/settings/smtp/test', {
        method: 'POST', body: JSON.stringify({ to: testTo }),
      });
      if (result.ok) {
        setTestStatus('sent');
      } else {
        setTestStatus('error');
        setTestError(result.error ?? 'Send failed.');
      }
    } catch (err) {
      setTestStatus('error');
      setTestError(err instanceof ApiError ? err.message : 'Could not send.');
    }
  }

  useEffect(() => {
    if (!data) return;
    setHost(data.host ?? '');
    setPort(data.port ?? 465);
    setUsername(data.username ?? '');
    setFromAddress(data.fromAddress ?? 'no-reply@venturelyx.com');
    setFromName(data.fromName ?? 'Venturelyx');
  }, [data]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await apiFetch('/admin/settings/smtp', {
        method: 'PUT',
        body: JSON.stringify({
          host, port, username: username || null, fromAddress, fromName,
          ...(password ? { password } : {}),
        }),
      });
      setPassword('');
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-6">
      <h2 className="font-display font-bold tracking-tight">Transactional email (SMTP)</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Password reset, verification, invites, billing receipts, and Growth Scan reports send through this. Kept
        separate from Grow&rsquo;s own campaign mailboxes on purpose.
      </p>

      {isLoading ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <form onSubmit={onSubmit} className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className={labelCls}>
            SMTP host
            <input required value={host} onChange={(e) => setHost(e.target.value)} placeholder="mail.spacemail.com" className={inputCls} />
          </label>
          <label className={labelCls}>
            Port
            <input
              type="number" required value={port}
              onChange={(e) => setPort(Number(e.target.value))}
              className={inputCls}
            />
            <span className="text-xs text-muted-foreground/70">465 (SSL) or 587 — Spacemail supports either.</span>
          </label>
          <label className={labelCls}>
            Username
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="no-reply@venturelyx.com" className={inputCls} />
          </label>
          <label className={labelCls}>
            Password {data?.passwordConfigured && <span className="text-xs text-success">(already set — leave blank to keep it)</span>}
            <input
              type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              placeholder={data?.passwordConfigured ? '••••••••' : ''}
              className={inputCls}
            />
          </label>
          <label className={labelCls}>
            From address
            <input type="email" required value={fromAddress} onChange={(e) => setFromAddress(e.target.value)} className={inputCls} />
          </label>
          <label className={labelCls}>
            From name
            <input required value={fromName} onChange={(e) => setFromName(e.target.value)} className={inputCls} />
          </label>

          {error && <p className="sm:col-span-2 text-sm text-destructive">{error}</p>}
          {saved && <p className="sm:col-span-2 text-sm text-success">Saved.</p>}

          <Button type="submit" disabled={saving} className="sm:col-span-2 mt-1">
            {saving ? 'Saving…' : 'Save SMTP settings'}
          </Button>
        </form>
      )}

      <div className="mt-6 border-t border-border pt-4">
        <p className="text-sm font-medium">Send a test email</p>
        <p className="mt-1 text-xs text-muted-foreground">Sends through whatever&rsquo;s saved above right now.</p>
        <div className="mt-2 flex gap-2">
          <input
            type="email" placeholder="you@business.com" value={testTo}
            onChange={(e) => setTestTo(e.target.value)}
            className={`${inputCls} flex-1`}
          />
          <Button type="button" variant="ghost" disabled={testStatus === 'sending' || !testTo} onClick={sendTest}>
            {testStatus === 'sending' ? 'Sending…' : 'Send test'}
          </Button>
        </div>
        {testStatus === 'sent' && <p className="mt-1 text-sm text-success">Sent — check the inbox.</p>}
        {testStatus === 'error' && <p className="mt-1 text-sm text-destructive">{testError}</p>}
      </div>
    </Card>
  );
}

export default function AdminSettingsPage() {
  return (
    <div>
      <PageHeader eyebrow="Staff only" title="Platform Settings" subtitle="Operational toggles and the transactional email configuration." />
      <div className="grid gap-4 lg:grid-cols-2">
        <PaymentGateCard />
        <SmtpCard />
      </div>
    </div>
  );
}
