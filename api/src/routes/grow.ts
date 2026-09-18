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
import { audit, decryptSecret, encryptSecret } from '../lib/auth.js';
import {
  CAP_MESSAGE, logAiUsage, resolveAIContext, staticEvents, streamAI, streamEventsToSSE,
} from '../lib/ai.js';
import { INSERT_COLUMNS, processRecords, summarize } from '../lib/growContactImport.js';
import {
  applyMapping, guessMapping, mappingMatchesHeaders, type MappingConfig,
} from '../lib/growContactImportMapping.js';
import { ingestFile } from '../lib/growContactImportXlsx.js';
import { enrollAllContacts } from '../lib/growEnroll.js';
import type { Querier } from '../lib/db.js';
import {
  firstUnrenderedPlaceholder, getSenderProfile, GROW_BASE_URL, GROW_BASE_URL_USABLE,
  hasUnrenderedPlaceholder, render, renderSenderFields, renderUnsubscribeFooter,
  type RenderableContact,
} from '../lib/growTemplate.js';
import { checkImapConnectivity, sendRenderedTestEmail, sendTestEmail } from '../lib/growMailboxTest.js';
import { mailboxCapOnDate, rampPoints, steadyCapDate } from '../lib/growMailboxWarmup.js';
import {
  DEFAULT_FALLBACK_CAP, isConsumerDomain, neededDailyTargetForDeadline, projectSchedule,
} from '../lib/growSchedule.js';
import {
  buildExpectedRecords, verifyDomain, type SendingDomainProvider,
} from '../lib/growSendingDomain.js';
import { HttpError } from '../plugins/context.js';

interface RenderedStep {
  subject: string;
  body: string;
  unsubscribe_url: string;
  refused: boolean;
  refusal_reason: string | null;
}

/** The one render path both /contacts/:id/preview and the campaign
 *  test-send endpoints go through — same render()/renderSenderFields()/
 *  renderUnsubscribeFooter()/hasUnrenderedPlaceholder() sequence either
 *  way, so a test send genuinely shows what the (not-yet-built) worker
 *  would produce, not a second, divergent implementation of the same idea.
 *  Does NOT check grow_suppressions — that's specific to a real contact's
 *  own email being the actual send target, which only the real preview
 *  endpoint is; a test send's destination is whatever address the caller
 *  typed in, unrelated to any contact's suppression status. */
async function renderStepForContact(
  q: Querier,
  step: { subject_tmpl: string; body_tmpl: string },
  contact: RenderableContact,
): Promise<RenderedStep> {
  const senderProfile = await getSenderProfile(q);
  const subject = renderSenderFields(render(step.subject_tmpl, contact), senderProfile);
  const bodyAfterMerge = renderSenderFields(render(step.body_tmpl, contact), senderProfile);

  const token = randomBytes(18).toString('hex');
  const unsubscribeUrl = `${GROW_BASE_URL}/u/${token}`;
  // Still splice in the real URL string for display below (so a refusal
  // shows exactly what's misconfigured, not a blank), but only when
  // GROW_BASE_URL is unusable, don't actually resolve the token — leaving
  // {{unsubscribe_footer}} in place is what makes hasUnrenderedPlaceholder()
  // catch it below, the same mechanism every other unresolved field uses.
  const body = GROW_BASE_URL_USABLE
    ? renderUnsubscribeFooter(bodyAfterMerge, {
        mailingAddress: senderProfile.mailing_address ?? '',
        unsubscribeUrl,
      })
    : bodyAfterMerge;

  const subjectUnresolved = hasUnrenderedPlaceholder(subject);
  const bodyUnresolved = hasUnrenderedPlaceholder(body);
  const refused = !GROW_BASE_URL_USABLE || subjectUnresolved || bodyUnresolved;
  const refusalReason = !GROW_BASE_URL_USABLE
    ? `refused to send: GROW_BASE_URL is still "${GROW_BASE_URL}" — set it to this deployment's real public URL before any Grow email can send`
    : refused
      ? `refused to send: unrendered placeholder ${
          firstUnrenderedPlaceholder(subjectUnresolved ? subject : body)
        } in ${subjectUnresolved ? 'subject' : 'body'}`
      : null;

  return { subject, body, unsubscribe_url: unsubscribeUrl, refused, refusal_reason: refusalReason };
}

// Same circuit-breaker thresholds as scheduler.js's circuitBreaker()
// (/opt/outreach/src) — the worker isn't built here, but the dashboard
// needs the same numbers the (future) worker will pause campaigns at, so
// they're returned by /grow/stats rather than duplicated as a second,
// driftable copy in the frontend.
const BOUNCE_PAUSE_RATE = 0.03;
const COMPLAINT_PAUSE_RATE = 0.003;
// scheduler.js's circuitBreaker() ignores rates entirely below this many
// sends — a campaign's first few messages can bounce 100% by pure bad luck
// with nothing wrong. Surfaced so the UI can say "not enough sends yet"
// instead of a scary, statistically meaningless percentage.
const MIN_SAMPLE = 50;

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const timeField = () => z.string().regex(TIME_RE, 'Use HH:MM (24-hour)');

// past_end_date is computed, not stored — "today" per the campaign's own
// timezone, same convention as everywhere else a campaign's own local date
// matters. Nothing here ever writes it; it's purely a read-time signal so
// the UI can show "ended" instead of leaving a campaign looking like it's
// just quietly not running, with no real automatic status transition since
// there's no worker to run one.
// start_date/end_date cast to text: node-postgres otherwise hands a `date`
// column back as a JS Date, which every consumer here — the plain string
// comparisons in this file, and <input type="date"> on the frontend, which
// silently rejects anything that isn't exactly "YYYY-MM-DD" — needs to not
// be. A `date` cast to text in Postgres is already exactly "YYYY-MM-DD",
// no time component to strip, so this is the one place to fix it for
// every response this constant appears in.
const CAMPAIGN_FIELDS = `id, name, status, timezone, window_start, window_end,
  weekdays_only, daily_target, start_date::text, end_date::text, pause_reason, created_at, updated_at,
  (end_date IS NOT NULL AND end_date < (now() AT TIME ZONE timezone)::date) AS past_end_date`;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateField = () => z.string().regex(DATE_RE, 'Use YYYY-MM-DD');

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
  start_date: dateField().nullable().optional(),
  end_date: dateField().nullable().optional(),
});

const campaignPatch = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  status: z.enum(['draft', 'running', 'paused', 'stopped', 'done']).optional(),
  timezone: z.string().trim().min(1).optional(),
  window_start: timeField().optional(),
  window_end: timeField().optional(),
  weekdays_only: z.boolean().optional(),
  daily_target: z.number().int().min(1).optional(),
  start_date: dateField().nullable().optional(),
  end_date: dateField().nullable().optional(),
  pause_reason: z.string().nullable().optional(),
});

/** Both the DB (grow_campaigns_date_range_check) and this route enforce
 *  end_date >= start_date — the DB so it can never be violated no matter
 *  what writes the row, this check so a bad PATCH gets a clear 400 instead
 *  of a raw constraint-violation error. */
function assertValidDateRange(start: string | null | undefined, end: string | null | undefined): void {
  if (start && end && end < start) {
    throw new HttpError(400, 'End date must be on or after the start date', 'invalid_date_range');
  }
}

const stepInput = z.object({
  step_no: z.number().int().min(1),
  delay_days: z.number().int().min(0).default(0),
  applies_to_rank: z.number().int().nullable().default(null),
  subject_tmpl: z.string().min(1),
  body_tmpl: z.string().min(1),
});

const stepsPatch = z.object({ steps: z.array(stepInput).min(1) });

// ---- Sending setup --------------------------------------------------------------

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;
const SENDING_DOMAIN_PROVIDERS = ['spacemail', 'google', 'microsoft', 'other'] as const;

const sendingDomainInput = z.object({
  domain: z.string().trim().toLowerCase().regex(DOMAIN_RE, 'Enter a real domain name, e.g. mail.example.com'),
  provider: z.enum(SENDING_DOMAIN_PROVIDERS),
});

const mailboxInput = z.object({
  domain_id: z.string().uuid(),
  address: z.string().trim().toLowerCase().email(),
  from_name: z.string().trim().min(1).max(100),
  reply_to: z.string().trim().toLowerCase().email().nullable().optional(),
  smtp_host: z.string().trim().min(1),
  smtp_port: z.number().int().min(1).max(65535).default(465),
  imap_host: z.string().trim().min(1).nullable().optional(),
  imap_port: z.number().int().min(1).max(65535).nullable().optional().default(993),
  username: z.string().trim().min(1),
  password: z.string().min(1).max(500),
  steady_cap: z.number().int().min(1).max(1000).default(25),
});

// Every field editable after creation. All optional — a PATCH only touches
// what it actually includes. password is the one exception to "present
// means set": an empty/omitted password means "leave the stored credential
// alone," never "wipe it," since there's no way to tell "didn't type one"
// from "wants no password" and the second isn't a real option here anyway.
const mailboxPatch = z.object({
  address: z.string().trim().toLowerCase().email().optional(),
  from_name: z.string().trim().min(1).max(100).optional(),
  reply_to: z.string().trim().toLowerCase().email().nullable().optional(),
  smtp_host: z.string().trim().min(1).optional(),
  smtp_port: z.number().int().min(1).max(65535).optional(),
  imap_host: z.string().trim().min(1).nullable().optional(),
  imap_port: z.number().int().min(1).max(65535).nullable().optional(),
  username: z.string().trim().min(1).optional(),
  password: z.string().min(1).max(500).optional(),
  status: z.enum(['active', 'paused']).optional(),
});

