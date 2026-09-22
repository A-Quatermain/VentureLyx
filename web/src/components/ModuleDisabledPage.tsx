import { Lock } from '@phosphor-icons/react/ssr';
import type { Icon } from '@phosphor-icons/react';
import { Card } from '@/components/ui/Card';

// Deep-link landing for a module an admin has turned off for this org
// (organizations.modules, toggled from /admin) — distinct from
// LockedModulePage ("Soon", a module that isn't built yet). Same visual
// shell, different badge/copy: this is reversible account configuration,
// not a roadmap promise.
export function ModuleDisabledPage({ icon: ModuleIcon, label }: { icon: Icon; label: string }) {
  return (
    <div className="flex min-h-[70vh] items-center justify-center p-4">
      <Card className="w-full max-w-lg p-8 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-muted">
          <ModuleIcon size={28} weight="duotone" className="text-muted-foreground" />
        </div>
        <div className="mt-4 flex items-center justify-center gap-2">
          <h1 className="font-display text-2xl font-bold tracking-tight">{label}</h1>
          <span className="flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Lock size={11} weight="bold" /> Off
          </span>
        </div>
        <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">
          {label} isn&rsquo;t turned on for your business yet. Ask your account team to enable it.
        </p>
      </Card>
    </div>
  );
}
