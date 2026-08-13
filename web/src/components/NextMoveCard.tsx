import { formatMoney } from '@/lib/format';
import type { Opportunity } from '@/lib/types';
import { PulseDot } from '@/components/ui/PulseDot';
import { Button } from '@/components/ui/Button';

// The signature component: one dark gradient card, one specific action.
// Everything else on Home is a supporting detail.
export function NextMoveCard({ opportunity }: { opportunity: Opportunity | undefined }) {
  return (
    <div className="rounded-card bg-gradient-to-br from-deepwater to-deepwater-2 p-4 text-white shadow-card">
      <div className="flex items-center gap-2">
        <PulseDot />
        <span className="text-xs font-semibold tracking-wide text-sun">YOUR NEXT BEST MOVE</span>
      </div>

      {opportunity ? (
        <>
          <p className="mt-3 font-display text-lg font-bold">{opportunity.title}</p>
          <p className="mt-1 text-sm text-white/70">{opportunity.rationale}</p>
          {opportunity.est_value_monthly && (
            <p data-numeric className="mt-2 font-mono text-sm text-sun">
              Est. {formatMoney(opportunity.est_value_monthly)}/mo
            </p>
          )}
          <div className="mt-4 flex gap-2">
            {/* No backend endpoint yet to act on or dismiss a
                growth_opportunity — present per design, inert until that
                lands (tracked alongside the seo_issues.auto_fixable gap). */}
            <Button variant="attention" disabled title="Coming soon">
              Act on this
            </Button>
            <Button variant="ghost" disabled title="Coming soon" className="border-white/30 text-white">
              Dismiss
            </Button>
          </div>
        </>
      ) : (
        <p className="mt-3 text-sm text-white/70">Nothing urgent right now.</p>
      )}
    </div>
  );
}
