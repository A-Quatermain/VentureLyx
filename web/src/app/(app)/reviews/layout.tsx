import { Star } from '@phosphor-icons/react/ssr';
import { getServerSession } from '@/lib/session';
import { ModuleDisabledPage } from '@/components/ModuleDisabledPage';

export const dynamic = 'force-dynamic';

export default async function ReviewsLayout({ children }: { children: React.ReactNode }) {
  const me = await getServerSession();
  const org = me.organizations?.find((o) => o.id === me.currentOrgId);
  const modules = (org?.modules as Record<string, boolean> | undefined) ?? {};
  if (modules.reviews === false) {
    return <ModuleDisabledPage icon={Star} label="Reviews" moduleKey="reviews" />;
  }
  return <>{children}</>;
}
