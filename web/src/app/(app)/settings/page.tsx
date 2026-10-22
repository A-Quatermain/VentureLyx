'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { mutate } from 'swr';
import { Cpu, Key, ChartBar, CaretDown, MapPin, MagnifyingGlass, TrendUp } from '@phosphor-icons/react';
import { useApi, useRole, atLeast } from '@/lib/useApi';
import { apiFetch, ApiError } from '@/lib/api';
import { API_BASE } from '@/lib/config';
import type {
  OrgProfile, AISettingsResponse, AIProviderPreference, AIFeature, AIModelOverride, AIProvider,
  ServiceArea, GscStatus, GrowSenderProfile, BillingStatus,
} from '@/lib/types';
import type { MeResponse } from '@/lib/types';
import { PageHeader } from '@/components/Primitives';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { BusinessProfileForm, type BusinessProfileValues } from '@/components/BusinessProfileForm';
import { AddBusinessDrawer } from '@/components/AddBusinessDrawer';
import { ServiceAreaForm, BLANK_CITY, realCities, type ServiceAreaValues } from '@/components/ServiceAreaForm';
import {
  GrowSenderProfileForm, realProductUrls, type GrowSenderProfileValues,
} from '@/components/GrowSenderProfileForm';

const ORG_KEY = '/orgs/current';
const AI_SETTINGS_KEY = '/settings/ai';

const FEATURE_LABEL: Record<AIFeature, string> = {
  seo_recommendations: 'SEO recommendations',
  page_generation: 'Page generation',
  review_response: 'Review responses',
  next_best_action: 'Next best action',
  metric_explanation: 'Metric explanations',
  business_blueprint: 'Business blueprint',
  sequence_writing: 'Grow sequence writing',
  ai_visibility_check: 'AI visibility checks',
  reply_classification: 'Grow reply classification',
  followup_assistant: 'Operate follow-up drafting',
  seo_issue_fix: 'ScaleSEO issue fixes',
};

export default function SettingsPage() {
  const role = useRole();
  const canEdit = atLeast(role, 'admin');

  return (
    <div className="p-4">
      <PageHeader
        eyebrow="Configuration"
        title="Settings"
        subtitle="Manage your business profile and how AI works across Venturelyx."
      />
      <div className="flex max-w-3xl flex-col gap-6">
        <YourBusinessesCard />
        <BillingCard canEdit={canEdit} />
        <BusinessCard canEdit={canEdit} />
        <ServiceAreaCard canEdit={canEdit} />
        <GrowSenderProfileCard canEdit={canEdit} />
        <GscCard canEdit={canEdit} />
        <AICard canEdit={canEdit} />
      </div>
    </div>
  );
}

// Settings isn't where a business gets created (that's the org switcher's
// "+ Add a business" row, which opens the same drawer this links to) — this
// is just a reasonable place to see how many you have. Each one is a
// separate org and, eventually, its own line on the bill.
function YourBusinessesCard() {
  const { data: me } = useApi<MeResponse>('/auth/me');
  const [adding, setAdding] = useState(false);
  const count = me?.organizations?.length ?? 0;

  return (
    <Card className="flex items-center justify-between gap-4 p-6">
      <div>
        <p className="font-display text-lg font-bold tracking-tight">Your businesses</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {me ? `${count} business${count === 1 ? '' : 'es'} on this account.` : 'Loading…'}
        </p>
      </div>
      <Button variant="ghost" onClick={() => setAdding(true)}>
        Add another business
      </Button>
      <AddBusinessDrawer open={adding} onOpenChange={setAdding} />
    </Card>
  );
}

const BILLING_KEY = '/billing/status';

// Human label per lookup_key family — purely cosmetic, never used to
// compute price or entitlement (that's lib/billingEntitlements.ts's job,
// server-side).
const PLAN_LABEL: Record<string, string> = {
  platform: 'Platform',
  growth_partner: 'Growth Partner',
  launch_growth: 'Launch & Growth',
  founding: 'Founding Business',
};

function planLabel(lookupKeys: string[]): string {
  const names = [...new Set(lookupKeys.map((k) => PLAN_LABEL[k.replace(/_(monthly|annual)$/, '')] ?? k))];
  return names.join(' + ') || 'Unknown plan';
}

