import { Robot } from '@phosphor-icons/react/ssr';
import { getServerSession } from '@/lib/session';
import { ModuleDisabledPage } from '@/components/ModuleDisabledPage';

export const dynamic = 'force-dynamic';

export default async function AiTeamLayout({ children }: { children: React.ReactNode }) {
  const me = await getServerSession();
  const org = me.organizations?.find((o) => o.id === me.currentOrgId);
  const modules = (org?.modules as Record<string, boolean> | undefined) ?? {};
  if (modules.ai_team === false) {
    return <ModuleDisabledPage icon={Robot} label="AI Team" moduleKey="ai_team" />;
  }
  return <>{children}</>;
}
