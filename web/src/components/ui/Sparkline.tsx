'use client';

import { useState } from 'react';
import type { SeoTrendPoint } from '@/lib/types';

// Stat-tile trend spec: 12-point sparkline in the de-emphasis hue, current
// period in the accent. Single series, so no legend — the card's own label
// already says what's plotted. Per-point hover/focus tooltip, same details
// reachable on keyboard focus as on hover (interaction.md); no crosshair —
// disproportionate for a compact supporting-detail widget.
export function Sparkline({ points }: { points: SeoTrendPoint[] }) {
  const [active, setActive] = useState<number | null>(null);

  // API returns newest-first; plot chronologically, left to right.
  const chrono = [...points].reverse().filter((p) => p.health !== null) as Array<{
    health: number;
    computed_at: string;
  }>;

  if (chrono.length < 2) {
    return <p className="text-xs text-muted-foreground">Not enough history yet for a trend.</p>;
  }

  const w = 100;
  const h = 30;
  const xAt = (i: number) => (i / (chrono.length - 1)) * w;
  const yAt = (v: number) => h - (v / 100) * h;

  const linePoints = chrono.map((p, i) => `${xAt(i)},${yAt(p.health)}`).join(' ');
  const lastIdx = chrono.length - 1;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${w} ${h}`} className="h-8 w-full" preserveAspectRatio="none">
        <polyline
          points={linePoints}
          fill="none"
          className="stroke-muted-foreground"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {/* Current period in the accent, drawn over the muted line. */}
        <line
          x1={xAt(lastIdx - 1)}
          y1={yAt(chrono[lastIdx - 1]!.health)}
          x2={xAt(lastIdx)}
          y2={yAt(chrono[lastIdx]!.health)}
          className="stroke-primary"
          strokeWidth="2"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {chrono.map((p, i) => (
          <circle
            key={p.computed_at}
            cx={xAt(i)}
            cy={yAt(p.health)}
            r={i === lastIdx ? 2.5 : 1.5}
            className={i === lastIdx ? 'fill-primary' : 'fill-muted-foreground'}
          />
        ))}
      </svg>
      {/* 24px hit targets, positioned by percentage over the same coordinate
          space as the SVG (preserveAspectRatio="none" keeps them aligned). */}
      {chrono.map((p, i) => (
        <button
          key={p.computed_at}
          type="button"
          aria-label={`${p.health} on ${new Date(p.computed_at).toLocaleDateString()}`}
          className="absolute h-6 w-6 -translate-x-1/2 -translate-y-1/2"
          style={{ left: `${xAt(i)}%`, top: `${(yAt(p.health) / h) * 100}%` }}
          onMouseEnter={() => setActive(i)}
          onMouseLeave={() => setActive(null)}
          onFocus={() => setActive(i)}
          onBlur={() => setActive(null)}
        />
      ))}
      {active !== null && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-full rounded-md border border-border bg-surface px-2 py-1 text-xs shadow-sm"
          style={{
            left: `${xAt(active)}%`,
            top: `${(yAt(chrono[active]!.health) / h) * 100}%`,
            marginTop: '-6px',
          }}
        >
          <span className="font-mono font-medium text-foreground" data-numeric>
            {chrono[active]!.health}
          </span>{' '}
          <span className="text-muted-foreground">
            {new Date(chrono[active]!.computed_at).toLocaleDateString()}
          </span>
        </div>
      )}
    </div>
  );
}
