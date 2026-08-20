// Ported from ref-1's GrowthGauge.jsx. Fed by summary.seo?.health — we
// don't have a separate composite "growth score," so this honestly reuses
// the one score-shaped number the API actually has rather than inventing
// a fake composite.
export function GrowthGauge({ score = 0, size = 200 }: { score?: number | null; size?: number }) {
  const clamped = Math.max(0, Math.min(100, score ?? 0));
  const radius = size / 2 - 16;
  const cx = size / 2;
  const cy = size / 2;
  const startAngle = Math.PI;
  const endAngle = 0;
  const angle = startAngle - (clamped / 100) * (startAngle - endAngle);

  const polar = (a: number, r = radius): [number, number] => [cx + r * Math.cos(a), cy - r * Math.sin(a)];
  const [sx, sy] = polar(startAngle);
  const [ex, ey] = polar(endAngle);
  const [px, py] = polar(angle);

  const color =
    clamped >= 75 ? 'hsl(var(--success))' : clamped >= 50 ? 'hsl(var(--primary))' : 'hsl(var(--destructive))';

  return (
    <div className="flex flex-col items-center">
      <svg width={size} height={size / 2 + 24} viewBox={`0 0 ${size} ${size / 2 + 24}`}>
        <path
          d={`M ${sx} ${sy} A ${radius} ${radius} 0 0 1 ${ex} ${ey}`}
          fill="none"
          stroke="hsl(var(--muted))"
          strokeWidth="14"
        />
        <path d={`M ${sx} ${sy} A ${radius} ${radius} 0 0 1 ${px} ${py}`} fill="none" stroke={color} strokeWidth="14" />
        {[0, 25, 50, 75, 100].map((t) => {
          const a = startAngle - (t / 100) * (startAngle - endAngle);
          const [tx, ty] = polar(a, radius + 14);
          return (
            <text key={t} x={tx} y={ty} fontSize="9" fontFamily="var(--font-mono)" fill="hsl(var(--muted-fg))" textAnchor="middle">
              {t}
            </text>
          );
        })}
      </svg>
      <div className="-mt-16 text-center">
        <div className="font-mono text-5xl font-bold tracking-tighter">{score == null ? '—' : clamped}</div>
        <div className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">Growth Score</div>
      </div>
    </div>
  );
}
