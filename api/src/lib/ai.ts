/**
 * Venturelyx :: AI service.
 *
 * Direct SDK calls to Anthropic and OpenAI — no emergentintegrations, no
 * EMERGENT_LLM_KEY, no third-party proxy in front of either provider.
 * Anthropic is primary; OpenAI is the fallback (or primary, per-org). Every
 * completion is logged to ai_usage, RLS-scoped like everything else.
 */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { decryptSecret } from './auth.js';
import type { Querier } from './db.js';

export type Tier = 'heavy' | 'primary' | 'cheap';

export type Feature =
  | 'seo_recommendations'
  | 'page_generation'
  | 'review_response'
  | 'next_best_action'
  | 'metric_explanation'
  | 'business_blueprint'
  | 'sequence_writing'
  | 'ai_visibility_check';

export const FEATURES: Feature[] = [
  'seo_recommendations', 'page_generation', 'review_response',
  'next_best_action', 'metric_explanation', 'business_blueprint', 'sequence_writing',
  'ai_visibility_check',
];

export type Provider = 'anthropic' | 'openai';
export type ProviderPreference = 'auto' | Provider;

export const FEATURE_TIER: Record<Feature, Tier> = {
  seo_recommendations: 'primary',
  page_generation: 'primary',
  review_response: 'primary',
  next_best_action: 'primary',
  metric_explanation: 'cheap',
  business_blueprint: 'heavy',
  sequence_writing: 'primary',
  // Runs several queries per org, weekly, unattended (scripts/ai-visibility-check) —
  // cheap by default since this is a sampling exercise, not a one-off
  // high-stakes generation; an org can still override it in Settings like
  // any other feature.
  ai_visibility_check: 'cheap',
};

// claude-opus-5 / claude-sonnet-5 / claude-haiku-4-5-20251001 are the current
// Claude 5 family model IDs.
export const ANTHROPIC_MODEL: Record<Tier, string> = {
  heavy: 'claude-opus-5',
  primary: 'claude-sonnet-5',
  cheap: 'claude-haiku-4-5-20251001',
};

// Verified live against the configured key (GET /v1/models) rather than
// assumed: gpt-4.1 and gpt-5-nano-2025-08-07 work over Chat Completions;
// gpt-5-pro does not; it only accepts POST /v1/responses (chat/completions
// returns "This model is only supported in v1/responses"). gpt-5-pro is
// also a slow, high-effort reasoning model (~20s for a trivial prompt in
// testing) — appropriate only for the heavy tier, never anything
// interactive.
export const OPENAI_MODEL: Record<Tier, string> = {
  heavy: 'gpt-5-pro',
  primary: 'gpt-4.1',
  cheap: 'gpt-5-nano-2025-08-07',
};
const OPENAI_RESPONSES_ONLY = new Set<string>(['gpt-5-pro']);
// gpt-5-family models are reasoning models: part of max_completion_tokens is
// spent on hidden reasoning before any visible output, and reject the
// legacy max_tokens param outright. A small cap (e.g. the default 1024 used
// for gpt-4.1) can consume its entire budget on reasoning and return an
// empty completion — verified live: 20 tokens produced zero visible output.
const OPENAI_REASONING_FAMILY = (model: string) => model.startsWith('gpt-5');

// Every model either provider can currently be told to use — the Advanced
// per-feature override in Settings picks from exactly this list, never free
// text, so an override can't reference a model name we've never verified.
export const KNOWN_MODELS: Array<{ provider: Provider; model: string; label: string }> = [
  { provider: 'anthropic', model: ANTHROPIC_MODEL.heavy, label: 'Claude Opus 5' },
  { provider: 'anthropic', model: ANTHROPIC_MODEL.primary, label: 'Claude Sonnet 5' },
  { provider: 'anthropic', model: ANTHROPIC_MODEL.cheap, label: 'Claude Haiku 4.5' },
  { provider: 'openai', model: OPENAI_MODEL.heavy, label: 'GPT-5 Pro' },
  { provider: 'openai', model: OPENAI_MODEL.primary, label: 'GPT-4.1' },
  { provider: 'openai', model: OPENAI_MODEL.cheap, label: 'GPT-5 Nano' },
];

// Blended estimate, USD per 1K tokens — for the Settings "estimated cost"
// display and the monthly spend cap only. Not a substitute for each
// provider's real invoice; ai_usage.approx_tokens is itself an estimate
// (or, for gpt-5-pro's Responses API, a real total_tokens count when the
// SDK reports one).
const RATE_PER_1K_TOKENS: Record<string, number> = {
  'claude-opus-5': 0.015,
  'claude-sonnet-5': 0.003,
  'claude-haiku-4-5-20251001': 0.0008,
  'gpt-5-pro': 0.015,
  'gpt-4.1': 0.002,
  'gpt-5-nano-2025-08-07': 0.00015,
};

