/**
 * Venturelyx :: module status — single source of truth for what's actually
 * live, in beta, or not built yet, shown to a prospect on the marketing
 * landing page.
 *
 * "beta" modules only ship what subtitle says is live — everything else
 * listed in subtitle as "coming" isn't in the app yet. Keeping this in one
 * file means a status change (Grow's SMS/funnels/ads shipping, say) is a
 * one-line edit here rather than a copy hunt through page.tsx.
 *
 * Icon is a name, not a component: page.tsx (a Server Component) imports
 * Phosphor icons from '@phosphor-icons/react/ssr', while any future client
 * consumer would need the plain '@phosphor-icons/react' import — the two
 * aren't the same component type, so this file can't hold a JSX icon
 * reference usable by both. Each consumer maps this name to its own import.
 */
export type ModuleStatus = 'live' | 'beta' | 'soon';

export interface ModuleInfo {
  key: string;
  name: string;
  href: string;
  icon: 'Compass' | 'Package' | 'Kanban' | 'MagnifyingGlass' | 'TrendUp' | 'Robot' | 'Star';
  description: string;
  status: ModuleStatus;
  /** Only meaningful for status: 'beta' — what's actually live vs coming. */
  subtitle?: string;
}

export const MODULES: ModuleInfo[] = [
  {
    key: 'build', name: 'Build', href: '/build', icon: 'Compass',
    description: 'Idea → blueprint → brand → site', status: 'soon',
  },
  {
    key: 'source', name: 'Source', href: '/source', icon: 'Package',
    description: 'Suppliers, RFQs, cost compares', status: 'soon',
  },
  {
    key: 'operate', name: 'Operate', href: '/operate', icon: 'Kanban',
    description: 'CRM, jobs, invoices, payments', status: 'live',
  },
  {
    key: 'scaleseo', name: 'ScaleSEO', href: '/scaleseo', icon: 'MagnifyingGlass',
    description: "Get found. Fix what's broken.", status: 'live',
  },
  {
    key: 'grow', name: 'Grow', href: '/grow', icon: 'TrendUp',
    description: 'Leads, email/SMS, funnels, ads', status: 'beta',
    subtitle: 'Email campaigns live · SMS, funnels, ads coming',
  },
  {
    key: 'ai-team', name: 'AI Team', href: '/ai-team', icon: 'Robot',
    description: 'Receptionist, sales, SEO agents', status: 'beta',
    subtitle: 'AI Growth Strategist, Page Builder, review replies live · Phone attendant coming',
  },
  {
    key: 'reviews', name: 'Reviews', href: '/reviews', icon: 'Star',
    description: 'Collect and respond to reviews', status: 'live',
  },
];