const STATUS_TONE: Record<string, string> = {
  active: 'bg-success/10 text-success',
  trialing: 'bg-success/10 text-success',
  past_due: 'bg-warning/10 text-warning',
  canceled: 'bg-muted text-muted-foreground',
  unpaid: 'bg-destructive/10 text-destructive',
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function BillingCard({ canEdit }: { canEdit: boolean }) {
  const { data, isLoading } = useApi<BillingStatus>(BILLING_KEY);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function goTo(path: string, body: unknown) {
    setBusy(true);
    setError(null);
    try {
      const { url } = await apiFetch<{ url: string }>(path, { method: 'POST', body: JSON.stringify(body) });
      window.location.href = url;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach billing.');
      setBusy(false);
    }
  }

  const sub = data?.subscription ?? null;

  return (
    <Card id="billing" className="scroll-mt-20 p-6">
      <div className="mb-1 flex items-center gap-2">
        <Key size={18} className="text-primary" />
        <p className="font-display text-lg font-bold tracking-tight">Billing</p>
      </div>
      {isLoading ? (
        <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
      ) : !sub ? (
        <div className="mt-3">
          <p className="text-sm text-muted-foreground">No active subscription yet.</p>
          {canEdit && (
            <>
              <Button className="mt-3" onClick={() => goTo('/billing/checkout', { lookupKeys: ['platform_monthly'] })} disabled={busy}>
                {busy ? 'Starting checkout…' : 'Subscribe — Platform ($129/mo)'}
              </Button>
              <p className="mt-2 text-xs text-muted-foreground">
                Looking for Growth Partner, Launch &amp; Growth, or the Founding Business rate? Those are set up with
                your Venturelyx contact, not self-service here.
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="mt-3 flex items-center justify-between gap-4 rounded-lg border border-border p-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">{planLabel(sub.price_lookup_keys)}</p>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${STATUS_TONE[sub.status] ?? 'bg-muted text-muted-foreground'}`}>
                {sub.status.replace(/_/g, ' ')}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {sub.status === 'past_due'
                ? 'Your last payment failed — update your card to keep your modules unlocked.'
                : sub.cancel_at
                  ? `Cancels ${formatDate(sub.cancel_at)}`
                  : `Renews ${formatDate(sub.current_period_end)}`}
            </p>
          </div>
          {canEdit && (
            <Button variant="ghost" className="shrink-0" onClick={() => goTo('/billing/portal', {})} disabled={busy}>
              Manage billing
            </Button>
          )}
        </div>
      )}
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
    </Card>
  );
}

function BusinessCard({ canEdit }: { canEdit: boolean }) {
  const { data: org, isLoading } = useApi<OrgProfile>(ORG_KEY);
  const [profile, setProfile] = useState<BusinessProfileValues | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (org) {
      setProfile({
        name: org.name,
        website_url: org.website_url ?? '',
        vertical: org.vertical ?? '',
        service_area: org.service_area ?? '',
      });
    }
  }, [org]);

  async function onSave() {
    if (!profile) return;
    setSaving(true);
    setError(null);
    try {
      await apiFetch(ORG_KEY, {
        method: 'PATCH',
        body: JSON.stringify({
          name: profile.name,
          website_url: profile.website_url.trim() || null,
          vertical: profile.vertical.trim() || null,
          service_area: profile.service_area.trim() || null,
        }),
      });
      await Promise.all([mutate(ORG_KEY), mutate('/auth/me')]);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card id="business" className="scroll-mt-20 p-6">
      <p className="mb-4 font-display text-lg font-bold tracking-tight">Business profile</p>
      {isLoading || !profile ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <BusinessProfileForm values={profile} onChange={setProfile} />
          {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
          {canEdit && (
            <div className="mt-4 flex items-center gap-3">
              <Button onClick={onSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
              {saved && <span className="text-sm text-success">Saved.</span>}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

const SERVICE_AREA_KEY = '/service-area';

function ServiceAreaCard({ canEdit }: { canEdit: boolean }) {
  const { data, isLoading } = useApi<ServiceArea>(SERVICE_AREA_KEY);
  const [draft, setDraft] = useState<ServiceAreaValues | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    const cities = data.locations
      .filter((l) => l.radius_miles == null)
      .map((l) => ({ name: l.name, region: l.region ?? '', isPrimary: l.is_primary }));
    setDraft({
      mode: data.service_area_mode,
      cities: cities.length > 0 ? cities : [{ ...BLANK_CITY }],
      address_line1: data.address_line1 ?? '',
      address_line2: data.address_line2 ?? '',
      city: data.city ?? '',
      region: data.region ?? '',
      postal_code: data.postal_code ?? '',
      radiusMiles: data.service_radius_miles ?? '',
    });
  }, [data]);

  async function onSave() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const body =
        draft.mode === 'cities'
          ? {
              mode: 'cities' as const,
              cities: realCities(draft.cities).map((c) => ({
                name: c.name, region: c.region.trim() || null, isPrimary: c.isPrimary,
              })),
            }
          : {
              mode: 'radius' as const,
              address_line1: draft.address_line1,
              address_line2: draft.address_line2 || null,
              city: draft.city,
              region: draft.region || null,
              postal_code: draft.postal_code || null,
              radiusMiles: Number(draft.radiusMiles),
            };
      await apiFetch(SERVICE_AREA_KEY, { method: 'PUT', body: JSON.stringify(body) });
      await mutate(SERVICE_AREA_KEY);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save your service area.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card id="service-area" className="scroll-mt-20 p-6">
      <div className="mb-1 flex items-center gap-2">
        <MapPin size={18} className="text-primary" />
        <p className="font-display text-lg font-bold tracking-tight">Service area</p>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        Where you work. This drives the coverage-gap report in ScaleSEO — every service you offer is
        checked against every place you serve.
      </p>
      {isLoading || !draft ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <fieldset disabled={!canEdit} className="contents">
            <ServiceAreaForm values={draft} onChange={setDraft} />
          </fieldset>
          {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
          {canEdit && (
            <div className="mt-4 flex items-center gap-3">
              <Button onClick={onSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
              {saved && <span className="text-sm text-success">Saved.</span>}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

const GROW_SENDER_PROFILE_KEY = '/grow/sender-profile';

function GrowSenderProfileCard({ canEdit }: { canEdit: boolean }) {
  const { data, isLoading } = useApi<GrowSenderProfile>(GROW_SENDER_PROFILE_KEY);
  const [draft, setDraft] = useState<GrowSenderProfileValues | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setDraft({
      sender_name: data.sender_name ?? '',
      website_url: data.website_url ?? '',
      phone: data.phone ?? '',
      contact_email: data.contact_email ?? '',
      mailing_address: data.mailing_address ?? '',
      product_urls: data.product_urls.length > 0 ? data.product_urls : [{ label: '', url: '' }],
    });
  }, [data]);

  async function onSave() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const body = {
        sender_name: draft.sender_name.trim() || null,
        website_url: draft.website_url.trim() || null,
        phone: draft.phone.trim() || null,
        contact_email: draft.contact_email.trim() || null,
        mailing_address: draft.mailing_address.trim() || null,
        product_urls: realProductUrls(draft.product_urls),
      };
      await apiFetch(GROW_SENDER_PROFILE_KEY, { method: 'PUT', body: JSON.stringify(body) });
      await mutate(GROW_SENDER_PROFILE_KEY);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save your Grow sender profile.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="p-6">
      <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <TrendUp size={18} className="text-primary" />
          <p className="font-display text-lg font-bold tracking-tight">Grow sender profile</p>
        </div>
        <Link href="/grow/sending" className="text-sm font-medium text-primary hover:underline">
          Sending domains &amp; mailboxes →
        </Link>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        Who your outreach emails come from. Resolved as merge fields in sequence steps — website and phone
        are optional, but a mailing address is legally required before any real send exists. Verifying a
        sending domain and adding a mailbox happens on the linked page, not here.
      </p>
      {isLoading || !draft ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <fieldset disabled={!canEdit} className="contents">
            <GrowSenderProfileForm values={draft} onChange={setDraft} />
          </fieldset>
          {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
          {canEdit && (
            <div className="mt-4 flex items-center gap-3">
              <Button onClick={onSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
              {saved && <span className="text-sm text-success">Saved.</span>}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

const GSC_STATUS_KEY = '/integrations/gsc/status';

function GscCard({ canEdit }: { canEdit: boolean }) {
  const { data, isLoading } = useApi<GscStatus>(GSC_STATUS_KEY);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // The OAuth flow ends in a full-page redirect back to this route with
  // ?gsc=connected or ?gsc=error&reason=... — read once on mount, then strip
  // it from the URL so a refresh doesn't re-show a stale banner.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gsc = params.get('gsc');
    if (!gsc) return;
    if (gsc === 'connected') {
      setNotice('Google Search Console connected. Data will appear within a few minutes.');
      mutate(GSC_STATUS_KEY);
    } else if (gsc === 'error') {
      setNotice(`Could not connect Google Search Console (${params.get('reason') ?? 'unknown error'}).`);
    }
    window.history.replaceState(null, '', window.location.pathname);
  }, []);

  async function onDisconnect() {
    setBusy(true);
    try {
      await apiFetch('/integrations/gsc/disconnect', { method: 'POST' });
      await mutate(GSC_STATUS_KEY);
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : 'Could not disconnect.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card id="gsc" className="scroll-mt-20 p-6">
      <div className="mb-1 flex items-center gap-2">
        <MagnifyingGlass size={18} className="text-primary" />
        <p className="font-display text-lg font-bold tracking-tight">Google Search Console</p>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        Powers the Keywords tab in ScaleSEO with real query-level performance — no connection, no
        keyword data.
      </p>
      {notice && <p className="mb-3 text-sm text-muted-foreground">{notice}</p>}
      {isLoading || !data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : data.connected ? (
        <div className="flex items-center justify-between rounded-lg border border-border p-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{data.propertyUrl}</p>
            <p className="text-xs text-muted-foreground">
              {data.lastSyncAt ? `Last synced ${new Date(data.lastSyncAt).toLocaleString()}` : 'Not synced yet'}
            </p>
          </div>
          {canEdit && (
            <Button variant="ghost" onClick={onDisconnect} disabled={busy} className="shrink-0 text-destructive">
              Disconnect
            </Button>
          )}
        </div>
      ) : data.status === 'error' ? (
        // Was connected; Google rejected the refresh token (revoked access,
        // or the grant otherwise expired) — workers/seo/gsc.py flips status
        // to 'error' rather than retrying forever. Distinct from never
        // having connected: this needs "reconnect", not "connect".
        <div className="flex items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning/5 p-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-warning">Connection needs to be renewed</p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {data.propertyUrl}
              {data.lastError ? ` · ${data.lastError}` : ' · Google stopped accepting the saved connection.'}
            </p>
          </div>
          {canEdit && (
            <Button
              variant="ghost"
              className="shrink-0"
              onClick={() => { window.location.href = `${API_BASE}/integrations/gsc/oauth/start`; }}
            >
              Reconnect
            </Button>
          )}
        </div>
      ) : (
        canEdit && (
          <Button onClick={() => { window.location.href = `${API_BASE}/integrations/gsc/oauth/start`; }}>
            Connect Google Search Console
          </Button>
        )
      )}
    </Card>
  );
}

const PROVIDERS: { key: AIProviderPreference; label: string; desc: string }[] = [
  {
    key: 'auto',
    label: 'Auto (best model per task, with fallback)',
    desc: 'Routes each task to Anthropic first, falling back to OpenAI automatically if one is unavailable.',
  },
  {
    key: 'anthropic',
    label: 'Prefer Claude (Anthropic)',
    desc: 'Claude Opus 5 / Sonnet 5 / Haiku 4.5. Falls back to OpenAI on error.',
  },
  {
    key: 'openai',
    label: 'Prefer ChatGPT (OpenAI)',
    desc: 'GPT-5 Pro / GPT-4.1 / GPT-5 Nano. Falls back to Anthropic on error.',
  },
];

function AICard({ canEdit }: { canEdit: boolean }) {
  const { data, isLoading } = useApi<AISettingsResponse>(AI_SETTINGS_KEY);

  const [providerPreference, setProviderPreference] = useState<AIProviderPreference>('auto');
  const [spendCap, setSpendCap] = useState('');
  const [overrides, setOverrides] = useState<Partial<Record<AIFeature, AIModelOverride | null>>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const [keyDrafts, setKeyDrafts] = useState<Record<AIProvider, string>>({ anthropic: '', openai: '' });
  const [keyBusy, setKeyBusy] = useState<Partial<Record<AIProvider, boolean>>>({});
  const [keyError, setKeyError] = useState<Partial<Record<AIProvider, string | null>>>({});

  useEffect(() => {
    if (data) {
      setProviderPreference(data.providerPreference);
      setSpendCap(data.spendCapMonthly != null ? String(data.spendCapMonthly) : '');
      setOverrides(data.modelOverrides);
    }
  }, [data]);

  async function onSave() {
    setSaving(true);
    setError(null);
    try {
      await apiFetch(AI_SETTINGS_KEY, {
        method: 'PATCH',
        body: JSON.stringify({
          providerPreference,
          spendCapMonthly: spendCap.trim() ? Number(spendCap) : null,
          modelOverrides: overrides,
        }),
      });
      await mutate(AI_SETTINGS_KEY);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  }

  async function saveKey(provider: AIProvider) {
    const apiKey = keyDrafts[provider].trim();
    if (!apiKey) return;
    setKeyBusy((b) => ({ ...b, [provider]: true }));
    setKeyError((e) => ({ ...e, [provider]: null }));
    try {
      await apiFetch(`/settings/ai/keys/${provider}`, { method: 'PUT', body: JSON.stringify({ apiKey }) });
      setKeyDrafts((d) => ({ ...d, [provider]: '' }));
      await mutate(AI_SETTINGS_KEY);
    } catch (err) {
      setKeyError((e) => ({ ...e, [provider]: err instanceof ApiError ? err.message : 'Could not save this key.' }));
    } finally {
      setKeyBusy((b) => ({ ...b, [provider]: false }));
    }
  }

  async function removeKey(provider: AIProvider) {
    setKeyBusy((b) => ({ ...b, [provider]: true }));
    setKeyError((e) => ({ ...e, [provider]: null }));
    try {
      await apiFetch(`/settings/ai/keys/${provider}`, { method: 'DELETE' });
      await mutate(AI_SETTINGS_KEY);
    } catch (err) {
      setKeyError((e) => ({ ...e, [provider]: err instanceof ApiError ? err.message : 'Could not remove this key.' }));
    } finally {
      setKeyBusy((b) => ({ ...b, [provider]: false }));
    }
  }

  if (isLoading || !data) {
    return (
      <Card className="p-6">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </Card>
    );
  }

  const capReached = data.spendCapMonthly != null && data.usageThisMonth.totalEstimatedCost >= data.spendCapMonthly;
  const featureEntries = Object.entries(data.usageThisMonth.byFeature) as Array<
    [AIFeature, { calls: number; tokens: number; estimatedCost: number }]
  >;

  return (
    <Card className="p-6">
      <div className="mb-4 flex items-center gap-2">
        <Cpu size={18} className="text-primary" />
        <p className="font-display text-lg font-bold tracking-tight">AI</p>
      </div>

      <div className="space-y-3">
        {PROVIDERS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => canEdit && setProviderPreference(p.key)}
            disabled={!canEdit}
            className={`w-full rounded-lg border p-4 text-left transition-colors ${
              providerPreference === p.key ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted'
            } disabled:cursor-not-allowed`}
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{p.label}</span>
              {providerPreference === p.key && (
                <span className="ml-auto font-mono text-xs text-primary">SELECTED</span>
              )}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{p.desc}</p>
          </button>
        ))}
      </div>

      <div className="mt-6 border-t border-border pt-6">
        <div className="mb-3 flex items-center gap-2">
          <Key size={16} className="text-muted-foreground" />
          <p className="text-sm font-semibold">Your own API keys (optional)</p>
        </div>
        <p className="mb-3 text-xs text-muted-foreground">
          Connect your own Anthropic or OpenAI key to bill calls to your own account instead of the shared
          one. Keys are encrypted at rest and never shown again once saved.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          {(['anthropic', 'openai'] as const).map((provider) => {
            const connected = data.connectedProviders.includes(provider);
            const sharedAvailable = provider === 'anthropic' ? data.hasSharedAnthropic : data.hasSharedOpenai;
            return (
              <div key={provider} className="rounded-lg border border-border p-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium capitalize">{provider}</span>
                  <span
                    className={`font-mono text-[10px] uppercase ${connected ? 'text-success' : 'text-muted-foreground'}`}
                  >
                    {connected ? 'Connected' : sharedAvailable ? 'Using shared key' : 'Not configured'}
                  </span>
                </div>
                {canEdit && (
                  <div className="mt-2 flex gap-2">
                    <input
                      type="password"
                      autoComplete="off"
                      placeholder={connected ? 'Replace key…' : 'sk-…'}
                      value={keyDrafts[provider]}
                      onChange={(e) => setKeyDrafts((d) => ({ ...d, [provider]: e.target.value }))}
                      className="min-h-[36px] flex-1 rounded-lg border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                    />
                    <Button
                      variant="ghost"
                      onClick={() => saveKey(provider)}
                      disabled={keyBusy[provider] || !keyDrafts[provider].trim()}
                    >
                      Save
                    </Button>
                    {connected && (
                      <Button
                        variant="ghost"
                        onClick={() => removeKey(provider)}
                        disabled={keyBusy[provider]}
                        className="text-destructive"
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                )}
                {keyError[provider] && <p className="mt-1 text-xs text-destructive">{keyError[provider]}</p>}
              </div>
            );
          })}
        </div>
      </div>

      <div className="mt-6 border-t border-border pt-6">
        <div className="mb-3 flex items-center gap-2">
          <ChartBar size={16} className="text-muted-foreground" />
          <p className="text-sm font-semibold">Usage this month</p>
        </div>
        {featureEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No AI usage yet this month.</p>
        ) : (
          <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
            {featureEntries.map(([feature, u]) => (
              <div key={feature} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{FEATURE_LABEL[feature] ?? feature}</span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {u.calls} call{u.calls === 1 ? '' : 's'} · {u.tokens.toLocaleString()} tokens
                </span>
                <span className="shrink-0 font-mono text-sm font-semibold" data-numeric>
                  ~${u.estimatedCost.toFixed(2)}
                </span>
              </div>
            ))}
            <div className="flex items-center justify-between bg-muted px-3 py-2 text-sm font-semibold">
              <span>Total estimated cost</span>
              <span className="font-mono" data-numeric>
                ~${data.usageThisMonth.totalEstimatedCost.toFixed(2)}
              </span>
            </div>
          </div>
        )}
        <p className="mt-2 text-xs text-muted-foreground/70">
          Estimates only, based on approximate token counts — not a substitute for your provider&apos;s invoice.
        </p>
      </div>

      <div className="mt-6 border-t border-border pt-6">
        <label className="flex flex-col gap-1 text-sm text-muted-foreground">
          Monthly spend cap (optional)
          <div className="flex items-center gap-2">
            <span className="text-sm">$</span>
            <input
              type="number"
              min="0"
              step="1"
              disabled={!canEdit}
              placeholder="No cap"
              value={spendCap}
              onChange={(e) => setSpendCap(e.target.value)}
              className="min-h-[38px] w-32 rounded-lg border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </div>
        </label>
        <p className="mt-1 text-xs text-muted-foreground">
          AI pauses for the rest of the month once this is reached — everything else keeps working.
        </p>
        {capReached && (
          <p className="mt-2 text-xs font-medium text-destructive">
            AI is currently paused — this month&apos;s cap has been reached.
          </p>
        )}
      </div>

      <div className="mt-6 border-t border-border pt-6">
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          className="flex w-full items-center justify-between text-sm font-semibold"
        >
          Advanced: per-feature model override
          <CaretDown size={14} weight="bold" className={`transition-transform ${advancedOpen ? 'rotate-180' : ''}`} />
        </button>
        {advancedOpen && (
          <div className="mt-3 space-y-2">
            {(Object.keys(FEATURE_LABEL) as AIFeature[]).map((feature) => {
              const current = overrides[feature];
              const value = current ? `${current.provider}:${current.model}` : '';
              return (
                <label key={feature} className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
                  {FEATURE_LABEL[feature]}
                  <select
                    disabled={!canEdit}
                    value={value}
                    onChange={(e) => {
                      const v = e.target.value;
                      const [provider, model] = v.split(':');
                      setOverrides((o) => ({
                        ...o,
                        [feature]: v && provider && model ? { provider: provider as AIProvider, model } : null,
                      }));
                    }}
                    className="min-h-[36px] w-56 rounded-lg border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                  >
                    <option value="">Default (tier-based)</option>
                    {data.knownModels.map((m) => (
                      <option key={`${m.provider}:${m.model}`} value={`${m.provider}:${m.model}`}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
          </div>
        )}
      </div>

      {error && <p className="mt-4 text-sm text-destructive">{error}</p>}
      {canEdit && (
        <div className="mt-6 flex items-center gap-3 border-t border-border pt-6">
          <Button onClick={onSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save AI settings'}
          </Button>
          {saved && <span className="text-sm text-success">Saved.</span>}
        </div>
      )}
    </Card>
  );
}