export function estimateCost(model: string, approxTokens: number): number {
  const rate = RATE_PER_1K_TOKENS[model] ?? 0.002;
  return (approxTokens / 1000) * rate;
}

const sharedAnthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;
const sharedOpenai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

export interface AIClients {
  anthropic: Anthropic | null;
  openai: OpenAI | null;
}

// Bring-your-own keys, decrypted from integrations (org_id, provider,
// external_id='byo') — falls back to the shared env-level client per
// provider when an org hasn't connected its own. Callers resolve this once,
// in their own short req.db(), same reasoning as everything else here: a
// stream can run many seconds and must never hold a Querier open across it.
export async function getAIClients(db: Querier, orgId: string): Promise<AIClients> {
  const rows = await db.rows<{
    provider: string; credential_enc: Buffer; credential_iv: Buffer; credential_tag: Buffer;
  }>(
    `SELECT provider, credential_enc, credential_iv, credential_tag
       FROM integrations
      WHERE org_id = $1 AND provider IN ('anthropic', 'openai') AND external_id = 'byo'
        AND status = 'connected' AND credential_enc IS NOT NULL`,
    [orgId],
  );
  const clients: AIClients = { anthropic: sharedAnthropic, openai: sharedOpenai };
  for (const row of rows) {
    // A BYO row can become permanently undecryptable if VAULT_KEY ever
    // changes after it was saved (the ciphertext was encrypted under the
    // old key) — that's an operational event, not a per-request bug, and
    // must not take down the whole AI feature for the org. Fall back to
    // the shared client for that provider, same as if nothing were
    // connected; Settings' "Connected" status is a separate, human-visible
    // signal that the key needs reconnecting.
    let key: string;
    try {
      key = decryptSecret(row.credential_enc, row.credential_iv, row.credential_tag);
    } catch {
      continue;
    }
    if (row.provider === 'anthropic') clients.anthropic = new Anthropic({ apiKey: key });
    if (row.provider === 'openai') clients.openai = new OpenAI({ apiKey: key });
  }
  return clients;
}

function resolveProviderOrder(pref: ProviderPreference, clients: AIClients): Provider[] {
  const have = { anthropic: !!clients.anthropic, openai: !!clients.openai };
  if (pref === 'anthropic') return [...(have.anthropic ? (['anthropic'] as const) : []), ...(have.openai ? (['openai'] as const) : [])];
  if (pref === 'openai') return [...(have.openai ? (['openai'] as const) : []), ...(have.anthropic ? (['anthropic'] as const) : [])];
  // auto: Anthropic primary, OpenAI fallback — skip whichever has no client.
  return [...(have.anthropic ? (['anthropic'] as const) : []), ...(have.openai ? (['openai'] as const) : [])];
}

export type ModelOverrides = Partial<Record<Feature, { provider: Provider; model: string }>>;

export interface AISettings {
  providerPreference: ProviderPreference;
  spendCapMonthly: number | null;
  modelOverrides: ModelOverrides;
}

const DEFAULT_AI_SETTINGS: AISettings = { providerPreference: 'auto', spendCapMonthly: null, modelOverrides: {} };

// organizations.settings, not .modules — modules is genuinely "which
// modules are enabled" (operate/scaleseo booleans are already live there);
// AI preferences are a config bag, and settings is the column built for
// that.
export async function getAISettings(db: Querier, orgId: string): Promise<AISettings> {
  const row = await db.one<{ settings: Record<string, unknown> | null }>(
    `SELECT settings FROM organizations WHERE id = $1`,
    [orgId],
  );
  const s = row?.settings ?? {};
  const pref = s.ai_provider;
  const cap = s.ai_spend_cap_monthly;
  return {
    providerPreference: pref === 'anthropic' || pref === 'openai' ? pref : 'auto',
    spendCapMonthly: typeof cap === 'number' && cap > 0 ? cap : null,
    modelOverrides: (s.ai_model_overrides as ModelOverrides) ?? {},
  };
}

export async function getMonthlySpend(db: Querier, orgId: string): Promise<number> {
  const rows = await db.rows<{ model: string; approx_tokens: number }>(
    `SELECT model, approx_tokens FROM ai_usage
      WHERE org_id = $1 AND created_at >= date_trunc('month', now())`,
    [orgId],
  );
  return rows.reduce((sum, r) => sum + estimateCost(r.model, r.approx_tokens), 0);
}

