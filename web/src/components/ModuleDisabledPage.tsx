'use client';

import { useState } from 'react';
import { Lock } from '@phosphor-icons/react';
import type { Icon } from '@phosphor-icons/react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { apiFetch, ApiError } from '@/lib/api';

// à la carte monthly lookup_key per module (scripts/stripeCatalog.ts) — the
// one thing an "Upgrade" button here needs, never a Stripe price id.
// ai_team has no standalone price (bundle-only, see
// lib/billingEntitlements.ts's own comment on that), hence no entry: that
// module's prompt names the plan instead of an add-on.
const MODULE_PRICE_KEY: Record<string, string> = {
  scaleseo: 'module_scaleseo_monthly',
  operate: 'module_operate_monthly',
  grow: 'module_grow_monthly',
  reviews: 'module_reviews_monthly',
};

// Deep-link landing for a module that isn't on this org's current plan —
// almost always a billing fact now (organizations.modules is written
// exclusively by the Stripe webhook once an org has ever subscribed; see
// lib/billingEntitlements.ts), so the prompt is "upgrade," not "ask your
// account team" the way it read before billing existed.
export function ModuleDisabledPage({ icon: ModuleIcon, label, moduleKey }: { icon: Icon; label: string; moduleKey: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const priceKey = MODULE_PRICE_KEY[moduleKey];

  async function onUpgrade(lookupKeys: string[]) {
    setLoading(true);
    setError(null);
    try {
      const { url } = await apiFetch<{ url: string }>('/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({ lookupKeys }),
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
        {priceKey ? (
          <>
            <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">
              {label} isn&rsquo;t included in your current plan. Add it on its own, or get every module with the
              Single Business Plan.
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
              <Button onClick={() => onUpgrade([priceKey])} disabled={loading}>
                {loading ? 'Starting checkout…' : `Add ${label}`}
              </Button>
              <Button variant="ghost" onClick={() => onUpgrade(['plan_single_monthly'])} disabled={loading}>
                See the full plan
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">
              {label} is included in the Single Business Plan — it isn&rsquo;t sold on its own.
            </p>
            <div className="mt-5">
              <Button onClick={() => onUpgrade(['plan_single_monthly'])} disabled={loading}>
                {loading ? 'Starting checkout…' : 'Upgrade to the Single Business Plan'}
              </Button>
            </div>
          </>
        )}
        {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      </Card>
    </div>
  );
}
