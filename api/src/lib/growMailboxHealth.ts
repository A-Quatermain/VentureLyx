/**
 * Venturelyx :: Grow mailbox warmup health gate
 * (docs/specs/grow-warmup-coach-spec.md section 3).
 *
 * The warmup ramp (grow_mailbox_daily_cap(), 009_grow.sql) only ever goes
 * up on a fixed schedule — it has no idea whether a mailbox is actually
 * landing cleanly. This adds the other half: per mailbox, a rolling
 * 7-day bounce/complaint rate, reusing growScheduler.ts's own
 * BOUNCE_PAUSE_RATE/COMPLAINT_PAUSE_RATE/MIN_SAMPLE — the exact thresholds
 * the circuit breaker already uses for a campaign, just evaluated per
 * mailbox instead.
 *
 * Protection is immediate, recovery is not — intentionally asymmetric:
 *   - rate > threshold  -> hold the cap 1 step (5/day) down, right away.
 *   - rate > 2x threshold -> hold it 2 steps down, right away.
 *   - once healthy, recover exactly 1 step per full 7 CONSECUTIVE healthy
 *     days, back up toward steady_cap — never snaps back to full capacity
 *     just because today happened to look fine.
 *
 * grow_mailbox_daily_cap() stays cheap: this module computes the result
 * and STORES it (health_steps_down) on the mailbox row; the cap function
 * only ever reads that column, no live computation in the hot path.
 */
import type { Querier } from './db.js';
import { audit } from './auth.js';
import { BOUNCE_PAUSE_RATE, COMPLAINT_PAUSE_RATE, MIN_SAMPLE } from './growScheduler.js';

export const HEALTH_WINDOW_DAYS = 7;
export const RECOVERY_WINDOW_DAYS = 7;
export const MAX_STEPS_DOWN = 2;

export interface MailboxHealthRow {
  id: string;
  address: string;
  health_steps_down: number;
  health_healthy_since: string | Date | null;
}

export interface HealthEvalResult {
  stepsDown: number;
  reason: string | null;
  healthySince: Date | null;
}

function toDate(v: string | Date | null): Date | null {
  if (!v) return null;
  return v instanceof Date ? v : new Date(v);
}

/** Pure(ish) evaluation — one mailbox, no writes. Exported on its own so
 *  the decision logic can be exercised directly without a live DB. */
