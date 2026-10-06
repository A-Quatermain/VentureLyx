/**
 * Venturelyx :: Grow -> Operate CRM bridge.
 *
 * grow_contacts is the campaign roster — it stays exactly that. The moment
 * a contact replies (a real reply, classified by growPoller.ts) or
 * unsubscribes, this module is what turns that into a worked-relationship
 * record: a parties row (found by email, or created), an attribution_touches
 * row recording the campaign as the source, a timeline_events entry, and —
 * for a reply — an open deal in the default pipeline, arriving in the
 * "working" stage per spec. grow_contacts.party_id is then linked back, so
 * a single person is one party even across several campaigns.
 */
import type { Querier } from './db.js';
import { logTimeline } from './timeline.js';

export type ReplyTag = 'interested' | 'not_now' | 'not_a_fit' | 'question';

export interface PipelineStage {
  key: string;
  label: string;
  probability: number;
  is_won: boolean;
  is_lost: boolean;
}

// new -> working -> qualified -> won/lost, per spec. A pipeline's stage list
// is config (pipelines.stages), not a hardcoded enum, so an org can rename
// or reorder these later without a migration — this is only the seed for an
// org that has never had one.
const DEFAULT_STAGES: PipelineStage[] = [
  { key: 'new', label: 'New', probability: 10, is_won: false, is_lost: false },
  { key: 'working', label: 'Working', probability: 25, is_won: false, is_lost: false },
  { key: 'qualified', label: 'Qualified', probability: 50, is_won: false, is_lost: false },
  { key: 'won', label: 'Won', probability: 100, is_won: true, is_lost: false },
  { key: 'lost', label: 'Lost', probability: 0, is_won: false, is_lost: true },
];

export async function getOrCreateDefaultPipeline(
  q: Querier,
): Promise<{ id: string; stages: PipelineStage[] }> {
  const existing = await q.one<{ id: string; stages: PipelineStage[] }>(
    `SELECT id, stages FROM pipelines WHERE org_id = app.current_org() AND is_default LIMIT 1`,
  );
  if (existing) return existing;

  const created = await q.one<{ id: string; stages: PipelineStage[] }>(
    `INSERT INTO pipelines (org_id, name, stages, is_default)
     VALUES (app.current_org(), 'Sales Pipeline', $1::jsonb, true)
     RETURNING id, stages`,
    [JSON.stringify(DEFAULT_STAGES)],
  );
  return created!;
}

interface PartyRow {
  id: string;
  display_name: string;
  lifecycle: string;
}

/** Dedupe seam for the whole bridge: one person is one party no matter how
 *  many campaigns (or a website form, or manual entry) they came in through,
 *  matched on email via party_contacts, never on name (too ambiguous). */
export async function findOrCreateParty(
  q: Querier, email: string, nameHint: string | null,
): Promise<PartyRow> {
  const existing = await q.one<PartyRow>(
    `SELECT p.id, p.display_name, p.lifecycle
       FROM party_contacts pc JOIN parties p ON p.id = pc.party_id
      WHERE pc.org_id = app.current_org() AND pc.channel = 'email' AND pc.value = $1
        AND p.deleted_at IS NULL
      LIMIT 1`,
    [email],
  );
  if (existing) return existing;

  const created = await q.one<PartyRow>(
    `INSERT INTO parties (org_id, kind, display_name, is_lead, lifecycle)
     VALUES (app.current_org(), 'person', $1, false, 'new')
     RETURNING id, display_name, lifecycle`,
    [nameHint && nameHint.trim() ? nameHint.trim() : email],
  );
  await q.exec(
    `INSERT INTO party_contacts (org_id, party_id, channel, value, is_primary)
     VALUES (app.current_org(), $1, 'email', $2, true)
     ON CONFLICT DO NOTHING`,
    [created!.id, email],
  );
  return created!;
}

