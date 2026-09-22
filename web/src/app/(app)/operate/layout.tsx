import { Kanban } from '@phosphor-icons/react/ssr';
import { getServerSession } from '@/lib/session';
import { ModuleDisabledPage } from '@/components/ModuleDisabledPage';

export const dynamic = 'force-dynamic';

// Deep-link gate: covers every route under (app)/operate/*, including
// /operate/customers/[id] and /operate/catalog, since a Next.js layout
// wraps its whole subtree. Missing key ('operate' never toggled) counts as
// enabled — only an explicit false disables — same rule as
// api/src/lib/moduleAccess.ts, kept in sync by hand since this is a
// separate app with no shared import path to that file.
export default async function OperateLayout({ children }: { children: React.ReactNode }) {
  const me = await getServerSession();
  const org = me.organizations?.find((o) => o.id === me.currentOrgId);
  const modules = (org?.modules as Record<string, boolean> | undefined) ?? {};
  if (modules.operate === false) {
    return <ModuleDisabledPage icon={Kanban} label="Operate" />;
  }
  return <>{children}</>;
}