export async function evaluateMailboxHealth(
  q: Querier, mailbox: MailboxHealthRow, now: Date = new Date(),
): Promise<HealthEvalResult> {
  const s = await q.one<{ attempts: string | number; bounced: string | number }>(
    `SELECT COUNT(*) FILTER (WHERE status IN ('sent', 'bounced')) AS attempts,
            COUNT(*) FILTER (WHERE status = 'bounced')            AS bounced
       FROM grow_messages
      WHERE mailbox_id = $1
        AND created_at > now() - ($2 || ' days')::interval`,
    [mailbox.id, HEALTH_WINDOW_DAYS],
  );
  const attempts = Number(s?.attempts ?? 0);

  // Not enough data to judge — hold exactly where it is. Does not run the
  // recovery clock on data that isn't meaningful yet, and does not escalate
  // on it either (same MIN_SAMPLE guard the circuit breaker uses, and the
  // same reasoning: a mailbox being refused outright still needs attempts
  // >= MIN_SAMPLE via the sent+bounced definition to count as real data).
  if (attempts < MIN_SAMPLE) {
    return {
      stepsDown: mailbox.health_steps_down,
      reason: mailbox.health_steps_down > 0
        ? `holding ${mailbox.health_steps_down} step(s) down — fewer than ${MIN_SAMPLE} attempts in the last ${HEALTH_WINDOW_DAYS} days to re-evaluate`
        : null,
      healthySince: toDate(mailbox.health_healthy_since),
    };
  }

  const complaintsRow = await q.one<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM grow_events e
       JOIN grow_messages m ON m.id = e.message_id
      WHERE e.type = 'complaint' AND m.mailbox_id = $1
        AND m.created_at > now() - ($2 || ' days')::interval`,
    [mailbox.id, HEALTH_WINDOW_DAYS],
  );

  const bounceRate = Number(s!.bounced) / attempts;
  const complaintRate = Number(complaintsRow?.n ?? 0) / attempts;
  const bounceRatio = bounceRate / BOUNCE_PAUSE_RATE;
  const complaintRatio = complaintRate / COMPLAINT_PAUSE_RATE;
  const worstRatio = Math.max(bounceRatio, complaintRatio);
  const desiredSteps = Math.min(MAX_STEPS_DOWN, worstRatio > 2 ? 2 : worstRatio > 1 ? 1 : 0);

  if (desiredSteps > mailbox.health_steps_down) {
    // Immediate protective step-up, never delayed, and never explained
    // away by whichever metric happens to be milder.
    const byBounce = bounceRatio >= complaintRatio;
    const rate = byBounce ? bounceRate : complaintRate;
    const threshold = byBounce ? BOUNCE_PAUSE_RATE : COMPLAINT_PAUSE_RATE;
    return {
      stepsDown: desiredSteps,
      reason: `${byBounce ? 'bounce' : 'complaint'} rate ${(rate * 100).toFixed(2)}% exceeds ` +
        `${desiredSteps > 1 ? '2x ' : ''}${(threshold * 100).toFixed(2)}% over the last ` +
        `${HEALTH_WINDOW_DAYS} days (${attempts} attempts) — cap held ${desiredSteps} step(s) down`,
      healthySince: null,
    };
  }

  if (desiredSteps === 0) {
    const healthySince = toDate(mailbox.health_healthy_since) ?? now;
    const daysHealthy = (now.getTime() - healthySince.getTime()) / 86_400_000;

    if (mailbox.health_steps_down > 0 && daysHealthy >= RECOVERY_WINDOW_DAYS) {
      const nextSteps = mailbox.health_steps_down - 1;
      return {
        stepsDown: nextSteps,
        reason: nextSteps > 0
          ? `healthy for ${RECOVERY_WINDOW_DAYS}+ days — recovered one cap step, ${nextSteps} remaining`
          : `healthy for ${RECOVERY_WINDOW_DAYS}+ days — fully recovered to steady_cap`,
        healthySince: now, // restart the clock for the next recovery step
      };
    }
    return {
      stepsDown: mailbox.health_steps_down,
      reason: mailbox.health_steps_down > 0
        ? `healthy, recovering — ${Math.floor(daysHealthy)}/${RECOVERY_WINDOW_DAYS} days toward the next cap step`
        : null,
      healthySince,
    };
  }

  // Still over threshold, but no worse than before — hold, no recovery
  // clock runs while this is true.
  return {
    stepsDown: mailbox.health_steps_down,
    reason: `bounce rate ${(bounceRate * 100).toFixed(2)}% / complaint rate ${(complaintRate * 100).toFixed(2)}% ` +
      `still over threshold over the last ${HEALTH_WINDOW_DAYS} days — holding ${mailbox.health_steps_down} step(s) down`,
    healthySince: null,
  };
}

/** Evaluates every active/warming mailbox in the CURRENT tenant context
 *  and persists the result. Audits only when health_steps_down actually
 *  CHANGES — an unchanged re-evaluation (the common case, most ticks) is
 *  not an event worth an audit_log row, just like a crawl that finds
 *  nothing new doesn't write a signal. */
export async function runMailboxHealthGate(q: Querier, orgId: string): Promise<void> {
  const mailboxes = await q.rows<MailboxHealthRow>(
    `SELECT id, address, health_steps_down, health_healthy_since
       FROM grow_mailboxes WHERE status IN ('warming', 'active')`,
  );
  const now = new Date();

  for (const mailbox of mailboxes) {
    const result = await evaluateMailboxHealth(q, mailbox, now);
    const changed = result.stepsDown !== mailbox.health_steps_down;

    await q.exec(
      `UPDATE grow_mailboxes
          SET health_steps_down = $2, health_reason = $3,
              health_healthy_since = $4, health_evaluated_at = now()
        WHERE id = $1`,
      [mailbox.id, result.stepsDown, result.reason, result.healthySince],
    );

    if (changed) {
      await audit(q, {
        orgId, actorUser: null, action: 'grow.mailbox.health_gate',
        entityType: 'grow_mailboxes', entityId: mailbox.id,
        diff: {
          address: mailbox.address,
          from_steps_down: mailbox.health_steps_down,
          to_steps_down: result.stepsDown,
          reason: result.reason,
        },
      });
    }
  }
}
