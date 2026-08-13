import { Card } from './Card';

export function StatStrip({ stats }: { stats: Array<{ label: string; value: string }> }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {stats.map((s) => (
        <Card key={s.label} className="text-center">
          <p data-numeric className="font-mono text-xl font-semibold text-ink">
            {s.value}
          </p>
          <p className="mt-0.5 text-xs text-ink-3">{s.label}</p>
        </Card>
      ))}
    </div>
  );
}
