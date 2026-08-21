'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { mutate } from 'swr';
import {
  Robot, Target, MagnifyingGlass, PencilLine, Star, ChartLineUp, Buildings,
} from '@phosphor-icons/react';
import { useApi, useRole, atLeast } from '@/lib/useApi';
import { apiFetch } from '@/lib/api';
import type { AISettingsResponse, AIFeature, AIModelOverride, AIProvider } from '@/lib/types';
import { PageHeader } from '@/components/Primitives';
import { Card } from '@/components/ui/Card';

const AI_SETTINGS_KEY = '/settings/ai';

// Which of the six declared features actually stream a real completion
// today (grepped against api/src/routes/ai.ts) — the other three are real
// config slots for work that isn't built yet, and must say so rather than
// show invented activity.
const ACTIVE_FEATURES = new Set<AIFeature>(['next_best_action', 'page_generation', 'review_response']);

const ASSISTANTS: Array<{
  feature: AIFeature;
  name: string;
  module: string;
  href?: string;
  icon: typeof Robot;
  description: string;
}> = [
  {
    feature: 'next_best_action',
    name: 'Growth Strategist',
    module: 'Command Center',
    href: '/home',
    icon: Target,
    description: 'Reads your open opportunities and unresolved signals, then recommends the single highest-value thing to do next.',
  },
  {
    feature: 'page_generation',
    name: 'Content Writer',
    module: 'ScaleSEO',
    href: '/scaleseo',
    icon: PencilLine,
    description: 'Drafts service pages, location pages, blog posts, and landing pages from a topic and target keyword, ready for you to review and publish.',
  },
  {
    feature: 'review_response',
    name: 'Reputation Assistant',
    module: 'Reviews',
    href: '/reviews',
    icon: Star,
    description: 'Drafts a reply to any customer review in your voice, ready to send or edit.',
  },
  {
    feature: 'seo_recommendations',
    name: 'SEO Assistant',
    module: 'ScaleSEO',
    icon: MagnifyingGlass,
    description: "Will read your crawl results and turn technical, content, and local SEO issues into a ranked to-do list. ScaleSEO's AI Recommendation card currently reuses the Growth Strategist instead.",
  },
  {
    feature: 'metric_explanation',
    name: 'Insights Analyst',
    module: 'Command Center',
    icon: ChartLineUp,
    description: "Will explain why any metric moved, in plain English, right from the card it's on.",
  },
  {
    feature: 'business_blueprint',
    name: 'Business Planner',
    module: 'Build',
    icon: Buildings,
    description: 'Will turn a business idea into a full blueprint — positioning, brand direction, a starter site — as part of the upcoming Build module.',
  },
];

export default function AiTeamPage() {
  const role = useRole();
  const isAdmin = atLeast(role, 'admin');

  return (
    <div className="p-4">
      <PageHeader
        eyebrow="AI Team"
        title="Your AI Team"
        subtitle="Six assistants working your business. Pick which model each one uses, or leave it on Auto."
      />
      {isAdmin ? <AdminGrid /> : <ReadOnlyGrid />}
    </div>
  );
}

