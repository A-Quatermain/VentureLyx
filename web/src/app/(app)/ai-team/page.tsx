'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { mutate } from 'swr';
import {
  Robot, Target, MagnifyingGlass, PencilLine, Star, ChartLineUp, Buildings, PaperPlaneTilt, ChatCircleDots,
} from '@phosphor-icons/react';
import { useApi, useRole, atLeast } from '@/lib/useApi';
import { apiFetch } from '@/lib/api';
import type { AISettingsResponse, AIFeature, AIModelOverride, AIProvider, MeResponse } from '@/lib/types';
import { PageHeader } from '@/components/Primitives';
import { Card } from '@/components/ui/Card';

const AI_SETTINGS_KEY = '/settings/ai';

// Only the modules that actually have an organizations.modules toggle today
// (same keys lib/moduleAccess.ts enforces on writes) map here. 'Command
// Center' and 'Build' have no such key — Command Center is never gated by
// design, and Build doesn't exist yet (business_blueprint stays "coming
// soon" on its own, regardless of this map).
const MODULE_TOGGLE_KEY: Record<string, string> = {
  ScaleSEO: 'scaleseo',
  Reviews: 'reviews',
  Grow: 'grow',
  Operate: 'operate',
};

// Absent key means enabled — same rule lib/moduleAccess.ts enforces.
function isModuleOn(modules: Record<string, boolean> | null | undefined, moduleName: string): boolean {
  const key = MODULE_TOGGLE_KEY[moduleName];
  return !key || modules?.[key] !== false;
}

// Which declared features actually stream a real completion today (grepped
// against api/src/routes/ai.ts and routes/grow.ts) — business_blueprint is
// the one real config slot left for work that isn't built yet (the Build
// module), and must say so rather than show invented activity.
const ACTIVE_FEATURES = new Set<AIFeature>([
  'next_best_action', 'page_generation', 'review_response', 'seo_recommendations', 'metric_explanation',
  'sequence_writing', 'followup_assistant',
]);

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
    href: '/scaleseo',
    icon: MagnifyingGlass,
    description: 'Reads your crawl results and turns technical, content, and local SEO issues into a ranked to-do list — right on the Scanner tab’s AI Recommendation card.',
  },
  {
    feature: 'metric_explanation',
    name: 'Insights Analyst',
    module: 'Command Center',
    href: '/home',
    icon: ChartLineUp,
    description: "Explains why a metric moved, in plain English — click the sparkle on any stat tile.",
  },
  {
    feature: 'sequence_writing',
    name: 'Outreach Writer',
    module: 'Grow',
    href: '/grow',
    icon: PaperPlaneTilt,
    description: 'Drafts a starting email sequence for a campaign from your catalog, locations, and contacts — nothing sends until you review and save it.',
  },
  {
    feature: 'followup_assistant',
    name: 'Follow-up Assistant',
    module: 'Operate',
    href: '/operate/leads',
    icon: ChatCircleDots,
    description: 'Drafts follow-ups for a stale lead or job, and payment reminders for overdue invoices — ready for you to review and send yourself. Never sends or charges on its own.',
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
        subtitle="Your AI assistants across every module. Pick which model each one uses, or leave it on Auto."
      />
      {isAdmin ? <AdminGrid /> : <ReadOnlyGrid />}
    </div>
  );
}

