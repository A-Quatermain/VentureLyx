/**
 * Venturelyx :: Grow (email outreach).
 *
 * Read and preview surface only. The scheduler/worker that actually queues
 * and sends messages is not built here — grow_messages.status stays
 * whatever the standalone CampusPath engine's logic would have left it as
 * (nothing writes to it from this file). Same role grades as the rest of
 * the app: reading is viewer, creating/editing is staff.
 *
 * Preview rendering ports scheduler.js's render() and sender.js's
 * renderUnsubscribeFooter()/hasUnrenderedPlaceholder() from the standalone
 * engine (/opt/outreach/src) unchanged — see ../lib/growTemplate.ts — so
 * what a contact's preview shows is exactly what the real sender would
 * produce, refusal banner included.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/auth.js';
import {
  CAP_MESSAGE, logAiUsage, resolveAIContext, staticEvents, streamAI, streamEventsToSSE,
} from '../lib/ai.js';
import { INSERT_COLUMNS, processRecords, summarize } from '../lib/growContactImport.js';
import {
  applyMapping, guessMapping, mappingMatchesHeaders, type MappingConfig,
} from '../lib/growContactImportMapping.js';
import { ingestFile } from '../lib/growContactImportXlsx.js';
import {
  firstUnrenderedPlaceholder, hasUnrenderedPlaceholder, render, renderUnsubscribeFooter,
  type RenderableContact,
} from '../lib/growTemplate.js';
import { HttpError } from '../plugins/context.js';

// Mirrors sender.js's BASE_URL/MAILING_ADDRESS (/opt/outreach/src) so a
// preview's unsubscribe link/footer look exactly like a real send's. Kept
// as their own env vars rather than reusing APP_BASE_URL (the frontend
// origin used elsewhere in this API) since Grow's own /u/:token route
// doesn't exist yet — the worker and sending path are out of scope here.
const GROW_BASE_URL = process.env.GROW_BASE_URL || 'http://localhost:8080';
const GROW_MAILING_ADDRESS = process.env.GROW_MAILING_ADDRESS || '';

// Same circuit-breaker thresholds as scheduler.js's circuitBreaker()
// (/opt/outreach/src) — the worker isn't built here, but the dashboard
// needs the same numbers the (future) worker will pause campaigns at, so
// they're returned by /grow/stats rather than duplicated as a second,
// driftable copy in the frontend.
const BOUNCE_PAUSE_RATE = 0.03;
const COMPLAINT_PAUSE_RATE = 0.003;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const timeField = () => z.string().regex(TIME_RE, 'Use HH:MM (24-hour)');

const CAMPAIGN_FIELDS = `id, name, status, timezone, window_start, window_end,
  weekdays_only, daily_target, pause_reason, created_at, updated_at`;

const STEP_FIELDS = `id, campaign_id, step_no, delay_days, applies_to_rank,
  subject_tmpl, body_tmpl, created_at, updated_at`;

const MESSAGE_FIELDS = `id, campaign_id, contact_id, mailbox_id, step_no,
  recipient_domain, subject, status, scheduled_at, sent_at, attempts, error`;

const campaignInput = z.object({
  name: z.string().trim().min(1).max(200),
  timezone: z.string().trim().min(1).default('America/New_York'),
  window_start: timeField().default('08:30'),
  window_end: timeField().default('15:30'),
  weekdays_only: z.boolean().default(true),
  daily_target: z.number().int().min(1).default(100),
});

const campaignPatch = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  status: z.enum(['draft', 'running', 'paused', 'stopped', 'done']).optional(),
  timezone: z.string().trim().min(1).optional(),
  window_start: timeField().optional(),
  window_end: timeField().optional(),
  weekdays_only: z.boolean().optional(),
  daily_target: z.number().int().min(1).optional(),
  pause_reason: z.string().nullable().optional(),
});

const stepInput = z.object({
  step_no: z.number().int().min(1),
  delay_days: z.number().int().min(0).default(0),
  applies_to_rank: z.number().int().nullable().default(null),
  subject_tmpl: z.string().min(1),
  body_tmpl: z.string().min(1),
});

const stepsPatch = z.object({ steps: z.array(stepInput).min(1) });

// ---- AI sequence authoring ----------------------------------------------------
//
// Two different shapes on purpose. Generation produces structured data (a
// set of steps) that only matters once it's complete — there's no useful
// partial state to show mid-stream — so it reuses streamAI() internally
// (same provider fallback, BYO keys, spend cap, usage logging as every
// other AI feature) but buffers the full completion server-side and
// returns one JSON response. The inline assist endpoint rewrites a short
// selection a person is actively looking at, where watching it type is the
// point, so that one stays a real SSE stream via streamEventsToSSE —
// exactly the pattern routes/ai.ts already uses, AIStreamPanel and all.
//
// Every merge field the model is allowed to use, and the one reserved
// token it must never invent, remove, or alter. Matches growTemplate.ts's
// render() — first_name/contact_name/entity_name/role/region/city/
// enrollment are the grow_contacts columns worth addressing someone by;
// unsubscribe_footer is resolved later, at send time, by sender-side logic
// this file doesn't touch.
const MERGE_FIELDS = ['first_name', 'contact_name', 'entity_name', 'role', 'region', 'city', 'enrollment'] as const;
const UNSUBSCRIBE_TOKEN = '{{unsubscribe_footer}}';
const VALID_TOKEN_NAMES = new Set<string>([...MERGE_FIELDS, 'unsubscribe_footer']);

function countOccurrences(text: string, token: string): number {
  return text.split(token).length - 1;
}

/** Throws if `text` uses a {{...}} token outside the allowed set — the
 *  model was told the exact list in the prompt; this is the check that
 *  doesn't just trust it followed instructions. */
