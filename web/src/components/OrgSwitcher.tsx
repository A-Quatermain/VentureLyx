'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { mutate } from 'swr';
import { apiFetch } from '@/lib/api';
import type { Organization } from '@/lib/types';
import { healthTone, toneFill } from '@/components/ui/tone';

// Switching orgs is a real state change: POST /auth/org updates
// sessions.org_id server-side (that's what makes req.db()'s RLS context
// correct on the next call), then we revalidate every SWR-cached org-scoped
// query and refresh server-rendered data. Never just re-slice a cached
// all-orgs list client-side. The most-used control in the app, per
// docs/DESIGN.md — the portfolio view (every business + its health) is one
// tap away rather than a separate screen.
export function OrgSwitcher({
  organizations,
  currentOrgId,
}: {
  organizations: Organization[];
  currentOrgId: string | null | undefined;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [switching, setSwitching] = useState(false);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const current = organizations.find((o) => o.id === currentOrgId);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onEscape);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onEscape);
    };
  }, []);

  async function switchTo(orgId: string) {
    setOpen(false);
    if (orgId === currentOrgId) return;

    setSwitching(true);
    try {
      await apiFetch('/auth/org', { method: 'POST', body: JSON.stringify({ orgId }) });
      await mutate(() => true); // revalidate every SWR-cached org-scoped query
      startTransition(() => router.refresh()); // re-run server components (layout, /auth/me)
    } finally {
      setSwitching(false);
    }
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={switching || pending}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex min-h-[42px] items-center gap-2 rounded-lg border border-border bg-surface px-3 text-sm font-medium text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
      >
        {current ? (
          <>
            <HealthDot health={current.health} />
            <span className="flex flex-col items-start leading-tight">
              <span>{current.name}</span>
              <span className="text-[11px] font-normal text-muted-foreground">
                {current.siteCount} site{current.siteCount === 1 ? '' : 's'}
                {current.health != null ? ` · ${current.health}/100` : ''}
              </span>
            </span>
          </>
        ) : (
          'Choose a business…'
        )}
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path
            d="M3 4.5 6 7.5 9 4.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 top-full z-10 mt-1 w-72 rounded-lg border border-border bg-surface py-1 shadow-md"
        >
          {organizations.map((org) => (
            <button
              key={org.id}
              type="button"
              role="option"
              aria-selected={org.id === currentOrgId}
              onClick={() => switchTo(org.id)}
              className={`flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted ${
                org.id === currentOrgId ? 'bg-primary/5' : ''
              }`}
            >
              <HealthDot health={org.health} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-foreground">{org.name}</p>
                <p className="text-xs text-muted-foreground">
                  {org.siteCount} site{org.siteCount === 1 ? '' : 's'}
                </p>
              </div>
              <span className="font-mono text-sm text-muted-foreground" data-numeric>
                {org.health ?? '—'}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function HealthDot({ health }: { health: number | null }) {
  const tone = health === null ? 'muted' : healthTone(health);
  return <span className={`h-2 w-2 shrink-0 rounded-full ${toneFill[tone]}`} />;
}
