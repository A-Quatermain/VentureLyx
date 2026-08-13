import { formatMoney } from '@/lib/format';
import type { MoneyChannel } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Bar } from '@/components/ui/Bar';
import type { Tone } from '@/components/ui/tone';

const CHANNEL_TONES: Tone[] = ['pool', 'sun', 'growth', 'alert', 'ink'];

export function RevenueCard({
  collected,
  outstanding,
  lastMonth,
  channels,
}: {
  collected: string;
  outstanding: string;
  lastMonth: string;
  channels: MoneyChannel[];
}) {
  const total = channels.reduce((sum, c) => sum + Number(c.amount), 0);
  const prev = Number(lastMonth);
  const pctChange = prev > 0 ? ((Number(collected) - prev) / prev) * 100 : null;

  return (
    <Card>
      <p className="text-xs font-medium text-ink-3">REVENUE THIS MONTH</p>
      <p data-numeric className="mt-1 font-mono text-2xl font-semibold text-ink">
        {formatMoney(collected)}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
        {pctChange !== null && (
          <span
            className={`rounded-full px-2 py-0.5 font-medium ${
              pctChange >= 0 ? 'bg-growth-soft text-growth' : 'bg-alert-soft text-alert'
            }`}
          >
            {pctChange >= 0 ? '+' : ''}
            {pctChange.toFixed(0)}% vs last month
          </span>
        )}
        <span data-numeric className="font-mono text-ink-3">
          {Number(outstanding) > 0
            ? `${formatMoney(outstanding)} outstanding`
            : 'Nothing outstanding'}
        </span>
      </div>

      <div className="mt-4 flex flex-col gap-3">
        {channels.length === 0 ? (
          <p className="text-sm text-ink-2">
            No payments recorded this month yet — completed jobs and invoices show up here.
          </p>
        ) : (
          channels.map((c, i) => (
            <Bar
              key={c.channel}
              label={c.channel}
              valueText={formatMoney(c.amount)}
              percent={total > 0 ? (Number(c.amount) / total) * 100 : 0}
              tone={CHANNEL_TONES[i % CHANNEL_TONES.length]}
            />
          ))
        )}
      </div>
    </Card>
  );
}
