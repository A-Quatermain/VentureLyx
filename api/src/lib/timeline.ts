/**
 * Venturelyx :: shared timeline_events writer.
 *
 * Pulled out of routes/operate.ts so growPromote.ts (no HTTP request, no
 * req.ctx) can log the same way a real Operate action does — a Grow reply
 * landing on a party's timeline must look and behave identically to
 * anything a human did in Operate, not like a second, parallel event log.
 */
import type { Querier } from './db.js';

export async function logTimeline(
  q: Querier,
  entry: {
    orgId: string | null; partyId?: string | null; eventType: string; title: string;
    body?: string | null; actorType?: 'user' | 'system' | 'ai_persona' | 'customer';
    actorUserId?: string | null; actorLabel?: string | null;
    module?: string; entityType?: string | null; entityId?: string | null;
    direction?: 'inbound' | 'outbound' | null; payload?: unknown;
  },
): Promise<void> {
  await q.exec(
    `INSERT INTO timeline_events
       (org_id, party_id, event_type, module, title, body, actor_type, actor_user_id,
        actor_label, entity_type, entity_id, direction, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      entry.orgId, entry.partyId ?? null, entry.eventType, entry.module ?? 'operate',
      entry.title, entry.body ?? null, entry.actorType ?? 'user', entry.actorUserId ?? null,
      entry.actorLabel ?? null, entry.entityType ?? null, entry.entityId ?? null,
      entry.direction ?? null, entry.payload ? JSON.stringify(entry.payload) : '{}',
    ],
  );
}
