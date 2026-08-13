import type { Opportunity, Signal } from '@/lib/types';
import { formatMoney } from '@/lib/format';
import { Card } from '@/components/ui/Card';
import { Row } from '@/components/ui/Row';
import { severityTone } from '@/components/ui/tone';
import { IconAlertTriangle, IconTrendUp } from '@/components/ui/icons';

function relativeTime(iso: string): string {
  const hours = Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// Merges the growth_opportunities NextMoveCard didn't already use with open
// signals — mockup's "Worth doing" mixes both kinds of row (a dollar value
// for an opportunity, a status for a signal), which is honest here because
// both are real fields on real API responses, not invented for the row.
export function WorthDoingCard({
  opportunities,
  signals,
}: {
  opportunities: Opportunity[];
  signals: Signal[];
}) {
  const empty = opportunities.length === 0 && signals.length === 0;

  return (
    <Card className="p-0">
      <p className="p-4 pb-2 text-xs font-medium text-ink-3">WORTH DOING</p>
      {empty ? (
        <p className="px-4 pb-4 text-sm text-ink-2">
          No open signals — new ones appear here as pages break or leads go untouched.
        </p>
      ) : (
        <div className="divide-y divide-line-2">
          {opportunities.map((o) => (
            <Row
              key={o.id}
              icon={<IconTrendUp width={16} height={16} />}
              tone="sun"
              title={o.title}
              subtitle={o.rationale}
              value={
                o.est_value_monthly ? (
                  <span data-numeric className="font-mono text-sm text-growth">
                    +{formatMoney(o.est_value_monthly)}
                    <span className="block text-[10px] font-sans font-normal text-ink-3">per month</span>
                  </span>
                ) : undefined
              }
            />
          ))}
          {signals.map((s) => (
            <Row
              key={s.id}
              icon={<IconAlertTriangle width={16} height={16} />}
              tone={severityTone(s.severity)}
              title={s.summary}
              subtitle={s.module}
              value={<span className="text-xs text-ink-3">{relativeTime(s.detected_at)}</span>}
            />
          ))}
        </div>
      )}
    </Card>
  );
}
