import { redirect } from 'next/navigation';
import { getServerSession } from '@/lib/session';
import { AppShell } from '@/components/AppShell';

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
    >
      {children}
    </AppShell>
  );
}
