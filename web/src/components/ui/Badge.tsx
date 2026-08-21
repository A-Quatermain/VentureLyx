import type { SignalSeverity } from '@/lib/types';
import { severityTone, toneOutline } from './tone';

export function SeverityBadge({ severity }: { severity: SignalSeverity }) {
  return (
    <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase ${toneOutline[severityTone(severity)]}`}>
      {severity}
    </span>
  );
}