const testSendInput = z.object({ to: z.string().trim().toLowerCase().email() });

// '*' is the only non-hostname value the domain column ever holds — the
// default rule every recipient domain without its own row falls back to.
const DOMAIN_POLICY_DOMAIN_RE = /^(\*|[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+)$/;

const domainPolicyInput = z.object({
  domain: z.string().trim().toLowerCase()
    .regex(DOMAIN_POLICY_DOMAIN_RE, "Enter a real domain, or '*' for the default rule"),
  daily_cap: z.number().int().min(0).max(10_000),
});

const domainPolicyCapPatch = z.object({ daily_cap: z.number().int().min(0).max(10_000) });

const MAILBOX_FIELDS = `id, domain_id, address, from_name, reply_to, smtp_host, smtp_port,
  imap_host, imap_port, username, warmup_started_on, steady_cap, status, last_health_at,
  created_at, updated_at`;

interface SendingReadiness {
  hasVerifiedDomain: boolean;
  hasActiveMailbox: boolean;
  ready: boolean;
}

/** A campaign has nothing to send from until the org has at least one
 *  fully-verified sending domain (SPF, DKIM, and DMARC all resolving) and
 *  at least one mailbox in a sendable state — the same states
 *  scheduler.js's mailboxCapacity() treats as capable of sending
 *  ('warming' or 'active'; 'paused'/'disabled' are not). */
async function checkSendingReadiness(q: Querier): Promise<SendingReadiness> {
  const domain = await q.one(
    `SELECT 1 FROM grow_sending_domains WHERE spf_ok AND dkim_ok AND dmarc_ok LIMIT 1`,
  );
  const mailbox = await q.one(
    `SELECT 1 FROM grow_mailboxes WHERE status IN ('warming','active') LIMIT 1`,
  );
  const hasVerifiedDomain = !!domain;
  const hasActiveMailbox = !!mailbox;
  return { hasVerifiedDomain, hasActiveMailbox, ready: hasVerifiedDomain && hasActiveMailbox };
}

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
// Every merge field the model is allowed to use, and the reserved tokens
// it must never invent, remove, or alter. Matches growTemplate.ts's
// render() — first_name/contact_name/entity_name/role/region/city/
// enrollment are the grow_contacts columns worth addressing someone by.
// sender_name/sender_website/sender_phone/sender_email/unsubscribe_footer/
// product_url:<label> are all resolved later (renderSenderFields()/
// renderUnsubscribeFooter(), at preview or send time) against data this
// prompt doesn't have direct access to — the model only ever emits the
// token, never a real value.
const MERGE_FIELDS = ['first_name', 'contact_name', 'entity_name', 'role', 'region', 'city', 'enrollment'] as const;
const UNSUBSCRIBE_TOKEN = '{{unsubscribe_footer}}';
const RESERVED_TOKEN_NAMES = new Set<string>([
  'unsubscribe_footer', 'sender_name', 'sender_website', 'sender_phone', 'sender_email',
]);
const VALID_TOKEN_NAMES = new Set<string>([...MERGE_FIELDS, ...RESERVED_TOKEN_NAMES]);
const PRODUCT_URL_TOKEN_RE = /\{\{\s*product_url:([^{}]+?)\s*\}\}/g;

function countOccurrences(text: string, token: string): number {
  return text.split(token).length - 1;
}

/** Throws if `text` uses a {{...}} token outside the allowed set, or a
 *  {{product_url:<label>}} whose label isn't one of this org's own
 *  product_urls — the model was told the exact list in the prompt; this
 *  is the check that doesn't just trust it followed instructions, and the
 *  specific guardrail against inventing a URL the org never entered. */
function assertValidMergeTokens(text: string, productLabels: Set<string>): void {
  for (const match of text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
    if (!VALID_TOKEN_NAMES.has(match[1]!)) {
      throw new HttpError(502, `The AI used an unsupported merge field {{${match[1]}}} — try generating again`, 'ai_invalid_output');
    }
  }
  for (const match of text.matchAll(PRODUCT_URL_TOKEN_RE)) {
    const label = match[1]!.trim();
    if (!productLabels.has(label)) {
      throw new HttpError(
        502,
        `The AI referenced {{product_url:${label}}}, which isn't one of this org's product URLs — try generating again`,
        'ai_invalid_output',
      );
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
  senderProfile: {
    sender_name: string | null; website_url: string | null; phone: string | null;
    contact_email: string | null; product_urls: Array<{ label: string; url: string }>;
  },
  skeleton: SequenceSkeletonStep[],
): { system: string; user: string } {
  // Only ever offer a sender token the org has actually filled in — an
  // empty field or an empty product_urls list means that field just isn't
  // mentioned as available at all, so there's nothing for the model to
  // reach for and invent a value around.
  const senderFields = [
    senderProfile.sender_name ? '{{sender_name}}' : null,
    senderProfile.website_url ? '{{sender_website}}' : null,
    senderProfile.phone ? '{{sender_phone}}' : null,
    senderProfile.contact_email ? '{{sender_email}}' : null,
    ...senderProfile.product_urls.map((p) => `{{product_url:${p.label}}}`),
  ].filter((f): f is string => f !== null);

  const system = [
    `You are drafting a cold-outreach email sequence for ${org?.name ?? 'this business'}` +
      `${org?.vertical ? `, a ${org.vertical} business` : ''}.`,
    'GROUNDING RULES — follow exactly, no exceptions:',
    '- Use ONLY the facts given below (what this business sells, where it operates, who is being contacted, ' +
      'and the sender fields listed as available). Never invent customer names, testimonials, statistics, ' +
      'years in business, awards, capabilities, or links not listed below.',
    '- If "What this business sells" says nothing is listed, write generically about wanting to start a ' +
      'conversation — do not invent a product or service to describe.',
    `- Every merge field must be written exactly as {{field}} and be one of: ${MERGE_FIELDS.map((f) => `{{${f}}}`).join(', ')}` +
      `${senderFields.length > 0 ? `, or one of these sender fields: ${senderFields.join(', ')}` : ''}. ` +
      'Never invent a merge field name, a {{product_url:...}} label not listed above, or use a sender field not listed as available.',
    senderFields.length > 0
      ? '- Sender fields belong in a short, natural closing signature at the end of the body, after the last ' +
        'sentence and before the unsubscribe token — something like "Best,\\n{{sender_name}}" optionally followed ' +
        'by one line with a phone, email, or website (e.g. "{{sender_phone}} · {{sender_website}}"). Use only the ' +
        'fields actually available, and only ones that make sense in a signature — never invent a "Links:" list, ' +
        'a bullet list, or multiple mid-paragraph mentions of the same field.'
      : '- No sender fields (name, website, phone, email, product links) are available for this org yet — do not ' +
        'invent a signature block or reference any of them.',
    `- End every email body with the literal token ${UNSUBSCRIBE_TOKEN} on its own line, exactly once, unchanged, ` +
      'after the signature (if any).',
    '- Each email: 80-150 words including any signature, plain text, no markdown, no "Subject:" label inside the body.',
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
  const senderAvailable = senderFields.length > 0
    ? senderFields.map((f) => `- ${f}`).join('\n')
    : '(none — do not reference a website, phone, or product link)';
  const steps = skeleton
    .map((s, i) => `${i + 1}. Step ${s.step_no}${s.rankLabel ? ` for contacts with role "${s.rankLabel}"` : ''} — ${s.angle}`)
    .join('\n');

  const user = [
    `What this business sells:\n${sell}`,
    `Where it operates:\n${where}`,
    `Sender fields available to use (optional):\n${senderAvailable}`,
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

// Shared by the list, the id-export used for "select all matching this
// filter", and the bulk actions below — one definition so a bulk delete
// can never see a different set of rows than what's on screen.
const contactFilterQuery = z.object({
  tier: z.string().trim().min(1).optional(),
  region: z.string().trim().min(1).optional(),
  contact_rank: z.coerce.number().int().optional(),
  enrollment_state: z.enum(ENROLLMENT_STATES).optional(),
  // Scopes both the enrollment_state EXISTS check and which enrollment
  // en.* below reports as "this row's enrollment" — with no campaign_id,
  // that's just whichever enrollment was touched most recently across any
  // campaign (the dashboard-wide view this list always showed before);
  // with one, it's specifically this contact's enrollment in it, which is
  // what "remove from campaign" needs to act on unambiguously.
  campaign_id: z.string().uuid().optional(),
  suppressed: z.coerce.boolean().optional(),
  // Free-text search for the test-send picker's "any existing contact"
  // search box — email or name, not a structured filter, so it's kept
  // separate from the rest even though it shares the same $-position
  // scheme below.
  q: z.string().trim().min(1).max(200).optional(),
});

const contactListQuery = contactFilterQuery.extend({
  page: z.coerce.number().int().min(1).default(1),
});

// Fixed positions $1-$7 shared by every query below that filters the
// contacts list — the paginated list, the "select all matching this
// filter" id export, and (implicitly) anything future that needs the same
// filter. Query-specific params (e.g. LIMIT/OFFSET) start at $8.
const CONTACT_JOIN_SQL = `
  LEFT JOIN LATERAL (
    SELECT e.id, e.state, e.campaign_id FROM grow_enrollments e
     WHERE e.contact_id = c.id
       AND ($5::uuid IS NULL OR e.campaign_id = $5)
     ORDER BY e.updated_at DESC LIMIT 1
  ) en ON true
  LEFT JOIN grow_suppressions s ON s.org_id = app.current_org() AND s.email = c.email
`;

const CONTACT_FILTER_SQL = `
  ($1::text IS NULL OR c.tier = $1)
  AND ($2::text IS NULL OR c.region = $2)
  AND ($3::int IS NULL OR c.contact_rank = $3)
  AND ($4::text IS NULL OR EXISTS (
        SELECT 1 FROM grow_enrollments e2
         WHERE e2.contact_id = c.id AND e2.state = $4
           AND ($5::uuid IS NULL OR e2.campaign_id = $5)))
  AND ($6::boolean IS NULL OR (s.id IS NOT NULL) = $6)
  AND ($7::text IS NULL OR c.email ILIKE '%' || $7 || '%' OR c.contact_name ILIKE '%' || $7 || '%'
       OR c.first_name ILIKE '%' || $7 || '%')
`;

function contactFilterParams(f: z.infer<typeof contactFilterQuery>): unknown[] {
  return [f.tier ?? null, f.region ?? null, f.contact_rank ?? null, f.enrollment_state ?? null,
    f.campaign_id ?? null, f.suppressed ?? null, f.q ?? null];
}

const bulkIdsInput = z.object({ ids: z.array(z.string().uuid()).min(1).max(5000) });

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
    assertValidDateRange(body.start_date, body.end_date);

    return req.db(async (q) => {
      const campaign = await q.one(
        `INSERT INTO grow_campaigns
           (org_id, name, timezone, window_start, window_end, weekdays_only, daily_target,
            start_date, end_date)
         VALUES (app.current_org(), $1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING ${CAMPAIGN_FIELDS}`,
        [body.name, body.timezone, body.window_start, body.window_end,
         body.weekdays_only, body.daily_target, body.start_date ?? null, body.end_date ?? null],
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
    assertValidDateRange(body.start_date, body.end_date);

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
      // Starting a campaign with nothing to send from isn't a state worth
      // reaching just so it can fail silently later — block it here, with
      // the specific reason, rather than letting a (future) worker find
      // out mid-run.
      if (body.status === 'running') {
        const readiness = await checkSendingReadiness(q);
        if (!readiness.ready) {
          const missing = [
            !readiness.hasVerifiedDomain ? 'no fully verified sending domain (SPF, DKIM, and DMARC)' : null,
            !readiness.hasActiveMailbox ? 'no active mailbox' : null,
          ].filter(Boolean).join(' and ');
          throw new HttpError(400, `Can't start this campaign — this org has ${missing} yet.`, 'not_ready_to_send');
        }
      }

      // assertValidDateRange above only catches a patch that sets both
      // dates inconsistently in the same request; changing just one against
      // the other's existing value needs the current row to check against,
      // so a bad combination gets this clean 400 instead of a raw
      // grow_campaigns_date_range_check violation surfacing as a 500.
      if (('start_date' in body) !== ('end_date' in body)) {
        // ::text, same reason CAMPAIGN_FIELDS casts it above — a bare
        // `date` column comes back as a JS Date, which compares against a
        // plain "YYYY-MM-DD" string with neither a throw nor sensible
        // coercion, just a silent, always-false result.
        const current = await q.one<{ start_date: string | null; end_date: string | null }>(
          `SELECT start_date::text, end_date::text FROM grow_campaigns WHERE id = $1`, [id],
        );
        if (current) {
          assertValidDateRange(
            'start_date' in body ? body.start_date : current.start_date,
            'end_date' in body ? body.end_date : current.end_date,
          );
        }
      }

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

  // A campaign that has actually sent mail carries its own CAN-SPAM record
  // in grow_messages — deleting the campaign would delete that log along
  // with it (ON DELETE CASCADE, same as every other child table here), so
  // that case archives instead and never removes a row. A campaign that
  // never sent anything has no such record to protect; grow_sequence_steps,
  // grow_enrollments and grow_messages all cascade from grow_campaigns
  // already (009_grow.sql), so one DELETE is enough to take its steps and
  // enrollments with it — no separate cleanup queries needed.
  app.delete('/grow/campaigns/:id', async (req) => {
    req.requireRole('manager');
    const sess = req.requireAuth();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    return req.db(async (q) => {
      const campaign = await q.one<{ id: string; name: string }>(
        `SELECT id, name FROM grow_campaigns WHERE id = $1`, [id],
      );
      if (!campaign) throw new HttpError(404, 'Campaign not found', 'not_found');

      const sent = await q.one<{ n: number }>(
        `SELECT count(*) AS n FROM grow_messages WHERE campaign_id = $1 AND status = 'sent'`, [id],
      );
      const sentCount = sent?.n ?? 0;

      if (sentCount > 0) {
        const archived = await q.one(
          `UPDATE grow_campaigns SET status = 'archived' WHERE id = $1 RETURNING ${CAMPAIGN_FIELDS}`,
          [id],
        );
        await audit(q, {
          orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'grow_campaigns.archive',
          entityType: 'grow_campaigns', entityId: id, ip: req.ip,
          diff: { reason: `refused delete: ${sentCount} sent message(s) on record` },
        });
        return { archived: true, campaign: archived };
      }

      await q.exec(`DELETE FROM grow_campaigns WHERE id = $1`, [id]);
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'grow_campaigns.delete',
        entityType: 'grow_campaigns', entityId: id, ip: req.ip, diff: { name: campaign.name },
      });
      return { archived: false, campaign: null };
    });
  });

  app.get('/grow/sending-readiness', async (req) => {
    req.requireRole('viewer');
    return req.db((q) => checkSendingReadiness(q));
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

  // ---- Test send (with merge) ----------------------------------------------------
  //
  // Exercises the exact same render path a real send would (renderStepForContact,
  // shared with /contacts/:id/preview above), against either a real contact
  // or hand-entered merge values for a hypothetical one, through a real
  // mailbox's real SMTP — but never writes grow_messages and never touches
  // an enrollment, so it can't count against a mailbox's daily cap or show
  // up in the send log. [TEST] is prefixed onto the subject at both the
  // render and the send step, so what's shown before sending is exactly
  // what goes out.

  const testSendManualFields = z.object({
    first_name: z.string().trim().max(100).optional(),
    contact_name: z.string().trim().max(200).optional(),
    role: z.string().trim().max(200).optional(),
    entity_name: z.string().trim().max(200).optional(),
    region: z.string().trim().max(100).optional(),
    city: z.string().trim().max(100).optional(),
    enrollment: z.string().trim().max(50).optional(),
  });

  const testSendRenderInput = z.object({
    // The template text itself, not a step_id — the editor can hold
    // AI-generated or hand-edited steps that were never saved (nothing
    // gets a grow_sequence_steps row until "Save changes"), and this needs
    // to render exactly what's on screen right now, not whatever last made
    // it to the database. Whoever calls this owns getting the right text
    // here; there's no campaign_id/step ownership to check against a
    // template that was never a row in the first place.
    subject_tmpl: z.string().min(1),
    body_tmpl: z.string().min(1),
    // Neither required: omitting both renders against an entirely blank
    // hypothetical contact (render()'s own blank-field fallbacks apply —
    // "there" for a missing first_name, '' for everything else).
    contact_id: z.string().uuid().optional(),
    manual: testSendManualFields.optional(),
  });

  async function resolveTestSendContact(
    q: Querier, body: z.infer<typeof testSendRenderInput>,
  ): Promise<RenderableContact> {
    if (body.contact_id) {
      const c = await q.one<RenderableContact>(
        `SELECT email, first_name, contact_name, role, entity_name, region, city, enrollment,
                recipient_domain, is_free_provider, contact_rank, attrs
           FROM grow_contacts WHERE id = $1`,
        [body.contact_id],
      );
      if (!c) throw new HttpError(404, 'Contact not found', 'not_found');
      return c;
    }
    const m = body.manual ?? {};
    return {
      first_name: m.first_name ?? null,
      contact_name: m.contact_name ?? null,
      role: m.role ?? null,
      entity_name: m.entity_name ?? null,
      region: m.region ?? null,
      city: m.city ?? null,
      enrollment: m.enrollment ?? null,
      recipient_domain: 'example.com',
      is_free_provider: false,
      contact_rank: 1,
      attrs: {},
    };
  }

  async function assertCampaignExists(q: Querier, campaignId: string): Promise<void> {
    const campaign = await q.one(`SELECT id FROM grow_campaigns WHERE id = $1`, [campaignId]);
    if (!campaign) throw new HttpError(404, 'Campaign not found', 'not_found');
  }

  app.post('/grow/campaigns/:id/test-send/render', async (req) => {
    req.requireRole('staff');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = testSendRenderInput.parse(req.body);

    return req.db(async (q) => {
      await assertCampaignExists(q, id);
      const contact = await resolveTestSendContact(q, body);
      const rendered = await renderStepForContact(
        q, { subject_tmpl: body.subject_tmpl, body_tmpl: body.body_tmpl }, contact,
      );
      return { subject: `[TEST] ${rendered.subject}`, body: rendered.body, refused: rendered.refused, refusal_reason: rendered.refusal_reason };
    });
  });

  const campaignTestSendInput = testSendRenderInput.extend({
    mailbox_id: z.string().uuid(),
    to: z.string().trim().toLowerCase().email(),
  });

  app.post('/grow/campaigns/:id/test-send', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = campaignTestSendInput.parse(req.body);

    const prep = await req.db(async (q) => {
      await assertCampaignExists(q, id);
      const contact = await resolveTestSendContact(q, body);
      const stepRendered = await renderStepForContact(
        q, { subject_tmpl: body.subject_tmpl, body_tmpl: body.body_tmpl }, contact,
      );
      const rendered = {
        subject: `[TEST] ${stepRendered.subject}`, body: stepRendered.body,
        refused: stepRendered.refused, refusal_reason: stepRendered.refusal_reason,
      };

      // A template that refuses to render (unresolved merge/sender field,
      // or {{unsubscribe_footer}} itself somehow missing) refuses to send
      // here too, same as everywhere else — never mind that this is only a
      // test, it would still be a real SMTP send of a broken email.
      if (rendered.refused) {
        return { rendered, mailbox: null, password: null };
      }

      const mailboxRow = await q.one<{
        id: string; address: string; from_name: string; reply_to: string | null;
        smtp_host: string; smtp_port: number; username: string; integration_id: string;
      }>(
        `SELECT id, address, from_name, reply_to, smtp_host, smtp_port, username, integration_id
           FROM grow_mailboxes WHERE id = $1`,
        [body.mailbox_id],
      );
      if (!mailboxRow) throw new HttpError(404, 'Mailbox not found', 'not_found');
      const cred = await q.one<{ credential_enc: Buffer; credential_iv: Buffer; credential_tag: Buffer }>(
        `SELECT credential_enc, credential_iv, credential_tag FROM integrations WHERE id = $1`,
        [mailboxRow.integration_id],
      );
      if (!cred?.credential_enc) {
        throw new HttpError(409, 'No stored credential for this mailbox — re-add it', 'no_credential');
      }
      return {
        rendered, mailbox: mailboxRow,
        password: decryptSecret(cred.credential_enc, cred.credential_iv, cred.credential_tag),
      };
    });

    if (!prep.mailbox || !prep.password) {
      return { ...prep.rendered, smtp: null };
    }

    const smtp = await sendRenderedTestEmail(prep.mailbox, prep.password, body.to, prep.rendered.subject, prep.rendered.body);

    // No grow_messages row, no enrollment touched — audited the same way
    // the sending-setup "Send test email" button is, so there's still a
    // record of who fired a real SMTP send and to where, without it
    // looking anywhere like a real queued/sent message.
    await req.db((q) => audit(q, {
      orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'grow_campaigns.test_send',
      entityType: 'grow_campaigns', entityId: id, ip: req.ip,
      diff: { to: body.to, mailbox_id: body.mailbox_id, subject_tmpl: body.subject_tmpl, smtp_ok: smtp.ok },
    }));

    return { ...prep.rendered, smtp };
  });

  // ---- Enroll (bulk, one-shot) -----------------------------------------------
  //
  // Nothing else in this app or the standalone engine it was ported from
  // ever wrote a grow_enrollments row (see lib/growEnroll.ts's header) — a
  // campaign could sit at status='running' indefinitely with real mailboxes
  // and real contacts and never queue anything. This is the missing step:
  // enroll every not-yet-enrolled, not-suppressed contact into the
  // campaign. Safe to call more than once — already-enrolled and suppressed
  // contacts are skipped, not re-inserted or double-sent.
  app.post('/grow/campaigns/:id/enroll', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    return req.db(async (q) => {
      await assertCampaignExists(q, id);
      const result = await enrollAllContacts(q, id);
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'grow_campaigns.enroll',
        entityType: 'grow_campaigns', entityId: id, ip: req.ip, diff: result,
      });
      return result;
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

    const { system, user, skeleton, productLabels, ctx } = await req.db(async (q) => {
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
      const senderProfile = await getSenderProfile(q);
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
      const prompt = buildSequenceGenerationPrompt(org, catalogItems, locations, senderProfile, skel);
      return {
        system: prompt.system, user: prompt.user, skeleton: skel,
        productLabels: new Set(senderProfile.product_urls.map((p) => p.label)),
        ctx: context,
      };
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
      assertValidMergeTokens(subject, productLabels);
      assertValidMergeTokens(body, productLabels);
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

  // ---- Sending setup ------------------------------------------------------------
  // Nothing sends without a verified domain and at least one mailbox — this
  // section is entirely CRUD + verification, never the sending path itself
  // (grow_messages.status is never touched here, same boundary as the rest
  // of this file).

  app.get('/grow/sending-domains', async (req) => {
    req.requireRole('viewer');
    return req.db(async (q) => {
      const rows = await q.rows<{
        id: string; domain: string; provider: SendingDomainProvider;
        spf_ok: boolean; dkim_ok: boolean; dmarc_ok: boolean; verified_at: string | null;
      }>(
        `SELECT id, domain, provider, spf_ok, dkim_ok, dmarc_ok, verified_at
           FROM grow_sending_domains ORDER BY created_at`,
      );
      return rows.map((r) => ({ ...r, expected_records: buildExpectedRecords(r.domain, r.provider) }));
    });
  });

  app.post('/grow/sending-domains', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const body = sendingDomainInput.parse(req.body);

    return req.db(async (q) => {
      const row = await q.one<{
        id: string; domain: string; provider: SendingDomainProvider;
        spf_ok: boolean; dkim_ok: boolean; dmarc_ok: boolean; verified_at: string | null;
      }>(
        `INSERT INTO grow_sending_domains (org_id, domain, provider)
         VALUES (app.current_org(), $1, $2)
         RETURNING id, domain, provider, spf_ok, dkim_ok, dmarc_ok, verified_at`,
        [body.domain, body.provider],
      );
      if (!row) throw new HttpError(409, `${body.domain} has already been added`, 'duplicate_domain');
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'grow_sending_domains.create',
        entityType: 'grow_sending_domains', entityId: row.id, ip: req.ip, diff: body,
      });
      return { ...row, expected_records: buildExpectedRecords(row.domain, row.provider) };
    });
  });

  // Live DNS lookups against the domain's real, public DNS — nothing here
  // reads from or writes to grow_sending_domains' spf_ok/dkim_ok/dmarc_ok
  // until the lookups have actually returned, so a slow or unresponsive
  // resolver just makes this request slow, never wrong.
  app.post('/grow/sending-domains/:id/verify', async (req) => {
    req.requireRole('staff');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const domainRow = await req.db((q) =>
      q.one<{ domain: string; provider: SendingDomainProvider }>(
        `SELECT domain, provider FROM grow_sending_domains WHERE id = $1`,
        [id],
      ),
    );
    if (!domainRow) throw new HttpError(404, 'Sending domain not found', 'not_found');

    const result = await verifyDomain(domainRow.domain, domainRow.provider);

    return req.db(async (q) => {
      const updated = await q.one(
        `UPDATE grow_sending_domains
            SET spf_ok = $2, dkim_ok = $3, dmarc_ok = $4, verified_at = now()
          WHERE id = $1
        RETURNING id, domain, provider, spf_ok, dkim_ok, dmarc_ok, verified_at`,
        [id, result.spf.ok, result.dkim.ok, result.dmarc.ok],
      );
      return { ...updated, checks: [result.spf, result.dkim, result.dmarc], subdomain_warning: result.subdomainWarning };
    });
  });

  app.get('/grow/mailboxes', async (req) => {
    req.requireRole('viewer');
    return req.db(async (q) => {
      const rows = await q.rows<{
        id: string; domain_id: string; address: string; from_name: string; reply_to: string | null;
        smtp_host: string; smtp_port: number; imap_host: string | null; imap_port: number | null;
        username: string; warmup_started_on: string | null; steady_cap: number; status: string;
        last_health_at: string | null; created_at: string; updated_at: string;
        domain: string; daily_cap: number; has_message_history: boolean;
      }>(
        `SELECT m.id, m.domain_id, m.address, m.from_name, m.reply_to, m.smtp_host, m.smtp_port,
                m.imap_host, m.imap_port, m.username, m.warmup_started_on, m.steady_cap, m.status,
                m.last_health_at, m.created_at, m.updated_at,
                d.domain,
                grow_mailbox_daily_cap(m.*, CURRENT_DATE) AS daily_cap,
                EXISTS (SELECT 1 FROM grow_messages msg WHERE msg.mailbox_id = m.id) AS has_message_history
           FROM grow_mailboxes m
           JOIN grow_sending_domains d ON d.id = m.domain_id
          ORDER BY m.created_at`,
      );
      return rows.map((r) => ({
        ...r,
        steady_cap_date: r.warmup_started_on
          ? steadyCapDate(new Date(r.warmup_started_on), r.steady_cap).toISOString().slice(0, 10)
          : null,
      }));
    });
  });

  app.post('/grow/mailboxes', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const body = mailboxInput.parse(req.body);

    return req.db(async (q) => {
      const domain = await q.one<{ id: string }>(`SELECT id FROM grow_sending_domains WHERE id = $1`, [body.domain_id]);
      if (!domain) throw new HttpError(404, 'Sending domain not found', 'not_found');

      // Credential vault row, same convention as GSC's OAuth token
      // (integrations.credential_enc/iv/tag via encryptSecret) — the
      // password is never written anywhere else, including audit_log
      // below, whose diff deliberately excludes it.
      const { enc, iv, tag } = encryptSecret(body.password);
      const integration = await q.one<{ id: string }>(
        `INSERT INTO integrations (org_id, provider, external_id, display_name, status,
                                    credential_enc, credential_iv, credential_tag)
         VALUES (app.current_org(), 'grow_mailbox', $1, $2, 'connected', $3, $4, $5)
         RETURNING id`,
        [body.address, body.address, enc, iv, tag],
      );
      if (!integration) throw new HttpError(409, `${body.address} is already connected`, 'duplicate_mailbox');

      const mailbox = await q.one(
        `INSERT INTO grow_mailboxes
           (org_id, domain_id, integration_id, address, from_name, reply_to,
            smtp_host, smtp_port, imap_host, imap_port, username,
            warmup_started_on, steady_cap, status)
         VALUES (app.current_org(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_DATE, $11, 'warming')
         RETURNING ${MAILBOX_FIELDS}`,
        [
          body.domain_id, integration.id, body.address, body.from_name, body.reply_to ?? null,
          body.smtp_host, body.smtp_port, body.imap_host ?? null, body.imap_port ?? null,
          body.username, body.steady_cap,
        ],
      );
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'grow_mailboxes.create',
        entityType: 'grow_mailboxes', entityId: (mailbox as { id: string }).id, ip: req.ip,
        diff: { ...body, password: undefined },
      });
      return mailbox;
    });
  });

  app.patch('/grow/mailboxes/:id', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = mailboxPatch.parse(req.body);

    if (Object.keys(body).length === 0) {
      throw new HttpError(400, 'Nothing to update', 'invalid_input');
    }

    return req.db(async (q) => {
      const current = await q.one<{ address: string; integration_id: string }>(
        `SELECT address, integration_id FROM grow_mailboxes WHERE id = $1`, [id],
      );
      if (!current) throw new HttpError(404, 'Mailbox not found', 'not_found');

      const addressChanging = body.address !== undefined && body.address !== current.address;
      if (addressChanging) {
        // grow_messages.mailbox_id has no cascade or default — every row
        // it's ever pointed at stays attributed to whatever address was
        // used to send it, which is the whole point of a send log. Renaming
        // out from under that would make the log lie about who sent what;
        // pausing and adding a new mailbox is the correct move instead.
        const hasHistory = await q.one(`SELECT 1 FROM grow_messages WHERE mailbox_id = $1 LIMIT 1`, [id]);
        if (hasHistory) {
          throw new HttpError(
            409,
            `${current.address} has message history — changing its address would misattribute that send log. Pause it and add a new mailbox instead.`,
            'has_message_history',
          );
        }
      }

      const fields: string[] = [];
      const values: unknown[] = [];
      let i = 1;
      const setField = (col: string, val: unknown) => { fields.push(`${col} = $${i}`); values.push(val); i += 1; };

      if (body.address !== undefined) setField('address', body.address);
      if (body.from_name !== undefined) setField('from_name', body.from_name);
      if ('reply_to' in body) setField('reply_to', body.reply_to ?? null);
      if (body.smtp_host !== undefined) setField('smtp_host', body.smtp_host);
      if (body.smtp_port !== undefined) setField('smtp_port', body.smtp_port);
      if ('imap_host' in body) setField('imap_host', body.imap_host ?? null);
      if ('imap_port' in body) setField('imap_port', body.imap_port ?? null);
      if (body.username !== undefined) setField('username', body.username);

      // A changed address always wins over an explicit status in the same
      // request — there's no sending history under the new identity, so
      // 'warming' is the only status that's actually true, no matter what
      // was asked for.
      const finalStatus = addressChanging ? 'warming' : body.status;
      if (finalStatus !== undefined) setField('status', finalStatus);
      if (addressChanging) fields.push('warmup_started_on = CURRENT_DATE');

      const mailbox = fields.length > 0
        ? await q.one(
            `UPDATE grow_mailboxes SET ${fields.join(', ')} WHERE id = $${i} RETURNING ${MAILBOX_FIELDS}`,
            [...values, id],
          )
        : await q.one(`SELECT ${MAILBOX_FIELDS} FROM grow_mailboxes WHERE id = $1`, [id]);
      if (!mailbox) throw new HttpError(404, 'Mailbox not found', 'not_found');

      // Re-encrypts through the same integrations vault row POST created —
      // never a second row, never a bare env var. A blank/omitted password
      // leaves the stored credential untouched; there's no "clear the
      // password" operation, since a mailbox with none can't send at all.
      if (body.password) {
        const { enc, iv, tag } = encryptSecret(body.password);
        await q.exec(
          `UPDATE integrations SET credential_enc = $2, credential_iv = $3, credential_tag = $4 WHERE id = $1`,
          [current.integration_id, enc, iv, tag],
        );
      }
      // Keeps integrations.external_id (its UNIQUE (org_id, provider,
      // external_id) key) in step with the mailbox's own address — so a
      // renamed mailbox doesn't leave a stale row squatting on the old
      // address, blocking it from ever being reused by a real future one.
      if (addressChanging) {
        await q.exec(
          `UPDATE integrations SET external_id = $2, display_name = $2 WHERE id = $1`,
          [current.integration_id, body.address],
        );
      }

      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'grow_mailboxes.update',
        entityType: 'grow_mailboxes', entityId: id, ip: req.ip,
        diff: { ...body, password: body.password ? '(changed)' : undefined },
      });
      return mailbox;
    });
  });

  // Refused, not archived, the same as a contact with send history — there's
  // no softer "keep it but retire it" state for a mailbox the way archiving
  // is for a campaign; pausing already covers "stop using this," so delete
  // only ever means delete.
  app.delete('/grow/mailboxes/:id', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    return req.db(async (q) => {
      const mailbox = await q.one<{ address: string; integration_id: string }>(
        `SELECT address, integration_id FROM grow_mailboxes WHERE id = $1`, [id],
      );
      if (!mailbox) throw new HttpError(404, 'Mailbox not found', 'not_found');

      const hasSent = await q.one(
        `SELECT 1 FROM grow_messages WHERE mailbox_id = $1 AND status = 'sent' LIMIT 1`, [id],
      );
      if (hasSent) {
        throw new HttpError(
          409,
          `${mailbox.address} has sent messages — deleting it would break that send log. Pause it instead.`,
          'has_sent_messages',
        );
      }

      // grow_messages.mailbox_id has no ON DELETE cascade, so any row still
      // pointing here — sent or not — would fail this DELETE at the
      // database level regardless of the check above; nothing today
      // actually inserts one for a mailbox that's never sent, since the
      // only writer of grow_messages would be the (not yet built) worker.
      await q.exec(`DELETE FROM grow_mailboxes WHERE id = $1`, [id]);
      // integrations is the credential vault row this mailbox owned —
      // nothing else references it once the mailbox is gone.
      await q.exec(`DELETE FROM integrations WHERE id = $1`, [mailbox.integration_id]);

      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'grow_mailboxes.delete',
        entityType: 'grow_mailboxes', entityId: id, ip: req.ip, diff: { address: mailbox.address },
      });
      return { deleted: true };
    });
  });

  // Sends one real message through this mailbox's real SMTP credentials,
  // then checks (not "confirms a reply arrived" — see growMailboxTest.ts)
  // that the same credentials can authenticate over IMAP and open INBOX.
  // Both results are returned verbatim, success or failure — never
  // summarized into a bare boolean that would hide a real SMTP/IMAP error
  // string from the person debugging why sends aren't going out.
  app.post('/grow/mailboxes/:id/test-send', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { to } = testSendInput.parse(req.body);

    const { mailbox, password } = await req.db(async (q) => {
      const row = await q.one<{
        id: string; address: string; from_name: string; reply_to: string | null;
        smtp_host: string; smtp_port: number; imap_host: string | null; imap_port: number | null;
        username: string; integration_id: string;
      }>(
        `SELECT id, address, from_name, reply_to, smtp_host, smtp_port, imap_host, imap_port, username, integration_id
           FROM grow_mailboxes WHERE id = $1`,
        [id],
      );
      if (!row) throw new HttpError(404, 'Mailbox not found', 'not_found');

      const cred = await q.one<{ credential_enc: Buffer; credential_iv: Buffer; credential_tag: Buffer }>(
        `SELECT credential_enc, credential_iv, credential_tag FROM integrations WHERE id = $1`,
        [row.integration_id],
      );
      if (!cred?.credential_enc) {
        throw new HttpError(409, 'No stored credential for this mailbox — re-add it', 'no_credential');
      }
      return { mailbox: row, password: decryptSecret(cred.credential_enc, cred.credential_iv, cred.credential_tag) };
    });

    const smtp = await sendTestEmail(mailbox, password, to);
    const imap = await checkImapConnectivity(mailbox, password);

    await req.db(async (q) => {
      await q.exec(`UPDATE grow_mailboxes SET last_health_at = now() WHERE id = $1`, [id]);
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'grow_mailboxes.test_send',
        entityType: 'grow_mailboxes', entityId: id, ip: req.ip,
        diff: { to, smtp_ok: smtp.ok, imap_ok: imap.ok },
      });
    });

    return { smtp, imap };
  });

  // ---- Domain caps ----------------------------------------------------------------
  //
  // grow_domain_policies is org-wide, not campaign-scoped (there's no
  // campaign_id column) — every campaign this org runs shares the same
  // per-recipient-domain throttle, matching scheduler.js's domainCapacity(),
  // which reads it the same way regardless of which campaign is asking.
  //
  // A fresh org has no rows here at all, so this list is synthesized, not a
  // straight SELECT: every domain with an explicit policy, plus (since an
  // uncapped domain with real volume is exactly the gap this table exists
  // to surface) the top domains among currently-enrolled contacts that
  // *don't* have one yet, plus a '*' row — real if the org has saved one,
  // synthesized at scheduler.js's own hardcoded fallback (25) if not, so
  // the table always shows what's actually governing an uncapped domain
  // right now rather than implying there's no limit at all.
  const UNCAPPED_DOMAINS_SHOWN = 15;

  app.get('/grow/domain-policies', async (req) => {
    req.requireRole('viewer');
    return req.db(async (q) => {
      const org = await q.one<{ timezone: string }>(
        `SELECT timezone FROM organizations WHERE id = app.current_org()`,
      );
      const tz = org?.timezone ?? 'UTC';

      const explicit = await q.rows<{
        id: string; domain: string; daily_cap: number; enrolled_contacts: number; sent_today: number;
      }>(
        `SELECT p.id, p.domain, p.daily_cap,
                COALESCE(ec.n, 0) AS enrolled_contacts,
                COALESCE(st.n, 0) AS sent_today
           FROM grow_domain_policies p
           LEFT JOIN LATERAL (
             SELECT count(DISTINCT e.contact_id) AS n
               FROM grow_enrollments e JOIN grow_contacts c ON c.id = e.contact_id
              WHERE e.state = 'active' AND c.recipient_domain = p.domain
           ) ec ON true
           LEFT JOIN LATERAL (
             SELECT count(*) AS n FROM grow_messages m
              WHERE m.status = 'sent' AND m.recipient_domain = p.domain
                AND (m.sent_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date
           ) st ON true
          WHERE p.domain <> '*'`,
        [tz],
      );

      const uncapped = await q.rows<{ domain: string; enrolled_contacts: number; sent_today: number }>(
        `SELECT c.recipient_domain AS domain,
                count(DISTINCT e.contact_id) AS enrolled_contacts,
                COALESCE((
                  SELECT count(*) FROM grow_messages m
                   WHERE m.status = 'sent' AND m.recipient_domain = c.recipient_domain
                     AND (m.sent_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date
                ), 0) AS sent_today
           FROM grow_enrollments e
           JOIN grow_contacts c ON c.id = e.contact_id
          WHERE e.state = 'active'
            AND NOT EXISTS (SELECT 1 FROM grow_domain_policies p WHERE p.domain = c.recipient_domain)
          GROUP BY c.recipient_domain
          ORDER BY enrolled_contacts DESC
          LIMIT ${UNCAPPED_DOMAINS_SHOWN}`,
        [tz],
      );

      const star = await q.one<{ id: string; daily_cap: number }>(
        `SELECT id, daily_cap FROM grow_domain_policies WHERE domain = '*'`,
      );
      const starTotals = await q.one<{ enrolled_contacts: number; sent_today: number }>(
        `SELECT
           (SELECT count(DISTINCT e.contact_id) FROM grow_enrollments e JOIN grow_contacts c ON c.id = e.contact_id
             WHERE e.state = 'active'
               AND NOT EXISTS (SELECT 1 FROM grow_domain_policies p
                                WHERE p.domain = c.recipient_domain AND p.domain <> '*')
           ) AS enrolled_contacts,
           (SELECT count(*) FROM grow_messages m
             WHERE m.status = 'sent'
               AND (m.sent_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date
               AND NOT EXISTS (SELECT 1 FROM grow_domain_policies p
                                WHERE p.domain = m.recipient_domain AND p.domain <> '*')
           ) AS sent_today`,
        [tz],
      );

      const rows = [
        ...explicit.map((r) => ({ ...r, is_default: false })),
        ...uncapped.map((r) => ({
          id: null as string | null, domain: r.domain, daily_cap: star?.daily_cap ?? DEFAULT_FALLBACK_CAP,
          enrolled_contacts: r.enrolled_contacts, sent_today: r.sent_today, is_default: false,
        })),
        {
          id: star?.id ?? null, domain: '*', daily_cap: star?.daily_cap ?? DEFAULT_FALLBACK_CAP,
          enrolled_contacts: starTotals?.enrolled_contacts ?? 0, sent_today: starTotals?.sent_today ?? 0,
          is_default: true,
        },
      ];

      return rows
        .sort((a, b) => b.enrolled_contacts - a.enrolled_contacts)
        .map((r) => ({
          ...r,
          is_consumer: isConsumerDomain(r.domain),
          remaining: Math.max(0, r.daily_cap - r.sent_today),
          is_saved: r.id !== null,
        }));
    });
  });

  app.post('/grow/domain-policies', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const body = domainPolicyInput.parse(req.body);

    return req.db(async (q) => {
      const row = await q.one(
        `INSERT INTO grow_domain_policies (org_id, domain, daily_cap)
         VALUES (app.current_org(), $1, $2)
         ON CONFLICT (org_id, domain) DO UPDATE SET daily_cap = EXCLUDED.daily_cap
         RETURNING id, domain, daily_cap`,
        [body.domain, body.daily_cap],
      );
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'grow_domain_policies.upsert',
        entityType: 'grow_domain_policies', entityId: (row as { id: string }).id, ip: req.ip, diff: body,
      });
      return row;
    });
  });

  app.patch('/grow/domain-policies/:id', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = domainPolicyCapPatch.parse(req.body);

    return req.db(async (q) => {
      const row = await q.one(
        `UPDATE grow_domain_policies SET daily_cap = $2 WHERE id = $1 RETURNING id, domain, daily_cap`,
        [id, body.daily_cap],
      );
      if (!row) throw new HttpError(404, 'Domain policy not found', 'not_found');
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'grow_domain_policies.update',
        entityType: 'grow_domain_policies', entityId: id, ip: req.ip, diff: body,
      });
      return row;
    });
  });

  app.delete('/grow/domain-policies/:id', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    return req.db(async (q) => {
      const existing = await q.one<{ domain: string }>(`SELECT domain FROM grow_domain_policies WHERE id = $1`, [id]);
      if (!existing) throw new HttpError(404, 'Domain policy not found', 'not_found');
      if (existing.domain === '*') {
        throw new HttpError(400, "The '*' default rule can't be removed — edit its cap instead", 'invalid_input');
      }
      await q.exec(`DELETE FROM grow_domain_policies WHERE id = $1`, [id]);
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'grow_domain_policies.delete',
        entityType: 'grow_domain_policies', entityId: id, ip: req.ip, diff: { domain: existing.domain },
      });
      return { ok: true };
    });
  });

  // ---- Schedule projection ----------------------------------------------------------
  //
  // Everything the "schedule & pacing" tab needs beyond the campaign row
  // itself (window_start/end/timezone/weekdays_only/daily_target are just
  // columns on grow_campaigns — the existing PATCH /grow/campaigns/:id
  // already edits them, no new endpoint needed for that half of the page).

  app.get('/grow/campaigns/:id/schedule-projection', async (req) => {
    req.requireRole('viewer');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    return req.db(async (q) => {
      // start_date/end_date cast to text for the same reason CAMPAIGN_FIELDS
      // does — a bare `date` column comes back from node-postgres as a JS
      // Date, and this endpoint needs a plain "YYYY-MM-DD" string both to
      // compare against completion_date (itself a plain string) and to
      // hand to new Date() below without a second, redundant conversion.
      const campaign = await q.one<{
        timezone: string; weekdays_only: boolean; daily_target: number;
        start_date: string | null; end_date: string | null;
      }>(
        `SELECT timezone, weekdays_only, daily_target, start_date::text, end_date::text
           FROM grow_campaigns WHERE id = $1`,
        [id],
      );
      if (!campaign) throw new HttpError(404, 'Campaign not found', 'not_found');

      // Same-shaped remaining-sends count as the projection's job requires:
      // one row per (active enrollment, still-unsent qualifying step) pair,
      // grouped by recipient domain — everything this campaign still has
      // left to say to everyone currently in it, not just their next email.
      const remainingByDomain = await q.rows<{ domain: string; n: number }>(
        `SELECT c.recipient_domain AS domain, count(*) AS n
           FROM grow_enrollments e
           JOIN grow_contacts c ON c.id = e.contact_id
           JOIN grow_sequence_steps s ON s.campaign_id = e.campaign_id
                                       AND s.step_no > e.current_step
                                       AND (s.applies_to_rank IS NULL OR s.applies_to_rank = c.contact_rank)
          WHERE e.campaign_id = $1 AND e.state = 'active'
          GROUP BY c.recipient_domain`,
        [id],
      );

      const mailboxRows = await q.rows<{ status: string; warmup_started_on: string | null; steady_cap: number }>(
        `SELECT status, warmup_started_on, steady_cap FROM grow_mailboxes`,
      );
      const policyRows = await q.rows<{ domain: string; daily_cap: number }>(
        `SELECT domain, daily_cap FROM grow_domain_policies`,
      );

      const domainCaps = new Map(policyRows.filter((p) => p.domain !== '*').map((p) => [p.domain, p.daily_cap]));
      const fallbackCap = policyRows.find((p) => p.domain === '*')?.daily_cap ?? DEFAULT_FALLBACK_CAP;
      const mailboxes = mailboxRows.map((m) => ({
        status: m.status,
        warmupStartedOn: m.warmup_started_on ? new Date(m.warmup_started_on) : null,
        steadyCap: m.steady_cap,
      }));

      const startDateStr = campaign.start_date;
      const endDateStr = campaign.end_date;
      const startDate = startDateStr ? new Date(startDateStr) : null;
      const endDate = endDateStr ? new Date(endDateStr) : null;
      const domainRemaining = new Map(remainingByDomain.map((r) => [r.domain, r.n]));

      const projection = projectSchedule({
        mailboxes,
        domainRemaining,
        domainCaps,
        fallbackCap,
        dailyTarget: campaign.daily_target,
        weekdaysOnly: campaign.weekdays_only,
        timezone: campaign.timezone,
        startDate,
        endDate,
      });

      // Only meaningful once end_date is actually set — with none, there's
      // no deadline to be on or off track against, and asking "what target
      // would finish it in time" doesn't mean anything.
      // remaining_sends === 0 means there's nothing left to project at all
      // (already fully sent) — trivially on track regardless of what
      // completion_date reads, not "off track" just because nothing ran.
      const onTrack = !endDateStr
        ? null
        : projection.remaining_sends === 0
          ? true
          : projection.completion_date !== null && projection.completion_date <= endDateStr;
      const neededDailyTarget = endDate && onTrack === false
        ? neededDailyTargetForDeadline({
            mailboxes, domainRemaining, domainCaps, fallbackCap,
            weekdaysOnly: campaign.weekdays_only, timezone: campaign.timezone, startDate, endDate,
          })
        : null;

      // Circuit breaker, scoped to this campaign specifically — same
      // definitions as scheduler.js's circuitBreaker() (WHERE campaign_id =
      // $2), unlike /grow/stats' org-wide dashboard rollup.
      const totals = await q.one<{ sent: number; bounced: number }>(
        `SELECT count(*) FILTER (WHERE status = 'sent') AS sent,
                count(*) FILTER (WHERE status = 'bounced') AS bounced
           FROM grow_messages WHERE campaign_id = $1`,
        [id],
      );
      const complaints = await q.one<{ n: number }>(
        `SELECT count(*) AS n FROM grow_events e
           JOIN grow_messages m ON m.id = e.message_id
          WHERE e.type = 'complaint' AND m.campaign_id = $1`,
        [id],
      );
      const sent = totals?.sent ?? 0;
      const bounceRate = sent > 0 ? (totals!.bounced / sent) : 0;
      const complaintRate = sent > 0 ? ((complaints?.n ?? 0) / sent) : 0;

      // Mailbox warmup ramps for the chart — org-wide, same as the mailbox
      // list itself; not filtered to this campaign because sending
      // infrastructure isn't campaign-scoped.
      const mailboxesForChart = await q.rows<{
        id: string; address: string; warmup_started_on: string | null; steady_cap: number; status: string;
      }>(
        `SELECT id, address, warmup_started_on, steady_cap, status FROM grow_mailboxes ORDER BY address`,
      );

      return {
        circuit_breaker: {
          sent, bounced: totals?.bounced ?? 0, complaints: complaints?.n ?? 0,
          bounce_rate: bounceRate, bounce_threshold: BOUNCE_PAUSE_RATE,
          complaint_rate: complaintRate, complaint_threshold: COMPLAINT_PAUSE_RATE,
          sample_size_met: sent >= MIN_SAMPLE, min_sample: MIN_SAMPLE,
        },
        projection: {
          ...projection,
          start_date: startDateStr,
          end_date: endDateStr,
          on_track: onTrack,
          needed_daily_target: neededDailyTarget,
        },
        mailbox_ramps: mailboxesForChart.map((m) => ({
          id: m.id, address: m.address, status: m.status, steady_cap: m.steady_cap,
          warmup_started_on: m.warmup_started_on,
          steady_cap_date: m.warmup_started_on
            ? steadyCapDate(new Date(m.warmup_started_on), m.steady_cap).toISOString().slice(0, 10)
            : null,
          current_cap: m.warmup_started_on
            ? mailboxCapOnDate(
                { status: m.status, warmupStartedOn: new Date(m.warmup_started_on), steadyCap: m.steady_cap },
                new Date(new Date().toISOString().slice(0, 10)),
              )
            : 0,
          points: m.warmup_started_on ? rampPoints(new Date(m.warmup_started_on), m.steady_cap) : [],
        })),
      };
    });
  });

  // ---- Contacts ---------------------------------------------------------------

  app.get('/grow/contacts', async (req) => {
    req.requireRole('viewer');
    const filter = contactListQuery.parse(req.query);
    const offset = (filter.page - 1) * 50;

    return req.db((q) =>
      q.rows(
        `SELECT c.id, c.email, c.first_name, c.contact_name, c.role, c.contact_rank,
                c.entity_name, c.region, c.city, c.state, c.recipient_domain, c.tier,
                c.is_chain, c.domain_rank, c.source_profile, c.created_at,
                en.id AS enrollment_id, en.state AS latest_enrollment_state, en.campaign_id AS enrollment_campaign_id,
                s.id AS suppression_id, s.reason AS suppression_reason, s.created_at AS suppression_created_at
           FROM grow_contacts c
           ${CONTACT_JOIN_SQL}
          WHERE ${CONTACT_FILTER_SQL}
          ORDER BY c.created_at DESC
          LIMIT 50 OFFSET $8`,
        [...contactFilterParams(filter), offset],
      ),
    );
  });

  // "Select all matching this filter" without shipping the whole list back
  // just to read off ids — same filters as the list above, id-only, capped
  // well above anything this app's contact volumes actually reach so a
  // bulk action never silently acts on fewer rows than the count it showed.
  const CONTACT_IDS_LIMIT = 5000;

  app.get('/grow/contacts/ids', async (req) => {
    req.requireRole('viewer');
    const filter = contactFilterQuery.parse(req.query);

    return req.db(async (q) => {
      const rows = await q.rows<{ id: string }>(
        `SELECT c.id
           FROM grow_contacts c
           ${CONTACT_JOIN_SQL}
          WHERE ${CONTACT_FILTER_SQL}
          ORDER BY c.created_at DESC
          LIMIT $8`,
        [...contactFilterParams(filter), CONTACT_IDS_LIMIT + 1],
      );
      const truncated = rows.length > CONTACT_IDS_LIMIT;
      return { ids: rows.slice(0, CONTACT_IDS_LIMIT).map((r) => r.id), truncated };
    });
  });

  const contactCreateInput = z.object({
    email: z.string().trim().toLowerCase().email(),
    first_name: z.string().trim().min(1).max(100).optional(),
    contact_name: z.string().trim().min(1).max(200).optional(),
    role: z.string().trim().min(1).max(200).optional(),
    entity_name: z.string().trim().min(1).max(200).optional(),
    region: z.string().trim().min(1).max(100).optional(),
    city: z.string().trim().min(1).max(100).optional(),
    state: z.string().trim().min(1).max(100).optional(),
    contact_rank: z.number().int().min(1).default(1),
    tier: z.string().trim().min(1).max(50).optional(),
  });

  // One-at-a-time create — for a test contact, not a replacement for the
  // CSV/XLSX import flow above (growContactImport.ts is still the only
  // path that understands wide-format unpivoting, scholarship flags, and
  // the rest of the real import shape). recipient_domain and
  // is_free_provider are required, typed columns on grow_contacts (not
  // attrs) same as an imported row, so they're derived here rather than
  // left for the caller to get wrong — recipient_domain from the email
  // itself, is_free_provider from the same consumer-domain list the
  // per-domain caps table already flags.
  app.post('/grow/contacts', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const body = contactCreateInput.parse(req.body);
    const recipientDomain = body.email.split('@')[1]!;

    return req.db(async (q) => {
      const contact = await q.one(
        `INSERT INTO grow_contacts
           (org_id, email, first_name, contact_name, role, entity_name, region, city, state,
            recipient_domain, is_free_provider, contact_rank, tier, source_profile)
         VALUES (app.current_org(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'manual')
         ON CONFLICT (org_id, email) DO NOTHING
         RETURNING id, email, first_name, contact_name, role, contact_rank, entity_name, region, city, state,
                   recipient_domain, tier, is_chain, domain_rank, source_profile, created_at`,
        [body.email, body.first_name ?? null, body.contact_name ?? null, body.role ?? null,
         body.entity_name ?? null, body.region ?? null, body.city ?? null, body.state ?? null,
         recipientDomain, isConsumerDomain(recipientDomain), body.contact_rank, body.tier ?? null],
      );
      if (!contact) throw new HttpError(409, `${body.email} already exists`, 'duplicate_contact');
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'grow_contacts.create',
        entityType: 'grow_contacts', entityId: (contact as { id: string }).id, ip: req.ip,
        diff: { email: body.email },
      });
      return contact;
    });
  });

  app.delete('/grow/contacts/:id', async (req) => {
    req.requireRole('manager');
    const sess = req.requireAuth();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    return req.db(async (q) => {
      const contact = await q.one<{ id: string; email: string }>(
        `SELECT id, email FROM grow_contacts WHERE id = $1`, [id],
      );
      if (!contact) throw new HttpError(404, 'Contact not found', 'not_found');

      const hasHistory = await q.one(`SELECT 1 FROM grow_messages WHERE contact_id = $1 LIMIT 1`, [id]);
      if (hasHistory) {
        throw new HttpError(
          409,
          `${contact.email} has a send history — deleting it would destroy that compliance record. Suppress it instead to stop any further sends.`,
          'has_message_history',
        );
      }

      // grow_enrollments cascades from grow_contacts already (009_grow.sql);
      // grow_messages never does (its own history above already ruled out
      // any existing here) — nothing left to clean up by hand.
      await q.exec(`DELETE FROM grow_contacts WHERE id = $1`, [id]);
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'grow_contacts.delete',
        entityType: 'grow_contacts', entityId: id, ip: req.ip, diff: { email: contact.email },
      });
      return { deleted: true };
    });
  });

  app.post('/grow/contacts/bulk-delete', async (req) => {
    req.requireRole('manager');
    const sess = req.requireAuth();
    const { ids } = bulkIdsInput.parse(req.body);

    return req.db(async (q) => {
      const blocked = await q.rows<{ id: string; email: string }>(
        `SELECT id, email FROM grow_contacts c
          WHERE id = ANY($1)
            AND EXISTS (SELECT 1 FROM grow_messages m WHERE m.contact_id = c.id)`,
        [ids],
      );
      const blockedIds = new Set(blocked.map((b) => b.id));
      const deletable = ids.filter((i) => !blockedIds.has(i));

      const deleted = deletable.length > 0
        ? await q.exec(`DELETE FROM grow_contacts WHERE id = ANY($1)`, [deletable])
        : 0;

      if (deleted > 0) {
        await audit(q, {
          orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'grow_contacts.bulk_delete',
          entityType: 'grow_contacts', ip: req.ip,
          diff: { requested: ids.length, deleted, blocked: blocked.length },
        });
      }
      return { deleted, blocked: blocked.map((b) => ({ id: b.id, email: b.email })) };
    });
  });

  app.post('/grow/contacts/:id/suppress', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    return req.db(async (q) => {
      const contact = await q.one<{ email: string }>(`SELECT email FROM grow_contacts WHERE id = $1`, [id]);
      if (!contact) throw new HttpError(404, 'Contact not found', 'not_found');

      // Manual is the only reason a person clicking a button can honestly
      // claim — unsubscribed/hard_bounce/complaint/chain_overflow are set
      // by an automated signal (a reply-poller, a bounce webhook, the
      // worker), none of which exist yet. ON CONFLICT DO NOTHING so this
      // can never downgrade an existing stronger suppression back to manual.
      const inserted = await q.one<{ id: string; reason: string; created_at: string }>(
        `INSERT INTO grow_suppressions (org_id, email, reason)
         VALUES (app.current_org(), $1, 'manual')
         ON CONFLICT (org_id, email) DO NOTHING
         RETURNING id, reason, created_at`,
        [contact.email],
      );
      if (!inserted) {
        const existing = await q.one<{ id: string; reason: string; created_at: string }>(
          `SELECT id, reason, created_at FROM grow_suppressions WHERE org_id = app.current_org() AND email = $1`,
          [contact.email],
        );
        return { alreadySuppressed: true, suppression: existing };
      }
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'grow_contacts.suppress',
        entityType: 'grow_contacts', entityId: id, ip: req.ip, diff: { email: contact.email, reason: 'manual' },
      });
      return { alreadySuppressed: false, suppression: inserted };
    });
  });

  app.post('/grow/contacts/bulk-suppress', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const { ids } = bulkIdsInput.parse(req.body);

    return req.db(async (q) => {
      const contacts = await q.rows<{ email: string }>(
        `SELECT DISTINCT email FROM grow_contacts WHERE id = ANY($1)`, [ids],
      );
      const suppressed = await q.exec(
        `INSERT INTO grow_suppressions (org_id, email, reason)
         SELECT app.current_org(), e, 'manual' FROM unnest($1::text[]) AS e
         ON CONFLICT (org_id, email) DO NOTHING`,
        [contacts.map((c) => c.email)],
      );
      const alreadySuppressed = contacts.length - suppressed;
      if (suppressed > 0) {
        await audit(q, {
          orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'grow_contacts.bulk_suppress',
          entityType: 'grow_contacts', ip: req.ip,
          diff: { requested: ids.length, suppressed, alreadySuppressed },
        });
      }
      return { suppressed, alreadySuppressed };
    });
  });

  // Un-suppress. Only 'manual' rows — a suppression from an actual bounce,
  // complaint, or unsubscribe is the recipient's own signal, not something
  // a staff member gets to override from this screen.
  app.delete('/grow/suppressions/:id', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    return req.db(async (q) => {
      const row = await q.one<{ email: string; reason: string }>(
        `SELECT email, reason FROM grow_suppressions WHERE id = $1`, [id],
      );
      if (!row) throw new HttpError(404, 'Suppression not found', 'not_found');
      if (row.reason !== 'manual') {
        throw new HttpError(
          400,
          `Can't remove a '${row.reason}' suppression — only ones added manually can be undone.`,
          'not_manual',
        );
      }
      await q.exec(`DELETE FROM grow_suppressions WHERE id = $1`, [id]);
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'grow_contacts.unsuppress',
        entityType: 'grow_suppressions', entityId: id, ip: req.ip, diff: { email: row.email },
      });
      return { unsuppressed: true };
    });
  });

  // Removes an enrollment, keeps the contact. If this was the rank-1 side
  // of a gate (see 009_grow.sql — a rank-2 contact waits for the rank-1
  // contact in the same campaign to go quiet before entering the queue),
  // whatever was gated on it would otherwise wait forever for an
  // enrollment that no longer exists, so that gate is cleared first.
  app.delete('/grow/enrollments/:id', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    return req.db(async (q) => {
      const enrollment = await q.one<{ id: string; contact_id: string; campaign_id: string }>(
        `SELECT id, contact_id, campaign_id FROM grow_enrollments WHERE id = $1`, [id],
      );
      if (!enrollment) throw new HttpError(404, 'Enrollment not found', 'not_found');

      const ungated = await q.exec(
        `UPDATE grow_enrollments SET gated_on_contact_id = NULL
          WHERE campaign_id = $1 AND gated_on_contact_id = $2`,
        [enrollment.campaign_id, enrollment.contact_id],
      );
      await q.exec(`DELETE FROM grow_enrollments WHERE id = $1`, [id]);
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'grow_enrollments.delete',
        entityType: 'grow_enrollments', entityId: id, ip: req.ip,
        diff: { contact_id: enrollment.contact_id, campaign_id: enrollment.campaign_id, ungated },
      });
      return { removed: true, ungated };
    });
  });

  // Bulk counterpart, shaped around what the contacts list actually
  // selects (contacts, filtered to one campaign) rather than enrollment
  // ids the client would otherwise have no easy way to gather for a
  // "select all matching this filter" selection spanning pages.
  app.post('/grow/campaigns/:id/remove-contacts', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { ids } = bulkIdsInput.parse(req.body);

    return req.db(async (q) => {
      const campaign = await q.one(`SELECT id FROM grow_campaigns WHERE id = $1`, [id]);
      if (!campaign) throw new HttpError(404, 'Campaign not found', 'not_found');

      const ungated = await q.exec(
        `UPDATE grow_enrollments SET gated_on_contact_id = NULL
          WHERE campaign_id = $1 AND gated_on_contact_id = ANY($2)`,
        [id, ids],
      );
      const removed = await q.exec(
        `DELETE FROM grow_enrollments WHERE campaign_id = $1 AND contact_id = ANY($2)`,
        [id, ids],
      );
      if (removed > 0) {
        await audit(q, {
          orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'grow_enrollments.bulk_delete',
          entityType: 'grow_campaigns', entityId: id, ip: req.ip,
          diff: { requested: ids.length, removed, ungated },
        });
      }
      return { removed, ungated };
    });
  });

  const clearAllContactsInput = z.object({ confirm: z.string() });

  // For undoing a bad import wholesale, not a per-contact tool. Two
  // guardrails a per-contact delete doesn't need: can't be mid-send (a
  // running campaign could be actively working through the very list this
  // would erase), and — same rule as the single/bulk delete above — refuses
  // outright the moment this org has sent any real mail, since pausing a
  // campaign first would otherwise be all it takes to route around that
  // protection and erase the compliance record it exists to protect.
  app.post('/grow/contacts/clear-all', async (req) => {
    req.requireRole('manager');
    const sess = req.requireAuth();
    const { confirm } = clearAllContactsInput.parse(req.body);

    return req.db(async (q) => {
      const org = await q.one<{ name: string }>(`SELECT name FROM organizations WHERE id = app.current_org()`);
      if (!org || confirm.trim() !== org.name) {
        throw new HttpError(400, `Type the org name exactly ("${org?.name ?? ''}") to confirm.`, 'confirmation_mismatch');
      }
      const running = await q.one<{ name: string }>(`SELECT name FROM grow_campaigns WHERE status = 'running' LIMIT 1`);
      if (running) {
        throw new HttpError(409, `Can't clear contacts while "${running.name}" is running — pause it first.`, 'campaign_running');
      }
      const hasHistory = await q.one(`SELECT 1 FROM grow_messages LIMIT 1`);
      if (hasHistory) {
        throw new HttpError(
          409,
          'This org has sent mail on record — clearing every contact would destroy that compliance history. Delete or suppress individual contacts instead.',
          'has_message_history',
        );
      }

      const deleted = await q.exec(`DELETE FROM grow_contacts`, []);
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'grow_contacts.clear_all',
        entityType: 'grow_contacts', ip: req.ip, diff: { deleted },
      });
      return { deleted };
    });
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
        region: string | null; city: string | null; enrollment: number | null;
        recipient_domain: string; is_free_provider: boolean; contact_rank: number;
        attrs: Record<string, unknown>;
        enrollment_id: string; campaign_id: string; campaign_name: string;
        current_step: number;
      }>(
        `SELECT c.id AS contact_id, c.email, c.first_name, c.contact_name, c.role,
                c.entity_name, c.region, c.city, c.enrollment,
                c.recipient_domain, c.is_free_provider, c.contact_rank, c.attrs,
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
        region: enrolled.region,
        city: enrolled.city,
        enrollment: enrolled.enrollment,
        recipient_domain: enrolled.recipient_domain,
        is_free_provider: enrolled.is_free_provider,
        contact_rank: enrolled.contact_rank,
        attrs: enrolled.attrs,
      };

      // Suppression is enforced here regardless of the enrollment's own
      // state — an 'active' enrollment doesn't mean this address is safe
      // to mail; grow_suppressions is the org-wide, permanent no-send list
      // (unsubscribes, hard bounces, complaints, and manual suppressions
      // all land here) and this is the one place today that actually shows
      // what a send would do, so it's checked ahead of the template render
      // below, not left for the (not yet built) worker to be the first and
      // only thing that ever checks it.
      const suppression = await q.one<{ reason: string }>(
        `SELECT reason FROM grow_suppressions WHERE org_id = app.current_org() AND email = $1`,
        [enrolled.email],
      );

      const rendered = await renderStepForContact(q, step, contactForRender);
      const refused = !!suppression || rendered.refused;
      const refusalReason = suppression
        ? `refused to send: ${enrolled.email} is suppressed (${suppression.reason})`
        : rendered.refusal_reason;

      return {
        contact_id: enrolled.contact_id,
        campaign_id: enrolled.campaign_id,
        campaign_name: enrolled.campaign_name,
        enrollment_id: enrolled.enrollment_id,
        step_no: step.step_no,
        to: enrolled.email,
        subject: rendered.subject,
        body: rendered.body,
        unsubscribe_url: rendered.unsubscribe_url,
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
