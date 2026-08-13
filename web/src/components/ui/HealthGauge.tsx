import { healthTone, toneFill, toneSoft, type HealthTone } from './tone';

// Stat tile + meter, per the dataviz skill: value in the default sans
// (proportional figures — tabular-nums is for table columns, not a big
// standalone number), fill carries status, unfilled track is a neutral step.
const STATUS_LABEL: Record<HealthTone, string> = {
  growth: 'Healthy',
  sun: 'Needs attention',
  alert: 'Critical',
};

export function HealthGauge({ score, label = 'Health' }: { score: number | null; label?: string }) {
  if (score === null) {
    return <p className="text-sm text-ink-2">No score yet — waiting on the first crawl.</p>;
  }

  const tone = healthTone(score);

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium text-ink-3">{label.toUpperCase()}</span>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${toneSoft[tone]}`}>
          {STATUS_LABEL[tone]}
        </span>
      </div>
      <p className="mt-1 text-3xl font-semibold text-ink">{score}</p>
      <div className={`mt-2 h-2 w-full overflow-hidden rounded-full ${toneSoft[tone].split(' ')[0]}`}>
        <div
          className={`h-full rounded-full ${toneFill[tone]}`}
          style={{ width: `${Math.max(0, Math.min(100, score))}%` }}
        />
      </div>
    </div>
  );
}