function assertValidMergeTokens(text: string): void {
  for (const match of text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
    if (!VALID_TOKEN_NAMES.has(match[1]!)) {
      throw new HttpError(502, `The AI used an unsupported merge field {{${match[1]}}} — try generating again`, 'ai_invalid_output');
    }
  }
}

function stripJsonFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return fenced ? fenced[1]! : trimmed;
}

interface SequenceSkeletonStep {
  step_no: number;
  delay_days: number;
  applies_to_rank: number | null;
  rankLabel: string | null;
  angle: string;
}

// Fixed intro / follow-up / break-up cadence — the same shape the
// CampusPath seed (db/seeds/seed_sequence_campuspath.sql) used by hand.
// Mechanical fields (step_no, delay_days, applies_to_rank) are computed
// here, never left to the model — it only ever fills in subject/body text
// for a slot this code already defined, so there's nothing structural for
// it to get wrong.
const SEQUENCE_ANGLES = [
  { delay_days: 0, angle: 'An opening intro email: who you are and the one clear reason this is worth 30 seconds of their time.' },
  { delay_days: 5, angle: 'A brief follow-up: one new, concrete angle not used in step 1. Shorter than step 1.' },
  { delay_days: 7, angle: 'A final, polite close-out: say you will stop reaching out here, leave the door open.' },
];

function buildSequenceSkeleton(rankGroups: Array<{ rank: number | null; role: string | null }>): SequenceSkeletonStep[] {
  const groups = rankGroups.length > 0 ? rankGroups : [{ rank: null, role: null }];
  return groups.flatMap((g) =>
    SEQUENCE_ANGLES.map((a, i) => ({
      step_no: i + 1,
      delay_days: a.delay_days,
      applies_to_rank: g.rank,
      rankLabel: g.role,
      angle: a.angle,
    })),
  );
}

function buildSequenceGenerationPrompt(
  org: { name: string; vertical: string | null } | null,
  catalogItems: Array<{ name: string; description: string | null }>,
  locations: Array<{ name: string; region: string | null }>,
  skeleton: SequenceSkeletonStep[],
): { system: string; user: string } {
  const system = [
    `You are drafting a cold-outreach email sequence for ${org?.name ?? 'this business'}` +
      `${org?.vertical ? `, a ${org.vertical} business` : ''}.`,
    'GROUNDING RULES — follow exactly, no exceptions:',
    '- Use ONLY the facts given below (what this business sells, where it operates, who is being contacted). ' +
      'Never invent customer names, testimonials, statistics, years in business, awards, or capabilities not listed below.',
    '- If "What this business sells" says nothing is listed, write generically about wanting to start a ' +
      'conversation — do not invent a product or service to describe.',
    `- Every merge field must be written exactly as {{field}} and be one of: ${MERGE_FIELDS.map((f) => `{{${f}}}`).join(', ')}. ` +
      'Never invent a merge field name, and never use one not in this list.',
    `- End every email body with the literal token ${UNSUBSCRIBE_TOKEN} on its own line, exactly once, unchanged.`,
    '- Each email: 80-150 words, plain text, no markdown, no "Subject:" label inside the body.',
    'Respond with ONLY valid JSON — no markdown fences, no commentary — matching exactly this shape:',
    '{"emails":[{"subject":"...","body":"..."}, ...]}',
    `The array must have exactly ${skeleton.length} entries, in the exact order listed below.`,
  ].join('\n');

  const sell = catalogItems.length > 0
    ? catalogItems.map((c) => `- ${c.name}${c.description ? `: ${c.description}` : ''}`).join('\n')
    : '(nothing listed — do not invent what this business sells)';
  const where = locations.length > 0
    ? [...new Set(locations.map((l) => (l.region ? `${l.name}, ${l.region}` : l.name)))].join('; ')
    : '(nothing listed — do not invent where this business operates)';
  const steps = skeleton
    .map((s, i) => `${i + 1}. Step ${s.step_no}${s.rankLabel ? ` for contacts with role "${s.rankLabel}"` : ''} — ${s.angle}`)
    .join('\n');

  const user = [
    `What this business sells:\n${sell}`,
    `Where it operates:\n${where}`,
    `Write these ${skeleton.length} email(s), in order:\n${steps}`,
  ].join('\n\n');

  return { system, user };
}

