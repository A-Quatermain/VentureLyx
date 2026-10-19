/**
 * Venturelyx :: Grow scheduler — the (until now) not-yet-built worker's
 * planning and claiming logic.
 *
 * Ported from the standalone CampusPath engine's scheduler.js
 * (/opt/outreach/src) onto grow_* tables, org-scoped by Postgres RLS
 * instead of an explicit tenant_id parameter — every function here must be
 * called inside withTenant({orgId, ...}, fn) (see lib/db.ts), the same
 * convention every route in routes/grow.ts already follows. No query here
 * adds its own org_id/WHERE filter; RLS supplies it (see ROADMAP.md's
 * "queries carry no org_id filter and must not add one").
 *
 * Two entry points, same split as the standalone engine:
 *   planOrgCampaigns(q)  — decides who gets queued today, for every
 *                          running campaign in the org at once
 *   claimDue(q, limit)   — worker pulls messages whose time has come
 *
 * One deliberate change from the ported original: weekdays_only used
 * `now.getDay()` (server-local weekday) even though window_start/window_end
 * are wall-clock times in the campaign's own timezone — scheduler.js's own
 * header comment flagged this as a known-but-unfixed quirk. growSchedule.ts
 * (the read-only projection already in this app) already established the
 * correct fix (isWeekend() against the campaign's timezone), so the real
 * worker uses that rather than reintroducing a bug a sibling file already
 * fixed once.
 *
 * One deliberate addition beyond the ported original: start_date/end_date
 * (db/migrations/013_grow_campaign_dates.sql) are hard bounds here, exactly
 * as that migration's own comment says the real worker should treat them.
 *
 * Another: mailboxCapacity() below also excludes a mailbox whose sending
 * domain has been disabled (db/migrations/028_grow_domain_enable.sql) —
 * mailbox.status alone used to be the only gate, which meant pausing a
 * domain (as opposed to every mailbox under it individually) did nothing
 * to actually stop sends.
 *
 * Another: planOrgCampaigns() plans every running campaign in an org in
 * one coordinated pass, not one isolated planTick() per campaign. Two
 * campaigns sharing a mailbox pool used to each plan in sequence against
 * whatever capacity was left when their turn came — the first campaign
 * in the loop could (and, on the live org this was caught on, did)
 * consume the entire pool before the second one was even considered,
 * leaving it at zero while it still had plenty of contacts to send.
 * allocateMailboxCapacity() below splits each mailbox's remaining
 * capacity across every campaign that still wants it before any of them
 * actually picks contacts — see its own doc comment for the policy.
 */
import type { Querier } from './db.js';
import { getSenderProfile, render, renderSenderFields } from './growTemplate.js';
import { isWeekend, todayInTimezone } from './growSchedule.js';

export const BOUNCE_PAUSE_RATE = 0.03;    // 3% hard bounces
export const COMPLAINT_PAUSE_RATE = 0.003; // 0.3% — Gmail/Microsoft draw the line here
export const MIN_SAMPLE = 50;              // don't judge a campaign on its first few sends

export interface GrowCampaign {
  id: string;
  name: string;
  status: string;
  timezone: string;
  window_start: string;
  window_end: string;
  weekdays_only: boolean;
  daily_target: number;
  start_date: string | Date | null;
  end_date: string | Date | null;
  /** Set by a manual resume (routes/grow.ts) — see this file's header for
   *  why circuitBreaker() below only counts activity after this point
   *  once it's set, rather than the campaign's whole-lifetime history. */
  breaker_armed_at: string | Date | null;
}

export interface MailboxCapacity {
  id: string; address: string; from_name: string; reply_to: string | null;
  cap: number; committed_today: number; remaining: number;
}

// Fixed advisory-lock namespace for the per-mailbox lock below — nothing
// else in this codebase takes an advisory lock today, but a literal
// classid keeps it that way: anything added later under a different
// classid can never collide with this one, whatever objid it picks.
const MAILBOX_LOCK_CLASSID = 837264;

