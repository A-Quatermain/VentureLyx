import Link from 'next/link';

// Numbered 01–06 to show the business lifecycle (docs/DESIGN.md, Layout).
// Routes beyond ScaleSEO don't exist until the module-shells pass — linking
// to them now is deliberate, not a bug: real navigation from day one.
const MODULES = [
  { n: '01', label: 'Build', href: '/build' },
  { n: '02', label: 'Source', href: '/source' },
  { n: '03', label: 'Operate', href: '/operate' },
  { n: '04', label: 'ScaleSEO', href: '/scaleseo' },
  { n: '05', label: 'Grow', href: '/grow' },
  { n: '06', label: 'AI Team', href: '/ai-team' },
] as const;

export function ModuleRail() {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-6">
      {MODULES.map((m) => (
        <Link
          key={m.href}
          href={m.href}
          className="rounded-card border border-line-2 bg-card p-3 text-center shadow-card hover:border-pool"
        >
          <span data-numeric className="font-mono text-xs text-ink-3">
            {m.n}
          </span>
          <p className="mt-1 text-sm font-medium text-ink">{m.label}</p>
        </Link>
      ))}
    </div>
  );
}