function AdminGrid() {
  const { data, isLoading } = useApi<AISettingsResponse>(AI_SETTINGS_KEY);
  const { data: me } = useApi<MeResponse>('/auth/me');
  const modules = me?.organizations?.find((o) => o.id === me.currentOrgId)?.modules as Record<string, boolean> | null | undefined;
  const [overrides, setOverrides] = useState<Partial<Record<AIFeature, AIModelOverride | null>>>({});
  const [savingFeature, setSavingFeature] = useState<AIFeature | null>(null);
  const [errorFeature, setErrorFeature] = useState<AIFeature | null>(null);
  // Per-agent monthly cap, alongside the org-wide one in Settings — typed as
  // text so a field can sit empty mid-edit rather than snapping to "0".
  const [capInputs, setCapInputs] = useState<Partial<Record<AIFeature, string>>>({});
  const [capErrorFeature, setCapErrorFeature] = useState<AIFeature | null>(null);

  useEffect(() => {
    if (data) setOverrides(data.modelOverrides);
  }, [data]);

  useEffect(() => {
    if (data) {
      setCapInputs(
        Object.fromEntries(
          Object.entries(data.featureSpendCaps).map(([f, v]) => [f, String(v)]),
        ),
      );
    }
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

  async function onCapBlur(feature: AIFeature, raw: string) {
    const trimmed = raw.trim();
    const parsed = trimmed === '' ? null : Number(trimmed);
    if (parsed !== null && (!Number.isFinite(parsed) || parsed <= 0)) return; // leave invalid input unsaved, don't clobber the real value
    setCapErrorFeature(null);
    try {
      await apiFetch(AI_SETTINGS_KEY, {
        method: 'PATCH',
        body: JSON.stringify({ featureSpendCaps: { [feature]: parsed } }),
      });
      await mutate(AI_SETTINGS_KEY);
    } catch {
      setCapErrorFeature(feature);
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
        const moduleOn = isModuleOn(modules, a.module);
        const active = ACTIVE_FEATURES.has(a.feature) && moduleOn;
        const usage = data.usageThisMonth.byFeature[a.feature];
        const current = overrides[a.feature];
        const selectValue = current ? `${current.provider}:${current.model}` : '';

        return (
          <Card key={a.feature} className={moduleOn ? 'flex flex-col p-5' : 'flex flex-col p-5 opacity-60'}>
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
                  !moduleOn ? 'bg-muted text-muted-foreground' : active ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'
                }`}
              >
                {!moduleOn ? 'Locked' : active ? 'Active' : 'Coming soon'}
              </span>
            </div>

            <p className="flex-1 text-sm text-muted-foreground">
              {!moduleOn ? `Turned off along with the ${a.module} module for this business.` : a.description}
            </p>

            {active && (() => {
              const cap = data.featureSpendCaps[a.feature];
              const spent = usage?.estimatedCost ?? 0;
              const capHit = cap !== undefined && spent >= cap;
              return (
                <div className={`mt-3 rounded-lg px-3 py-2 text-xs ${capHit ? 'bg-destructive/10 text-destructive' : 'bg-muted'}`}>
                  {usage ? (
                    <>
                      <span className="font-mono tabular-nums text-foreground">{usage.calls}</span> call
                      {usage.calls === 1 ? '' : 's'} this month ·{' '}
                      <span className="font-mono tabular-nums text-foreground">~${usage.estimatedCost.toFixed(2)}</span>
                      {cap !== undefined && <span className="text-muted-foreground"> of ${cap.toFixed(2)} cap</span>}
                    </>
                  ) : (
                    <span className="text-muted-foreground">No usage yet this month.</span>
                  )}
                  {capHit && <div className="mt-0.5 font-medium">Paused — this agent's monthly cap is reached.</div>}
                </div>
              );
            })()}

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

            <label className="mt-3 flex flex-col gap-1 text-xs text-muted-foreground">
              Monthly cap for this agent
              <input
                type="number"
                min={1}
                step={1}
                inputMode="decimal"
                placeholder="No cap"
                value={capInputs[a.feature] ?? ''}
                onChange={(e) => setCapInputs({ ...capInputs, [a.feature]: e.target.value })}
                onBlur={(e) => onCapBlur(a.feature, e.target.value)}
                className="min-h-[38px] rounded-lg border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
              {capErrorFeature === a.feature && <span className="text-destructive">Could not save — try again.</span>}
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
  const { data: me } = useApi<MeResponse>('/auth/me');
  const modules = me?.organizations?.find((o) => o.id === me.currentOrgId)?.modules as Record<string, boolean> | null | undefined;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {ASSISTANTS.map((a) => {
        const moduleOn = isModuleOn(modules, a.module);
        const active = ACTIVE_FEATURES.has(a.feature) && moduleOn;
        return (
          <Card key={a.feature} className={moduleOn ? 'flex flex-col p-5' : 'flex flex-col p-5 opacity-60'}>
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
                  !moduleOn ? 'bg-muted text-muted-foreground' : active ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'
                }`}
              >
                {!moduleOn ? 'Locked' : active ? 'Active' : 'Coming soon'}
              </span>
            </div>
            <p className="flex-1 text-sm text-muted-foreground">
              {!moduleOn ? `Turned off along with the ${a.module} module for this business.` : a.description}
            </p>
            {a.href && moduleOn && (
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
