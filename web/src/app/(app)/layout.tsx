import { redirect } from 'next/navigation';
import { getServerSession } from '@/lib/session';
import { OrgSwitcher } from '@/components/OrgSwitcher';
import { SignOutButton } from '@/components/SignOutButton';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const me = await getServerSession();

  if (!me.authenticated) redirect('/sign-in');
  if (!me.mfaSatisfied) redirect('/mfa');

  return (
    <div className="min-h-screen bg-daylight">
      <header className="flex items-center justify-between border-b border-line-2 bg-card px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="font-display text-base font-bold text-deepwater">Venturelyx</span>
          <OrgSwitcher
            organizations={me.organizations ?? []}
            currentOrgId={me.currentOrgId}
          />
        </div>
        <SignOutButton />
      </header>
      <main>{children}</main>
    </div>
  );
}
