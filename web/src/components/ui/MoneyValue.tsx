import { formatMoney } from '@/lib/format';
import type { MoneyChannel } from '@/lib/types';

// "Money is always monospace and always carries its source." Not "$24,380"
// but "$24,380 — Found on Google $10,970, Repeat customers $8,530…"
export function MoneyValue({
  amount,
  source,
  size = 'base',
}: {
  amount: string | number;
  source?: MoneyChannel[];
  size?: 'base' | 'lg';
}) {
  return (
    <p data-numeric className={`font-mono ${size === 'lg' ? 'text-2xl' : 'text-base'}`}>
      <span className="font-medium text-ink">{formatMoney(amount)}</span>
      {source && source.length > 0 && (
        <span className="text-ink-3">
          {' — '}
          {source.map((c, i) => (
            <span key={c.channel}>
              {i > 0 && ', '}
              {c.channel} {formatMoney(c.amount)}
            </span>
          ))}
        </span>
      )}
    </p>
  );
}
