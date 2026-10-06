/**
 * Venturelyx :: AI reply classification.
 *
 * One of four tags per real reply (never run on an auto-reply/bounce —
 * those are already classified by growPoller.ts without needing a model at
 * all): interested, not_now, not_a_fit, question. This is the AI's first
 * pass only — Operate's lead list lets a human override it, and the human
 * call always wins (growPromote.ts's reply_tag_source flips to 'human' the
 * moment someone does, and never flips back on its own).
 */
import { resolveAIContext, streamAI, logAiUsage, type AIStreamEvent } from './ai.js';
import type { Querier } from './db.js';
import type { ReplyTag } from './growPromote.js';

const VALID_TAGS: ReplyTag[] = ['interested', 'not_now', 'not_a_fit', 'question'];

const FEATURE = 'reply_classification' as const;

function buildPrompt(replyText: string): string {
  return (
    `A prospect replied to a cold outreach email. Classify the reply as exactly one word, ` +
    `nothing else: interested, not_now, not_a_fit, or question.\n\n` +
    `- interested: wants to move forward, book a call, get pricing, etc.\n` +
    `- not_now: open to it later, bad timing, "check back in a few months."\n` +
    `- not_a_fit: explicitly not interested, wrong audience, asked to stop.\n` +
    `- question: asking something before deciding either way, no clear signal yet.\n\n` +
    `Reply:\n"""\n${replyText.slice(0, 2000)}\n"""\n\n` +
    `Answer with exactly one of: interested / not_now / not_a_fit / question`
  );
}

function parseTag(text: string): ReplyTag | null {
  const normalized = text.trim().toLowerCase().replace(/[^a-z_]/g, '');
  return (VALID_TAGS as string[]).includes(normalized) ? (normalized as ReplyTag) : null;
}

/** Returns null on any failure (capped org, no provider configured, model
 *  declined to answer cleanly) rather than throwing — a reply still gets
 *  promoted to a party with no tag rather than not at all; classification
 *  is a enhancement on top of promotion, not a precondition for it. */
export async function classifyReply(q: Querier, orgId: string, replyText: string): Promise<ReplyTag | null> {
  const ctx = await resolveAIContext(q, orgId, FEATURE);
  if (ctx.capExceeded) return null;

  let text = '';
  try {
    const gen = streamAI({
      orgId,
      feature: FEATURE,
      messages: [{ role: 'user', content: buildPrompt(replyText) }],
      // NOT a tight budget despite the one-word answer: the cheap tier's
      // OpenAI model is a reasoning model that spends part of this budget on
      // hidden reasoning before any visible output — verified live, a budget
      // as low as 10 produced zero visible text every time (ai.ts's own
      // OPENAI_REASONING_FAMILY comment warns about exactly this).
      maxTokens: 500,
      providerPreference: ctx.providerPreference,
      clients: ctx.clients,
      modelOverride: ctx.modelOverride,
      onUsage: (usage) => logAiUsage(q, { orgId, feature: FEATURE, ...usage }),
    });
    for await (const event of gen as AsyncGenerator<AIStreamEvent>) {
      if (event.type === 'delta') text += event.text;
    }
  } catch {
    return null;
  }
  return parseTag(text);
}
