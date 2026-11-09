'use client';

import { useState } from 'react';
import { mutate } from 'swr';
import {
  CheckCircle, XCircle, Warning, CreditCard, ArrowsClockwise, ClipboardText,
} from '@phosphor-icons/react';
import { useApi } from '@/lib/useApi';
import { apiFetch, ApiError } from '@/lib/api';
import { PageHeader } from '@/components/Primitives';
import { Card } from '@/components/ui/Card';
import { SkeletonCard } from '@/components/ui/Skeleton';
import { toneSoft, type Tone } from '@/components/ui/tone';
import type { AdminBillingStatus, AdminBillingSyncResult, AdminBillingKeyStatus } from '@/lib/types';

const STATUS_KEY = '/admin/billing/status';

function fmt(d: string): string {
  return new Date(d).toLocaleString();
}

function Chip({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${toneSoft[tone]}`}>
      {children}
    </span>
  );
}

function OkChip({ ok, okLabel = 'OK', badLabel = 'Missing' }: { ok: boolean; okLabel?: string; badLabel?: string }) {
  return ok
    ? <Chip tone="success"><CheckCircle size={14} weight="fill" /> {okLabel}</Chip>
    : <Chip tone="destructive"><XCircle size={14} weight="fill" /> {badLabel}</Chip>;
}

function KeyRow({ label, status }: { label: string; status: AdminBillingKeyStatus }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="font-mono text-xs text-muted-foreground">{status.masked ?? 'not set'}</div>
      </div>
      <OkChip ok={status.configured} />
    </div>
  );
}

export default function AdminBillingPage() {
  const { data, isLoading, error } = useApi<AdminBillingStatus>(STATUS_KEY);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<AdminBillingSyncResult | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [showSelfCheck, setShowSelfCheck] = useState(false);

  async function onSyncCatalog() {
    if (!data) return;
    const warn = data.mode === 'live'
      ? 'This writes to your LIVE Stripe catalog (create/update products and prices — no charges). Continue?'
      : 'Sync the Stripe catalog for test mode now?';
    if (!window.confirm(warn)) return;

    setSyncing(true);
    setSyncError(null);
    setSyncResult(null);
    try {
      const result = await apiFetch<AdminBillingSyncResult>('/admin/billing/sync-catalog', {
        method: 'POST',
        body: JSON.stringify({ confirm: true }),
      });
      setSyncResult(result);
      await mutate(STATUS_KEY);
    } catch (err) {
      setSyncError(err instanceof ApiError ? err.message : 'Sync failed.');
    } finally {
      setSyncing(false);
    }
  }

  if (isLoading) return <SkeletonCard />;
  if (error || !data) return <p className="text-sm text-destructive">Could not load Stripe status.</p>;

  const allCatalogOk = data.catalog.every((p) => p.prices.every((pr) => pr.ok));
  const selfCheckOk = data.keys.secretKey.configured && data.keys.publishableKey.configured
    && data.keys.webhookSecretConfigured && !data.keys.modeMismatch && !data.keys.hintMismatch && allCatalogOk;

  return (
    <div>
      <PageHeader
        eyebrow="Staff only — platform account"
        title="Billing / Stripe"
        subtitle="Mode, keys, webhook health, and catalog — the platform's own Stripe account, not a per-business setting."
        actions={
          <button
            onClick={() => setShowSelfCheck(true)}
            className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted"
          >
            <ClipboardText size={16} /> Run self-check
          </button>
        }
      />

      {/* Mode banner */}
      <Card className={`mb-4 p-5 ${data.mode === 'live' ? 'border-warning/40 bg-warning/5' : ''}`}>
        <div className="flex items-center gap-3">
          <CreditCard size={28} weight="duotone" className={data.mode === 'live' ? 'text-warning' : 'text-muted-foreground'} />
          <div>
            <div className="font-display text-2xl font-bold tracking-tight">
              {data.mode === 'live' ? 'LIVE MODE — real charges' : 'TEST MODE'}
            </div>
            <p className="text-sm text-muted-foreground">
              Confirmed directly from Stripe (<code>balance.retrieve().livemode</code>), not guessed from the key's prefix.
            </p>
            {data.keys.hintMismatch && (
              <p className="mt-2 flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm font-semibold text-destructive">
                <Warning size={16} weight="fill" /> The key's own prefix disagrees with what Stripe just reported — trusting
                Stripe. This should never happen; investigate before doing anything else here.
              </p>
            )}
          </div>
        </div>
      </Card>

      {showSelfCheck && (
        <Card className={`mb-4 p-4 ${selfCheckOk ? 'border-success/40 bg-success/5' : 'border-destructive/40 bg-destructive/5'}`}>
          <div className="flex items-center gap-2 text-sm font-semibold">
            {selfCheckOk
              ? <><CheckCircle size={18} weight="fill" className="text-success" /> All checks pass — mode {data.mode}, keys consistent, webhook secret set, every catalog lookup key matches.</>
              : <><XCircle size={18} weight="fill" className="text-destructive" /> Something needs attention — see the red rows below.</>}
          </div>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-6">
          <h2 className="font-display font-bold tracking-tight">Keys</h2>
          {data.keys.modeMismatch && (
            <p className="mt-2 flex items-center gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <Warning size={16} weight="fill" /> Secret and publishable key modes don&rsquo;t match — checkout will error.
            </p>
          )}
          <div className="mt-4 flex flex-col gap-2">
            <KeyRow label="Secret key (STRIPE_SECRET_KEY)" status={data.keys.secretKey} />
            <KeyRow label="Publishable key (STRIPE_PUBLISHABLE_KEY)" status={data.keys.publishableKey} />
            <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
              <span className="text-sm font-medium">Webhook secret (STRIPE_WEBHOOK_SECRET)</span>
              <OkChip ok={data.keys.webhookSecretConfigured} />
            </div>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            The publishable key isn&rsquo;t actually read by checkout today — <code>routes/billing.ts</code> redirects to
            Stripe&rsquo;s own hosted Checkout Session URL rather than initializing Stripe.js in the browser. Shown here for
            completeness, not because anything currently depends on it.
          </p>
        </Card>

        <Card className="p-6">
          <h2 className="font-display font-bold tracking-tight">Webhook health</h2>
          <p className="mt-1 text-sm text-muted-foreground">Register this exact URL in the Stripe Dashboard.</p>
          <div className="mt-3 rounded-lg border border-border bg-muted/30 px-3 py-2 font-mono text-xs">
            {data.webhook.expectedUrl}
          </div>
          <div className="mt-4">
            {data.webhook.lastEvent ? (
              <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
                <span className="text-sm">{data.webhook.lastEvent.type}</span>
                <span className="text-xs text-muted-foreground">{fmt(data.webhook.lastEvent.processedAt)}</span>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No events received yet.</p>
            )}
          </div>
          <p className="mt-3 text-xs text-muted-foreground">{data.webhook.note}</p>
        </Card>

        <Card className="p-6 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="font-display font-bold tracking-tight">Catalog check</h2>
            <button
              onClick={onSyncCatalog}
              disabled={syncing}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              <ArrowsClockwise size={16} className={syncing ? 'animate-spin' : ''} /> {syncing ? 'Syncing…' : 'Sync catalog'}
            </button>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            A red row means checkout can succeed while the module never unlocks — the lookup key below doesn&rsquo;t match
            what <code>billingEntitlements.ts</code> expects.
          </p>
          {syncError && <p className="mt-3 text-sm text-destructive">{syncError}</p>}
          {syncResult && (
            <pre className={`mt-3 max-h-64 overflow-auto rounded-lg p-3 text-xs ${syncResult.ok ? 'bg-muted/30' : 'bg-destructive/10 text-destructive'}`}>
              {syncResult.log}
            </pre>
          )}

          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <th className="py-2">Product</th>
                  <th className="py-2">Lookup key</th>
                  <th className="py-2">Expected</th>
                  <th className="py-2">Stripe price</th>
                  <th className="py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.catalog.flatMap((product) =>
                  product.prices.map((price, i) => (
                    <tr key={price.lookupKey} className={`border-b border-border last:border-0 ${!price.ok ? 'bg-destructive/5' : ''}`}>
                      <td className="py-2">{i === 0 ? product.productName : ''}</td>
                      <td className="py-2 font-mono text-xs">{price.lookupKey}</td>
                      <td className="py-2 font-mono tabular-nums">
                        ${(price.expectedCents / 100).toFixed(2)}{price.interval ? `/${price.interval}` : ' one-time'}
                      </td>
                      <td className="py-2 font-mono text-xs text-muted-foreground">
                        {price.stripePriceId ?? '—'}
                      </td>
                      <td className="py-2">
                        {!price.stripePriceId ? (
                          <Chip tone="destructive"><XCircle size={14} weight="fill" /> Missing in Stripe</Chip>
                        ) : !price.modulesMatch ? (
                          <Chip tone="destructive"><Warning size={14} weight="fill" /> Not in LOOKUP_KEY_MODULES</Chip>
                        ) : (
                          <Chip tone="success"><CheckCircle size={14} weight="fill" /> OK</Chip>
                        )}
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        </Card>

        <Card className="p-6 lg:col-span-2">
          <h2 className="font-display font-bold tracking-tight">Recent entitlements</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Current state as of each organization&rsquo;s last webhook-driven update — not a full change history.
          </p>
          {data.recentEntitlements.length === 0 && <p className="mt-2 text-sm text-muted-foreground">No subscriptions yet.</p>}
          <div className="mt-3 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <th className="py-2">Organization</th>
                  <th className="py-2">Status</th>
                  <th className="py-2">Modules</th>
                  <th className="py-2">Updated</th>
                </tr>
              </thead>
              <tbody>
                {data.recentEntitlements.map((e) => (
                  <tr key={e.orgId} className="border-b border-border last:border-0">
                    <td className="py-2">{e.orgName}</td>
                    <td className="py-2 text-muted-foreground">{e.status}</td>
                    <td className="py-2">
                      <div className="flex flex-wrap gap-1">
                        {e.modules.length === 0
                          ? <span className="text-muted-foreground">none</span>
                          : e.modules.map((m) => <Chip key={m} tone="primary">{m}</Chip>)}
                      </div>
                    </td>
                    <td className="py-2 text-xs text-muted-foreground">{fmt(e.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
