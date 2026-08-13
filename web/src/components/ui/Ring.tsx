import { healthTone, type HealthTone } from './tone';

const strokeTone: Record<HealthTone, { track: string; fill: string }> = {
  growth: { track: 'stroke-growth-soft', fill: 'stroke-growth' },
  sun: { track: 'stroke-sun-soft', fill: 'stroke-sun' },
  alert: { track: 'stroke-alert-soft', fill: 'stroke-alert' },
};

export function Ring({ score, size = 88, strokeWidth = 8 }: { score: number; size?: number; strokeWidth?: number }) {
  const tone = strokeTone[healthTone(score)];
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, score));
  const offset = circumference * (1 - clamped / 100);

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          className={tone.track}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className={tone.fill}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-semibold text-ink">{score}</span>
        <span className="text-[10px] text-ink-3">/100</span>
      </div>
    </div>
  );
}
