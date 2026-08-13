import type { ReactNode } from 'react';
import { toneSoft, type Tone } from './tone';

export function Row({
  icon,
  tone = 'ink',
  title,
  subtitle,
  value,
}: {
  icon?: ReactNode;
  tone?: Tone;
  title: ReactNode;
  subtitle?: ReactNode;
  value?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-card-sunk">
      {icon && (
        <div
          className={`flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-button ${toneSoft[tone]}`}
        >
          {icon}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-ink">{title}</p>
        {subtitle && <p className="truncate text-xs text-ink-3">{subtitle}</p>}
      </div>
      {value !== undefined && <div className="shrink-0 text-right">{value}</div>}
    </div>
  );
}
