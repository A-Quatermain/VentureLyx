'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { mutate } from 'swr';
import {
  Globe, Buildings, MapPin, Tag, MagnifyingGlass, Users, ClipboardText, Receipt, Briefcase,
  CheckCircle, CircleDashed, ArrowRight,
} from '@phosphor-icons/react';
import { useApi, useRole, atLeast } from '@/lib/useApi';
import { apiFetch } from '@/lib/api';
import type { SetupProgress, SetupStepKey, SeoSite } from '@/lib/types';
import { Card } from '@/components/ui/Card';

const PROGRESS_KEY = '/setup/progress';

interface StepMeta {
  key: SetupStepKey;
  label: string;
  reason: string;
  icon: typeof Globe;
  cta: string;
  href: (primarySiteId: string | null) => string;
  /** Can be marked "not doing this one" instead of completed — see
   *  api/src/routes/setup.ts's SKIPPABLE_STEPS. */
  skippable?: boolean;
}

// Wording matches what was asked for verbatim where given; the two steps
// without a quoted reason (business, review) get one written in the same
// voice.
const STEP_META: StepMeta[] = [
  {
    key: 'website',
    label: 'Add your website',
    reason: 'We scan it and find what’s missing.',
    icon: Globe,
    cta: 'Add site',
    href: () => '/scaleseo?add=1',
  },
  {
    key: 'business',
    label: 'Confirm your business details',
    reason: 'Keeps every report and recommendation grounded in the right business.',
    icon: Buildings,
    cta: 'Review',
    href: () => '/settings#business',
  },
  {
    key: 'cities',
    label: 'Add the cities you serve',
    reason: 'This is what finds your coverage gaps.',
    icon: MapPin,
    cta: 'Add cities',
    href: () => '/settings#service-area',
  },
  {
    key: 'services',
    label: 'Add the services you sell',
    reason: 'Crossed with your cities, this is your opportunity map.',
    icon: Tag,
    cta: 'Add services',
    href: () => '/operate/catalog',
  },
  {
    key: 'gsc',
    label: 'Connect Google Search Console',
    reason: 'Real search data, optional.',
    icon: MagnifyingGlass,
    cta: 'Connect',
    href: () => '/settings#gsc',
  },
  {
    key: 'customers',
    label: 'Import customers',
    reason: 'CSV import or manual — this makes revenue tracking work.',
    icon: Users,
    cta: 'Import customers',
    href: () => '/operate/customers/import',
    skippable: true,
  },
  {
    key: 'invoices',
    label: 'Import invoices',
    reason: 'Bring in your current-year invoices so revenue and outstanding balances show up right away.',
    icon: Receipt,
    cta: 'Import invoices',
    href: () => '/operate/invoices/import',
    skippable: true,
  },
  {
    key: 'jobs',
    label: 'Import open jobs',
    reason: 'Bring in whatever you have scheduled so the Jobs board isn’t starting from zero.',
    icon: Briefcase,
    cta: 'Import jobs',
    href: () => '/operate/jobs/import',
    skippable: true,
  },
  {
    key: 'review',
    label: 'Review your first scan results',
    reason: 'See what Venturelyx already found — this is the moment you decide if it’s worth your time.',
    icon: ClipboardText,
    cta: 'Review',
    href: (siteId) => (siteId ? `/scaleseo/${siteId}` : '/scaleseo'),
  },
];

// Pinned to Command Center until every step is done, then dismissible — a
// new org with nothing set up yet should never land on a dashboard that
// just looks empty or broken. Progress is read live from /setup/progress
// (five of seven steps are derived from real data, not a stored flag — see
// api/src/routes/setup.ts), so this always reflects the org's actual state,
// not a one-time snapshot.
export function SetupChecklist() {
  const router = useRouter();
  const role = useRole();
  const canDismiss = atLeast(role, 'manager');
  const { data: progress } = useApi<SetupProgress>(PROGRESS_KEY);
  const { data: sites } = useApi<SeoSite[]>('/seo/sites');
  const [dismissing, setDismissing] = useState(false);

  if (!progress || progress.dismissed) return null;

  const primarySite = sites?.find((s) => s.is_primary) ?? sites?.[0] ?? null;
  const complete = progress.done === progress.total;

  async function onDismiss() {
    setDismissing(true);
    try {
      await apiFetch('/setup/dismiss', { method: 'POST' });
      await mutate(PROGRESS_KEY);
    } finally {
      setDismissing(false);
    }
  }

  function onStepClick(step: StepMeta) {
    if (step.key === 'review') {
      // Fire-and-forget — the step still navigates immediately even if this
      // is slow or fails; being a beat late to show as "done" isn't worth
      // blocking on.
      apiFetch('/setup/mark-reviewed', { method: 'POST' }).then(() => mutate(PROGRESS_KEY));
    }
    router.push(step.href(primarySite?.id ?? null));
  }

  async function onStepSkip(key: SetupStepKey) {
    await apiFetch('/setup/skip', { method: 'POST', body: JSON.stringify({ key }) });
    await mutate(PROGRESS_KEY);
  }

  return (
    <Card className="mb-4 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
        <div>
          <p className="text-sm font-semibold">{complete ? 'You’re all set up' : 'Get set up'}</p>
          <p className="text-xs text-muted-foreground">
            {progress.done} of {progress.total} done
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="h-2 w-28 overflow-hidden rounded-full bg-muted sm:w-40">
            <div
              className="h-full rounded-full bg-primary transition-all duration-500"
              style={{ width: `${(progress.done / progress.total) * 100}%` }}
            />
          </div>
          {complete && canDismiss && (
            <button
              onClick={onDismiss}
              disabled={dismissing}
              className="shrink-0 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              {dismissing ? 'Dismissing…' : 'Dismiss'}
            </button>
          )}
        </div>
      </div>
      <ul className="divide-y divide-border">
        {STEP_META.map((step) => {
          const s = progress.steps.find((st) => st.key === step.key);
          const done = s?.done ?? false;
          const skipped = s?.skipped ?? false;
          return (
            <li key={step.key} className="flex items-center gap-3 px-6 py-3">
              {done ? (
                <CheckCircle size={20} weight="fill" className={`shrink-0 ${skipped ? 'text-muted-foreground/60' : 'text-success'}`} />
              ) : (
                <CircleDashed size={20} className="shrink-0 text-muted-foreground/40" />
              )}
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                <step.icon size={16} weight="duotone" className="text-primary" />
              </div>
              <div className="min-w-0 flex-1">
                <p className={`text-sm font-medium ${done ? 'text-muted-foreground' : 'text-foreground'}`}>
                  {step.label}{skipped && ' — skipped'}
                </p>
                <p className="text-xs text-muted-foreground">{step.reason}</p>
              </div>
              {!done && (
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    onClick={() => onStepClick(step)}
                    className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
                  >
                    {step.cta} <ArrowRight size={12} weight="bold" />
                  </button>
                  {step.skippable && (
                    <button
                      onClick={() => onStepSkip(step.key)}
                      className="text-xs font-medium text-muted-foreground hover:text-foreground"
                    >
                      Skip
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
