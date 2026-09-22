import { redirect } from 'next/navigation';
import { getServerSession } from '@/lib/session';
import { AppShell } from '@/components/AppShell';

// Every route under this layout depends on the request's session cookie —
// none of them were ever really static. Without this, Next.js still tries
// to prerender each one once at build time regardless, and that build-time
// call has no real cookie and no INTERNAL_API_BASE (a docker-compose
// runtime env var; the build stage has no docker network). `dynamic` on a
// layout propagates to its whole subtree, so this one export covers every
// (app) page.
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await getServerSession();

  if (!me.authenticated) redirect('/sign-in');
  if (!me.mfaSatisfied) redirect('/mfa');
  // A registered user with zero organizations (skipped or abandoned
  // onboarding) has nothing for any (app) route to show — /command/summary
  // and everything else 400s with "Select a business first" the moment
  // req.requireRole() runs. This is the authoritative guard: no matter how
  // such a user reaches an (app) route (stale bookmark, back button, a
  // client-side redirect that forgot to check), they land back in
  // onboarding instead of a broken shell.
  if (!me.organizations || me.organizations.length === 0) redirect('/onboarding');

  const currentOrg = me.organizations?.find((o) => o.id === me.currentOrgId);

  return (
    <AppShell
      organizations={me.organizations ?? []}
      currentOrgId={me.currentOrgId}
      orgName={currentOrg?.name ?? null}
      orgModules={(currentOrg?.modules as Record<string, boolean> | undefined) ?? {}}
    >
      {children}
    </AppShell>
  );
}
