import { Package } from '@phosphor-icons/react/ssr';
import { LockedModulePage } from '@/components/LockedModulePage';

export default function SourcePage() {
  return (
    <LockedModulePage
      icon={Package}
      label="Source"
      description="Suppliers, RFQs, cost compares. Find and compare vendors, request quotes, and keep your cost of goods under control."
      bullets={[
        'Supplier directory for your industry',
        'Request-for-quote comparisons side by side',
        'Cost tracking against your catalog',
      ]}
    />
  );
}