async function ensureOpenDeal(
  q: Querier, orgId: string, partyId: string, touchId: string | null, title: string,
): Promise<string> {
  const existing = await q.one<{ id: string }>(
    `SELECT id FROM deals WHERE party_id = $1 AND status = 'open' ORDER BY created_at LIMIT 1`,
    [partyId],
  );
  if (existing) return existing.id;

  const pipeline = await getOrCreateDefaultPipeline(q);
  const created = await q.one<{ id: string }>(
    `INSERT INTO deals (org_id, pipeline_id, party_id, title, stage, status, source_touch_id)
     VALUES (app.current_org(), $1, $2, $3, 'working', 'open', $4)
     RETURNING id`,
    [pipeline.id, partyId, title, touchId],
  );
  // A fresh deal's own creation is itself timeline-worthy — the pipeline
  // board's "days in stage" and the party's timeline both want this moment.
  await logTimeline(q, {
    orgId, partyId, eventType: 'deal.created', module: 'operate',
    title: `Entered pipeline: ${title}`, actorType: 'system',
    entityType: 'deal', entityId: created!.id,
  });
  return created!.id;
}

// A lead already working, qualified, or already a customer should never be
// silently knocked back to "working" by a later reply — only a party that
// hasn't been worked yet (or had gone cold/dormant) jumps there.
const ADVANCES_ON_REPLY = new Set(['new', 'lost', 'dormant']);

export async function promoteOnReply(q: Querier, input: {
  orgId: string;
  email: string;
  nameHint: string | null;
  campaignId: string;
  campaignName: string;
  stepNo: number;
  replyText: string;
  tag: ReplyTag | null;
}): Promise<{ partyId: string; dealId: string }> {
  const party = await findOrCreateParty(q, input.email, input.nameHint);

  const touch = await q.one<{ id: string }>(
    `INSERT INTO attribution_touches (org_id, party_id, source, medium, campaign, channel)
     VALUES (app.current_org(), $1, 'grow', 'email', $2, 'email')
     RETURNING id`,
    [party.id, input.campaignName],
  );
  const touchId = touch!.id;

  const advance = ADVANCES_ON_REPLY.has(party.lifecycle);
  await q.exec(
    `UPDATE parties SET
        is_lead = true,
        lifecycle = CASE WHEN $2 THEN 'working' ELSE lifecycle END,
        last_touch_id = $3,
        first_touch_id = COALESCE(first_touch_id, $3),
        reply_tag = COALESCE($4, reply_tag),
        reply_tag_source = CASE WHEN $4 IS NOT NULL THEN 'ai' ELSE reply_tag_source END,
        last_activity_at = now()
      WHERE id = $1`,
    [party.id, advance, touchId, input.tag],
  );

  await logTimeline(q, {
    orgId: input.orgId, partyId: party.id, eventType: 'grow.reply', module: 'grow',
    title: `Replied to "${input.campaignName}" (step ${input.stepNo})`,
    body: input.replyText, actorType: 'customer', direction: 'inbound',
    entityType: 'grow_campaign', entityId: input.campaignId,
    payload: { campaign_id: input.campaignId, step_no: input.stepNo, tag: input.tag, tag_source: input.tag ? 'ai' : null },
  });

  const dealId = await ensureOpenDeal(q, input.orgId, party.id, touchId, `${party.display_name} — inbound reply`);
  return { partyId: party.id, dealId };
}

/** Finds, not creates — no reply, no engagement signal worth the "updates
 *  the party too" promise; an inbox-wide unsubscribe from someone who was
 *  never promoted has no party to update yet, which is fine: grow_suppressions
 *  (growUnsubscribe.ts) already stops them being mailed either way. */
export async function promoteOnUnsubscribe(q: Querier, input: {
  orgId: string;
  email: string;
}): Promise<void> {
  const party = await q.one<{ id: string }>(
    `SELECT p.id FROM party_contacts pc JOIN parties p ON p.id = pc.party_id
      WHERE pc.org_id = app.current_org() AND pc.channel = 'email' AND pc.value = $1
        AND p.deleted_at IS NULL
      LIMIT 1`,
    [input.email],
  );
  if (!party) return;

  await q.exec(
    `UPDATE party_contacts SET opted_out_at = now()
      WHERE party_id = $1 AND channel = 'email' AND value = $2 AND opted_out_at IS NULL`,
    [party.id, input.email],
  );
  await logTimeline(q, {
    orgId: input.orgId, partyId: party.id, eventType: 'grow.unsubscribe', module: 'grow',
    title: 'Unsubscribed from email outreach', actorType: 'customer', direction: 'inbound',
  });
}
