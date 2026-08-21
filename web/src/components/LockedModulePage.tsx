import Link from 'next/link';
import { Lock, ArrowLeft } from '@phosphor-icons/react/ssr';
import type { Icon } from '@phosphor-icons/react';
import { Card } from '@/components/ui/Card';

// What an unbuilt module routes to instead of a dead end — never hidden,
// never a bare tooltip. A real page explaining what's coming.
export function LockedModulePage({
  icon: ModuleIcon,
  label,
  description,
  bullets,
}: {
  icon: Icon;
  label: string;
  description: string;
  bullets: string[];
}) {
  return (
    <div className="flex min-h-[70vh] items-center justify-center p-4">
      <Card className="w-full max-w-lg p-8 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
          <ModuleIcon size={28} weight="duotone" className="text-primary" />
        </div>
        <div className="mt-4 flex items-center justify-center gap-2">
          <h1 className="font-display text-2xl font-bold tracking-tight">{label}</h1>
          <span className="flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Lock size={11} weight="bold" /> Soon
          </span>
        </div>
        <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">{description}</p>
        <ul className="mx-auto mt-6 flex max-w-xs flex-col gap-2 text-left text-sm text-muted-foreground">
          {bullets.map((b) => (
            <li key={b} className="flex items-start gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/40" />
              {b}
            </li>
          ))}
        </ul>
        <Link
          href="/home"
          className="mt-8 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:text-primary-hover"
        >
          <ArrowLeft size={14} weight="bold" /> Back to Command Center
        </Link>
      </Card>
    </div>
  );
}