export async function logAiUsage(
  db: Querier,
  entry: { orgId: string; feature: Feature; provider: Provider; model: string; approxTokens: number },
): Promise<void> {
  await db.exec(
    `INSERT INTO ai_usage (org_id, feature, provider, model, approx_tokens) VALUES ($1,$2,$3,$4,$5)`,
    [entry.orgId, entry.feature, entry.provider, entry.model, entry.approxTokens],
  );
}

export interface AIMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface StreamAIOptions {
  orgId: string;
  feature: Feature;
  system?: string;
  messages: AIMessage[];
  maxTokens?: number;
  // req.db() opens a transaction for one short-lived callback; a stream can
  // run for many seconds (gpt-5-pro took ~20s for a trivial prompt in
  // testing), so streamAI never holds a Querier open across it — that would
  // pin a pooled connection for the whole request under concurrent AI
  // traffic. Callers resolve all of the below in their own short req.db()
  // upfront and pass the results in here.
  providerPreference: ProviderPreference;
  clients: AIClients;
  /** From AISettings.modelOverrides[feature], if the org set one. */
  modelOverride?: { provider: Provider; model: string };
  onUsage: (entry: { provider: Provider; model: string; approxTokens: number }) => Promise<void>;
}

export type AIStreamEvent =
  | { type: 'meta'; provider: Provider; model: string; fallback: boolean }
  | { type: 'delta'; text: string }
  | { type: 'done' };

interface UsageInfo {
  provider: Provider;
  model: string;
  approxTokens: number;
}

async function* streamAnthropic(
  client: Anthropic, model: string, opts: StreamAIOptions, usage: UsageInfo,
): AsyncGenerator<string> {
  usage.model = model;
  const stream = client.messages.stream({
    model,
    max_tokens: opts.maxTokens ?? 1024,
    system: opts.system,
    messages: opts.messages,
  });
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      yield event.delta.text;
    }
  }
  const final = await stream.finalMessage();
  usage.approxTokens = (final.usage?.input_tokens ?? 0) + (final.usage?.output_tokens ?? 0);
}

async function* streamOpenAI(
  client: OpenAI, model: string, opts: StreamAIOptions, usage: UsageInfo,
): AsyncGenerator<string> {
  usage.model = model;

  if (OPENAI_RESPONSES_ONLY.has(model)) {
    const stream = await client.responses.create({
      model,
      instructions: opts.system,
      input: opts.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    });
    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') {
        yield event.delta;
      } else if (event.type === 'response.completed') {
        usage.approxTokens = event.response.usage?.total_tokens ?? 0;
      }
    }
    return;
  }

  const reasoning = OPENAI_REASONING_FAMILY(model);
  const stream = await client.chat.completions.create({
    model,
    messages: [
      ...(opts.system ? [{ role: 'system' as const, content: opts.system }] : []),
      ...opts.messages,
    ],
    stream: true,
    stream_options: { include_usage: true },
    ...(reasoning
      ? { max_completion_tokens: opts.maxTokens ?? 2000 }
      : { max_tokens: opts.maxTokens ?? 1024 }),
  });
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) yield delta;
    if (chunk.usage) usage.approxTokens = chunk.usage.total_tokens;
  }
}

/**
 * Streams a completion for `feature`, trying providers in preference order.
 * Only falls back to the next provider on a failure that happens before any
 * chunk was yielded (auth/model/connection errors surface immediately for
 * both SDKs) — once real content has started streaming to the caller, a
 * mid-stream failure is not retried, since splicing two different
 * providers' partial output back together isn't something a caller could
 * present coherently.
 *
 * A modelOverride pins both provider and model with no fallback — it's an
 * explicit choice the org made in Settings, not a preference to route
 * around a failure.
 */
