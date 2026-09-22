/**
 * Venturelyx :: AI-backed routes. Thin over api/src/lib/ai.ts — each route
 * gathers real org data (plus AI settings/clients/spend check) in one short
 * req.db() call, then streams a completion via SSE. No route holds a
 * Querier open across the stream itself (see the note on ai.ts's
 * StreamAIOptions).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  logAiUsage, streamAI, streamEventsToSSE, resolveAIContext, staticEvents, CAP_MESSAGE,
} from '../lib/ai.js';
import { HttpError } from '../plugins/context.js';
import { moduleWriteGate } from '../lib/moduleAccess.js';

export default async function aiRoutes(app: FastifyInstance) {

  // ---- Command Center: AI Growth Strategist --------------------------------
  // Reads open growth_opportunities and unresolved signals, streams one
  // prioritized recommendation grounded in that data — nothing fabricated
  // if there's nothing to analyze.
  app.post('/ai/growth-strategist/stream', async (req, reply) => {
    req.requireRole('viewer');
    const orgId = req.ctx.orgId!;
    const feature = 'next_best_action' as const;

    const { prompt, ctx } = await req.db(async (q) => {
      const context = await resolveAIContext(q, orgId, feature);
      const org = await q.one<{ name: string; vertical: string | null }>(
        `SELECT name, vertical FROM organizations WHERE id = app.current_org()`,
      );
      const opportunities = await q.rows<{
        title: string; rationale: string; est_value_monthly: string | null; module: string;
      }>(
        `SELECT title, rationale, est_value_monthly::text, module
           FROM growth_opportunities
          WHERE status = 'open'
          ORDER BY score DESC NULLS LAST, est_value_monthly DESC NULLS LAST
          LIMIT 5`,
      );
      const signals = await q.rows<{ module: string; summary: string; severity: number }>(
        `SELECT module, summary, severity FROM signals
          WHERE resolved_at IS NULL
          ORDER BY severity, detected_at DESC
          LIMIT 10`,
      );
      return { prompt: buildGrowthStrategistPrompt(org, opportunities, signals), ctx: context };
    });

    if (!prompt) {
      await streamEventsToSSE(reply, staticEvents("You're all caught up — no open opportunities or active signals right now."));
      return;
    }
    if (ctx.capExceeded) {
      await streamEventsToSSE(reply, staticEvents(CAP_MESSAGE));
      return;
    }

    const gen = streamAI({
      orgId,
      feature,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      providerPreference: ctx.providerPreference,
      clients: ctx.clients,
      modelOverride: ctx.modelOverride,
      onUsage: (usage) => req.db((q) => logAiUsage(q, { orgId, feature, ...usage })),
    });

    await streamEventsToSSE(reply, gen);
  });

  // ---- ScaleSEO: AI Page Builder --------------------------------------------
  // Drafts body copy only — title/meta/H1/slug stay real form fields the
  // person fills in, not AI-generated, since a small business owner reading
  // this needs to trust and edit those directly, not approve a black box.
  // Content Writer, per ai-team/page.tsx's own ASSISTANTS list: module
  // 'ScaleSEO', not 'AI Team' — that page is a roster view over features
  // that live in their owning modules, not a module with its own routes.
  app.post('/ai/page-generation/stream', { preHandler: moduleWriteGate('scaleseo') }, async (req, reply) => {
    req.requireRole('staff');
    const orgId = req.ctx.orgId!;
    const feature = 'page_generation' as const;
    const body = z.object({
      kind: z.string().min(1),
      topic: z.string().min(1).max(500),
    }).parse(req.body);

    const { system, ctx } = await req.db(async (q) => {
      const context = await resolveAIContext(q, orgId, feature);
      const org = await q.one<{ name: string; vertical: string | null }>(
        `SELECT name, vertical FROM organizations WHERE id = app.current_org()`,
      );
      return { system: buildPageGenerationPrompt(org, body.kind), ctx: context };
    });

    if (ctx.capExceeded) {
      await streamEventsToSSE(reply, staticEvents(CAP_MESSAGE));
      return;
    }

    const gen = streamAI({
      orgId,
      feature,
      system,
      messages: [{ role: 'user', content: `Write the page. Topic / target keyword: ${body.topic}` }],
      maxTokens: 1500,
      providerPreference: ctx.providerPreference,
      clients: ctx.clients,
      modelOverride: ctx.modelOverride,
      onUsage: (usage) => req.db((q) => logAiUsage(q, { orgId, feature, ...usage })),
    });

    await streamEventsToSSE(reply, gen);
  });

  // ---- Reviews: AI-drafted reply --------------------------------------------
  // The review's real rating/author/body are read server-side by ID rather
  // than trusted from the request body — a client can't ask the model to
  // reply to fabricated review content this way.
  // Reputation Assistant, per ai-team/page.tsx: module 'Reviews'.
  app.post('/ai/review-response/stream', { preHandler: moduleWriteGate('reviews') }, async (req, reply) => {
    req.requireRole('staff');
    const orgId = req.ctx.orgId!;
    const feature = 'review_response' as const;
    const { reviewId } = z.object({ reviewId: z.string().uuid() }).parse(req.body);

    const { system, user, ctx } = await req.db(async (q) => {
      const context = await resolveAIContext(q, orgId, feature);
      const org = await q.one<{ name: string; vertical: string | null }>(
        `SELECT name, vertical FROM organizations WHERE id = app.current_org()`,
      );
      const review = await q.one<{ author_name: string; rating: number; body: string | null }>(
        `SELECT author_name, rating, body FROM reviews WHERE id = $1`,
        [reviewId],
      );
      if (!review) throw new HttpError(404, 'Review not found', 'not_found');
      return {
        system: buildReviewResponsePrompt(org),
        user: `Reviewer: ${review.author_name} (${review.rating}/5 stars)\nReview: "${review.body ?? '(no text)'}"`,
        ctx: context,
      };
    });

    if (ctx.capExceeded) {
      await streamEventsToSSE(reply, staticEvents(CAP_MESSAGE));
      return;
    }

    const gen = streamAI({
      orgId,
      feature,
      system,
      messages: [{ role: 'user', content: user }],
      maxTokens: 500,
      providerPreference: ctx.providerPreference,
      clients: ctx.clients,
      modelOverride: ctx.modelOverride,
      onUsage: (usage) => req.db((q) => logAiUsage(q, { orgId, feature, ...usage })),
    });

    await streamEventsToSSE(reply, gen);
  });
}

function buildReviewResponsePrompt(org: { name: string; vertical: string | null } | null): string {
  return (
    `You are writing a public reply to a customer review for ${org?.name ?? 'this business'}` +
    `${org?.vertical ? ` (a ${org.vertical} business)` : ''}. Write ONE short, warm, professional ` +
    `reply (2-4 sentences) the owner can post as-is or lightly edit. Thank the reviewer by name. ` +
    `For 4-5 star reviews: express genuine gratitude, invite them back. For 1-3 star reviews: ` +
    `acknowledge their specific concern without being defensive, apologize sincerely, and invite them ` +
    `to reach out directly to resolve it — never argue or make excuses. Never invent specific facts, ` +
    `promises, or discounts not already in the review itself.`
  );
}

function buildPageGenerationPrompt(org: { name: string; vertical: string | null } | null, kind: string): string {
  return (
    `You are writing website body copy for ${org?.name ?? 'a small business'}` +
    `${org?.vertical ? `, a ${org.vertical} business` : ''}. Page type: ${kind}. ` +
    `Write plain body copy only — no title, no meta description, no HTML, no markdown headers, ` +
    `no code fences. 3-5 short paragraphs, plain text, conversational but professional. ` +
    `Never invent specific facts about this business (no fake testimonials, years in business, ` +
    `credentials, or statistics) — write generically persuasive copy the owner can edit in real details.`
  );
}

function buildGrowthStrategistPrompt(
  org: { name: string; vertical: string | null } | null,
  opportunities: Array<{ title: string; rationale: string; est_value_monthly: string | null; module: string }>,
  signals: Array<{ module: string; summary: string; severity: number }>,
): { system: string; user: string } | null {
  if (opportunities.length === 0 && signals.length === 0) return null;

  const system =
    `You are the Growth Strategist inside ${org?.name ?? 'this business'}'s Venturelyx Command Center` +
    `${org?.vertical ? ` (a ${org.vertical} business)` : ''}. ` +
    `You're writing for the owner, not a marketer — plain language, no jargon. ` +
    `Ground every claim strictly in the data given; never invent numbers, competitors, or facts not in it. ` +
    `Recommend exactly ONE next action, in 2-4 sentences: what to do, why (cite the specific number or ` +
    `signal that justifies it), and roughly how long it should take. No preamble, no bullet list, no sign-off.`;

  const oppLines = opportunities.map(
    (o) => `- [${o.module}] ${o.title}: ${o.rationale}${o.est_value_monthly ? ` (est. $${o.est_value_monthly}/mo)` : ''}`,
  );
  const sigLines = signals.map((s) => `- [${s.module}] severity ${s.severity}: ${s.summary}`);

  const user = [
    opportunities.length > 0 ? `Open growth opportunities:\n${oppLines.join('\n')}` : null,
    signals.length > 0 ? `Active signals:\n${sigLines.join('\n')}` : null,
    'What is the single highest-priority action right now?',
  ]
    .filter(Boolean)
    .join('\n\n');

  return { system, user };
}
