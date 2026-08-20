import type { SignalSeverity } from '@/lib/types';
import { severityTone, toneOutline } from './tone';

export function SeverityBadge({ severity }: { severity: SignalSeverity }) {
  return (
    <span className={`border px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase ${toneOutline[severityTone(severity)]}`}>
      {severity}
    </span>
  );
}
