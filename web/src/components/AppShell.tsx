'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Gauge, Kanban, MagnifyingGlass, Compass, Package, TrendUp, Robot, Lock,
  Buildings, List, X, Star,
} from '@phosphor-icons/react';
import type { Organization } from '@/lib/types';
import { OrgSwitcher } from '@/components/OrgSwitcher';
import { SignOutButton } from '@/components/SignOutButton';
import { ThemeToggle } from '@/components/ThemeToggle';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/Tooltip';

// Reviews isn't one of the six lifecycle modules below (no product plan
// slot for it), but it's real and functional — real schema (migration 007),
// real CRUD, real AI-drafted replies — so it lives here, not in the
// numbered/locked list.
const NAV = [
  { href: '/home', label: 'Command Center', icon: Gauge },
  { href: '/reviews', label: 'Reviews', icon: Star },
] as const;

// Business-lifecycle modules, numbered 01–06. Only Operate and ScaleSEO
// have real backend data — the rest render as genuinely inert (no <Link>,
// no route) rather than a clickable stub page, per docs/design_guidelines.json
// ("locked_modules": muted foreground, small lock icon, "Coming Soon" tooltip).
const MODULES = [
  { n: '01', href: '/build', label: 'Build', icon: Compass, locked: true },
  { n: '02', href: '/source', label: 'Source', icon: Package, locked: true },
  { n: '03', href: '/operate', label: 'Operate', icon: Kanban, locked: false },
  { n: '04', href: '/scaleseo', label: 'ScaleSEO', icon: MagnifyingGlass, locked: false },
  { n: '05', href: '/grow', label: 'Grow', icon: TrendUp, locked: true },
  { n: '06', href: '/ai-team', label: 'AI Team', icon: Robot, locked: true },
] as const;

function NavLink({ href, label, icon: Icon, active }: { href: string; label: string; icon: typeof Gauge; active: boolean }) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-3 border-l-2 px-6 py-2.5 text-sm font-medium transition-colors ${
        active
          ? 'border-primary bg-primary/5 text-foreground'
          : 'border-transparent text-muted-foreground hover:bg-muted hover:text-foreground'
      }`}
    >
      <Icon size={20} weight="duotone" />
      {label}
    </Link>
  );
}

function LockedNavItem({ label, icon: Icon }: { label: string; icon: typeof Gauge }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="flex cursor-not-allowed select-none items-center justify-between gap-3 px-6 py-2.5 text-muted-foreground/50">
          <span className="flex items-center gap-3">
            <Icon size={20} weight="duotone" />
            <span className="text-sm font-medium">{label}</span>
          </span>
          <Lock size={14} weight="bold" />
        </div>
      </TooltipTrigger>
      <TooltipContent side="right">Coming soon</TooltipContent>
    </Tooltip>
  );
}

function SidebarNav({ pathname }: { pathname: string }) {
  return (
    <>
      <div className="flex h-16 items-center border-b border-border px-6">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center bg-primary">
            <span className="font-display text-lg font-black leading-none text-primary-foreground">V</span>
          </div>
          <span className="font-display text-lg font-black tracking-tighter">VENTURELYX</span>
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto py-4">
        {NAV.map((item) => (
          <NavLink key={item.href} {...item} active={pathname === item.href} />
        ))}
        <p className="mb-2 mt-4 px-6 font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">Modules</p>
        {MODULES.map((m) =>
          m.locked ? (
            <LockedNavItem key={m.href} label={m.label} icon={m.icon} />
          ) : (
            <NavLink key={m.href} href={m.href} label={m.label} icon={m.icon} active={pathname.startsWith(m.href)} />
          ),
        )}
      </nav>
    </>
  );
}

export function AppShell({
  organizations,
  currentOrgId,
  orgName,
  children,
}: {
  organizations: Organization[];
  currentOrgId: string | null | undefined;
  orgName: string | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <TooltipProvider delayDuration={150}>
      <div className="flex min-h-screen bg-background text-foreground">
        {/* Desktop sidebar — no responsive treatment in the reference itself,
            so below `dt` this collapses behind the hamburger drawer instead
            of disappearing outright. */}
        <aside className="fixed z-20 hidden h-screen w-64 shrink-0 flex-col border-r border-border bg-surface dt:flex">
          <SidebarNav pathname={pathname} />
        </aside>

        {/* Mobile drawer */}
        {drawerOpen && (
          <div className="fixed inset-0 z-30 dt:hidden">
            <div className="absolute inset-0 bg-foreground/40" onClick={() => setDrawerOpen(false)} />
            <aside className="relative flex h-full w-64 flex-col border-r border-border bg-surface">
              <SidebarNav pathname={pathname} />
            </aside>
          </div>
        )}

        <div className="flex min-h-screen flex-1 flex-col dt:ml-64">
          <header className="sticky top-0 z-10 flex h-16 items-center justify-between border-b border-border bg-surface/90 px-4 backdrop-blur-xl dt:px-8">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setDrawerOpen((v) => !v)}
                aria-label="Toggle navigation"
                className="grid h-9 w-9 place-items-center border border-border text-muted-foreground dt:hidden"
              >
                {drawerOpen ? <X size={16} weight="bold" /> : <List size={16} weight="bold" />}
              </button>
              <Buildings size={18} weight="duotone" className="hidden text-muted-foreground sm:block" />
              <span className="hidden font-display font-bold tracking-tight sm:inline">{orgName ?? 'Your Business'}</span>
              <OrgSwitcher organizations={organizations} currentOrgId={currentOrgId} />
            </div>
            <div className="flex items-center gap-2">
              <ThemeToggle />
              <SignOutButton />
            </div>
          </header>
          <main className="w-full max-w-[1500px] flex-1 p-4 dt:p-8">{children}</main>
        </div>
      </div>
    </TooltipProvider>
  );
}
