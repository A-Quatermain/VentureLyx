import Link from 'next/link';
import { toneSoft } from '@/components/ui/tone';

// Numbered 01–06 to show the business lifecycle (docs/DESIGN.md, Layout).
// Status reflects what's actually wired to real data today — not aspiration.
const MODULES = [
  { n: '01', label: 'Build', href: '/build', desc: 'Sites and pages for the business.' },
  { n: '02', label: 'Source', href: '/source', desc: 'Suppliers, quotes, and RFQs.' },
  { n: '03', label: 'Operate', href: '/operate', desc: 'Leads, jobs, and money owed.' },
  { n: '04', label: 'ScaleSEO', href: '/scaleseo', desc: 'Site health and search performance.' },
  { n: '05', label: 'Grow', href: '/grow', desc: 'Growth opportunities and campaigns.' },
  { n: '06', label: 'AI Team', href: '/ai-team', desc: 'Assistants working the queue.' },
] as const;

export function ModuleRail({
  leadCount,
  seoHealth,
}: {
  leadCount?: number;
  seoHealth?: number | null;
}) {
  const chips: Partial<Record<(typeof MODULES)[number]['label'], { label: string; tone: keyof typeof toneSoft }>> = {
    Operate: leadCount !== undefined
      ? { label: `${leadCount} lead${leadCount === 1 ? '' : 's'}`, tone: 'growth' }
      : { label: 'Live', tone: 'growth' },
    ScaleSEO: seoHealth != null
      ? { label: `${seoHealth}/100`, tone: 'growth' }
      : { label: 'Live', tone: 'growth' },
  };

  return (
    <div className="grid grid-cols-1 gap-2 g2:grid-cols-2 dt:grid-cols-3">
      {MODULES.map((m) => {
        const chip = chips[m.label] ?? { label: 'Coming soon', tone: 'ink' as const };
        return (
          <Link
            key={m.href}
            href={m.href}
            className="rounded-card border border-line-2 bg-card p-3 shadow-card transition-colors hover:border-pool"
          >
            <div className="flex items-start justify-between">
              <span data-numeric className="font-mono text-xs text-ink-3">
                {m.n}
              </span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${toneSoft[chip.tone]}`}>
                {chip.label}
              </span>
            </div>
            <p className="mt-1 text-sm font-medium text-ink">{m.label}</p>
            <p className="mt-0.5 text-xs text-ink-3">{m.desc}</p>
          </Link>
        );
      })}
    </div>
  );
}
