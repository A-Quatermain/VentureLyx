import type { ReactNode } from 'react';
import { toneFill, type Tone } from './tone';

export function Bar({
  label,
  valueText,
  percent,
  tone = 'primary',
  sub,
}: {
  label: ReactNode;
  valueText: ReactNode;
  percent: number;
  tone?: Tone;
  sub?: string;
}) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="truncate font-medium text-foreground">{label}</span>
        <span className="shrink-0 font-mono tabular-nums text-foreground" data-numeric>
          {valueText}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full ${toneFill[tone]}`} style={{ width: `${clamped}%` }} />
      </div>
      {sub && <p className="mt-1 text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}
