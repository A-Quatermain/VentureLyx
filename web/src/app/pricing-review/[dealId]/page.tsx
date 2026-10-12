'use client';

import { useParams, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { useApi } from '@/lib/useApi';
import { Card } from '@/components/ui/Card';

const PLAN_LABEL: Record<string, string> = {
  platform: 'Platform', growth_partner: 'Growth Partner', launch_growth: 'Launch & Growth', founding: 'Founding Business',
};

interface PricingReview {
  stage: string;
  checkout: {
    plan_key: string;
    setup_fee_cents: number;
    monthly_cents: number;
    status: 'open' | 'completed' | 'expired' | 'canceled';
    checkout_url: string | null;
  } | null;
}

function fmt(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function PricingReviewContent() {
  const { dealId } = useParams<{ dealId: string }>();
  const paid = useSearchParams().get('paid');
  const { data, isLoading } = useApi<PricingReview>(`/pricing-review/${dealId}`);

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!data?.checkout) return <p className="text-sm text-muted-foreground">No pricing has been set up for this yet.</p>;

  const c = data.checkout;

  return (
    <>
      {paid === '1' && <p className="mb-4 text-sm font-medium text-success">Payment received — welcome to Venturelyx! Check your email for next steps.</p>}
      {paid === '0' && <p className="mb-4 text-sm text-muted-foreground">Checkout was cancelled — you can pick up where you left off below whenever you&rsquo;re ready.</p>}

      <p className="font-display text-lg font-bold tracking-tight">{PLAN_LABEL[c.plan_key] ?? c.plan_key}</p>
      <table className="mt-4 w-full text-sm">
        <tbody>
          {c.setup_fee_cents > 0 && (
            <tr className="border-b border-border">
              <td className="py-2 text-muted-foreground">One-time setup</td>
              <td className="py-2 text-right font-medium">{fmt(c.setup_fee_cents)}</td>
            </tr>
          )}
          <tr className="border-b border-border">
            <td className="py-2 text-muted-foreground">Monthly</td>
            <td className="py-2 text-right font-medium">{fmt(c.monthly_cents)}/mo</td>
          </tr>
          <tr>
            <td className="py-2 text-muted-foreground">Status</td>
            <td className="py-2 text-right font-medium capitalize">{c.status}</td>
          </tr>
        </tbody>
      </table>

      {c.status === 'open' && c.checkout_url && (
        <a
          href={c.checkout_url}
          className="mt-6 inline-flex min-h-[44px] w-full items-center justify-center rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary-hover"
        >
          Continue to secure payment
        </a>
      )}
      {c.status === 'completed' && <p className="mt-6 text-sm text-success">Paid — you&rsquo;re all set.</p>}
      {(c.status === 'expired' || c.status === 'canceled') && (
        <p className="mt-6 text-sm text-muted-foreground">This checkout link is no longer active — ask your Venturelyx contact to send a new one.</p>
      )}
    </>
  );
}

export default function PricingReviewPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md p-8">
        <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
          <PricingReviewContent />
        </Suspense>
      </Card>
    </main>
  );
}
