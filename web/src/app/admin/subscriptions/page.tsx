'use client';

import { CreditCard } from '@phosphor-icons/react';
import { PageHeader } from '@/components/Primitives';
import { Card } from '@/components/ui/Card';

// Placeholder — Stripe isn't wired up yet (see web/src/lib/pricing.ts).
// Fills in once billing exists: subscription status, plan, renewal date,
// payment method on file, per organization.
export default function AdminSubscriptionsPage() {
  return (
    <div>
      <PageHeader eyebrow="Staff only" title="Subscriptions" subtitle="Stripe isn't wired up yet — this fills in once it is." />
      <Card className="flex flex-col items-center gap-3 p-12 text-center">
        <CreditCard size={32} weight="duotone" className="text-muted-foreground/50" />
        <p className="text-muted-foreground">
          No billing data to show. Once Stripe is connected, this page will list each
          organization&rsquo;s subscription status, plan, and renewal date.
        </p>
      </Card>
    </div>
  );
}