const ASSIST_INSTRUCTIONS = ['rewrite', 'shorten', 'tone', 'direct'] as const;
type AssistInstruction = (typeof ASSIST_INSTRUCTIONS)[number];

const ASSIST_INSTRUCTION_TEXT: Record<AssistInstruction, string> = {
  rewrite: 'Rewrite this text so it reads better, keeping the same meaning and roughly the same length.',
  shorten: 'Shorten this text as much as you can while keeping its core meaning — cut words, do not just truncate it.',
  tone: 'Rewrite this text in a warmer, friendlier tone, without becoming informal or losing professionalism.',
  direct: 'Rewrite this text to be more direct and to the point — cut hedging and filler, get to the ask faster.',
};

function buildAssistPrompt(org: { name: string; vertical: string | null } | null, instruction: AssistInstruction): string {
  return [
    `You are editing one short snippet of a cold-outreach email for ${org?.name ?? 'this business'}` +
      `${org?.vertical ? `, a ${org.vertical} business` : ''}.`,
    ASSIST_INSTRUCTION_TEXT[instruction],
    'Respond with ONLY the rewritten text — no quotes, no preamble, no explanation.',
    'Never invent customers, metrics, testimonials, or capabilities not already implied by the text itself.',
    'If the text contains a {{merge_field}} token (double curly braces), keep every such token exactly as-is — never alter, translate, or remove it.',
    `Never add, remove, or alter ${UNSUBSCRIBE_TOKEN} — refuse to touch it if asked.`,
  ].join(' ');
}

const ENROLLMENT_STATES = ['active', 'replied', 'bounced', 'unsubscribed', 'completed', 'held', 'failed'] as const;

const contactListQuery = z.object({
  tier: z.string().trim().min(1).optional(),
  region: z.string().trim().min(1).optional(),
  contact_rank: z.coerce.number().int().optional(),
  enrollment_state: z.enum(ENROLLMENT_STATES).optional(),
  page: z.coerce.number().int().min(1).default(1),
});

const previewQuery = z.object({
  campaign_id: z.string().uuid().optional(),
});

const messageListQuery = z.object({
  status: z.enum(['queued', 'sending', 'sent', 'failed', 'bounced', 'cancelled']).optional(),
  campaign_id: z.string().uuid().optional(),
  page: z.coerce.number().int().min(1).default(1),
});

const slotMappingSchema = z.object({
  label: z.string(),
  rank: z.number().int().nullable(),
  fields: z.record(z.string().nullable()).default({}),
});

const mappingConfigSchema = z.object({
  format: z.enum(['long', 'wide']),
  shared: z.record(z.string().nullable()).default({}),
  slots: z.array(slotMappingSchema).min(1),
});

function parseMappingField(raw: string | undefined): MappingConfig {
  if (!raw) throw new HttpError(400, 'Missing "mapping" field', 'invalid_input');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Invalid mapping JSON', 'invalid_input');
  }
  return mappingConfigSchema.parse(json) as MappingConfig;
}

// A single file part plus any accompanying text fields (the mapping JSON) —
// @fastify/multipart interleaves both kinds of part in one request body.
async function readMultipartUpload(
  req: FastifyRequest,
): Promise<{ buffer: Buffer; filename: string; fields: Record<string, string> }> {
  const fields: Record<string, string> = {};
  let file: { buffer: Buffer; filename: string } | null = null;

  for await (const part of req.parts()) {
    if (part.type === 'file') {
      const buffer = await part.toBuffer();
      if (part.file.truncated) {
        throw new HttpError(400, 'File is too large (15MB limit)', 'file_too_large');
      }
      file = { buffer, filename: part.filename };
    } else {
      fields[part.fieldname] = String(part.value ?? '');
    }
  }

  if (!file) throw new HttpError(400, 'No file was uploaded', 'no_file');
  return { buffer: file.buffer, filename: file.filename, fields };
}

