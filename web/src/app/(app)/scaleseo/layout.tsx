import { MagnifyingGlass } from '@phosphor-icons/react/ssr';
import { getServerSession } from '@/lib/session';
import { ModuleDisabledPage } from '@/components/ModuleDisabledPage';

export const dynamic = 'force-dynamic';

export default async function ScaleSeoLayout({ children }: { children: React.ReactNode }) {
  const me = await getServerSession();
  const org = me.organizations?.find((o) => o.id === me.currentOrgId);
  const modules = (org?.modules as Record<string, boolean> | undefined) ?? {};
  if (modules.scaleseo === false) {
    return <ModuleDisabledPage icon={MagnifyingGlass} label="ScaleSEO" />;
  }
  return <>{children}</>;
}
