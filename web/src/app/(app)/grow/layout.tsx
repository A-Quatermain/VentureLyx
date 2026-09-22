import { TrendUp } from '@phosphor-icons/react/ssr';
import { getServerSession } from '@/lib/session';
import { ModuleDisabledPage } from '@/components/ModuleDisabledPage';

export const dynamic = 'force-dynamic';

export default async function GrowLayout({ children }: { children: React.ReactNode }) {
  const me = await getServerSession();
  const org = me.organizations?.find((o) => o.id === me.currentOrgId);
  const modules = (org?.modules as Record<string, boolean> | undefined) ?? {};
  if (modules.grow === false) {
    return <ModuleDisabledPage icon={TrendUp} label="Grow" />;
  }
  return <>{children}</>;
}
