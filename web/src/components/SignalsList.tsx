import type { Signal } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Row } from '@/components/ui/Row';
import { severityTone } from '@/components/ui/tone';
import { IconAlertTriangle } from '@/components/ui/icons';

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const hours = Math.round(ms / 3_600_000);
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function SignalsList({ signals }: { signals: Signal[] }) {
  return (
    <Card className="p-0">
      <p className="p-4 pb-2 text-xs font-medium text-ink-3">WORTH DOING</p>
      {signals.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-ink-2">
          No open signals — new ones appear here as pages break or leads go untouched.
        </p>
      ) : (
        <div className="divide-y divide-line-2">
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
