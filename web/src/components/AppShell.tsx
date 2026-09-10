'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Gauge, Kanban, MagnifyingGlass, Compass, Package, TrendUp, Robot, Lock,
  Buildings, List, X, Star, Gear,
} from '@phosphor-icons/react';
import type { Organization } from '@/lib/types';
import { OrgSwitcher } from '@/components/OrgSwitcher';
import { SignOutButton } from '@/components/SignOutButton';
import { ThemeToggle } from '@/components/ThemeToggle';

// Command Center, then all six lifecycle modules in order, then Reviews
// (real and functional, just not one of the official six) and Settings.
// Every entry is a real, clickable <Link> — an unbuilt module still routes
// somewhere (its own locked-module page explaining what it will do), never
// a dead end or a hidden nav item.
const NAV_TOP = [{ href: '/home', label: 'Command Center', icon: Gauge }] as const;

const MODULES = [
  { href: '/build', label: 'Build', icon: Compass, locked: true },
  { href: '/source', label: 'Source', icon: Package, locked: true },
  { href: '/operate', label: 'Operate', icon: Kanban, locked: false },
  { href: '/scaleseo', label: 'ScaleSEO', icon: MagnifyingGlass, locked: false },
  { href: '/grow', label: 'Grow', icon: TrendUp, locked: false },
  { href: '/ai-team', label: 'AI Team', icon: Robot, locked: false },
] as const;

const NAV_BOTTOM = [
  { href: '/reviews', label: 'Reviews', icon: Star },
  { href: '/settings', label: 'Settings', icon: Gear },
] as const;

function NavLink({
  href,
  label,
  icon: Icon,
  active,
  soon,
}: {
  href: string;
  label: string;
  icon: typeof Gauge;
  active: boolean;
  soon?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`mx-3 flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
        active
          ? 'bg-primary/10 text-primary'
          : soon
            ? 'text-muted-foreground/70 hover:bg-muted hover:text-foreground'
            : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      }`}
    >
      <Icon size={20} weight={active ? 'fill' : 'duotone'} className={active ? 'text-primary' : ''} />
      <span className="flex-1">{label}</span>
      {soon && (
        <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          <Lock size={10} weight="bold" /> Soon
        </span>
      )}
    </Link>
  );
}

function SidebarNav({ pathname }: { pathname: string }) {
  return (
    <>
      <div className="flex h-16 items-center px-6">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary shadow-sm">
            <span className="font-display text-lg font-bold leading-none text-primary-foreground">V</span>
          </div>
          <span className="font-display text-lg font-bold tracking-tight">Venturelyx</span>
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto py-2">
        <div className="space-y-1">
          {NAV_TOP.map((item) => (
            <NavLink key={item.href} {...item} active={pathname === item.href} />
          ))}
        </div>
        <p className="mb-1 mt-5 px-6 text-xs font-medium uppercase tracking-wide text-muted-foreground">Modules</p>
        <div className="space-y-1">
          {MODULES.map((m) => (
            <NavLink
              key={m.href}
              href={m.href}
              label={m.label}
              icon={m.icon}
              active={pathname.startsWith(m.href)}
              soon={m.locked}
            />
          ))}
        </div>
        <div className="mt-5 space-y-1 border-t border-border pt-3">
          {NAV_BOTTOM.map((item) => (
            <NavLink key={item.href} {...item} active={pathname === item.href} />
          ))}
        </div>
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
          <aside className="relative flex h-full w-64 flex-col bg-surface shadow-xl">
            <SidebarNav pathname={pathname} />
          </aside>
        </div>
      )}

      <div className="flex min-h-screen flex-1 flex-col dt:ml-64">
        <header className="sticky top-0 z-10 flex h-16 items-center justify-between border-b border-border bg-surface px-4 shadow-sm dt:px-8">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setDrawerOpen((v) => !v)}
              aria-label="Toggle navigation"
              className="grid h-9 w-9 place-items-center rounded-lg border border-border text-muted-foreground dt:hidden"
            >
              {drawerOpen ? <X size={16} weight="bold" /> : <List size={16} weight="bold" />}
            </button>
            <Buildings size={18} weight="duotone" className="hidden text-muted-foreground sm:block" />
            <span className="hidden font-display font-semibold tracking-tight sm:inline">{orgName ?? 'Your Business'}</span>
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
  );
}
