import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getServerSession } from '@/lib/session';
import { SignOutButton } from '@/components/SignOutButton';
import { ThemeToggle } from '@/components/ThemeToggle';

// Session-dependent on every request, same reasoning as (app)/layout.tsx.
export const dynamic = 'force-dynamic';

const NAV = [
  { href: '/admin', label: 'Dashboard' },
  { href: '/admin/users', label: 'Users' },
  { href: '/admin/organizations', label: 'Organizations' },
  { href: '/admin/waitlist', label: 'Waitlist' },
  { href: '/admin/growth-scans', label: 'Growth Scan Leads' },
  { href: '/admin/subscriptions', label: 'Subscriptions' },
  { href: '/admin/email-log', label: 'Email Log' },
] as const;

// Staff-only, and "staff-only" means invisible, not forbidden — notFound()
// renders the real Next.js 404 page with a real 404 status, indistinguishable
// from /admin never having existed. A 403/redirect-to-sign-in would instead
// confirm this surface exists to anyone who stumbles onto the URL. This is
// the server-side half of that guarantee; api/src/routes/admin.ts's
// requireStaffOrNotFound() is the other half, necessary in its own right
// since those routes are reachable directly, not only through this shell.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const me = await getServerSession();
  if (!me.authenticated || !me.mfaSatisfied || !me.user?.isStaff) {
    notFound();
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-10 flex h-16 items-center justify-between border-b border-border bg-surface px-6 shadow-sm">
        <div className="flex items-center gap-6">
          <span className="font-display text-lg font-bold tracking-tight">Venturelyx Admin</span>
          <nav className="hidden items-center gap-1 sm:flex">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <SignOutButton />
        </div>
      </header>
      <nav className="flex items-center gap-1 overflow-x-auto border-b border-border bg-surface px-4 py-2 sm:hidden">
        {NAV.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="shrink-0 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {item.label}
          </Link>
        ))}
      </nav>
      <main className="mx-auto max-w-6xl p-6">{children}</main>
    </div>
  );
}