export async function* streamAI(opts: StreamAIOptions): AsyncGenerator<AIStreamEvent, void, unknown> {
  const tier = FEATURE_TIER[opts.feature];

  if (opts.modelOverride) {
    const { provider, model } = opts.modelOverride;
    const client = provider === 'anthropic' ? opts.clients.anthropic : opts.clients.openai;
    if (!client) throw new Error(`${provider} is not configured for this deployment`);
    const usage: UsageInfo = { provider, model, approxTokens: 0 };
    yield { type: 'meta', provider, model, fallback: false };
    const gen = provider === 'anthropic'
      ? streamAnthropic(client as Anthropic, model, opts, usage)
      : streamOpenAI(client as OpenAI, model, opts, usage);
    for await (const chunk of gen) yield { type: 'delta', text: chunk };
    yield { type: 'done' };
    await opts.onUsage(usage);
    return;
  }

  const order = resolveProviderOrder(opts.providerPreference, opts.clients);
  if (order.length === 0) {
    throw new Error('No AI provider is configured for this deployment');
  }

  let lastErr: unknown;
  for (const [idx, provider] of order.entries()) {
    const model = provider === 'anthropic' ? ANTHROPIC_MODEL[tier] : OPENAI_MODEL[tier];
    const usage: UsageInfo = { provider, model: '', approxTokens: 0 };
    let yieldedAny = false;
    try {
      yield { type: 'meta', provider, model, fallback: idx > 0 };
      const gen = provider === 'anthropic'
        ? streamAnthropic(opts.clients.anthropic!, model, opts, usage)
        : streamOpenAI(opts.clients.openai!, model, opts, usage);
      for await (const chunk of gen) {
        yieldedAny = true;
        yield { type: 'delta', text: chunk };
      }
      yield { type: 'done' };
      await opts.onUsage(usage);
      return;
    } catch (err) {
      lastErr = err;
      if (yieldedAny) throw err;
      // else: try the next provider in order.
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('All configured AI providers failed');
}

export interface AIContext {
  providerPreference: ProviderPreference;
  clients: AIClients;
  modelOverride?: { provider: Provider; model: string };
  capExceeded: boolean;
}

/** Every AI-backed route's setup boilerplate: settings, clients (shared or
 *  BYO), and whether this org's monthly spend cap is already hit. Shared
 *  by routes/ai.ts and routes/grow.ts's sequence-writing endpoints rather
 *  than each re-deriving it. */
export async function resolveAIContext(db: Querier, orgId: string, feature: Feature): Promise<AIContext> {
  const settings = await getAISettings(db, orgId);
  const clients = await getAIClients(db, orgId);
  let capExceeded = false;
  if (settings.spendCapMonthly !== null) {
    const spent = await getMonthlySpend(db, orgId);
    capExceeded = spent >= settings.spendCapMonthly;
  }
  return {
    providerPreference: settings.providerPreference,
    clients,
    modelOverride: settings.modelOverrides[feature],
    capExceeded,
  };
}

export const CAP_MESSAGE =
  "AI is paused for this business — this month's spend cap has been reached. Raise it in Settings to continue.";

/** A canned, non-streamed "stream" — for a capped org, or a route that
 *  decided there's nothing worth asking the model (e.g. no data to reason
 *  over) — so callers can still hand it to streamEventsToSSE and every
 *  consumer sees the same event shape either way. */
export async function* staticEvents(text: string): AsyncGenerator<AIStreamEvent> {
  yield { type: 'delta', text };
  yield { type: 'done' };
}

// Same origin list @fastify/cors is configured with in server.ts. Duplicated
// here (not imported) because streamEventsToSSE has to compute this itself —
// see the comment below on why.
const CORS_ORIGINS = (process.env.CORS_ORIGINS ?? 'https://app.venturelyx.com').split(',');

/**
 * Pipes an AIStreamEvent generator to the client as SSE. Hijacks the
 * response so Fastify never tries to also send its own reply.
 *
 * reply.hijack() means Fastify's onSend hook never runs for this response —
 * which is exactly where @fastify/cors attaches Access-Control-Allow-Origin/
 * -Credentials. Without reproducing that here, every one of these responses
 * came back 200 with a real streamed body (confirmed live: the request does
 * reach the route, runs the model, and streams real tokens) but with no CORS
 * headers on the actual response — only on its preflight. Browsers allow the
 * preflight and the request itself to go out, then silently discard the
 * response and reject fetch() with a network-level error, which is
 * indistinguishable from the server never having been reached at all.
 */
export async function streamEventsToSSE(
  reply: import('fastify').FastifyReply,
  gen: AsyncGenerator<AIStreamEvent, void, unknown>,
): Promise<void> {
  reply.hijack();
  const origin = reply.request.headers.origin;
  const corsHeaders: Record<string, string> = {};
  if (origin && CORS_ORIGINS.includes(origin)) {
    corsHeaders['Access-Control-Allow-Origin'] = origin;
    corsHeaders['Access-Control-Allow-Credentials'] = 'true';
    corsHeaders['Vary'] = 'Origin';
  }
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...corsHeaders,
  });
  try {
    for await (const event of gen) {
      reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
  } catch (err) {
    reply.raw.write(
      `event: error\ndata: ${JSON.stringify({ message: err instanceof Error ? err.message : 'AI request failed' })}\n\n`,
    );
  } finally {
    reply.raw.end();
  }
}
