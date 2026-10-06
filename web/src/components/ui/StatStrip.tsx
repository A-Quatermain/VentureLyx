import { Card } from './Card';

// 2 columns on narrow screens regardless of count (3 or 4 both stay legible
// at phone width), the real column count once there's room.
const COLS_AT_SM: Record<number, string> = {
  2: 'sm:grid-cols-2',
  3: 'sm:grid-cols-3',
  4: 'sm:grid-cols-4',
  5: 'sm:grid-cols-5',
};

export function StatStrip({ stats }: { stats: Array<{ label: string; value: string }> }) {
  return (
    <div className={`grid grid-cols-2 gap-2 ${COLS_AT_SM[stats.length] ?? 'sm:grid-cols-3'}`}>
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
