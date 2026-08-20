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
import type { Querier } from './db.js';

export type Tier = 'heavy' | 'primary' | 'cheap';

export type Feature =
  | 'seo_recommendations'
  | 'page_generation'
  | 'review_response'
  | 'next_best_action'
  | 'metric_explanation'
  | 'business_blueprint';

export type Provider = 'anthropic' | 'openai';
export type ProviderPreference = 'auto' | Provider;

const FEATURE_TIER: Record<Feature, Tier> = {
  seo_recommendations: 'primary',
  page_generation: 'primary',
  review_response: 'primary',
  next_best_action: 'primary',
  metric_explanation: 'cheap',
  business_blueprint: 'heavy',
};

// claude-opus-5 / claude-sonnet-5 / claude-haiku-4-5-20251001 are the current
// Claude 5 family model IDs.
const ANTHROPIC_MODEL: Record<Tier, string> = {
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
const OPENAI_MODEL: Record<Tier, string> = {
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

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

function resolveProviderOrder(pref: ProviderPreference): Provider[] {
  const have = { anthropic: !!anthropic, openai: !!openai };
  if (pref === 'anthropic') return [...(have.anthropic ? (['anthropic'] as const) : []), ...(have.openai ? (['openai'] as const) : [])];
  if (pref === 'openai') return [...(have.openai ? (['openai'] as const) : []), ...(have.anthropic ? (['anthropic'] as const) : [])];
  // auto: Anthropic primary, OpenAI fallback — skip whichever has no key.
  return [...(have.anthropic ? (['anthropic'] as const) : []), ...(have.openai ? (['openai'] as const) : [])];
}

export async function getProviderPreference(db: Querier, orgId: string): Promise<ProviderPreference> {
  const row = await db.one<{ modules: { ai_provider?: string } | null }>(
    `SELECT modules FROM organizations WHERE id = $1`,
    [orgId],
  );
  const pref = row?.modules?.ai_provider;
  return pref === 'anthropic' || pref === 'openai' ? pref : 'auto';
}

async function logAiUsage(
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
  db: Querier;
  orgId: string;
  feature: Feature;
  system?: string;
  messages: AIMessage[];
  maxTokens?: number;
  /** Skips the organizations.modules lookup when already known. */
  providerPreference?: ProviderPreference;
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

async function* streamAnthropic(tier: Tier, opts: StreamAIOptions, usage: UsageInfo): AsyncGenerator<string> {
  if (!anthropic) throw new Error('Anthropic is not configured');
  const model = ANTHROPIC_MODEL[tier];
  usage.model = model;

  const stream = anthropic.messages.stream({
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

async function* streamOpenAI(tier: Tier, opts: StreamAIOptions, usage: UsageInfo): AsyncGenerator<string> {
  if (!openai) throw new Error('OpenAI is not configured');
  const model = OPENAI_MODEL[tier];
  usage.model = model;

  if (OPENAI_RESPONSES_ONLY.has(model)) {
    const stream = await openai.responses.create({
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
  const stream = await openai.chat.completions.create({
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
 */
export async function* streamAI(opts: StreamAIOptions): AsyncGenerator<AIStreamEvent, void, unknown> {
  const tier = FEATURE_TIER[opts.feature];
  const pref = opts.providerPreference ?? (await getProviderPreference(opts.db, opts.orgId));
  const order = resolveProviderOrder(pref);
  if (order.length === 0) {
    throw new Error('No AI provider is configured for this deployment');
  }

  let lastErr: unknown;
  for (const [idx, provider] of order.entries()) {
    const usage: UsageInfo = { provider, model: '', approxTokens: 0 };
    let yieldedAny = false;
    try {
      yield { type: 'meta', provider, model: provider === 'anthropic' ? ANTHROPIC_MODEL[tier] : OPENAI_MODEL[tier], fallback: idx > 0 };
      const gen = provider === 'anthropic' ? streamAnthropic(tier, opts, usage) : streamOpenAI(tier, opts, usage);
      for await (const chunk of gen) {
        yieldedAny = true;
        yield { type: 'delta', text: chunk };
      }
      yield { type: 'done' };
      await logAiUsage(opts.db, { orgId: opts.orgId, feature: opts.feature, ...usage });
      return;
    } catch (err) {
      lastErr = err;
      if (yieldedAny) throw err;
      // else: try the next provider in order.
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('All configured AI providers failed');
}

/**
 * Pipes an AIStreamEvent generator to the client as SSE. Hijacks the
 * response so Fastify never tries to also send its own reply.
 */
export async function streamEventsToSSE(
  reply: import('fastify').FastifyReply,
  gen: AsyncGenerator<AIStreamEvent, void, unknown>,
): Promise<void> {
  reply.hijack();
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
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