/** Remaining sends per mailbox today, after warmup ramp and every message
 *  already committed to it today — 'sent', 'sending' (claimed, in flight),
 *  or still 'queued' — across EVERY campaign in the org, not just the one
 *  calling this. A mailbox is one shared resource; two campaigns queuing
 *  against it in the same planning pass must each see the other's
 *  allocation. This used to count only 'sent', which is exactly the gap a
 *  live diagnostic found: two campaigns each read "0 sent today, 25
 *  remaining" independently and each queued up to the full cap, so a
 *  25/day mailbox ended up with ~60 messages committed to it in one day.
 *
 *  pg_advisory_xact_lock, one per candidate mailbox, acquired in a fixed
 *  (m.id) order and held for the rest of this transaction: planTick()
 *  already runs one campaign's whole read-then-insert sequence inside one
 *  transaction, and runPlanningPass() (growWorker.ts) plans every one of
 *  an org's running campaigns inside that SAME transaction, one after
 *  another — so today, this already serializes same-org campaigns
 *  against each other by construction. The lock is what keeps that true
 *  even if that ever changes (a second worker process, an overlapping
 *  tick): a second transaction asking for this mailbox's committed count
 *  blocks until the first transaction commits its allocation, instead of
 *  reading a stale count and over-committing anyway. Re-entrant within
 *  one transaction (a second campaign in the same planning pass re-locks
 *  an already-held mailbox instantly, not a deadlock), and auto-released
 *  at COMMIT/ROLLBACK — nothing to explicitly unlock.
 *
 *  Reads the ramp through grow_mailbox_daily_cap() (db/migrations/009_grow.sql)
 *  — the same function api/src/lib/growMailboxWarmup.ts mirrors for the UI
 *  projection — so "today's cap" can never drift between what the UI shows
 *  and what this worker actually enforces.
 *
 *  Takes a plain timezone, not a campaign: the mailbox pool is an org-
 *  level resource shared by every campaign, so "today" for this count
 *  has to be one single answer for the whole allocation decision, not
 *  whichever campaign happened to ask. planOrgCampaigns() passes the
 *  org's own timezone. */
async function mailboxCapacity(q: Querier, timezone: string): Promise<MailboxCapacity[]> {
  await q.rows(
    `SELECT pg_advisory_xact_lock($1, hashtext(m.id::text))
       FROM grow_mailboxes m
       JOIN grow_sending_domains d ON d.id = m.domain_id
      WHERE m.status IN ('warming','active') AND d.enabled
      ORDER BY m.id`,
    [MAILBOX_LOCK_CLASSID],
  );

  const rows = await q.rows<{
    id: string; address: string; from_name: string; reply_to: string | null;
    cap: number; committed_today: string | number;
  }>(
    `SELECT m.id, m.address, m.from_name, m.reply_to,
            grow_mailbox_daily_cap(m.*, (now() AT TIME ZONE $1)::date) AS cap,
            COUNT(msg.id) FILTER (
              WHERE msg.status IN ('sent', 'sending', 'queued')
                AND (COALESCE(msg.sent_at, msg.scheduled_at) AT TIME ZONE $1)::date
                    = (now() AT TIME ZONE $1)::date
            ) AS committed_today
       FROM grow_mailboxes m
       JOIN grow_sending_domains d ON d.id = m.domain_id
       LEFT JOIN grow_messages msg ON msg.mailbox_id = m.id
      WHERE m.status IN ('warming','active') AND d.enabled
      GROUP BY m.id`,
    [timezone],
  );

  return rows
    .map((r) => ({
      id: r.id, address: r.address, from_name: r.from_name, reply_to: r.reply_to,
      cap: r.cap, committed_today: Number(r.committed_today),
      remaining: Math.max(0, r.cap - Number(r.committed_today)),
    }))
    .filter((r) => r.remaining > 0);
}

/** Remaining sends per recipient domain today. '*' is the fallback rule
 *  (db/migrations/009_grow.sql grow_domain_policies). */
