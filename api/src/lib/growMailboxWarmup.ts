/**
 * Venturelyx :: Grow mailbox warmup — the date a mailbox's ramp reaches
 * steady_cap.
 *
 * The daily cap itself is read straight from the database's own
 * grow_mailbox_daily_cap() SQL function (db/migrations/009_grow.sql) —
 * never recomputed here, so "today's cap" can't drift from what the
 * (future) scheduler will actually enforce. This file only adds the one
 * thing that function can't answer for itself: projecting forward to find
 * the date the ramp reaches steady_cap, which means mirroring its formula
 * exactly rather than calling it 365 times.
 *
 *   cap(day) = LEAST(steady_cap, 5 * (1 + GREATEST(0, day - start) / 7))
 *
 * (integer division, per the SQL). Solving for the smallest day where
 * cap(day) >= steady_cap gives the closed form below.
 */

const MS_PER_DAY = 86_400_000;

export function steadyCapDate(warmupStartedOn: Date, steadyCap: number): Date {
  const weeksNeeded = Math.max(0, Math.ceil(steadyCap / 5) - 1);
  return new Date(warmupStartedOn.getTime() + weeksNeeded * 7 * MS_PER_DAY);
}

/** Same formula as grow_mailbox_daily_cap(), evaluated for an arbitrary
 *  (typically future) date instead of CURRENT_DATE — the one thing the SQL
 *  function can't do for a multi-week projection without being called once
 *  per candidate day. `onDate` and `warmupStartedOn` are both expected at
 *  UTC midnight, matching how node-postgres hands back a `date` column. */
export function mailboxCapOnDate(
  mailbox: { status: string; warmupStartedOn: Date | null; steadyCap: number },
  onDate: Date,
): number {
  if (mailbox.status !== 'active' && mailbox.status !== 'warming') return 0;
  if (!mailbox.warmupStartedOn) return 0;
  const daysSinceStart = Math.max(
    0,
    Math.floor((onDate.getTime() - mailbox.warmupStartedOn.getTime()) / MS_PER_DAY),
  );
  return Math.min(mailbox.steadyCap, 5 * (1 + Math.floor(daysSinceStart / 7)));
}

export interface RampPoint {
  date: string;
  cap: number;
}

/** One point per week the ramp actually steps up, from warmup start through
 *  the week steady_cap is first reached — a step function, not a smooth
 *  curve, so weekly points reproduce it exactly with no interpolation. */
export function rampPoints(warmupStartedOn: Date, steadyCap: number): RampPoint[] {
  const capDate = steadyCapDate(warmupStartedOn, steadyCap);
  const weeks = Math.round((capDate.getTime() - warmupStartedOn.getTime()) / (7 * MS_PER_DAY));
  const points: RampPoint[] = [];
  for (let w = 0; w <= weeks; w += 1) {
    const date = new Date(warmupStartedOn.getTime() + w * 7 * MS_PER_DAY);
    points.push({ date: date.toISOString().slice(0, 10), cap: Math.min(steadyCap, 5 * (w + 1)) });
  }
  return points;
}