function AdminGrid() {
  const { data, isLoading } = useApi<AISettingsResponse>(AI_SETTINGS_KEY);
  const [overrides, setOverrides] = useState<Partial<Record<AIFeature, AIModelOverride | null>>>({});
  const [savingFeature, setSavingFeature] = useState<AIFeature | null>(null);
  const [errorFeature, setErrorFeature] = useState<AIFeature | null>(null);

  useEffect(() => {
    if (data) setOverrides(data.modelOverrides);
  }, [data]);

  async function onModelChange(feature: AIFeature, value: string) {
    const [provider, model] = value.split(':');
    const next: Partial<Record<AIFeature, AIModelOverride | null>> = {
      ...overrides,
      [feature]: value && provider && model ? { provider: provider as AIProvider, model } : null,
    };
    setOverrides(next);
    setSavingFeature(feature);
    setErrorFeature(null);
    try {
      await apiFetch(AI_SETTINGS_KEY, { method: 'PATCH', body: JSON.stringify({ modelOverrides: next }) });
      await mutate(AI_SETTINGS_KEY);
    } catch {
      setErrorFeature(feature);
    } finally {
      setSavingFeature(null);
    }
  }

  if (isLoading || !data) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {ASSISTANTS.map((a) => (
          <Card key={a.feature} className="h-56 animate-pulse p-5" />
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {ASSISTANTS.map((a) => {
        const active = ACTIVE_FEATURES.has(a.feature);
        const usage = data.usageThisMonth.byFeature[a.feature];
        const current = overrides[a.feature];
        const selectValue = current ? `${current.provider}:${current.model}` : '';

        return (
          <Card key={a.feature} className="flex flex-col p-5">
            <div className="mb-3 flex items-start justify-between gap-2">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                  <a.icon size={19} weight="duotone" className="text-primary" />
                </div>
                <div>
                  <p className="text-sm font-semibold">{a.name}</p>
                  <p className="text-xs text-muted-foreground">{a.module}</p>
                </div>
              </div>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                  active ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'
                }`}
              >
                {active ? 'Active' : 'Not connected'}
              </span>
            </div>

            <p className="flex-1 text-sm text-muted-foreground">{a.description}</p>

            {active && (
              <div className="mt-3 rounded-lg bg-muted px-3 py-2 text-xs">
                {usage ? (
                  <>
                    <span className="font-mono tabular-nums text-foreground">{usage.calls}</span> call
                    {usage.calls === 1 ? '' : 's'} this month ·{' '}
                    <span className="font-mono tabular-nums text-foreground">~${usage.estimatedCost.toFixed(2)}</span>
                  </>
                ) : (
                  <span className="text-muted-foreground">No usage yet this month.</span>
                )}
              </div>
            )}

            {a.href && (
              <Link href={a.href} className="mt-3 text-xs font-medium text-primary hover:underline">
                Open in {a.module} →
              </Link>
            )}

            <label className="mt-4 flex flex-col gap-1 border-t border-border pt-4 text-xs text-muted-foreground">
              Model
              <select
                value={selectValue}
                onChange={(e) => onModelChange(a.feature, e.target.value)}
                disabled={savingFeature === a.feature}
                className="min-h-[38px] rounded-lg border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              >
                <option value="">Auto (best model per task, with fallback)</option>
                {data.knownModels.map((m) => (
                  <option key={`${m.provider}:${m.model}`} value={`${m.provider}:${m.model}`}>
                    {m.label}
                  </option>
                ))}
              </select>
              {errorFeature === a.feature && <span className="text-destructive">Could not save — try again.</span>}
            </label>
          </Card>
        );
      })}
    </div>
  );
}

// Non-admins can't read /settings/ai (admin-gated, same as the Settings
// page) — rather than show an error state, describe the team without
// pretending to offer controls this role can't use.
function ReadOnlyGrid() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {ASSISTANTS.map((a) => {
        const active = ACTIVE_FEATURES.has(a.feature);
        return (
          <Card key={a.feature} className="flex flex-col p-5">
            <div className="mb-3 flex items-start justify-between gap-2">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                  <a.icon size={19} weight="duotone" className="text-primary" />
                </div>
                <div>
                  <p className="text-sm font-semibold">{a.name}</p>
                  <p className="text-xs text-muted-foreground">{a.module}</p>
                </div>
              </div>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                  active ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'
                }`}
              >
                {active ? 'Active' : 'Not connected'}
              </span>
            </div>
            <p className="flex-1 text-sm text-muted-foreground">{a.description}</p>
            {a.href && (
              <Link href={a.href} className="mt-3 text-xs font-medium text-primary hover:underline">
                Open in {a.module} →
              </Link>
            )}
            <p className="mt-4 border-t border-border pt-4 text-xs text-muted-foreground/70">
              Ask an admin to configure which model this assistant uses in Settings.
            </p>
          </Card>
        );
      })}
    </div>
  );
}
