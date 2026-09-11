/**
 * Venturelyx :: Grow schedule projection.
 *
 * A read-time simulation of how long the campaign's remaining sends will
 * take, given today's mailbox warmup ramps, per-domain caps, and the
 * campaign's own daily_target — the same three constraints scheduler.js's
 * planTick() (/opt/outreach/src) applies in the same order (target, then
 * mailbox, then domain), just projected forward day by day instead of
 * decided one day at a time by a live worker. There is no worker here and
 * nothing is written: this is a projection from grow_enrollments,
 * grow_mailboxes and grow_domain_policies as they stand right now, not a
 * stored plan — rerun it and it can (and will) change as those change.
 *
 * Known simplification: it does not model grow_enrollments.gated_on_contact_id
 * (a rank-2 contact waiting for its rank-1 counterpart to go quiet before
 * entering the queue — see 009_grow.sql). That gate clears on a reply or a
 * timeout, both of which depend on how recipients actually respond, which
 * isn't something a capacity projection can predict. Every currently-active
 * enrollment's remaining steps are counted as though they were eligible
 * today, so a campaign with a lot of gated rank-2 contacts will complete
 * somewhat later than this projection shows.
 */
import { mailboxCapOnDate } from './growMailboxWarmup.js';

// Exactly the domains named in the brief: the big consumer webmail brands,
// plus bellsouth.net/att.net — both AT&T addresses actually hosted on
// Yahoo's mail infrastructure, and filtered just as harshly.
const CONSUMER_DOMAINS = new Set([
  'gmail.com', 'yahoo.com', 'aol.com', 'hotmail.com', 'outlook.com',
  'bellsouth.net', 'att.net',
]);

export function isConsumerDomain(domain: string): boolean {
  return CONSUMER_DOMAINS.has(domain.toLowerCase());
}

// scheduler.js's own hardcoded fallback when no '*' row exists yet
// (domainCapacity(): `let fallback = 25;`) — matched here so a fresh org
// with no grow_domain_policies rows at all still gets a realistic
// projection instead of an unbounded one.
export const DEFAULT_FALLBACK_CAP = 25;

const MS_PER_DAY = 86_400_000;

