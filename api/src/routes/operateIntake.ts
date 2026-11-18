/**
 * Venturelyx :: Operate lead intake — server-to-server, no session.
 *
 * POST /v1/operate/intake is the one route in this app authenticated by a
 * Bearer key instead of the session cookie every other route uses. It's
 * meant to be called directly from an org's own existing website backend
 * (its lead form stays exactly as it is today — this is what that
 * backend forwards submissions to, instead of its own database), so it
 * runs before contextPlugin's session/org resolution is relevant and
 * never touches req.ctx/req.db() — org identity comes entirely from
 * which key authenticated the request, resolved via withPlatform (the
 * key's own org is unknown until the hash lookup succeeds) and then
 * threaded through withTenant for everything after.
 *
 * Dedup: UNIQUE(org_id, reference) on operate_intake_log is the actual
 * guarantee — checked here first so a retry never even calls
 * findOrCreateParty twice, but the real "can't happen twice" promise
 * lives in the constraint, not in this check-then-act order (a genuinely
 * concurrent retry would still land on the same party, since
 * findOrCreateParty's own email-dedup savepoint handles that race
 * independently — see growPromote.ts. The only edge this doesn't fully
 * close is two truly simultaneous first-time submissions of the same
 * reference each creating their own deal before either reaches the
 * operate_intake_log insert; both would resolve to the same party via
 * email, so the practical impact is a possible duplicate deal, not a
 * duplicate lead — accepted rather than adding a second locking layer
 * for a race this narrow).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { withPlatform, withTenant, type Querier } from '../lib/db.js';
import { findOrCreateParty, getOrCreateDefaultPipeline } from '../lib/growPromote.js';
import { logTimeline } from '../lib/timeline.js';
import { HttpError } from '../plugins/context.js';
import { checkRateLimit } from '../lib/redis.js';

export const hashIntakeKey = (key: string) => createHash('sha256').update(key).digest('hex');

const RESERVED_DETAIL_KEYS = new Set(['name', 'email', 'phone', 'reference', 'stage']);

const intakeInput = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().toLowerCase().email().max(320),
  phone: z.string().trim().max(40).optional(),
  reference: z.string().trim().min(1).max(100),
  stage: z.string().trim().max(50).optional(),
  details: z.record(z.string(), z.unknown()).optional(),
}).refine(
  (body) => !body.details || JSON.stringify(body.details).length <= 8192,
  { message: 'details must be 8KB or smaller', path: ['details'] },
);

interface IntakeKeyRow {
  id: string;
  org_id: string;
  revoked_at: string | null;
}

export default async function operateIntakeRoutes(app: FastifyInstance) {
  app.post('/operate/intake', {
    config: { rateLimit: false }, // the Redis per-key limiter below replaces the global in-memory one for this route
  }, async (req, reply) => {
    const auth = req.headers.authorization;
    const rawKey = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : null;
    if (!rawKey) {
      throw new HttpError(401, 'Missing or malformed Authorization header', 'missing_key');
    }

    const keyHash = hashIntakeKey(rawKey);
    const keyRow = await withPlatform((q) =>
      q.one<IntakeKeyRow>(`SELECT id, org_id, revoked_at FROM operate_intake_keys WHERE key_hash = $1`, [keyHash]),
    );
    // Same response for "no such key" and "revoked" — distinguishable in
    // our own logs (by key_prefix, never the raw key), never to the caller.
    if (!keyRow || keyRow.revoked_at) {
      throw new HttpError(401, 'Invalid or revoked key', 'invalid_key');
    }

    const allowed = await checkRateLimit(`intake:${keyRow.id}`, 60, 60);
    if (!allowed) {
      throw new HttpError(429, 'Rate limit exceeded — 60 requests per minute per key', 'rate_limited');
    }

    const body = intakeInput.parse(req.body);
    const orgId = keyRow.org_id;

    const result = await withTenant({ orgId, userId: null, isStaff: false }, async (q) => {
      await q.exec(`UPDATE operate_intake_keys SET last_used_at = now() WHERE id = $1`, [keyRow.id]);

      const existing = await q.one<{ party_id: string; deal_id: string | null }>(
        `SELECT party_id, deal_id FROM operate_intake_log WHERE org_id = $1 AND reference = $2`,
        [orgId, body.reference],
      );
      if (existing) {
        return { partyId: existing.party_id, dealId: existing.deal_id, created: false };
      }

      const party = await findOrCreateParty(q, body.email, body.name);

      if (body.phone) {
        await q.exec(
          `INSERT INTO party_contacts (org_id, party_id, channel, value, is_primary)
           VALUES (app.current_org(), $1, 'phone', $2, false)
           ON CONFLICT (org_id, party_id, channel, value) DO NOTHING`,
          [party.id, body.phone],
        );
      }

      // Explicit top-level fields always win: strip anything in `details`
      // that collides with a first-class field name before merging, so a
      // stray details.email can never contradict the real party_contacts
      // row created above. Merged (not overwritten) onto any existing
      // custom data — an intake hit on an already-known party must not
      // erase whatever's already there.
      const cleanDetails = { ...(body.details ?? {}) };
      for (const key of RESERVED_DETAIL_KEYS) delete cleanDetails[key];
      await q.exec(
        `UPDATE parties SET custom = custom || $2::jsonb, is_lead = true, last_activity_at = now() WHERE id = $1`,
        [party.id, JSON.stringify(cleanDetails)],
      );

      const pipeline = await getOrCreateDefaultPipeline(q);
      const stageKeys = new Set(pipeline.stages.map((s) => s.key));
      if (body.stage && !stageKeys.has(body.stage)) {
        throw new HttpError(400, `Unknown stage "${body.stage}" for this org's pipeline`, 'unknown_stage');
      }
      const stage = body.stage ?? pipeline.stages[0]?.key ?? 'new';

      const deal = await q.one<{ id: string }>(
        `INSERT INTO deals (org_id, pipeline_id, party_id, title, stage, status)
         VALUES (app.current_org(), $1, $2, $3, $4, 'open')
         RETURNING id`,
        [pipeline.id, party.id, `${body.name} — website intake`, stage],
      );

      await logTimeline(q, {
        orgId, partyId: party.id, eventType: 'intake.received', module: 'operate',
        title: `New lead via website intake (ref ${body.reference})`,
        actorType: 'system', entityType: 'deal', entityId: deal!.id,
        payload: { reference: body.reference, stage },
      });

      try {
        await q.exec(
          `INSERT INTO operate_intake_log (org_id, reference, party_id, deal_id)
           VALUES ($1, $2, $3, $4) ON CONFLICT (org_id, reference) DO NOTHING`,
          [orgId, body.reference, party.id, deal!.id],
        );
      } catch {
        // Belt-and-suspenders only — the SELECT above already covers the
        // normal retry path; this catch just keeps a true race from
        // surfacing as a 500 to a lead's own website.
      }

      return { partyId: party.id, dealId: deal!.id, created: true };
    });

    reply.status(result.created ? 201 : 200);
    return { ok: true, party_id: result.partyId, deal_id: result.dealId };
  });
}