async function domainCapacity(
  q: Querier, campaign: GrowCampaign,
): Promise<{ caps: Map<string, number>; fallback: number }> {
  const rows = await q.rows<{ domain: string; daily_cap: number; sent_today: string | number }>(
    `WITH sent AS (
       SELECT recipient_domain, COUNT(*) AS n
         FROM grow_messages
        WHERE status = 'sent'
          AND (sent_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date
        GROUP BY recipient_domain
     )
     SELECT p.domain, p.daily_cap, COALESCE(s.n, 0) AS sent_today
       FROM grow_domain_policies p
       LEFT JOIN sent s ON s.recipient_domain = p.domain`,
    [campaign.timezone],
  );

  const caps = new Map<string, number>();
  let fallback = 25; // grow_domain_policies' own '*' row is expected; this only covers an org with none configured yet.
  for (const r of rows) {
    if (r.domain === '*') fallback = r.daily_cap;
    else caps.set(r.domain, Math.max(0, r.daily_cap - Number(r.sent_today)));
  }
  return { caps, fallback };
}

/** Live bounce and complaint rates for this campaign. Returns a reason
 *  string if the campaign must auto-pause.
 *
 *  The complaint count is joined through grow_messages to this specific
 *  campaign_id — a prior version counted grow_events(type='complaint')
 *  org-wide with no campaign scoping at all, so one campaign's complaints
 *  could trip a completely different campaign's breaker. Caught while
 *  adding the rearm behavior below, fixed in the same pass.
 *
 *  campaign.breaker_armed_at (set by a manual resume, routes/grow.ts's
 *  POST /grow/campaigns/:id/resume) restricts both the MIN_SAMPLE count
 *  and the rates themselves to activity created after that moment —
 *  "re-check the rate over the next batch," not "immediately re-trip on
 *  the exact same whole-history numbers that just caused the pause." A
 *  campaign that's never been manually resumed has no watermark, so this
 *  is simply the campaign's whole lifetime, same as before. */
export async function circuitBreaker(q: Querier, campaign: GrowCampaign): Promise<string | null> {
  // Two queries, not one JOIN — a LEFT JOIN from grow_messages to
  // grow_events would fan out and inflate the sent/bounced counts if a
  // single message ever has more than one matching event row (an ARF
  // report duplicated by a forwarding rule, say). Correctness over one
  // fewer round trip.
  const s = await q.one<{ sent: string | number; bounced: string | number }>(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'sent')    AS sent,
       COUNT(*) FILTER (WHERE status = 'bounced') AS bounced
     FROM grow_messages
    WHERE campaign_id = $1
      AND ($2::timestamptz IS NULL OR created_at > $2)`,
    [campaign.id, campaign.breaker_armed_at],
  );
  if (!s) return null;

  const sent = Number(s.sent);
  if (sent < MIN_SAMPLE) return null;

  const complaintsRow = await q.one<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM grow_events e
       JOIN grow_messages m ON m.id = e.message_id
      WHERE e.type = 'complaint' AND m.campaign_id = $1
        AND ($2::timestamptz IS NULL OR m.created_at > $2)`,
    [campaign.id, campaign.breaker_armed_at],
  );

  const bounceRate = Number(s.bounced) / sent;
  const complaintRate = Number(complaintsRow?.n ?? 0) / sent;

  if (bounceRate > BOUNCE_PAUSE_RATE) {
    return `bounce rate ${(bounceRate * 100).toFixed(1)}% exceeds ` +
           `${BOUNCE_PAUSE_RATE * 100}% — the list needs cleaning before more sends`;
  }
  if (complaintRate > COMPLAINT_PAUSE_RATE) {
    return `complaint rate ${(complaintRate * 100).toFixed(2)}% exceeds ` +
           `${COMPLAINT_PAUSE_RATE * 100}% — recipients are marking this as spam`;
  }
  return null;
}

interface DueEnrollment {
  enrollment_id: string; current_step: number; contact_id: string;
  email: string; first_name: string | null; contact_name: string | null;
  role: string | null; entity_name: string | null; recipient_domain: string;
  is_free_provider: boolean; contact_rank: number; attrs: Record<string, unknown>;
}

