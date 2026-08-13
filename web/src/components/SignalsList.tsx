import type { Signal } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { SeverityBadge } from '@/components/ui/Badge';

export function SignalsList({ signals }: { signals: Signal[] }) {
  if (signals.length === 0) {
    return (
      <Card>
        <p className="text-sm text-ink-2">No open signals.</p>
      </Card>
    );
  }

  return (
    <Card className="p-0">
      <ul className="divide-y divide-line-2">
        {signals.map((s) => (
          <li key={s.id} className="flex items-start gap-3 p-4">
            <SeverityBadge severity={s.severity} />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-ink">{s.summary}</p>
              <p className="mt-0.5 text-xs text-ink-3">{s.module}</p>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}
