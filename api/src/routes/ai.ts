/**
 * Venturelyx :: AI-backed routes. Thin over api/src/lib/ai.ts — each route
 * gathers real org data in one short req.db() call, then streams a
 * completion via SSE. No route holds a Querier open across the stream
 * itself (see the note on ai.ts's StreamAIOptions).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getProviderPreference, logAiUsage, streamAI, streamEventsToSSE, type AIStreamEvent } from '../lib/ai.js';

async function* staticEvents(text: string): AsyncGenerator<AIStreamEvent> {
  yield { type: 'delta', text };
  yield { type: 'done' };
}

export default async function aiRoutes(app: FastifyInstance) {

  // ---- Command Center: AI Growth Strategist --------------------------------
  // Reads open growth_opportunities and unresolved signals, streams one
  // prioritized recommendation grounded in that data — nothing fabricated
  // if there's nothing to analyze.
  app.post('/ai/growth-strategist/stream', async (req, reply) => {
    req.requireRole('viewer');
    const orgId = req.ctx.orgId!;
    const feature = 'next_best_action' as const;

    const { prompt, providerPreference } = await req.db(async (q) => {
      const preference = await getProviderPreference(q, orgId);
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
      return { prompt: buildGrowthStrategistPrompt(org, opportunities, signals), providerPreference: preference };
    });

    if (!prompt) {
      await streamEventsToSSE(reply, staticEvents("You're all caught up — no open opportunities or active signals right now."));
      return;
    }

    const gen = streamAI({
      orgId,
      feature,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      providerPreference,
      onUsage: (usage) => req.db((q) => logAiUsage(q, { orgId, feature, ...usage })),
    });

    await streamEventsToSSE(reply, gen);
  });

  // ---- ScaleSEO: AI Page Builder --------------------------------------------
  // Drafts body copy only — title/meta/H1/slug stay real form fields the
  // person fills in, not AI-generated, since a small business owner reading
  // this needs to trust and edit those directly, not approve a black box.
  app.post('/ai/page-generation/stream', async (req, reply) => {
    req.requireRole('staff');
    const orgId = req.ctx.orgId!;
    const feature = 'page_generation' as const;
    const body = z.object({
      kind: z.string().min(1),
      topic: z.string().min(1).max(500),
    }).parse(req.body);

    const { system, providerPreference } = await req.db(async (q) => {
      const preference = await getProviderPreference(q, orgId);
      const org = await q.one<{ name: string; vertical: string | null }>(
        `SELECT name, vertical FROM organizations WHERE id = app.current_org()`,
      );
      return { system: buildPageGenerationPrompt(org, body.kind), providerPreference: preference };
    });

    const gen = streamAI({
      orgId,
      feature,
      system,
      messages: [{ role: 'user', content: `Write the page. Topic / target keyword: ${body.topic}` }],
      maxTokens: 1500,
      providerPreference,
      onUsage: (usage) => req.db((q) => logAiUsage(q, { orgId, feature, ...usage })),
    });

    await streamEventsToSSE(reply, gen);
  });
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
