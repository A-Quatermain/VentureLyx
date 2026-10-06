/**
 * Venturelyx :: weekly AI answer check.
 *
 * Asks the org's configured LLM provider a handful of real local-search
 * questions built from the org's OWN services (catalog_items) and cities
 * (locations) — "best pool heater repair in Coral Springs" — and records
 * whether the business got mentioned, roughly where in the model's own
 * list, and which competitors came up instead. Writes to ai_answer_checks
 * (db/migrations/017_ai_answer_checks.sql).
 *
 * This is explicitly a SAMPLE of one model's answer on the day it was
 * asked — not a ranking, not a guarantee of placement, and not the same
 * thing as a real Google position (seo_rank_current) or real GSC data
 * (seo_gsc_daily). The UI is responsible for saying so every time this is
 * shown; this script only ever writes what the model actually said.
 *
 * Same image as the api/grow-worker services, different command — see
 * infra/docker-compose.workers.yml. Run weekly (not per-crawl) via a one-off
 * container invocation from cron, the same way scripts/gsc_sync.py --all-due
 * runs daily:
 *
 *   docker compose -f infra/docker-compose.workers.yml --env-file infra/.env \
 *     run --rm grow-worker node dist/worker/aiVisibilityCheck.js --all-due
 *
 * Usage:
 *   node dist/worker/aiVisibilityCheck.js --all-due      every org due this week
 *   node dist/worker/aiVisibilityCheck.js --org <uuid>   one org, regardless of due date
 */
import pino from 'pino';
import { withPlatform, withTenant } from '../lib/db.js';
import type { Querier } from '../lib/db.js';
import { resolveAIContext, streamAI, logAiUsage, type AIStreamEvent } from '../lib/ai.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });

for (const key of ['DATABASE_URL', 'VAULT_KEY']) {
  if (!process.env[key]) {
    log.fatal(`FATAL: ${key} is not set`);
    process.exit(1);
  }
}

const FEATURE = 'ai_visibility_check' as const;
const MAX_QUERIES_PER_ORG = 5;

interface QueryTarget {
  service: string;
  city: string;
  query: string;
}

function buildQueries(services: string[], cities: string[]): QueryTarget[] {
  const targets: QueryTarget[] = [];
  outer: for (const city of cities) {
    for (const service of services) {
      targets.push({ service, city, query: `best ${service.toLowerCase()} in ${city}` });
      if (targets.length >= MAX_QUERIES_PER_ORG) break outer;
    }
  }
  return targets;
}

// Numbered-list format keeps parsing deterministic — we ask for an ordered
// list rather than freeform prose we'd otherwise have to guess the shape of.
function buildPrompt(query: string): string {
  return (
    `A local customer searches: "${query}"\n\n` +
    `List the top 5 businesses you would recommend, in order, one per line, ` +
    `formatted exactly as "1. Business Name — one-sentence reason". ` +
    `If you don't have enough real information to name actual businesses for ` +
    `this area, say so plainly instead of inventing any.`
  );
}

interface ParsedAnswer {
  mentioned: boolean;
  position: number | null;
  competitors: string[];
}

function parseAnswer(businessName: string, text: string): ParsedAnswer {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const listed: string[] = [];
  for (const line of lines) {
    const m = line.match(/^\d+[.)]\s*(.+?)(?:\s*[—–-]\s*.*)?$/);
    if (m?.[1]) listed.push(m[1].trim());
  }
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = normalize(businessName);

  let position: number | null = null;
  listed.forEach((name, i) => {
    if (position === null && target.length > 0 && normalize(name).includes(target)) {
      position = i + 1;
    }
  });
  // "Mentioned" is a plain substring check over the whole response, not just
  // the parsed list — a model that name-drops the business without putting
  // it in a numbered slot should still count as a mention.
  const mentioned = position !== null || text.toLowerCase().includes(businessName.toLowerCase());
  const competitors = listed.filter((name) => !normalize(name).includes(target)).slice(0, 5);

  return { mentioned, position, competitors };
}