function addDays(date: Date, n: number): Date {
  return new Date(date.getTime() + n * MS_PER_DAY);
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The calendar date "today" falls on on in `timeZone`, as a UTC-midnight
 *  Date — ported from scheduler.js's zonedDateParts(), same reasoning: a
 *  campaign's weekday (for weekdays_only) is a wall-clock concept in its
 *  own timezone, not the server's UTC day. */
function todayInTimezone(timeZone: string): Date {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
}

function isWeekend(date: Date, timeZone: string): boolean {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
  return weekday === 'Sat' || weekday === 'Sun';
}

export interface ProjectionMailbox {
  status: string;
  warmupStartedOn: Date | null;
  steadyCap: number;
}

export interface ProjectionDay {
  date: string;
  mailbox_capacity: number;
  domain_capacity: number;
  daily_target: number;
  sent: number;
  binding: 'mailbox_capacity' | 'domain_caps' | 'daily_target';
}

export interface ProjectionResult {
  completion_date: string | null;
  horizon_exceeded: boolean;
  // Distinct from horizon_exceeded: this means the campaign's own end_date
  // was reached with sends still remaining — a real, user-set deadline
  // wasn't met, not just this projection's own 180-day safety cap.
  deadline_exceeded: boolean;
  remaining_sends: number;
  blocked_reason: 'no_mailbox_capacity' | 'no_domain_capacity' | null;
  days: ProjectionDay[];
}

export interface ProjectionInput {
  mailboxes: ProjectionMailbox[];
  domainRemaining: Map<string, number>;
  domainCaps: Map<string, number>;
  fallbackCap: number;
  dailyTarget: number;
  weekdaysOnly: boolean;
  timezone: string;
  // Both UTC-midnight Dates, matching todayInTimezone()'s own convention.
  // Null/undefined means "no bound" — the projection behaves exactly as it
  // did before either existed.
  startDate?: Date | null;
  endDate?: Date | null;
}

const HORIZON_DAYS = 180;
const STUCK_DAY_LIMIT = 14;

export function projectSchedule(params: ProjectionInput): ProjectionResult {
  const { mailboxes, domainCaps, fallbackCap, dailyTarget, weekdaysOnly, timezone, startDate, endDate } = params;
  const remaining = new Map(params.domainRemaining);
  let totalRemaining = [...remaining.values()].reduce((s, n) => s + n, 0);

  if (totalRemaining === 0) {
    return {
      completion_date: null, horizon_exceeded: false, deadline_exceeded: false,
      remaining_sends: 0, blocked_reason: null, days: [],
    };
  }
  if (!mailboxes.some((m) => m.status === 'active' || m.status === 'warming')) {
    return {
      completion_date: null, horizon_exceeded: false, deadline_exceeded: false, remaining_sends: totalRemaining,
      blocked_reason: 'no_mailbox_capacity', days: [],
    };
  }

  const capForDomain = (domain: string) => domainCaps.get(domain) ?? fallbackCap;

  const days: ProjectionDay[] = [];
  let date = todayInTimezone(timezone);
  if (startDate && startDate.getTime() > date.getTime()) date = startDate;
  let stuckDays = 0;
  let stoppedAtDeadline = false;

  while (totalRemaining > 0 && days.length < HORIZON_DAYS) {
    if (endDate && date.getTime() > endDate.getTime()) {
      stoppedAtDeadline = true;
      break;
    }
    if (weekdaysOnly && isWeekend(date, timezone)) {
      date = addDays(date, 1);
      continue;
    }

    const mailboxCapToday = mailboxes.reduce(
      (s, m) => s + mailboxCapOnDate(m, date),
      0,
    );

    const activeDomains = [...remaining.entries()]
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1]);
    const domainCapTotal = activeDomains.reduce(
      (s, [domain, n]) => s + Math.min(n, capForDomain(domain)),
      0,
    );

    const budget = Math.min(dailyTarget, mailboxCapToday, domainCapTotal);
    let binding: ProjectionDay['binding'];
    if (mailboxCapToday <= domainCapTotal && mailboxCapToday <= dailyTarget) binding = 'mailbox_capacity';
    else if (domainCapTotal <= mailboxCapToday && domainCapTotal <= dailyTarget) binding = 'domain_caps';
    else binding = 'daily_target';

    let sentToday = 0;
    if (budget > 0) {
      let left = budget;
      for (const [domain] of activeDomains) {
        if (left <= 0) break;
        const take = Math.min(left, remaining.get(domain)!, capForDomain(domain));
        if (take <= 0) continue;
        remaining.set(domain, remaining.get(domain)! - take);
        left -= take;
        sentToday += take;
      }
    }

    totalRemaining -= sentToday;
    days.push({
      date: isoDate(date), mailbox_capacity: mailboxCapToday, domain_capacity: domainCapTotal,
      daily_target: dailyTarget, sent: sentToday, binding,
    });

    // Zero progress for two straight weeks means capacity, not the
    // calendar, is what's actually stuck — stop simulating rather than
    // grinding out the full horizon to say the same thing 180 times.
    stuckDays = sentToday === 0 ? stuckDays + 1 : 0;
    if (stuckDays >= STUCK_DAY_LIMIT) {
      return {
        completion_date: null, horizon_exceeded: false, deadline_exceeded: false, remaining_sends: totalRemaining,
        blocked_reason: mailboxCapToday === 0 ? 'no_mailbox_capacity' : 'no_domain_capacity',
        days,
      };
    }

    date = addDays(date, 1);
  }

  return {
    completion_date: totalRemaining === 0 ? days[days.length - 1]!.date : null,
    horizon_exceeded: totalRemaining > 0 && !stoppedAtDeadline,
    deadline_exceeded: totalRemaining > 0 && stoppedAtDeadline,
    remaining_sends: totalRemaining,
    blocked_reason: null,
    days,
  };
}

/** Binary-searches the smallest daily_target that would finish by
 *  `base.endDate` under the exact same mailbox ramp and domain caps —
 *  answering "what target would be needed" rather than just "it won't
 *  make it." Returns null when even an effectively unlimited daily_target
 *  can't finish in time, meaning the real constraint is mailbox/domain
 *  capacity, not the target — raising daily_target wouldn't help at all. */
export function neededDailyTargetForDeadline(base: Omit<ProjectionInput, 'dailyTarget'>): number | null {
  if (!base.endDate) return null;
  const totalRemaining = [...base.domainRemaining.values()].reduce((s, n) => s + n, 0);
  if (totalRemaining === 0) return 0;

  const unlimited = projectSchedule({ ...base, dailyTarget: totalRemaining });
  if (unlimited.completion_date === null) return null;

  let lo = 1;
  let hi = totalRemaining;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const result = projectSchedule({ ...base, dailyTarget: mid });
    if (result.completion_date !== null) hi = mid; else lo = mid + 1;
  }
  return lo;
}
