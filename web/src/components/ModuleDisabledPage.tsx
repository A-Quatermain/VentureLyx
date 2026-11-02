'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Lock } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { apiFetch, ApiError } from '@/lib/api';

// v2 catalog (lib/billingEntitlements.ts's LOOKUP_KEY_MODULES): modules
// unlock by TIER, not individually — there is no per-module add-on price
// anymore. Each module here maps to the LOWEST tier that includes it.
// Platform is self-serve (checkout fires directly, same as an existing org
// adding a module always has); Growth Partner and Launch & Growth are
// sales-assisted — their "upgrade" is routing into the Growth Scan funnel,
// not an instant checkout call, so there's no lookup key to send here at all.
type TierFlow =
  | { kind: 'checkout'; lookupKey: string }
  | { kind: 'growth-scan' };

const MODULE_TIER: Record<string, { tier: string; price: string; flow: TierFlow }> = {
  operate: { tier: 'Platform', price: '$129/mo', flow: { kind: 'checkout', lookupKey: 'platform_monthly' } },
  scaleseo: { tier: 'Growth Partner', price: '$349/mo', flow: { kind: 'growth-scan' } },
  reviews: { tier: 'Growth Partner', price: '$349/mo', flow: { kind: 'growth-scan' } },
  grow: { tier: 'Launch & Growth', price: '$499/mo', flow: { kind: 'growth-scan' } },
  ai_team: { tier: 'Launch & Growth', price: '$499/mo', flow: { kind: 'growth-scan' } },
};

// Deep-link landing for a module that isn't on this org's current plan —
// almost always a billing fact now (organizations.modules is written
// exclusively by the Stripe webhook once an org has ever subscribed; see
// lib/billingEntitlements.ts), so the prompt is "upgrade," not "ask your
// account team" the way it read before billing existed.
export function ModuleDisabledPage({ icon: ModuleIcon, label, moduleKey }: { icon: Icon; label: string; moduleKey: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Every live module maps to a real tier — an unmapped key would mean a
  // module was added to a layout without being priced anywhere, which is a
  // programming error upstream, not something this page should silently
  // paper over with a fallback price that doesn't exist.
  const entry = MODULE_TIER[moduleKey];

  async function onUpgrade() {
    if (!entry) return;
    if (entry.flow.kind === 'growth-scan') {
      router.push('/growth-scan');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { url } = await apiFetch<{ url: string }>('/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ lookupKeys: [entry.flow.lookupKey] }),
      });
      window.location.href = url;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start checkout.');
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-[70vh] items-center justify-center p-4">
      <Card className="w-full max-w-lg p-8 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-muted">
          <ModuleIcon size={28} weight="duotone" className="text-muted-foreground" />
        </div>
        <div className="mt-4 flex items-center justify-center gap-2">
          <h1 className="font-display text-2xl font-bold tracking-tight">{label}</h1>
          <span className="flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Lock size={11} weight="bold" /> Not on your plan
          </span>
        </div>
        {entry && (
          <>
            <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">
              Included in <span className="font-medium text-foreground">{entry.tier}</span> — {entry.price}
            </p>
            <div className="mt-5">
              <Button onClick={onUpgrade} disabled={loading}>
                {loading
                  ? 'Starting checkout…'
                  : entry.flow.kind === 'checkout'
                    ? `Upgrade to ${entry.tier}`
                    : `Talk to sales about ${entry.tier}`}
              </Button>
            </div>
          </>
        )}
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      </Card>
    </div>
  );
}
