/**
 * Venturelyx :: Grow enrollment.
 *
 * Nothing in the standalone engine or this app ever wrote a grow_enrollments
 * row — 009_grow.sql's own comment says gated_on_contact_id is "set when the
 * enrollment is created," but no code anywhere (the standalone's seed.js
 * included) actually sets it. This is that missing step: given a campaign,
 * enroll every org contact not already enrolled in it and not suppressed.
 *
 * Gating rule (rank-2 waits for rank-1 at the same school): for each
 * entity_external_id, the contact with the lowest contact_rank being
 * enrolled here is the "gate root." Every other contact at that entity gets
 * gated_on_contact_id = the root's id; the root itself, and any contact at
 * an entity with no lower-ranked counterpart, is enrolled ungated. A tie at
 * the lowest rank (two contact_rank=1 contacts at one school) gates
 * neither against the other — only a strictly higher rank number waits.
 * Contacts with no entity_external_id (no school affiliation on the import)
 * are never gated; there's nothing to pair them against.
 */
import type { Querier } from './db.js';

export interface EnrollResult {
  enrolled: number;
  alreadyEnrolled: number;
  suppressed: number;
  totalContacts: number;
}

interface Candidate {
  id: string;
  contact_rank: number;
  entity_external_id: string | null;
  email: string;
}

export async function enrollAllContacts(q: Querier, campaignId: string): Promise<EnrollResult> {
  const totalRow = await q.one<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM grow_contacts`,
  );
  const alreadyRow = await q.one<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM grow_enrollments WHERE campaign_id = $1`,
    [campaignId],
  );

  const candidates = await q.rows<Candidate>(
    `SELECT c.id, c.contact_rank, c.entity_external_id, c.email
       FROM grow_contacts c
      WHERE NOT EXISTS (
              SELECT 1 FROM grow_enrollments e
               WHERE e.campaign_id = $1 AND e.contact_id = c.id)
        AND NOT EXISTS (
              SELECT 1 FROM grow_suppressions s WHERE s.email = c.email)`,
    [campaignId],
  );

  const suppressedRow = await q.one<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM grow_contacts c
      WHERE NOT EXISTS (SELECT 1 FROM grow_enrollments e WHERE e.campaign_id = $1 AND e.contact_id = c.id)
        AND EXISTS (SELECT 1 FROM grow_suppressions s WHERE s.email = c.email)`,
    [campaignId],
  );

  // Lowest-rank ("gate root") contact per entity, among just the contacts
  // being enrolled right now — tie-broken by email for determinism.
  const rootByEntity = new Map<string, { id: string; contact_rank: number; email: string }>();
  for (const c of candidates) {
    if (!c.entity_external_id) continue;
    const cur = rootByEntity.get(c.entity_external_id);
    if (!cur || c.contact_rank < cur.contact_rank
        || (c.contact_rank === cur.contact_rank && c.email < cur.email)) {
      rootByEntity.set(c.entity_external_id, { id: c.id, contact_rank: c.contact_rank, email: c.email });
    }
  }

  let enrolled = 0;
  for (const c of candidates) {
    const root = c.entity_external_id ? rootByEntity.get(c.entity_external_id) : undefined;
    const gatedOn = root && c.contact_rank > root.contact_rank ? root.id : null;

    await q.exec(
      `INSERT INTO grow_enrollments (org_id, campaign_id, contact_id, gated_on_contact_id, priority)
       VALUES (app.current_org(), $1, $2, $3, $4)
       ON CONFLICT (campaign_id, contact_id) DO NOTHING`,
      [campaignId, c.id, gatedOn, c.contact_rank],
    );
    enrolled += 1;
  }

  return {
    enrolled,
    alreadyEnrolled: Number(alreadyRow?.n ?? 0),
    suppressed: Number(suppressedRow?.n ?? 0),
    totalContacts: Number(totalRow?.n ?? 0),
  };
}
