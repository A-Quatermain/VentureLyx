import { redirect } from 'next/navigation';
import { getServerSession } from '@/lib/session';
import { AppShell } from '@/components/AppShell';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await getServerSession();

  if (!me.authenticated) redirect('/sign-in');
  if (!me.mfaSatisfied) redirect('/mfa');

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
