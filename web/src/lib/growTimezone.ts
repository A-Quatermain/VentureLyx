// Ports scheduler.js's zonedWallTimeToUtc (/opt/outreach/src) into the
// browser: the same DST-safe, IANA-database-backed conversion from a
// campaign's wall-clock window_start/window_end (a plain HH:MM in
// campaign.timezone) to the UTC instant it actually is — asking Intl what
// offset really applies on a given date rather than assuming a fixed one,
// which is what let a campaign's send window silently land four hours off
// once already. Display-only here; nothing schedules against this.

function zonedDateParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

function zonedWallTimeToUtc(
  year: number, month: number, day: number, hour: number, minute: number, timeZone: string,
): Date {
  const asIfUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(asIfUtc));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const hour24 = get('hour') === 24 ? 0 : get('hour');
  const asZoned = Date.UTC(get('year'), get('month') - 1, get('day'), hour24, get('minute'), get('second'));

  const offset = asZoned - asIfUtc;
  return new Date(asIfUtc - offset);
}

/** "HH:MM" (24h, UTC) that `time` (HH:MM in `timeZone`, today's date) maps
 *  to right now — for the "server runs UTC" note next to the window. */
export function timeInTimezoneToUtcLabel(time: string, timeZone: string): string | null {
  const match = time.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  try {
    const now = new Date();
    const { year, month, day } = zonedDateParts(now, timeZone);
    const utc = zonedWallTimeToUtc(year, month, day, Number(match[1]), Number(match[2]), timeZone);
    return utc.toISOString().slice(11, 16);
  } catch {
    return null;
  }
}

export function isValidTimezone(timeZone: string): boolean {
  try {
    Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Minutes between two HH:MM wall-clock times, assuming end is same-day and
 *  after start (a send window never wraps past midnight in practice). */
export function windowMinutes(start: string, end: string): number {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return (eh! * 60 + em!) - (sh! * 60 + sm!);
}

const BUSINESS_START_MIN = 8 * 60;
const BUSINESS_END_MIN = 18 * 60;

/** True if any part of [start, end) falls outside 08:00-18:00 wall-clock —
 *  "normal business hours" in the campaign's own timezone, which is exactly
 *  what window_start/window_end already are, no conversion needed. */
export function outsideBusinessHours(start: string, end: string): boolean {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const startMin = sh! * 60 + sm!;
  const endMin = eh! * 60 + em!;
  return startMin < BUSINESS_START_MIN || endMin > BUSINESS_END_MIN;
}
