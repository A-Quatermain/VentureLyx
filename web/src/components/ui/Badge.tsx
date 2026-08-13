import type { SignalSeverity } from '@/lib/types';

const styles: Record<SignalSeverity, string> = {
  critical: 'bg-alert-soft text-alert',
  high: 'bg-alert-soft text-alert',
  medium: 'bg-sun-soft text-sun',
  low: 'bg-line-2 text-ink-2',
};

export function SeverityBadge({ severity }: { severity: SignalSeverity }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium capitalize ${styles[severity]}`}
    >
      {severity}
    </span>
  );
}