/** Contacts due for their next step. Excludes anyone suppressed (re-checked
 *  here even though enrollAllContacts() already filters at enroll time — a
 *  contact can unsubscribe or bounce after being enrolled, and this is the
 *  query that decides who actually gets queued today), and holds a gated
 *  enrollment until whatever it's gated on has gone quiet (completed,
 *  bounced, or failed — see growEnroll.ts for how gating is assigned). */
async function dueEnrollments(q: Querier, campaign: GrowCampaign, limit: number): Promise<DueEnrollment[]> {
  return q.rows<DueEnrollment>(
    `SELECT e.id AS enrollment_id, e.current_step, e.contact_id,
            c.email, c.first_name, c.contact_name, c.role, c.entity_name,
            c.recipient_domain, c.is_free_provider, c.contact_rank, c.attrs
       FROM grow_enrollments e
       JOIN grow_contacts c ON c.id = e.contact_id
      WHERE e.campaign_id = $1
        AND e.state = 'active'
        AND e.next_eligible_at <= now()
        AND NOT EXISTS (
              SELECT 1 FROM grow_suppressions s WHERE s.email = c.email)
        AND (e.gated_on_contact_id IS NULL
             OR EXISTS (
               SELECT 1 FROM grow_enrollments g
                WHERE g.contact_id = e.gated_on_contact_id
                  AND g.campaign_id = e.campaign_id
                  AND g.state IN ('completed','bounced','failed','removed')))
      ORDER BY e.priority, e.next_eligible_at
      LIMIT $2`,
    [campaign.id, limit],
  );
}

/** The wall-clock date (in `timeZone`) `date` falls on, as UTC midnight —
 *  ported from scheduler.js's zonedDateParts(). */
function zonedDateParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** The UTC instant for a wall-clock date+time in `timeZone`. DST-safe by
 *  construction — ported unchanged from scheduler.js. */
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

/** Spreads sends across the campaign's send window with jitter — ported
 *  unchanged from scheduler.js's scheduleTimes(). */
function scheduleTimes(count: number, campaign: GrowCampaign, now: Date): Date[] {
  const [sh, sm] = campaign.window_start.split(':').map(Number) as [number, number];
  const [eh, em] = campaign.window_end.split(':').map(Number) as [number, number];
  const { year, month, day } = zonedDateParts(now, campaign.timezone);

  const start = zonedWallTimeToUtc(year, month, day, sh, sm, campaign.timezone);
  const end = zonedWallTimeToUtc(year, month, day, eh, em, campaign.timezone);

  const from = Math.max(start.getTime(), now.getTime());
  const span = end.getTime() - from;
  if (span <= 0 || count === 0) return [];

  const slot = span / count;
  return Array.from({ length: count }, (_, i) => {
    const jitter = (Math.random() - 0.5) * slot * 0.8;
    return new Date(from + slot * i + slot / 2 + jitter);
  }).sort((a, b) => a.getTime() - b.getTime());
}

function asUtcMidnight(d: string | Date): Date {
  if (d instanceof Date) return d;
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, day));
}

export interface PlanTickResult {
  queued: number;
  reason: string;
  paused?: boolean;
  considered?: number;
  throttledByDomain?: number;
}

export type GrowAllocationPolicy = 'equal_share_redistribute';

// The only policy implemented today. Exported as an explicit constant —
// per the brief, "make the policy a setting so weighting by target can
// be added later" — rather than a bare default buried inside the
// allocator. Adding a second policy later is a new branch in
// allocateMailboxCapacity() keyed on this constant, not a rewrite of it.
export const ALLOCATION_POLICY: GrowAllocationPolicy = 'equal_share_redistribute';

export interface CampaignDemand {
  campaignId: string;
  /** Contacts this campaign could use today, already capped by its own
   *  daily_target remaining — never more than that, however much mailbox
   *  capacity ends up free. */
  demand: number;
}

