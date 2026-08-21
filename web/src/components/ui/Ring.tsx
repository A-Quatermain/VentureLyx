// Large centred circular gauge — docs/design_guidelines.json's "gauge"
// component: indigo progress arc, big mono score in the centre, regardless
// of the score's value (health-based red/amber/green swapping lives in
// chips and bars elsewhere, not this hero number).
export function Ring({
  score,
  size = 88,
  strokeWidth = 8,
  label,
}: {
  score: number;
  size?: number;
  strokeWidth?: number;
  label?: string;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, score));
  const offset = circumference * (1 - clamped / 100);
  const scoreFontSize = size >= 160 ? 'text-5xl' : 'text-2xl';

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" strokeWidth={strokeWidth} className="stroke-muted" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          className="stroke-primary"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className={`font-mono ${scoreFontSize} font-semibold tabular-nums tracking-tight text-foreground`}>{score}</span>
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label ?? '/ 100'}</span>
      </div>
    </div>
  );
}
