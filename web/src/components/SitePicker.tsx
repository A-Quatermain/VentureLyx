'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Star } from '@phosphor-icons/react';
import type { SeoSite } from '@/lib/types';
import { healthTone, toneFill } from '@/components/ui/tone';

// Every site in the org, with its own health score, one tap to switch —
// the thing that reading "1 site · 85/100" as plain text never let you do.
// Modeled on OrgSwitcher's dropdown (same reasoning: the portfolio view is
// one tap away, not a separate screen), scoped to sites within this org
// rather than orgs.
export function SitePicker({ sites, currentSiteId }: { sites: SeoSite[]; currentSiteId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = sites.find((s) => s.id === currentSiteId);

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

  function switchTo(id: string) {
    setOpen(false);
    if (id === currentSiteId) return;
    router.push(`/scaleseo/${id}`);
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={sites.length === 0}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-lg px-1 py-1 text-left outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
      >
        <HealthDot health={current?.health ?? null} />
        <span className="flex flex-col leading-tight">
          <span className="font-display text-2xl font-bold tracking-tight">{current?.name ?? 'ScaleSEO'}</span>
          <span className="text-xs font-normal text-muted-foreground">
            {sites.length} site{sites.length === 1 ? '' : 's'}
            {current?.health != null ? ` · ${current.health}/100` : ''}
          </span>
        </span>
        {sites.length > 0 && (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="mt-1 shrink-0 text-muted-foreground">
            <path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute left-0 top-full z-10 mt-1 w-80 rounded-lg border border-border bg-surface py-1 shadow-md"
        >
          {sites.map((s) => (
            <button
              key={s.id}
              type="button"
              role="option"
              aria-selected={s.id === currentSiteId}
              onClick={() => switchTo(s.id)}
              className={`flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted ${
                s.id === currentSiteId ? 'bg-primary/5' : ''
              }`}
            >
              <HealthDot health={s.health} />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 truncate text-sm text-foreground">
                  {s.name}
                  {s.is_primary && <Star size={11} weight="fill" className="shrink-0 text-primary" />}
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {s.url.replace(/^https?:\/\//, '')} · {s.environment}
                </p>
              </div>
              <span className="shrink-0 font-mono text-sm text-muted-foreground" data-numeric>
                {s.health ?? '—'}
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
  return <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${toneFill[tone]}`} />;
}
