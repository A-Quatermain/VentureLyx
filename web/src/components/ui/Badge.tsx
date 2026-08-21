import type { SignalSeverity } from '@/lib/types';
import { severityTone, toneSoft } from './tone';

export function SeverityBadge({ severity }: { severity: SignalSeverity }) {
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${toneSoft[severityTone(severity)]}`}>
      {severity}
    </span>
  );
}