async function collectText(
  gen: AsyncGenerator<AIStreamEvent>,
): Promise<{ text: string; meta: { provider: string; model: string } | null }> {
  let text = '';
  let meta: { provider: string; model: string } | null = null;
  for await (const event of gen) {
    if (event.type === 'delta') text += event.text;
    if (event.type === 'meta') meta = { provider: event.provider, model: event.model };
  }
  return { text, meta };
}

// Web search results get spliced into the model's context, which pushes a
// query's token cost well above a plain completion — verified live: this
// tripped OpenAI's per-minute token limit after 2-3 of 5 queries in testing,
// where a non-search call never came close. A 429 here is a "wait," not a
// "give up" — one retry on the provider's own suggested delay recovers the
// query instead of silently dropping it from the week's sample.
function rateLimitDelayMs(err: unknown): number | null {
  const status = (err as { status?: number })?.status;
  if (status !== 429) return null;
  const headers = (err as { headers?: Record<string, string> })?.headers;
  const ms = Number(headers?.['retry-after-ms']);
  if (Number.isFinite(ms) && ms > 0) return ms;
  const secs = Number(headers?.['retry-after']);
  if (Number.isFinite(secs) && secs > 0) return secs * 1000;
  return 5000;
}

async function collectTextWithRetry(
  makeGen: () => AsyncGenerator<AIStreamEvent>,
): Promise<{ text: string; meta: { provider: string; model: string } | null }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await collectText(makeGen());
    } catch (err) {
      const delay = rateLimitDelayMs(err);
      if (delay === null || attempt >= 2) throw err;
      log.warn({ attempt, delayMs: delay }, 'rate limited, retrying after delay');
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

interface OrgSetup {
  orgName: string;
  siteId: string;
  services: string[];
  cities: string[];
  ctx: Awaited<ReturnType<typeof resolveAIContext>>;
}

async function loadOrgSetup(orgId: string): Promise<OrgSetup | null> {
  return withTenant({ orgId, userId: null, isStaff: false }, async (q) => {
    const org = await q.one<{ name: string }>(`SELECT name FROM organizations WHERE id = $1`, [orgId]);
    const site = await q.one<{ id: string }>(
      `SELECT id FROM seo_sites WHERE org_id = $1 AND is_primary LIMIT 1`,
      [orgId],
    );
    if (!org || !site) return null;

    const services = await q.rows<{ name: string }>(
      `SELECT name FROM catalog_items
        WHERE org_id = $1 AND is_active AND kind = 'service'
        ORDER BY priority, name LIMIT 10`,
      [orgId],
    );
    const cities = await q.rows<{ name: string }>(
      `SELECT name FROM locations
        WHERE org_id = $1 AND is_active
        ORDER BY priority, name LIMIT 10`,
      [orgId],
    );
    if (services.length === 0 || cities.length === 0) return null;

    const ctx = await resolveAIContext(q, orgId, FEATURE);
    return { orgName: org.name, siteId: site.id, services: services.map((s) => s.name),
      cities: cities.map((c) => c.name), ctx };
  });
}

async function recordCheck(
  orgId: string,
  siteId: string,
  target: QueryTarget,
  meta: { provider: string; model: string },
  parsed: ParsedAnswer,
  responseText: string,
): Promise<void> {
  await withTenant({ orgId, userId: null, isStaff: false }, (q) =>
    q.exec(
      `INSERT INTO ai_answer_checks
         (org_id, site_id, query, provider, model, mentioned, position, competitors, response_excerpt)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [orgId, siteId, target.query, meta.provider, meta.model, parsed.mentioned, parsed.position,
        parsed.competitors, responseText.slice(0, 2000)],
    ),
  );
}

async function checkOrg(orgId: string): Promise<number> {
  const setup = await loadOrgSetup(orgId);
  if (!setup) {
    log.info({ orgId }, 'skipped: no primary site, or no active services/cities to build a query from');
    return 0;
  }
  if (setup.ctx.capExceeded) {
    log.info({ orgId }, 'skipped: monthly AI spend cap reached');
    return 0;
  }

  const targets = buildQueries(setup.services, setup.cities);
  let n = 0;
  for (const target of targets) {
    // No Querier held open across the AI call itself — same reasoning as
    // every HTTP route in routes/ai.ts (see ai.ts's StreamAIOptions comment).
    // A function, not a value: collectTextWithRetry needs a fresh generator
    // per attempt, since a partially-consumed one can't be replayed.
    const makeGen = () => streamAI({
      orgId,
      feature: FEATURE,
      system: 'You answer local-search questions the way a knowledgeable local resident would. '
        + 'Search the web for real, current businesses rather than relying on memory, and name '
        + 'only ones you actually found.',
      messages: [{ role: 'user', content: buildPrompt(target.query) }],
      providerPreference: setup.ctx.providerPreference,
      clients: setup.ctx.clients,
      modelOverride: setup.ctx.modelOverride,
      // Without this, the model is answering from stale training data alone
      // and almost always declines rather than naming real businesses — the
      // whole point is to sample what a customer asking a browsing-grounded
      // assistant (ChatGPT, Perplexity, AI Overviews) actually sees today.
      webSearch: true,
      onUsage: (usage) =>
        withTenant({ orgId, userId: null, isStaff: false }, (q) =>
          logAiUsage(q, { orgId, feature: FEATURE, ...usage })),
    });

    let result: { text: string; meta: { provider: string; model: string } | null };
    try {
      result = await collectTextWithRetry(makeGen);
    } catch (err) {
      log.error({ orgId, query: target.query, err }, 'AI call failed for this query, skipping');
      continue;
    }
    if (!result.meta || !result.text) continue;

    const parsed = parseAnswer(setup.orgName, result.text);
    await recordCheck(orgId, setup.siteId, target, result.meta, parsed, result.text);
    n++;
  }
  return n;
}

async function findDueOrgs(): Promise<string[]> {
  const rows = await withPlatform((q) =>
    q.rows<{ id: string }>(
      `SELECT DISTINCT s.org_id AS id
         FROM seo_sites s
         JOIN catalog_items ci ON ci.org_id = s.org_id AND ci.is_active AND ci.kind = 'service'
         JOIN locations l ON l.org_id = s.org_id AND l.is_active
        WHERE s.is_primary
          AND NOT EXISTS (
            SELECT 1 FROM ai_answer_checks c
             WHERE c.org_id = s.org_id AND c.checked_at > now() - interval '6 days'
          )`,
    ),
  );
  return rows.map((r) => r.id);
}

async function main() {
  const args = process.argv.slice(2);
  const allDue = args.includes('--all-due');
  const orgFlagIdx = args.indexOf('--org');
  const singleOrg = orgFlagIdx >= 0 ? args[orgFlagIdx + 1] : null;

  if (!allDue && !singleOrg) {
    console.error('Usage: aiVisibilityCheck.js --all-due | --org <uuid>');
    process.exit(1);
  }

  const orgIds = singleOrg ? [singleOrg] : await findDueOrgs();
  log.info({ orgs: orgIds.length }, 'ai visibility check starting');

  let totalQueries = 0;
  for (const orgId of orgIds) {
    try {
      const n = await checkOrg(orgId);
      totalQueries += n;
      log.info({ orgId, queries: n }, 'org done');
    } catch (err) {
      log.error({ orgId, err }, 'org failed');
    }
  }

  log.info({ orgs: orgIds.length, queries: totalQueries }, 'ai visibility check done');
  process.exit(0);
}

main().catch((err) => {
  log.fatal({ err }, 'fatal');
  process.exit(1);
});
