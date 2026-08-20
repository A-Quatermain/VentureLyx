import { Card } from './Card';

export function StatStrip({ stats }: { stats: Array<{ label: string; value: string }> }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {stats.map((s) => (
        <Card key={s.label} className="p-4 text-center">
          <p data-numeric className="font-mono text-xl font-semibold">
            {s.value}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">{s.label}</p>
        </Card>
      ))}
    </div>
  );
}