/** Splits each mailbox's remaining capacity across every campaign still
 *  competing for it. This decides nothing about the hard ceiling — that's
 *  entirely mailboxCapacity()'s committed_today count and claimDue()'s
 *  send-time backstop, both unchanged and untouched by this function. All
 *  this does is divide whatever is already under that ceiling.
 *
 *  equal_share_redistribute (the only policy today): walks the mailboxes
 *  in a fixed order, carrying one running "remaining demand" per campaign
 *  across all of them — so a campaign's total allocation across the
 *  WHOLE pool is capped by its total demand, not just re-capped
 *  independently at every single mailbox. For each mailbox: split its
 *  capacity evenly across whichever campaigns still have demand left,
 *  then hand out whatever's left over — because a campaign's demand fell
 *  under its equal share, or just from the floor division's remainder —
 *  one at a time, round-robin, to campaigns that still want more, until
 *  either the mailbox runs out or every campaign's demand does. No
 *  capacity sits idle while a campaign still wants it; no campaign sits
 *  at zero while the pool still has room for it. */
export function allocateMailboxCapacity(
  mailboxes: MailboxCapacity[], demands: CampaignDemand[],
): Map<string, Map<string, number>> {
  const allocations = new Map<string, Map<string, number>>();
  const remainingDemand = new Map(demands.map((d) => [d.campaignId, d.demand]));
  const orderedMailboxes = [...mailboxes].sort((a, b) => a.id.localeCompare(b.id));

  for (const mailbox of orderedMailboxes) {
    let capacity = mailbox.remaining;
    const perCampaign = new Map<string, number>();
    allocations.set(mailbox.id, perCampaign);
    if (capacity <= 0) continue;

    const eligible = demands
      .map((d) => d.campaignId)
      .filter((id) => (remainingDemand.get(id) ?? 0) > 0);
    if (eligible.length === 0) continue;

    const equalShare = Math.floor(capacity / eligible.length);
    if (equalShare > 0) {
      for (const id of eligible) {
        const give = Math.min(equalShare, remainingDemand.get(id)!);
        perCampaign.set(id, (perCampaign.get(id) ?? 0) + give);
        remainingDemand.set(id, remainingDemand.get(id)! - give);
        capacity -= give;
      }
    }

    // Round-robin the leftover (under-share campaigns, or just the floor
    // division's remainder) to whoever still has demand. Removing an
    // exhausted campaign from the queue in place, without advancing the
    // pointer, keeps the rotation fair as campaigns drop out.
    let queue = eligible.filter((id) => (remainingDemand.get(id) ?? 0) > 0);
    let qi = 0;
    while (capacity > 0 && queue.length > 0) {
      const id = queue[qi % queue.length]!;
      if ((remainingDemand.get(id) ?? 0) <= 0) {
        queue = queue.filter((c) => c !== id);
        continue;
      }
      perCampaign.set(id, (perCampaign.get(id) ?? 0) + 1);
      remainingDemand.set(id, remainingDemand.get(id)! - 1);
      capacity -= 1;
      qi = (qi + 1) % queue.length;
    }
  }

  return allocations;
}

/** The per-campaign half of planning: steps, domain caps, picking
 *  candidates, inserting grow_messages and advancing enrollments. Exactly
 *  what used to be the second half of planTick(), now bounded by this
 *  campaign's specific per-mailbox allocation (from allocateMailboxCapacity())
 *  instead of a mailbox list every campaign could freely draw down. */
