import type { ReactNode } from 'react';
import { toneFill, type Tone } from './tone';

export function Bar({
  label,
  valueText,
  percent,
  tone = 'pool',
}: {
  label: ReactNode;
  valueText: ReactNode;
  percent: number;
  tone?: Tone;
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate text-ink-2">{label}</span>
        <span className="shrink-0 font-mono text-ink" data-numeric>
          {valueText}
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-line-2">
        <div className={`h-full rounded-full ${toneFill[tone]}`} style={{ width: `${clamped}%` }} />
      </div>
    </div>
  );
}
