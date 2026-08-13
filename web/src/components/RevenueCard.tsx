import { formatMoney } from '@/lib/format';
import type { MoneyChannel } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Bar } from '@/components/ui/Bar';
import type { Tone } from '@/components/ui/tone';

const CHANNEL_TONES: Tone[] = ['pool', 'sun', 'growth', 'alert', 'ink'];

export function RevenueCard({
  collected,
  outstanding,
  channels,
}: {
  collected: string;
  outstanding: string;
  channels: MoneyChannel[];
}) {
  const total = channels.reduce((sum, c) => sum + Number(c.amount), 0);

  return (
    <Card>
      <p className="text-xs font-medium text-ink-3">REVENUE THIS MONTH</p>
      <p data-numeric className="mt-1 font-mono text-2xl font-semibold text-ink">
        {formatMoney(collected)}
      </p>
      <p data-numeric className="mt-1 font-mono text-xs text-ink-3">
        {Number(outstanding) > 0
          ? `Money owed to you: ${formatMoney(outstanding)}`
          : 'Nothing outstanding.'}
      </p>

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