export default async function growRoutes(app: FastifyInstance) {

  // ---- Campaigns ------------------------------------------------------------

  app.get('/grow/campaigns', async (req) => {
    req.requireRole('viewer');
    return req.db((q) =>
      q.rows(`SELECT ${CAMPAIGN_FIELDS} FROM grow_campaigns ORDER BY created_at DESC LIMIT 200`),
    );
  });

  app.post('/grow/campaigns', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const body = campaignInput.parse(req.body);

    return req.db(async (q) => {
      const campaign = await q.one(
        `INSERT INTO grow_campaigns
           (org_id, name, timezone, window_start, window_end, weekdays_only, daily_target)
         VALUES (app.current_org(), $1,$2,$3,$4,$5,$6)
         RETURNING ${CAMPAIGN_FIELDS}`,
        [body.name, body.timezone, body.window_start, body.window_end,
         body.weekdays_only, body.daily_target],
      );
      const c = campaign as { id: string };
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'grow_campaigns.create',
        entityType: 'grow_campaigns', entityId: c.id, ip: req.ip,
      });
      return campaign;
    });
  });

  app.patch('/grow/campaigns/:id', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = campaignPatch.parse(req.body);

    if (Object.keys(body).length === 0) {
      throw new HttpError(400, 'Nothing to update', 'invalid_input');
    }

    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    for (const [key, value] of Object.entries(body)) {
      fields.push(`${key} = $${i}`);
      values.push(value);
      i += 1;
    }
    values.push(id);

    return req.db(async (q) => {
      const campaign = await q.one(
        `UPDATE grow_campaigns SET ${fields.join(', ')}
          WHERE id = $${i}
        RETURNING ${CAMPAIGN_FIELDS}`,
        values,
      );
      if (!campaign) throw new HttpError(404, 'Campaign not found', 'not_found');
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'grow_campaigns.update',
        entityType: 'grow_campaigns', entityId: id, ip: req.ip, diff: body,
      });
      return campaign;
    });
  });

  // ---- Sequence steps ---------------------------------------------------------

  app.get('/grow/campaigns/:id/steps', async (req) => {
    req.requireRole('viewer');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    return req.db(async (q) => {
      const campaign = await q.one(`SELECT id FROM grow_campaigns WHERE id = $1`, [id]);
      if (!campaign) throw new HttpError(404, 'Campaign not found', 'not_found');
      return q.rows(
        `SELECT ${STEP_FIELDS} FROM grow_sequence_steps
          WHERE campaign_id = $1
          ORDER BY step_no, applies_to_rank NULLS LAST`,
        [id],
      );
    });
  });

  // Replaces the campaign's entire step list. Simpler and safer than a
  // per-row upsert here: two different partial unique indexes back
  // (campaign_id, step_no, applies_to_rank) — one for ranked variants, one
  // for the catch-all — and a single INSERT can only declare one ON
  // CONFLICT arbiter, so there is no single statement that upserts both
  // kinds of row correctly. Delete-then-insert inside one transaction
  // (req.db wraps every call here in the same BEGIN/COMMIT) sidesteps that
  // without picking a side.
  app.patch('/grow/campaigns/:id/steps', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = stepsPatch.parse(req.body);

    const seen = new Set<string>();
    for (const s of body.steps) {
      const key = `${s.step_no}:${s.applies_to_rank ?? 'null'}`;
      if (seen.has(key)) {
        const rankNote = s.applies_to_rank !== null ? ` (rank ${s.applies_to_rank})` : ' (catch-all)';
        throw new HttpError(400, `Duplicate step ${s.step_no}${rankNote}`, 'invalid_input');
      }
      seen.add(key);
    }

    return req.db(async (q) => {
      const campaign = await q.one(`SELECT id FROM grow_campaigns WHERE id = $1`, [id]);
      if (!campaign) throw new HttpError(404, 'Campaign not found', 'not_found');

      await q.exec(`DELETE FROM grow_sequence_steps WHERE campaign_id = $1`, [id]);
      for (const s of body.steps) {
        await q.exec(
          `INSERT INTO grow_sequence_steps
             (org_id, campaign_id, step_no, delay_days, applies_to_rank, subject_tmpl, body_tmpl)
           VALUES (app.current_org(), $1,$2,$3,$4,$5,$6)`,
          [id, s.step_no, s.delay_days, s.applies_to_rank, s.subject_tmpl, s.body_tmpl],
        );
      }

      const steps = await q.rows(
        `SELECT ${STEP_FIELDS} FROM grow_sequence_steps
          WHERE campaign_id = $1
          ORDER BY step_no, applies_to_rank NULLS LAST`,
        [id],
      );
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'grow_sequence_steps.update',
        entityType: 'grow_campaigns', entityId: id, ip: req.ip, diff: body,
      });
      return steps;
    });
  });

  // Drafts a starting sequence grounded in this org's own profile — what it
  // sells (catalog_items), where it operates (locations), and who its
  // imported contacts actually are (grow_contacts.role, grouped by rank) —
  // rather than a generic template. Returns steps ready to drop into the
  // editor; nothing is saved until the owner hits the existing "Save
  // changes" on PATCH .../steps, same as a hand-written draft.
  app.post('/grow/campaigns/:id/sequence/generate', async (req) => {
    req.requireRole('staff');
    const orgId = req.ctx.orgId!;
    const feature = 'sequence_writing' as const;
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const { system, user, skeleton, ctx } = await req.db(async (q) => {
      const campaign = await q.one<{ id: string }>(`SELECT id FROM grow_campaigns WHERE id = $1`, [id]);
      if (!campaign) throw new HttpError(404, 'Campaign not found', 'not_found');

      const context = await resolveAIContext(q, orgId, feature);
      const org = await q.one<{ name: string; vertical: string | null }>(
        `SELECT name, vertical FROM organizations WHERE id = app.current_org()`,
      );
      const catalogItems = await q.rows<{ name: string; description: string | null }>(
        `SELECT name, description FROM catalog_items WHERE is_active = true ORDER BY priority LIMIT 20`,
      );
      const locations = await q.rows<{ name: string; region: string | null }>(
        `SELECT name, region FROM locations WHERE is_active = true ORDER BY is_primary DESC, name LIMIT 20`,
      );
      // Top two ranks actually present in this org's imported list, each
      // with its most common role label — "the contact's role" the AI
      // should address, not a guessed title. An org with no contacts yet
      // (or no role data) falls back to one rank-agnostic group.
      const rankGroups = await q.rows<{ contact_rank: number; role: string | null }>(
        `SELECT contact_rank, mode() WITHIN GROUP (ORDER BY role) AS role
           FROM grow_contacts
          WHERE role IS NOT NULL
          GROUP BY contact_rank
          ORDER BY contact_rank
          LIMIT 2`,
      );

      const skel = buildSequenceSkeleton(rankGroups.map((r) => ({ rank: r.contact_rank, role: r.role })));
      const prompt = buildSequenceGenerationPrompt(org, catalogItems, locations, skel);
      return { system: prompt.system, user: prompt.user, skeleton: skel, ctx: context };
    });

    if (ctx.capExceeded) {
      throw new HttpError(402, CAP_MESSAGE, 'spend_cap_exceeded');
    }

    let acc = '';
    const gen = streamAI({
      orgId, feature, system,
      messages: [{ role: 'user', content: user }],
      maxTokens: 3000,
      providerPreference: ctx.providerPreference,
      clients: ctx.clients,
      modelOverride: ctx.modelOverride,
      onUsage: (usage) => req.db((q) => logAiUsage(q, { orgId, feature, ...usage })),
    });
    for await (const event of gen) {
      if (event.type === 'delta') acc += event.text;
    }

    let parsed: { emails?: Array<{ subject?: string; body?: string }> };
    try {
      parsed = JSON.parse(stripJsonFences(acc));
    } catch {
      throw new HttpError(502, 'The AI response could not be read — try generating again', 'ai_invalid_output');
    }
    const emails = parsed.emails ?? [];
    if (emails.length !== skeleton.length) {
      throw new HttpError(502, "The AI response didn't match the expected shape — try generating again", 'ai_invalid_output');
    }

    const steps = skeleton.map((s, i) => {
      const subject = (emails[i]!.subject ?? '').trim();
      const body = (emails[i]!.body ?? '').trim();
      if (!subject || !body) {
        throw new HttpError(502, 'The AI response was missing a subject or body — try generating again', 'ai_invalid_output');
      }
      assertValidMergeTokens(subject);
      assertValidMergeTokens(body);
      if (countOccurrences(body, UNSUBSCRIBE_TOKEN) !== 1) {
        throw new HttpError(
          502,
          `Step ${s.step_no}'s draft is missing ${UNSUBSCRIBE_TOKEN} — try generating again`,
          'ai_invalid_output',
        );
      }
      return {
        step_no: s.step_no, delay_days: s.delay_days, applies_to_rank: s.applies_to_rank,
        subject_tmpl: subject, body_tmpl: body,
      };
    });

    return { steps };
  });

  // Rewrites one selected snippet from a step's subject or body — the live
  // "watch it type" case an SSE stream is actually for, unlike generation
  // above. Same grounding rules as generation, but this endpoint can only
  // state them in the prompt: an SSE stream has no complete text to
  // validate until it's already been shown to the user. The frontend
  // re-checks the merge-field/unsubscribe-token rules on the accumulated
  // result before "Apply" is allowed to splice it in.
  app.post('/grow/sequence/assist/stream', async (req, reply) => {
    req.requireRole('staff');
    const orgId = req.ctx.orgId!;
    const feature = 'sequence_writing' as const;
    const body = z.object({
      instruction: z.enum(ASSIST_INSTRUCTIONS),
      text: z.string().trim().min(1).max(2000),
      context: z.string().max(4000).optional(),
    }).parse(req.body);

    if (body.text.includes(UNSUBSCRIBE_TOKEN)) {
      throw new HttpError(400, "The unsubscribe footer can't be edited", 'invalid_input');
    }

    const { system, ctx } = await req.db(async (q) => {
      const context = await resolveAIContext(q, orgId, feature);
      const org = await q.one<{ name: string; vertical: string | null }>(
        `SELECT name, vertical FROM organizations WHERE id = app.current_org()`,
      );
      return { system: buildAssistPrompt(org, body.instruction), ctx: context };
    });

    if (ctx.capExceeded) {
      await streamEventsToSSE(reply, staticEvents(CAP_MESSAGE));
      return;
    }

    const userMsg = body.context
      ? `Full email for context (do not rewrite this part):\n"""\n${body.context}\n"""\n\n` +
        `Rewrite ONLY this selected portion:\n"""\n${body.text}\n"""`
      : `Rewrite:\n"""\n${body.text}\n"""`;

    const gen = streamAI({
      orgId, feature, system,
      messages: [{ role: 'user', content: userMsg }],
      maxTokens: 400,
      providerPreference: ctx.providerPreference,
      clients: ctx.clients,
      modelOverride: ctx.modelOverride,
      onUsage: (usage) => req.db((q) => logAiUsage(q, { orgId, feature, ...usage })),
    });

    await streamEventsToSSE(reply, gen);
  });

  // ---- Contacts ---------------------------------------------------------------

  app.get('/grow/contacts', async (req) => {
    req.requireRole('viewer');
    const { tier, region, contact_rank, enrollment_state, page } = contactListQuery.parse(req.query);
    const offset = (page - 1) * 50;

    return req.db((q) =>
      q.rows(
        `SELECT c.id, c.email, c.first_name, c.contact_name, c.role, c.contact_rank,
                c.entity_name, c.region, c.city, c.state, c.recipient_domain, c.tier,
                c.is_chain, c.domain_rank, c.source_profile, c.created_at,
                en.state AS latest_enrollment_state
           FROM grow_contacts c
           LEFT JOIN LATERAL (
             SELECT state FROM grow_enrollments e
              WHERE e.contact_id = c.id
              ORDER BY e.updated_at DESC LIMIT 1
           ) en ON true
          WHERE ($1::text IS NULL OR c.tier = $1)
            AND ($2::text IS NULL OR c.region = $2)
            AND ($3::int IS NULL OR c.contact_rank = $3)
            AND ($4::text IS NULL OR EXISTS (
                  SELECT 1 FROM grow_enrollments e2
                   WHERE e2.contact_id = c.id AND e2.state = $4))
          ORDER BY c.created_at DESC
          LIMIT 50 OFFSET $5`,
        [tier ?? null, region ?? null, contact_rank ?? null, enrollment_state ?? null, offset],
      ),
    );
  });

  // ---- Contacts import (CSV/XLSX upload) ---------------------------------------
  //
  // Three-step flow the mapping screen drives: inspect (headers + a
  // suggested mapping) -> preview (dry run against the finalized mapping,
  // no write) -> commit (inserts, and saves the mapping as this org's
  // reusable profile). Every accepted row still goes through
  // growContactImport.ts's toContact()/processRecords() completely
  // unchanged — the files in this section only turn an arbitrary upload
  // into the canonical record shape that function already expects, the
  // same as scripts/import-contacts.js's own known-shape CSV always was.

  app.post('/grow/contacts/import/inspect', async (req) => {
    req.requireRole('staff');
    const { buffer, filename } = await readMultipartUpload(req);
    const { headers, records, note } = ingestFile(buffer, filename);
    if (headers.length === 0) {
      throw new HttpError(400, 'No columns found in this file', 'empty_file');
    }

    return req.db(async (q) => {
      const saved = await q.one<{ format: 'long' | 'wide'; mapping: MappingConfig }>(
        `SELECT format, mapping FROM grow_import_profiles WHERE org_id = app.current_org()`,
      );
      const savedUsable = !!saved && mappingMatchesHeaders(saved.mapping, headers);
      return {
        headers,
        rowCount: records.length,
        sampleRows: records.slice(0, 5).map((r) => r.record),
        suggestedMapping: savedUsable ? saved!.mapping : guessMapping(headers),
        // hasSavedProfile: a profile exists for this org at all. usedSavedProfile:
        // that profile is what's actually behind suggestedMapping — false when a
        // saved profile exists but doesn't match this file's columns, so the UI
        // never claims "using your saved mapping" for a suggestion it isn't.
        hasSavedProfile: !!saved,
        usedSavedProfile: savedUsable,
        note,
      };
    });
  });

  app.post('/grow/contacts/import/preview', async (req) => {
    req.requireRole('staff');
    const { buffer, filename, fields } = await readMultipartUpload(req);
    const mapping = parseMappingField(fields.mapping);
    const { records, note } = ingestFile(buffer, filename);
    const expanded = applyMapping(records, mapping);
    const { accepted, rejections } = processRecords(expanded, req.ctx.orgId!);
    return { ...summarize({ totalRows: expanded.length, accepted, rejections }), note };
  });

  app.post('/grow/contacts/import/commit', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const { buffer, filename, fields } = await readMultipartUpload(req);
    const mapping = parseMappingField(fields.mapping);
    const { records } = ingestFile(buffer, filename);
    const expanded = applyMapping(records, mapping);

    return req.db(async (q) => {
      const { accepted, rejections } = processRecords(expanded, req.ctx.orgId!);
      const summary = summarize({ totalRows: expanded.length, accepted, rejections });

      let inserted = 0;
      const CHUNK = 200;
      for (let i = 0; i < accepted.length; i += CHUNK) {
        const chunk = accepted.slice(i, i + CHUNK);
        const values: unknown[] = [];
        const rowPlaceholders = chunk.map((contact, ri) => {
          const base = ri * INSERT_COLUMNS.length;
          const c = contact as unknown as Record<string, unknown>;
          INSERT_COLUMNS.forEach((col) => values.push(c[col]));
          return `(${INSERT_COLUMNS.map((_, ci) => `$${base + ci + 1}`).join(',')})`;
        }).join(',\n');
        inserted += await q.exec(
          `INSERT INTO grow_contacts (${INSERT_COLUMNS.join(',')})
           VALUES ${rowPlaceholders}
           ON CONFLICT (org_id, email) DO NOTHING`,
          values,
        );
      }

      // "A reusable profile per org" — upsert, not a growing library of
      // named profiles nobody asked for (see 010_grow_import_profiles.sql).
      await q.exec(
        `INSERT INTO grow_import_profiles (org_id, format, mapping)
         VALUES (app.current_org(), $1, $2)
         ON CONFLICT (org_id) DO UPDATE
           SET format = EXCLUDED.format, mapping = EXCLUDED.mapping`,
        [mapping.format, JSON.stringify(mapping)],
      );

      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'grow_contacts.import',
        entityType: 'grow_contacts', ip: req.ip,
        diff: {
          filename, format: mapping.format, inserted,
          accepted: accepted.length, rejected: rejections.length,
        },
      });

      return { ...summary, inserted, alreadyExisted: accepted.length - inserted };
    });
  });

  // Shows exactly what the (not-yet-built) worker would send for this
  // contact's next step: same render()/renderUnsubscribeFooter() as the
  // standalone engine, same refusal-on-unrendered-placeholder logic. The
  // unsubscribe token/URL are generated here for display only — no message
  // row is created, so this is never a real, working unsubscribe link.
  app.get('/grow/contacts/:id/preview', async (req) => {
    req.requireRole('viewer');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { campaign_id } = previewQuery.parse(req.query);

    return req.db(async (q) => {
      const contact = await q.one(`SELECT id FROM grow_contacts WHERE id = $1`, [id]);
      if (!contact) throw new HttpError(404, 'Contact not found', 'not_found');

      const enrolled = await q.one<{
        contact_id: string; email: string; first_name: string | null;
        contact_name: string | null; role: string | null; entity_name: string | null;
        recipient_domain: string; is_free_provider: boolean; contact_rank: number;
        attrs: Record<string, unknown>;
        enrollment_id: string; campaign_id: string; campaign_name: string;
        current_step: number;
      }>(
        `SELECT c.id AS contact_id, c.email, c.first_name, c.contact_name, c.role,
                c.entity_name, c.recipient_domain, c.is_free_provider, c.contact_rank, c.attrs,
                e.id AS enrollment_id, e.campaign_id, cp.name AS campaign_name, e.current_step
           FROM grow_contacts c
           JOIN grow_enrollments e ON e.contact_id = c.id
           JOIN grow_campaigns cp ON cp.id = e.campaign_id
          WHERE c.id = $1
            AND e.state = 'active'
            AND ($2::uuid IS NULL OR e.campaign_id = $2)
          ORDER BY e.next_eligible_at ASC
          LIMIT 1`,
        [id, campaign_id ?? null],
      );
      if (!enrolled) {
        throw new HttpError(404, 'This contact has no active enrollment to preview', 'no_active_enrollment');
      }

      // Same shape scheduler.js's dueEnrollments() passes into render(), and
      // the same matching rule planTick() uses to pick a step: an
      // exact-rank variant or a catch-all (applies_to_rank IS NULL) for
      // current_step + 1, whichever comes first in step_no order.
      const steps = await q.rows<{
        step_no: number; applies_to_rank: number | null;
        subject_tmpl: string; body_tmpl: string;
      }>(
        `SELECT step_no, applies_to_rank, subject_tmpl, body_tmpl
           FROM grow_sequence_steps
          WHERE campaign_id = $1
          ORDER BY step_no`,
        [enrolled.campaign_id],
      );
      const step = steps.find(
        (s) => s.step_no === enrolled.current_step + 1
          && (s.applies_to_rank === null || s.applies_to_rank === enrolled.contact_rank),
      );
      if (!step) {
        throw new HttpError(
          404,
          `No sequence step ${enrolled.current_step + 1} configured for rank ${enrolled.contact_rank}`,
          'no_matching_step',
        );
      }

      const contactForRender: RenderableContact = {
        email: enrolled.email,
        first_name: enrolled.first_name,
        contact_name: enrolled.contact_name,
        role: enrolled.role,
        entity_name: enrolled.entity_name,
        recipient_domain: enrolled.recipient_domain,
        is_free_provider: enrolled.is_free_provider,
        contact_rank: enrolled.contact_rank,
        attrs: enrolled.attrs,
      };

      const subject = render(step.subject_tmpl, contactForRender);
      const renderedBody = render(step.body_tmpl, contactForRender);

      const previewToken = randomBytes(18).toString('hex');
      const unsubscribeUrl = `${GROW_BASE_URL}/u/${previewToken}`;
      const body = renderUnsubscribeFooter(renderedBody, {
        mailingAddress: GROW_MAILING_ADDRESS,
        unsubscribeUrl,
      });

      const refused = hasUnrenderedPlaceholder(body);
      const refusalReason = refused
        ? `refused to send: unrendered placeholder ${firstUnrenderedPlaceholder(body)} in body`
        : null;

      return {
        contact_id: enrolled.contact_id,
        campaign_id: enrolled.campaign_id,
        campaign_name: enrolled.campaign_name,
        enrollment_id: enrolled.enrollment_id,
        step_no: step.step_no,
        to: enrolled.email,
        subject,
        body,
        unsubscribe_url: unsubscribeUrl,
        refused,
        refusal_reason: refusalReason,
      };
    });
  });

  // ---- Messages (queue view) ---------------------------------------------------

  app.get('/grow/messages', async (req) => {
    req.requireRole('viewer');
    const { status, campaign_id, page } = messageListQuery.parse(req.query);
    const offset = (page - 1) * 50;

    return req.db((q) =>
      q.rows(
        `SELECT ${MESSAGE_FIELDS}
           FROM grow_messages
          WHERE ($1::text IS NULL OR status = $1)
            AND ($2::uuid IS NULL OR campaign_id = $2)
          ORDER BY scheduled_at DESC
          LIMIT 50 OFFSET $3`,
        [status ?? null, campaign_id ?? null, offset],
      ),
    );
  });

  // ---- Stats --------------------------------------------------------------------

  // "Today" and mailbox/domain remaining-capacity use the org's own
  // timezone, same idea as scheduler.js's per-campaign campaign.timezone —
  // this rollup is org-wide (mailboxes and domain_policies aren't
  // campaign-scoped), so there is no single campaign timezone to borrow.
  app.get('/grow/stats', async (req) => {
    req.requireRole('viewer');

    return req.db(async (q) => {
      const org = await q.one<{ timezone: string }>(
        `SELECT timezone FROM organizations WHERE id = app.current_org()`,
      );
      const tz = org?.timezone ?? 'UTC';

      const sentToday = await q.one<{ n: number }>(
        `SELECT count(*) AS n FROM grow_messages
          WHERE status = 'sent'
            AND (sent_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`,
        [tz],
      );

      const queue = await q.one<{ n: number }>(
        `SELECT count(*) AS n FROM grow_messages WHERE status = 'queued'`,
      );

      const enrolled = await q.one<{ n: number }>(
        `SELECT count(DISTINCT contact_id) AS n FROM grow_enrollments WHERE state = 'active'`,
      );

      // Same bounce/complaint definitions as scheduler.js's circuitBreaker():
      // rates are of all-time sent, not "today".
      const totals = await q.one<{ sent: number; bounced: number }>(
        `SELECT count(*) FILTER (WHERE status = 'sent') AS sent,
                count(*) FILTER (WHERE status = 'bounced') AS bounced
           FROM grow_messages`,
      );
      const complaints = await q.one<{ n: number }>(
        `SELECT count(*) AS n FROM grow_events WHERE type = 'complaint'`,
      );
      const sent = totals?.sent ?? 0;
      const bounceRate = sent > 0 ? (totals!.bounced / sent) : 0;
      const complaintRate = sent > 0 ? ((complaints?.n ?? 0) / sent) : 0;

      const mailboxes = await q.rows<{
        id: string; address: string; status: string; steady_cap: number;
        cap: number; sent_today: number;
      }>(
        `SELECT m.id, m.address, m.status, m.steady_cap,
                grow_mailbox_daily_cap(m.*, (now() AT TIME ZONE $1)::date) AS cap,
                count(msg.id) FILTER (
                  WHERE msg.status = 'sent'
                    AND (msg.sent_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date
                ) AS sent_today
           FROM grow_mailboxes m
           LEFT JOIN grow_messages msg ON msg.mailbox_id = m.id
          WHERE m.status IN ('warming','active')
          GROUP BY m.id
          ORDER BY m.address`,
        [tz],
      );

      // '*' is the fallback rule (see grow_domain_policies), listed as-is,
      // not resolved against actual recipient domains — that resolution is
      // scheduler.js's domainCapacity() job at plan time, not a stats read.
      const domains = await q.rows<{ domain: string; daily_cap: number; sent_today: number }>(
        `WITH sent AS (
           SELECT recipient_domain, count(*) AS n
             FROM grow_messages
            WHERE status = 'sent'
              AND (sent_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date
            GROUP BY recipient_domain
         )
         SELECT p.domain, p.daily_cap, COALESCE(s.n, 0) AS sent_today
           FROM grow_domain_policies p
           LEFT JOIN sent s ON s.recipient_domain = p.domain
          ORDER BY p.domain`,
        [tz],
      );

      return {
        sent_today: sentToday?.n ?? 0,
        queue_depth: queue?.n ?? 0,
        contacts_enrolled: enrolled?.n ?? 0,
        bounce_rate: bounceRate,
        bounce_threshold: BOUNCE_PAUSE_RATE,
        complaint_rate: complaintRate,
        complaint_threshold: COMPLAINT_PAUSE_RATE,
        mailbox_capacity: mailboxes.map((m) => ({
          id: m.id, address: m.address, status: m.status,
          cap: m.cap, sent_today: m.sent_today,
          remaining: Math.max(0, m.cap - m.sent_today),
        })),
        domain_capacity: domains.map((d) => ({
          domain: d.domain, daily_cap: d.daily_cap, sent_today: d.sent_today,
          remaining: Math.max(0, d.daily_cap - d.sent_today),
        })),
      };
    });
  });
}
