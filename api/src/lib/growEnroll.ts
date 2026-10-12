/**
 * Venturelyx :: Grow enrollment.
 *
 * Nothing in the standalone engine or this app ever wrote a grow_enrollments
 * row — 009_grow.sql's own comment says gated_on_contact_id is "set when the
 * enrollment is created," but no code anywhere (the standalone's seed.js
 * included) actually sets it. This is that missing step: given a campaign,
 * enroll every eligible contact not already enrolled in it and not
 * suppressed — either every org contact (POST /grow/campaigns/:id/enroll,
 * the bulk one-shot action) or a specific batch (the contacts import
 * commit, `contactIds` restricted to just the rows that upload produced).
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
 *
 * Cross-campaign exclusivity: a contact already actively enrolled in a
 * DIFFERENT campaign that is itself running never gets a second,
 * simultaneous active enrollment here — skippedActiveElsewhere reports how
 * many were held back for exactly that reason, so a caller (the import
 * summary) can show it rather than silently dropping those contacts.
 * "Actively enrolled" is deliberately both halves: the enrollment's own
 * state = 'active' AND the other campaign's status = 'running' — a
 * completed/bounced/unsubscribed enrollment, or one sitting in a
 * draft/paused/stopped/done campaign, never blocks a new one.
 */
import type { Querier } from './db.js';

export interface EnrollOptions {
  /** Restrict to these contacts only (the import batch that just landed).
   *  Omitted = every org contact, the bulk one-shot action's own behavior. */
  contactIds?: string[];
  /** Tagged onto every enrollment row this call creates, so staff can see
   *  which upload a contact's enrollment came from (grow_enrollments.import_batch,
   *  db/migrations/027). Null/omitted for the bulk action, which isn't
   *  tied to any one upload. */
  importBatch?: string | null;
}

export interface EnrollResult {
  enrolled: number;
  alreadyEnrolled: number;
  suppressed: number;
  skippedActiveElsewhere: number;
  totalContacts: number;
}

interface Candidate {
  id: string;
  contact_rank: number;
  entity_external_id: string | null;
  email: string;
}

export async function enrollContacts(
  q: Querier, campaignId: string, options: EnrollOptions = {},
): Promise<EnrollResult> {
  const contactIds = options.contactIds ?? null;
  const importBatch = options.importBatch ?? null;

  // $1 only, deliberately — campaignId plays no part in "how many
  // contacts total," and binding it anyway while never referencing it in
  // the SQL makes Postgres unable to infer that parameter's type at all
  // ("could not determine data type of parameter $1", caught live).
  const totalRow = await q.one<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM grow_contacts c WHERE ($1::uuid[] IS NULL OR c.id = ANY($1))`,
    [contactIds],
  );
  const alreadyRow = await q.one<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM grow_enrollments e
       JOIN grow_contacts c ON c.id = e.contact_id
      WHERE e.campaign_id = $1 AND ($2::uuid[] IS NULL OR c.id = ANY($2))`,
    [campaignId, contactIds],
  );
  const suppressedRow = await q.one<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM grow_contacts c
      WHERE ($2::uuid[] IS NULL OR c.id = ANY($2))
        AND NOT EXISTS (SELECT 1 FROM grow_enrollments e WHERE e.campaign_id = $1 AND e.contact_id = c.id)
        AND EXISTS (SELECT 1 FROM grow_suppressions s WHERE s.email = c.email)`,
    [campaignId, contactIds],
  );
  const skippedActiveElsewhereRow = await q.one<{ n: string | number }>(
    `SELECT COUNT(*) AS n FROM grow_contacts c
      WHERE ($2::uuid[] IS NULL OR c.id = ANY($2))
        AND NOT EXISTS (SELECT 1 FROM grow_enrollments e WHERE e.campaign_id = $1 AND e.contact_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM grow_suppressions s WHERE s.email = c.email)
        AND EXISTS (
              SELECT 1 FROM grow_enrollments e2
                JOIN grow_campaigns cp2 ON cp2.id = e2.campaign_id
               WHERE e2.contact_id = c.id AND e2.campaign_id <> $1
                 AND e2.state = 'active' AND cp2.status = 'running'
            )`,
    [campaignId, contactIds],
  );

  const candidates = await q.rows<Candidate>(
    `SELECT c.id, c.contact_rank, c.entity_external_id, c.email
       FROM grow_contacts c
      WHERE ($2::uuid[] IS NULL OR c.id = ANY($2))
        AND NOT EXISTS (
              SELECT 1 FROM grow_enrollments e
               WHERE e.campaign_id = $1 AND e.contact_id = c.id)
        AND NOT EXISTS (
              SELECT 1 FROM grow_suppressions s WHERE s.email = c.email)
        AND NOT EXISTS (
              SELECT 1 FROM grow_enrollments e2
                JOIN grow_campaigns cp2 ON cp2.id = e2.campaign_id
               WHERE e2.contact_id = c.id AND e2.campaign_id <> $1
                 AND e2.state = 'active' AND cp2.status = 'running')`,
    [campaignId, contactIds],
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
      `INSERT INTO grow_enrollments (org_id, campaign_id, contact_id, gated_on_contact_id, priority, import_batch)
       VALUES (app.current_org(), $1, $2, $3, $4, $5)
       ON CONFLICT (campaign_id, contact_id) DO NOTHING`,
      [campaignId, c.id, gatedOn, c.contact_rank, importBatch],
    );
    enrolled += 1;
  }

  return {
    enrolled,
    alreadyEnrolled: Number(alreadyRow?.n ?? 0),
    suppressed: Number(suppressedRow?.n ?? 0),
    skippedActiveElsewhere: Number(skippedActiveElsewhereRow?.n ?? 0),
    totalContacts: Number(totalRow?.n ?? 0),
  };
}
