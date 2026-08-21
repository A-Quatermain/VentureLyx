import { TrendUp } from '@phosphor-icons/react/ssr';
import { LockedModulePage } from '@/components/LockedModulePage';

export default function GrowPage() {
  return (
    <LockedModulePage
      icon={TrendUp}
      label="Grow"
      description="Leads, email/SMS, funnels, ads. Turn traffic into leads and leads into customers with campaigns that report straight back to Command Center."
      bullets={[
        'Email and SMS campaigns',
        'Landing pages and funnels',
        'Ad spend tracked against real revenue',
      ]}
    />
  );
}