async function commitCampaignPlan(
  q: Querier, campaign: GrowCampaign, candidates: DueEnrollment[], budget: number,
  mailboxes: MailboxCapacity[], allocation: Map<string, number>, now: Date,
): Promise<PlanTickResult> {
  const { caps, fallback } = await domainCapacity(q, campaign);
  const steps = await q.rows<{
    step_no: number; delay_days: number; applies_to_rank: number | null;
    subject_tmpl: string; body_tmpl: string;
  }>(`SELECT * FROM grow_sequence_steps WHERE campaign_id = $1 ORDER BY step_no`, [campaign.id]);

  const mailboxById = new Map(mailboxes.map((m) => [m.id, m]));
  const remaining = new Map(allocation);
  let usableMailboxIds = [...allocation.keys()].filter((id) => (remaining.get(id) ?? 0) > 0);

  const picked: Array<{ contact: DueEnrollment; step: typeof steps[number]; mailbox: MailboxCapacity }> = [];
  const domainUsed = new Map<string, number>();
  let mi = 0;

  for (const c of candidates) {
    if (picked.length >= budget) break;
    if (usableMailboxIds.length === 0) break;

    const cap = caps.has(c.recipient_domain) ? caps.get(c.recipient_domain)! : fallback;
    const used = domainUsed.get(c.recipient_domain) ?? 0;
    if (used >= cap) continue;

    const step = steps.find(
      (s) => s.step_no === c.current_step + 1
        && (s.applies_to_rank === null || s.applies_to_rank === c.contact_rank),
    );
    if (!step) continue;

    let chosenId: string | null = null;
    for (let n = 0; n < usableMailboxIds.length; n++) {
      const id = usableMailboxIds[(mi + n) % usableMailboxIds.length]!;
      if ((remaining.get(id) ?? 0) > 0) { chosenId = id; mi = (mi + n + 1) % usableMailboxIds.length; break; }
    }
    if (!chosenId) break;

    remaining.set(chosenId, remaining.get(chosenId)! - 1);
    if (remaining.get(chosenId)! <= 0) {
      usableMailboxIds = usableMailboxIds.filter((id) => id !== chosenId);
      if (usableMailboxIds.length > 0) mi %= usableMailboxIds.length;
    }
    domainUsed.set(c.recipient_domain, used + 1);
    picked.push({ contact: c, step, mailbox: mailboxById.get(chosenId)! });
  }

  const times = scheduleTimes(picked.length, campaign, now);
  if (times.length < picked.length) {
    return { queued: 0, reason: 'send window closed for today' };
  }

  const senderProfile = await getSenderProfile(q);

  for (let i = 0; i < picked.length; i++) {
    const { contact, step, mailbox } = picked[i]!;
    const contactForRender = {
      email: contact.email, first_name: contact.first_name, contact_name: contact.contact_name,
      role: contact.role, entity_name: contact.entity_name, recipient_domain: contact.recipient_domain,
      is_free_provider: contact.is_free_provider, contact_rank: contact.contact_rank, attrs: contact.attrs,
    };
    // {{unsubscribe_footer}} is deliberately left unresolved here — the
    // message's own unsubscribe_token doesn't exist until this INSERT
    // creates the row (it's a column default), so growWorker.ts's sendOne()
    // fills it in at send time. Sender-identity fields, by contrast, don't
    // depend on the row and are resolved now, same as scheduler.js's own
    // render() call did for everything it could resolve at plan time.
    const subject = renderSenderFields(render(step.subject_tmpl, contactForRender), senderProfile);
    const body = renderSenderFields(render(step.body_tmpl, contactForRender), senderProfile);

    await q.exec(
      `INSERT INTO grow_messages
         (org_id, campaign_id, enrollment_id, contact_id, mailbox_id,
          step_no, recipient_domain, subject, body, scheduled_at)
       VALUES (app.current_org(), $1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [campaign.id, contact.enrollment_id, contact.contact_id, mailbox.id,
        step.step_no, contact.recipient_domain, subject, body, times[i]],
    );

    const next = steps.find((s) => s.step_no === step.step_no + 1);
    await q.exec(
      `UPDATE grow_enrollments
          SET current_step = $2,
              next_eligible_at = $3,
              state = CASE WHEN $4::boolean THEN 'completed' ELSE state END
        WHERE id = $1`,
      [contact.enrollment_id, step.step_no,
        next ? new Date(now.getTime() + next.delay_days * 86_400_000) : now,
        !next],
    );
  }

  return {
    queued: picked.length,
    considered: candidates.length,
    throttledByDomain: candidates.length - picked.length,
    reason: picked.length < budget ? 'domain caps or allocation exhausted' : 'budget met',
  };
}

/** Plans every running campaign in the org for today, in one coordinated
 *  pass. Each campaign still clears every gate it always did — status,
 *  date bounds, weekday, circuit breaker, its own daily_target budget,
 *  the send window — individually and first; only campaigns that clear
 *  all of those and still have contacts to send go into
 *  allocateMailboxCapacity() for a shared split of the mailbox pool
 *  (fetched once for the whole org, not once per campaign). Mirrors
 *  scheduler.js's planTick() for each campaign's own gates and picking
 *  logic (see commitCampaignPlan() above); the coordinated allocation
 *  across campaigns is new, and the reason this exists (see this file's
 *  header). */
export async function planOrgCampaigns(
  q: Querier, now: Date = new Date(),
): Promise<Map<string, PlanTickResult>> {
  const results = new Map<string, PlanTickResult>();

  const campaigns = await q.rows<GrowCampaign>(`SELECT * FROM grow_campaigns WHERE status = 'running'`);
  if (campaigns.length === 0) return results;

  interface Ready { campaign: GrowCampaign; budget: number; candidates: DueEnrollment[] }
  const ready: Ready[] = [];

  for (const campaign of campaigns) {
    const today = todayInTimezone(campaign.timezone);
    if (campaign.start_date && today.getTime() < asUtcMidnight(campaign.start_date).getTime()) {
      results.set(campaign.id, { queued: 0, reason: 'before campaign start_date' });
      continue;
    }
    if (campaign.end_date && today.getTime() > asUtcMidnight(campaign.end_date).getTime()) {
      results.set(campaign.id, { queued: 0, reason: 'after campaign end_date' });
      continue;
    }
    if (campaign.weekdays_only && isWeekend(now, campaign.timezone)) {
      results.set(campaign.id, { queued: 0, reason: 'weekend' });
      continue;
    }

    const halt = await circuitBreaker(q, campaign);
    if (halt) {
      await q.exec(`UPDATE grow_campaigns SET status = 'paused', pause_reason = $2 WHERE id = $1`, [campaign.id, halt]);
      results.set(campaign.id, { queued: 0, reason: halt, paused: true });
      continue;
    }

    // Cheap "is there any window left today" check, reusing scheduleTimes()
    // rather than re-deriving the same zoned start/end math separately —
    // checked up front now (an allocation eligibility gate, per the
    // brief) rather than only after picking, as the old single-campaign
    // planTick() did.
    if (scheduleTimes(1, campaign, now).length === 0) {
      results.set(campaign.id, { queued: 0, reason: 'send window closed for today' });
      continue;
    }

    const sentTodayRow = await q.one<{ n: string | number }>(
      `SELECT COUNT(*) AS n FROM grow_messages
        WHERE campaign_id = $1
          AND (COALESCE(sent_at, scheduled_at) AT TIME ZONE $2)::date
              = (now() AT TIME ZONE $2)::date
          AND status <> 'cancelled'`,
      [campaign.id, campaign.timezone],
    );
    const budget = campaign.daily_target - Number(sentTodayRow?.n ?? 0);
    if (budget <= 0) {
      results.set(campaign.id, { queued: 0, reason: 'daily target already met' });
      continue;
    }

    const candidates = await dueEnrollments(q, campaign, budget * 6);
    if (candidates.length === 0) {
      results.set(campaign.id, { queued: 0, reason: 'no eligible contacts', considered: 0 });
      continue;
    }

    ready.push({ campaign, budget, candidates });
  }

  if (ready.length === 0) return results;

  // One mailbox-pool read for every ready campaign in this org, not one
  // per campaign — the pool is an org-level resource, so "today's
  // remaining capacity" has to be a single shared answer. Keyed by the
  // org's own timezone, not any one campaign's (campaigns in the same org
  // could in principle run different timezones; the mailbox pool can't
  // have two different "today"s at once).
  const org = await q.one<{ timezone: string }>(`SELECT timezone FROM organizations WHERE id = app.current_org()`);
  const mailboxes = await mailboxCapacity(q, org?.timezone ?? ready[0]!.campaign.timezone);
  if (mailboxes.length === 0) {
    for (const r of ready) results.set(r.campaign.id, { queued: 0, reason: 'no mailbox capacity' });
    return results;
  }

  const demands: CampaignDemand[] = ready.map((r) => ({
    campaignId: r.campaign.id,
    demand: Math.min(r.budget, r.candidates.length),
  }));
  const allocation = allocateMailboxCapacity(mailboxes, demands);

  for (const r of ready) {
    const perCampaignAllocation = new Map<string, number>();
    for (const mailbox of mailboxes) {
      const slots = allocation.get(mailbox.id)?.get(r.campaign.id) ?? 0;
      if (slots > 0) perCampaignAllocation.set(mailbox.id, slots);
    }
    if (perCampaignAllocation.size === 0) {
      results.set(r.campaign.id, { queued: 0, reason: 'no mailbox capacity allocated this tick' });
      continue;
    }
    // One campaign's commit failing (a bad template, a one-off DB error)
    // must not lose every other campaign's already-committed inserts in
    // this same transaction — caught and recorded here, same resilience
    // the old per-campaign try/catch in runPlanningPass() gave each
    // isolated planTick() call.
    try {
      const result = await commitCampaignPlan(
        q, r.campaign, r.candidates, r.budget, mailboxes, perCampaignAllocation, now,
      );
      results.set(r.campaign.id, result);
    } catch (err) {
      results.set(r.campaign.id, {
        queued: 0, reason: `commit failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return results;
}

/** Worker side. SKIP LOCKED lets several worker ticks pull without
 *  colliding; the status flip to 'sending' means a crash mid-send never
 *  silently requeues the same message twice. Ported from scheduler.js's
 *  claimDue(), plus one addition beyond the ported original: a mailbox-
 *  cap backstop.
 *
 *  mailboxCapacity() enforces the cap at planning time, but planning and
 *  sending are two different passes, minutes apart, against a count that
 *  can only have grown in between — this is the last chokepoint before a
 *  send actually leaves, so it re-checks independently rather than
 *  trusting planning never over-commits (which is exactly how the gap a
 *  live diagnostic found happened: two campaigns each planned against the
 *  same mailbox's stale count). The check here is deliberately narrower
 *  than planning's — 'sent' + 'sending' only, not 'queued' — because
 *  'queued' is the pool being chosen from, not something already
 *  consuming real capacity.
 *
 *  A message whose mailbox is already at cap is simply left 'queued' —
 *  not failed, not cancelled. scheduled_at stays in the past, so the next
 *  check still considers it "due"; the cap check is always against
 *  *today* as of whenever that check runs, so once the calendar date
 *  rolls over and the mailbox's count resets to zero, this exact message
 *  is the first thing claimed. Deferred to the next day, never dropped. */
export async function claimDue<T extends { id: string; attempts: number }>(
  q: Querier, limit = 5,
): Promise<T[]> {
  return q.rows<T>(
    `WITH org_tz AS (SELECT timezone FROM organizations WHERE id = app.current_org())
     UPDATE grow_messages m
        SET status = 'sending', attempts = attempts + 1
      WHERE m.id IN (
        SELECT msg.id
          FROM grow_messages msg
          JOIN grow_mailboxes mb ON mb.id = msg.mailbox_id
         WHERE msg.status = 'queued'
           AND msg.scheduled_at <= now()
           AND (
             SELECT COUNT(*) FROM grow_messages m2
              WHERE m2.mailbox_id = mb.id
                AND m2.status IN ('sent', 'sending')
                AND (COALESCE(m2.sent_at, m2.scheduled_at) AT TIME ZONE (SELECT timezone FROM org_tz))::date
                    = (now() AT TIME ZONE (SELECT timezone FROM org_tz))::date
           ) < grow_mailbox_daily_cap(mb.*, (now() AT TIME ZONE (SELECT timezone FROM org_tz))::date)
         ORDER BY msg.scheduled_at
         FOR UPDATE SKIP LOCKED
         LIMIT $1)
      RETURNING m.*`,
    [limit],
  );
}
