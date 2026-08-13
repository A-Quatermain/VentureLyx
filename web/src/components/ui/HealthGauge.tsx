// Stat tile + meter, per the dataviz skill: value in the default sans
// (proportional figures — tabular-nums is for table columns, not a big
// standalone number), fill carries status, unfilled track is a neutral step.
function status(score: number): { color: string; soft: string; label: string } {
  if (score >= 80) return { color: 'bg-growth', soft: 'bg-growth-soft', label: 'Healthy' };
  if (score >= 50) return { color: 'bg-sun', soft: 'bg-sun-soft', label: 'Needs attention' };
  return { color: 'bg-alert', soft: 'bg-alert-soft', label: 'Critical' };
}

export function HealthGauge({ score, label = 'Health' }: { score: number | null; label?: string }) {
  if (score === null) {
    return <p className="text-sm text-ink-2">No score yet — waiting on the first crawl.</p>;
  }

  const s = status(score);

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium text-ink-3">{label.toUpperCase()}</span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.soft} text-ink`}>
          {s.label}
        </span>
      </div>
      <p className="mt-1 text-3xl font-semibold text-ink">{score}</p>
      <div className={`mt-2 h-2 w-full overflow-hidden rounded-full ${s.soft}`}>
        <div
          className={`h-full rounded-full ${s.color}`}
          style={{ width: `${Math.max(0, Math.min(100, score))}%` }}
        />
      </div>
    </div>
  );
}
