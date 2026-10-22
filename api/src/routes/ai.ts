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
import { HttpError, requireProvisioned } from '../plugins/context.js';
import { moduleWriteGate } from '../lib/moduleAccess.js';
import { computeGrowthScore } from '../lib/growthScore.js';
import { getSenderProfile } from '../lib/growTemplate.js';
import type { Querier } from '../lib/db.js';

const METRIC_KEYS = [
  'revenue', 'leads', 'customers', 'jobs', 'expenses', 'reviews', 'seo', 'growth_score',
] as const;
type MetricKey = (typeof METRIC_KEYS)[number];

export default async function aiRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireProvisioned);

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

  // ---- Command Center: AI Insights Analyst ----------------------------------
  // Explains why one stat tile is where it is, grounded strictly in real
  // this-period-vs-last-period numbers queried the same way /command/summary
  // already does (revenue/expenses: payments.received_at|expenses.incurred_on
  // month windows; leads: parties.is_lead 7-day windows; jobs: work_orders
  // week windows; reviews: reviews.reviewed_at month windows; seo: the two
  // most recent seo_scores rows). Growth Score has no stored history to diff
  // against (it's computed on the fly, never snapshotted) — for that one the
  // Analyst explains the current breakdown rather than fabricating a trend.
  app.post('/ai/metric-explanation/stream', async (req, reply) => {
    req.requireRole('viewer');
    const orgId = req.ctx.orgId!;
    const feature = 'metric_explanation' as const;
    const { metric } = z.object({ metric: z.enum(METRIC_KEYS) }).parse(req.body);

    const { prompt, ctx } = await req.db(async (q) => {
      const context = await resolveAIContext(q, orgId, feature);
      const org = await q.one<{ name: string; vertical: string | null; modules: Record<string, boolean> | null }>(
        `SELECT name, vertical, modules FROM organizations WHERE id = app.current_org()`,
      );
      const prompt = await buildMetricExplanationPrompt(q, org, metric);
      return { prompt, ctx: context };
    });

    if (!prompt) {
      await streamEventsToSSE(reply, staticEvents('Not enough data yet for this one — check back once there’s more history.'));
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
      maxTokens: 400,
      providerPreference: ctx.providerPreference,
      clients: ctx.clients,
      modelOverride: ctx.modelOverride,
      onUsage: (usage) => req.db((q) => logAiUsage(q, { orgId, feature, ...usage })),
    });

    await streamEventsToSSE(reply, gen);
  });

  // ---- ScaleSEO: AI per-issue fix draft ---------------------------------------
  // The "Fix this for me" button on an auto_fixable issue used to jump to the
  // AI Page Builder with a vague seeded topic — nonsensical for "missing
  // title" or "no schema," which aren't a new-page-body task at all (that's
  // thin_content/weak_qa_structure's job, and that one still routes to the
  // Page Builder, now with its own real seed). This instead drafts the exact
  // short text the guidance in lib/seoGuidance.ts already promises ("Venturelyx
  // can draft a title/meta description/structured data for this page"),
  // grounded in that one real page's current seo_pages row. Two buckets only —
  // the ones with enough real data to ground a draft honestly:
  //   title/meta: a title (<=60 chars) and/or meta description (~155 chars).
  //   schema: LocalBusiness or FAQPage JSON-LD from the org's real profile.
  // images_missing_alt has no per-image URL anywhere in the schema (seo_pages
  // only stores a COUNT of alt-less images) and missing_canonical isn't a
  // drafting task at all — both stay on the honest "How to fix" guidance
  // path in the UI rather than being routed here.
  const TITLE_META_CODES = [
    'missing_title', 'title_too_long', 'title_too_short',
    'missing_meta_desc', 'duplicate_meta_desc', 'meta_desc_too_long',
  ] as const;
  const SCHEMA_CODES = [
    'no_schema', 'missing_local_business_schema', 'incomplete_local_business_schema', 'missing_faq_schema',
  ] as const;
  const ISSUE_FIX_CODES = [...TITLE_META_CODES, ...SCHEMA_CODES] as const;

  app.post('/ai/seo-issue-fix/stream', { preHandler: moduleWriteGate('scaleseo') }, async (req, reply) => {
    req.requireRole('staff');
    const orgId = req.ctx.orgId!;
    const feature = 'seo_issue_fix' as const;
    const { siteId, code, url } = z.object({
      siteId: z.string().uuid(),
      code: z.enum(ISSUE_FIX_CODES),
      url: z.string().trim().min(1),
    }).parse(req.body);

    const { prompt, ctx } = await req.db(async (q) => {
      const context = await resolveAIContext(q, orgId, feature);
      const org = await q.one<{ name: string; vertical: string | null }>(
        `SELECT name, vertical FROM organizations WHERE id = app.current_org()`,
      );
      const page = await q.one<{
        title: string | null; meta_description: string | null; h1: string | null;
        word_count: number; schema_types: string[] | null;
      }>(
        `SELECT p.title, p.meta_description, p.h1, p.word_count, p.schema_types
           FROM seo_pages p
          WHERE p.site_id = $1 AND p.url = $2
          ORDER BY p.crawl_id DESC LIMIT 1`,
        [siteId, url],
      );
      if (!page) throw new HttpError(404, 'That page was not found in the latest crawl', 'not_found');

      if ((TITLE_META_CODES as readonly string[]).includes(code)) {
        return { prompt: buildSeoTitleMetaPrompt(org, url, page), ctx: context };
      }
      const sender = await getSenderProfile(q);
      return { prompt: buildSeoSchemaPrompt(org, sender, url, page, code), ctx: context };
    });

    if (ctx.capExceeded) {
      await streamEventsToSSE(reply, staticEvents(CAP_MESSAGE));
      return;
    }

    const gen = streamAI({
      orgId,
      feature,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      maxTokens: 500,
      providerPreference: ctx.providerPreference,
      clients: ctx.clients,
      modelOverride: ctx.modelOverride,
      onUsage: (usage) => req.db((q) => logAiUsage(q, { orgId, feature, ...usage })),
    });

    await streamEventsToSSE(reply, gen);
  });

  // ---- ScaleSEO: AI SEO Assistant --------------------------------------------
  // Turns the latest crawl's real seo_scores sub-scores + grouped seo_issues
  // into a ranked to-do list. Previously the Scanner tab's "AI Recommendation"
  // card just reused the Growth Strategist (org-wide opportunities/signals,
  // nothing about THIS site's crawl) — this is scoped to one site's actual
  // findings instead.
  app.post('/ai/seo-recommendations/stream', { preHandler: moduleWriteGate('scaleseo') }, async (req, reply) => {
    req.requireRole('viewer');
    const orgId = req.ctx.orgId!;
    const feature = 'seo_recommendations' as const;
    const { siteId } = z.object({ siteId: z.string().uuid() }).parse(req.body);

    const { prompt, ctx } = await req.db(async (q) => {
      const context = await resolveAIContext(q, orgId, feature);
      const org = await q.one<{ name: string; vertical: string | null }>(
        `SELECT name, vertical FROM organizations WHERE id = app.current_org()`,
      );
      const score = await q.one<{
        health: number; technical: number | null; content: number | null;
        local_seo: number | null; performance: number | null;
        broken_links: number; critical_issues: number; high_issues: number; crawl_id: number;
      }>(
        `SELECT health, technical, content, local_seo, performance,
                broken_links, critical_issues, high_issues, crawl_id
           FROM seo_scores WHERE site_id = $1 ORDER BY computed_at DESC LIMIT 1`,
        [siteId],
      );
      if (!score) return { prompt: null, ctx: context };

      const issues = await q.rows<{
        code: string; severity: string; auto_fixable: boolean; pages: number; example_detail: string | null;
      }>(
        `SELECT i.code, i.severity, i.auto_fixable, count(*)::int AS pages,
                (array_agg(i.detail ORDER BY i.url))[1] AS example_detail
           FROM seo_issues i
          WHERE i.crawl_id = $1
          GROUP BY i.code, i.severity, i.auto_fixable
          ORDER BY CASE i.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2
                                   WHEN 'medium' THEN 3 ELSE 4 END, count(*) DESC
          LIMIT 15`,
        [score.crawl_id],
      );
      // Page-level content/technical signal straight from seo_pages — not
      // every thin-content or missing-metadata problem necessarily surfaces
      // as its own seo_issues row, so this is read directly rather than
      // assumed to be redundant with the issues list above.
      const pageStats = await q.one<{
        total_pages: number; missing_title: number; thin_content: number;
        missing_meta_desc: number; missing_h1: number; not_indexable: number; images_missing_alt: number;
      }>(
        `SELECT count(*)::int AS total_pages,
                count(*) FILTER (WHERE title_len IS NULL OR title_len = 0)::int AS missing_title,
                count(*) FILTER (WHERE word_count IS NOT NULL AND word_count < 300)::int AS thin_content,
                count(*) FILTER (WHERE meta_desc_len IS NULL OR meta_desc_len = 0)::int AS missing_meta_desc,
                count(*) FILTER (WHERE h1_count = 0)::int AS missing_h1,
                count(*) FILTER (WHERE NOT indexable)::int AS not_indexable,
                count(*) FILTER (WHERE images_no_alt > 0)::int AS images_missing_alt
           FROM seo_pages WHERE crawl_id = $1`,
        [score.crawl_id],
      );
      return { prompt: buildSeoRecommendationsPrompt(org, score, issues, pageStats), ctx: context };
    });

    if (!prompt) {
      await streamEventsToSSE(reply, staticEvents('No crawl yet for this site — run a crawl first and I’ll turn the results into a to-do list.'));
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
      maxTokens: 800,
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

  // ---- Operate: AI Follow-up Assistant ---------------------------------------
  // Drafts a follow-up message grounded in one party's real state: lifecycle,
  // how long since last activity, their most recent reply (if any), any open
  // deal, and any open job (work_order) — covering both "a stale lead" and
  // "a job" from the one entity both are rows on. Draft-only: nothing here
  // sends anything — Operate has no outbound send channel of its own (that's
  // deliberately Grow's job), so the only human-confirm step this needs is
  // the owner reading the draft and sending it themselves however they
  // already contact this person.
  app.post('/ai/followup-assistant/stream', { preHandler: moduleWriteGate('operate') }, async (req, reply) => {
    req.requireRole('staff');
    const orgId = req.ctx.orgId!;
    const feature = 'followup_assistant' as const;
    const { partyId, invoiceId } = z.object({
      partyId: z.string().uuid().optional(),
      invoiceId: z.string().uuid().optional(),
    }).refine((b) => !!b.partyId !== !!b.invoiceId, 'Pass exactly one of partyId or invoiceId')
      .parse(req.body);

    const { prompt, ctx } = await req.db(async (q) => {
      const context = await resolveAIContext(q, orgId, feature);
      const org = await q.one<{ name: string; vertical: string | null }>(
        `SELECT name, vertical FROM organizations WHERE id = app.current_org()`,
      );

      if (invoiceId) {
        const invoice = await q.one<{
          display_name: string; number: string | null; total: string; amount_paid: string;
          due_on: string | null; status: string;
        }>(
          `SELECT p.display_name, i.number, i.total::text, i.amount_paid::text, i.due_on::text, i.status
             FROM invoices i JOIN parties p ON p.id = i.party_id
            WHERE i.id = $1`,
          [invoiceId],
        );
        if (!invoice) throw new HttpError(404, 'Invoice not found', 'not_found');
        return { prompt: buildInvoiceReminderPrompt(org, invoice), ctx: context };
      }

      const party = await q.one<{
        display_name: string; lifecycle: string; last_activity_at: string | null;
        deal_title: string | null; deal_value: string | null;
        last_reply_body: string | null; last_reply_at: string | null;
        job_title: string | null; job_status: string | null; job_scheduled_start: string | null;
      }>(
        `SELECT p.display_name, p.lifecycle, p.last_activity_at,
                d.title AS deal_title, d.value::text AS deal_value,
                lr.body AS last_reply_body, lr.occurred_at AS last_reply_at,
                wo.title AS job_title, wo.status AS job_status, wo.scheduled_start AS job_scheduled_start
           FROM parties p
      LEFT JOIN LATERAL (
                SELECT title, value FROM deals
                 WHERE party_id = p.id AND status = 'open'
                 ORDER BY created_at DESC LIMIT 1
              ) d ON true
      LEFT JOIN LATERAL (
                SELECT body, occurred_at FROM timeline_events
                 WHERE party_id = p.id AND event_type = 'grow.reply'
                 ORDER BY occurred_at DESC LIMIT 1
              ) lr ON true
      LEFT JOIN LATERAL (
                SELECT title, status, scheduled_start FROM work_orders
                 WHERE party_id = p.id AND status NOT IN ('complete', 'cancelled')
                 ORDER BY scheduled_start ASC NULLS LAST LIMIT 1
              ) wo ON true
          WHERE p.id = $1 AND p.deleted_at IS NULL`,
        [partyId],
      );
      if (!party) throw new HttpError(404, 'Contact not found', 'not_found');
      return { prompt: buildFollowupPrompt(org, party), ctx: context };
    });

    if (ctx.capExceeded) {
      await streamEventsToSSE(reply, staticEvents(CAP_MESSAGE));
      return;
    }

    const gen = streamAI({
      orgId,
      feature,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      maxTokens: 400,
      providerPreference: ctx.providerPreference,
      clients: ctx.clients,
      modelOverride: ctx.modelOverride,
      onUsage: (usage) => req.db((q) => logAiUsage(q, { orgId, feature, ...usage })),
    });

    await streamEventsToSSE(reply, gen);
  });
}

type OrgLite = { name: string; vertical: string | null; modules: Record<string, boolean> | null } | null;

async function buildMetricExplanationPrompt(
  q: Querier, org: OrgLite, metric: MetricKey,
): Promise<{ system: string; user: string } | null> {
  const bizLine = `${org?.name ?? 'this business'}${org?.vertical ? ` (a ${org.vertical} business)` : ''}`;
  const system =
    `You are the Insights Analyst inside ${bizLine}'s Venturelyx Command Center. ` +
    `You're writing for the owner, not an analyst — plain language, no jargon, 2-4 sentences. ` +
    `Ground every claim strictly in the numbers given; never invent a cause, event, or number not in them. ` +
    `If the numbers are flat or there's too little data to say much, say that plainly rather than overexplaining. ` +
    `No preamble, no sign-off.`;

  if (metric === 'revenue' || metric === 'expenses') {
    const table = metric === 'revenue' ? 'payments' : 'expenses';
    const col = metric === 'revenue' ? 'received_at' : 'incurred_on';
    const amountCol = metric === 'revenue' ? 'amount' : 'amount';
    const statusClause = metric === 'revenue' ? `AND status = 'succeeded'` : '';
    const row = await q.one<{ this_period: string; last_period: string }>(
      `SELECT
         COALESCE((SELECT sum(${amountCol}) FROM ${table}
                    WHERE ${col} >= date_trunc('month', now()) ${statusClause}), 0)::text AS this_period,
         COALESCE((SELECT sum(${amountCol}) FROM ${table}
                    WHERE ${col} >= date_trunc('month', now()) - interval '1 month'
                      AND ${col} <  date_trunc('month', now()) ${statusClause}), 0)::text AS last_period`,
    );
    if (!row) return null;
    const label = metric === 'revenue' ? 'Revenue collected' : 'Expenses';
    const user = `${label} this month: $${row.this_period}. Last month: $${row.last_period}. Why did it move, and what's the practical takeaway?`;
    return { system, user };
  }

  if (metric === 'leads') {
    const row = await q.one<{ this_period: number; last_period: number; stale: number }>(
      `SELECT
         (SELECT count(*) FROM parties WHERE is_lead AND deleted_at IS NULL
            AND first_seen_at >= now() - interval '7 days')::int AS this_period,
         (SELECT count(*) FROM parties WHERE is_lead AND deleted_at IS NULL
            AND first_seen_at >= now() - interval '14 days' AND first_seen_at < now() - interval '7 days')::int AS last_period,
         (SELECT count(*) FROM parties WHERE is_lead AND deleted_at IS NULL
            AND lifecycle IN ('new','working')
            AND (last_activity_at IS NULL OR last_activity_at < now() - interval '5 days'))::int AS stale`,
    );
    if (!row) return null;
    const user = `New leads in the last 7 days: ${row.this_period}. The 7 days before that: ${row.last_period}. ` +
      `${row.stale} lead(s) are currently stale (no activity in 5+ days). Why did lead flow move, and what's the practical takeaway?`;
    return { system, user };
  }

  if (metric === 'jobs') {
    const row = await q.one<{ this_period: number; last_period: number; today_total: number; today_done: number }>(
      `SELECT
         (SELECT count(*) FROM work_orders
            WHERE scheduled_start >= date_trunc('week', now())
              AND scheduled_start <  date_trunc('week', now()) + interval '7 days')::int AS this_period,
         (SELECT count(*) FROM work_orders
            WHERE scheduled_start >= date_trunc('week', now()) - interval '7 days'
              AND scheduled_start <  date_trunc('week', now()))::int AS last_period,
         (SELECT count(*) FROM work_orders WHERE scheduled_start::date = current_date)::int AS today_total,
         (SELECT count(*) FROM work_orders WHERE scheduled_start::date = current_date AND status = 'complete')::int AS today_done`,
    );
    if (!row) return null;
    const user = `Jobs scheduled this week: ${row.this_period}. Last week: ${row.last_period}. ` +
      `Today: ${row.today_done} of ${row.today_total} done. Why did job volume move, and what's the practical takeaway?`;
    return { system, user };
  }

  if (metric === 'customers') {
    // No "became a customer at" timestamp exists on parties (only the
    // generic updated_at) — rather than fabricate a precise conversion
    // trend from a column that bumps on any edit, explain the current
    // count in the context of the lead flow feeding it, which IS tracked
    // reliably (first_seen_at).
    const row = await q.one<{ total: number; new_leads_7d: number; stale: number }>(
      `SELECT
         (SELECT count(*) FROM parties WHERE is_customer AND deleted_at IS NULL)::int AS total,
         (SELECT count(*) FROM parties WHERE is_lead AND deleted_at IS NULL
            AND first_seen_at >= now() - interval '7 days')::int AS new_leads_7d,
         (SELECT count(*) FROM parties WHERE is_lead AND deleted_at IS NULL
            AND lifecycle IN ('new','working')
            AND (last_activity_at IS NULL OR last_activity_at < now() - interval '5 days'))::int AS stale`,
    );
    if (!row) return null;
    const user = `Total customers: ${row.total}. New leads in the last 7 days: ${row.new_leads_7d}, ` +
      `of which ${row.stale} lead(s) overall are currently stale. There's no exact month-over-month ` +
      `"became a customer" trend tracked yet, so explain the customer count in context of the lead flow ` +
      `feeding it, not a precise delta — and what's the practical takeaway?`;
    return { system, user };
  }

  if (metric === 'reviews') {
    const row = await q.one<{
      this_count: number; this_avg: string | null; last_count: number; last_avg: string | null;
      total_count: number; total_avg: string | null;
    }>(
      `SELECT
         count(*) FILTER (WHERE reviewed_at >= date_trunc('month', now()))::int AS this_count,
         avg(rating) FILTER (WHERE reviewed_at >= date_trunc('month', now()))::numeric(3,1)::text AS this_avg,
         count(*) FILTER (WHERE reviewed_at >= date_trunc('month', now()) - interval '1 month'
                             AND reviewed_at <  date_trunc('month', now()))::int AS last_count,
         avg(rating) FILTER (WHERE reviewed_at >= date_trunc('month', now()) - interval '1 month'
                                AND reviewed_at <  date_trunc('month', now()))::numeric(3,1)::text AS last_avg,
         count(*)::int AS total_count,
         avg(rating)::numeric(3,1)::text AS total_avg
       FROM reviews`,
    );
    if (!row || row.total_count === 0) return null;
    const user = `This month: ${row.this_count} new review(s)${row.this_avg ? `, avg rating ${row.this_avg}` : ''}. ` +
      `Last month: ${row.last_count} new review(s)${row.last_avg ? `, avg rating ${row.last_avg}` : ''}. ` +
      `All-time: ${row.total_count} reviews, avg ${row.total_avg}. Why did this move, and what's the practical takeaway?`;
    return { system, user };
  }

  if (metric === 'seo') {
    const rows = await q.rows<{
      health: number; technical: number | null; content: number | null;
      performance: number | null; local_seo: number | null; computed_at: string;
    }>(
      `SELECT sc.health, sc.technical, sc.content, sc.performance, sc.local_seo, sc.computed_at
         FROM seo_scores sc JOIN seo_sites s ON s.id = sc.site_id
        WHERE s.is_primary ORDER BY sc.computed_at DESC LIMIT 2`,
    );
    if (rows.length === 0) return null;
    const [current, previous] = rows;
    const user = previous
      ? `SEO health score: ${current!.health} (previous crawl: ${previous.health}). ` +
        `Technical ${current!.technical ?? '—'} (was ${previous.technical ?? '—'}), ` +
        `content ${current!.content ?? '—'} (was ${previous.content ?? '—'}), ` +
        `performance ${current!.performance ?? '—'} (was ${previous.performance ?? '—'}), ` +
        `local SEO ${current!.local_seo ?? '—'} (was ${previous.local_seo ?? '—'}). ` +
        `Why did the score move, and what's the practical takeaway?`
      : `SEO health score: ${current!.health} (first crawl on record — no prior score to compare against). ` +
        `Technical ${current!.technical ?? '—'}, content ${current!.content ?? '—'}, ` +
        `performance ${current!.performance ?? '—'}, local SEO ${current!.local_seo ?? '—'}. ` +
        `Briefly explain what's driving this score.`;
    return { system, user };
  }

  // growth_score: never snapshotted historically, so explain the current
  // breakdown's drivers rather than a fabricated delta — same inputs
  // /command/summary's own computeGrowthScore() call uses.
  const [seo, marketTargets, gbp, reputation, money, salesSignals] = await Promise.all([
    q.one<{ health: number | null }>(
      `SELECT sc.health FROM seo_scores sc JOIN seo_sites s ON s.id = sc.site_id
        WHERE s.is_primary ORDER BY sc.computed_at DESC LIMIT 1`,
    ),
    q.one<{ total: number; in_top20: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE current_position IS NOT NULL AND current_position <= 20)::int AS in_top20
         FROM market_targets`,
    ),
    q.one<{ connected: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM integrations WHERE provider = 'gbp' AND status = 'connected') AS connected`,
    ),
    q.one<{ avg_rating: string | null; review_count: number; recent_90d: number; replied: number }>(
      `SELECT avg(rating)::numeric(3,1)::text AS avg_rating, count(*)::int AS review_count,
              count(*) FILTER (WHERE reviewed_at >= now() - interval '90 days')::int AS recent_90d,
              count(*) FILTER (WHERE response_status = 'published')::int AS replied
         FROM reviews`,
    ),
    q.one<{ collected: string; last_month: string }>(
      `SELECT
         COALESCE((SELECT sum(amount) FROM payments
                    WHERE received_at >= date_trunc('month', now()) AND status = 'succeeded'), 0)::text AS collected,
         COALESCE((SELECT sum(amount) FROM payments
                    WHERE received_at >= date_trunc('month', now()) - interval '1 month'
                      AND received_at <  date_trunc('month', now()) AND status = 'succeeded'), 0)::text AS last_month`,
    ),
    q.one<{ new_leads_30d: number; deals_total: number; deals_won: number; invoiced: string; paid: string }>(
      `SELECT
         (SELECT count(*) FROM parties WHERE is_lead AND deleted_at IS NULL
            AND first_seen_at >= now() - interval '30 days')::int AS new_leads_30d,
         (SELECT count(*) FROM deals)::int AS deals_total,
         (SELECT count(*) FROM deals WHERE status = 'won')::int AS deals_won,
         (SELECT COALESCE(sum(total), 0) FROM invoices)::text AS invoiced,
         (SELECT COALESCE(sum(amount_paid), 0) FROM invoices)::text AS paid`,
    ),
  ]);

  const growthScore = computeGrowthScore({
    modules: org?.modules ?? null,
    seoHealth: seo?.health != null ? Number(seo.health) : null,
    marketTargetsTotal: marketTargets?.total ?? 0,
    marketTargetsInTop20: marketTargets?.in_top20 ?? 0,
    gbpConnected: gbp?.connected ?? false,
    reviewCount: reputation?.review_count ?? 0,
    avgRating: reputation?.avg_rating != null ? Number(reputation.avg_rating) : null,
    reviewsLast90d: reputation?.recent_90d ?? 0,
    repliedCount: reputation?.replied ?? 0,
    thisMonthRevenue: Number(money?.collected ?? 0),
    lastMonthRevenue: Number(money?.last_month ?? 0),
    newLeads30d: salesSignals?.new_leads_30d ?? 0,
    dealsTotal: salesSignals?.deals_total ?? 0,
    dealsWon: salesSignals?.deals_won ?? 0,
    invoicedTotal: Number(salesSignals?.invoiced ?? 0),
    invoicedPaid: Number(salesSignals?.paid ?? 0),
  });
  if (growthScore.score === null) return null;

  const user =
    `Growth Score: ${growthScore.score}/100, made of Visibility ${growthScore.visibility ?? 'n/a (module off)'}, ` +
    `Reputation ${growthScore.reputation ?? 'n/a (module off)'}, Sales ${growthScore.sales ?? 'n/a (module off)'}. ` +
    `Supporting numbers — SEO health: ${seo?.health ?? 'no scan yet'}; keyword coverage: ` +
    `${marketTargets?.in_top20 ?? 0}/${marketTargets?.total ?? 0} in top 20; Google Business connected: ` +
    `${gbp?.connected ? 'yes' : 'no'}; reviews: ${reputation?.review_count ?? 0} total ` +
    `(avg ${reputation?.avg_rating ?? 'n/a'}, ${reputation?.recent_90d ?? 0} in last 90 days, ` +
    `${reputation?.replied ?? 0} replied to); revenue this month: $${money?.collected ?? 0} ` +
    `(last month: $${money?.last_month ?? 0}); new leads in 30 days: ${salesSignals?.new_leads_30d ?? 0}; ` +
    `deals won: ${salesSignals?.deals_won ?? 0} of ${salesSignals?.deals_total ?? 0}. ` +
    `Explain what's driving this score and the single biggest lever to raise it.`;
  return { system, user };
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
}

function buildFollowupPrompt(
  org: { name: string; vertical: string | null } | null,
  party: {
    display_name: string; lifecycle: string; last_activity_at: string | null;
    deal_title: string | null; deal_value: string | null;
    last_reply_body: string | null; last_reply_at: string | null;
    job_title: string | null; job_status: string | null; job_scheduled_start: string | null;
  },
): { system: string; user: string } {
  const system =
    `You are writing a short, warm follow-up message from ${org?.name ?? 'this business'}` +
    `${org?.vertical ? ` (a ${org.vertical} business)` : ''} to one of its contacts. ` +
    `Write ONE message (2-4 sentences) the owner can lightly edit and send themselves through whatever ` +
    `channel they already use with this person — email, text, or a call script. Never invent facts, ` +
    `prices, dates, or promises not already given below. No preamble, no sign-off placeholder.`;

  const idleDays = daysSince(party.last_activity_at);
  const lines = [
    `Contact: ${party.display_name} (lifecycle: ${party.lifecycle})`,
    idleDays != null ? `No activity in ${idleDays} day(s).` : 'No activity recorded yet.',
    party.deal_title ? `Open deal: "${party.deal_title}"${party.deal_value ? ` ($${party.deal_value})` : ''}.` : null,
    party.last_reply_body ? `Their last reply: "${party.last_reply_body}"` : null,
    party.job_title
      ? `Open job: "${party.job_title}" (status: ${party.job_status}${party.job_scheduled_start ? `, scheduled ${party.job_scheduled_start}` : ', not yet scheduled'}).`
      : null,
  ].filter(Boolean);

  const user = `${lines.join('\n')}\n\nDraft the follow-up message.`;
  return { system, user };
}

function buildInvoiceReminderPrompt(
  org: { name: string; vertical: string | null } | null,
  invoice: { display_name: string; number: string | null; total: string; amount_paid: string; due_on: string | null; status: string },
): { system: string; user: string } {
  const system =
    `You are writing a short, polite overdue-invoice payment reminder from ${org?.name ?? 'this business'}` +
    `${org?.vertical ? ` (a ${org.vertical} business)` : ''} to a customer. ` +
    `Write ONE message (2-4 sentences) the owner can lightly edit and send themselves — firm but friendly, ` +
    `never threatening, never inventing a late fee, interest charge, or collections step that isn't given below. ` +
    `No preamble, no sign-off placeholder.`;

  const balance = (Number(invoice.total) - Number(invoice.amount_paid)).toFixed(2);
  const overdueDays = daysSince(invoice.due_on);
  const lines = [
    `Customer: ${invoice.display_name}`,
    `Invoice ${invoice.number ?? '(no number)'}: $${invoice.total} total, $${balance} still owed.`,
    invoice.due_on
      ? `Due ${invoice.due_on}${overdueDays != null && overdueDays > 0 ? ` — ${overdueDays} day(s) overdue` : ''}.`
      : 'No due date on file.',
    `Status: ${invoice.status}.`,
  ];

  const user = `${lines.join('\n')}\n\nDraft the payment reminder.`;
  return { system, user };
}

function buildSeoTitleMetaPrompt(
  org: { name: string; vertical: string | null } | null,
  url: string,
  page: { title: string | null; meta_description: string | null; h1: string | null; word_count: number },
): { system: string; user: string } {
  const system =
    `You are drafting the <title> tag and meta description for one page of ${org?.name ?? 'this business'}'s website` +
    `${org?.vertical ? ` (a ${org.vertical} business)` : ''}. ` +
    `Ground this strictly in the page's own current content given below — never invent a service, offer, or ` +
    `claim not implied by it. Output exactly two labeled lines, nothing else: ` +
    `"Title: <60 characters or fewer>" and "Meta description: <150-160 characters>". No preamble, no markdown.`;

  const user = [
    `Page: ${url}`,
    `Current title: ${page.title ?? '(none)'}`,
    `Current meta description: ${page.meta_description ?? '(none)'}`,
    `Main heading (H1): ${page.h1 ?? '(none)'}`,
    `Word count: ${page.word_count}`,
  ].join('\n');

  return { system, user };
}

const SCHEMA_TYPE_NAME: Record<string, string> = {
  no_schema: 'LocalBusiness',
  missing_local_business_schema: 'LocalBusiness',
  incomplete_local_business_schema: 'LocalBusiness',
  missing_faq_schema: 'FAQPage',
};

function buildSeoSchemaPrompt(
  org: { name: string; vertical: string | null } | null,
  sender: { website_url: string | null; phone: string | null; mailing_address: string | null },
  url: string,
  page: { title: string | null; h1: string | null; schema_types: string[] | null },
  code: string,
): { system: string; user: string } {
  const schemaType = SCHEMA_TYPE_NAME[code] ?? 'LocalBusiness';
  const system =
    `You are drafting ${schemaType} JSON-LD structured data for one page of ${org?.name ?? 'this business'}'s website` +
    `${org?.vertical ? ` (a ${org.vertical} business)` : ''}. ` +
    `Use ONLY the real facts given below — never invent an address, phone number, hours, or rating that isn't ` +
    `given. Omit a field entirely (don't fabricate a placeholder) if its real value isn't given. Output a single ` +
    `fenced \`\`\`json code block containing one valid JSON-LD object with "@context": "https://schema.org" and ` +
    `"@type": "${schemaType}" — nothing else, no explanation before or after.`;

  const user = [
    `Page: ${url}`,
    `Page title: ${page.title ?? '(none)'}`,
    `Main heading: ${page.h1 ?? '(none)'}`,
    `Business name: ${org?.name ?? '(unknown)'}`,
    `Website: ${sender.website_url ?? '(not on file)'}`,
    `Phone: ${sender.phone ?? '(not on file)'}`,
    `Address: ${sender.mailing_address ?? '(not on file)'}`,
    `Already-present schema types on this page: ${page.schema_types?.join(', ') || 'none'}`,
  ].join('\n');

  return { system, user };
}

function buildSeoRecommendationsPrompt(
  org: { name: string; vertical: string | null } | null,
  score: {
    health: number; technical: number | null; content: number | null;
    local_seo: number | null; performance: number | null;
    broken_links: number; critical_issues: number; high_issues: number;
  },
  issues: Array<{ code: string; severity: string; auto_fixable: boolean; pages: number; example_detail: string | null }>,
  pageStats: {
    total_pages: number; missing_title: number; thin_content: number;
    missing_meta_desc: number; missing_h1: number; not_indexable: number; images_missing_alt: number;
  } | null,
): { system: string; user: string } {
  const system =
    `You are the SEO Assistant inside ${org?.name ?? 'this business'}'s Venturelyx ScaleSEO module` +
    `${org?.vertical ? ` (a ${org.vertical} business)` : ''}. ` +
    `You're writing for the owner, not an SEO specialist — plain language, no jargon. ` +
    `Ground every claim strictly in the crawl data given; never invent issues, pages, or numbers not in it. ` +
    `Turn it into a ranked to-do list: 3-6 items, most impactful first, each one line — what to fix ` +
    `and why it matters (cite the real severity or page count). Note which ones are auto-fixable. ` +
    `No preamble, no sign-off, just the list.`;

  const scoreLine = `Scores (0-100): health ${score.health}` +
    (score.technical != null ? `, technical ${score.technical}` : '') +
    (score.content != null ? `, content ${score.content}` : '') +
    (score.local_seo != null ? `, local SEO ${score.local_seo}` : '') +
    (score.performance != null ? `, performance ${score.performance}` : '') +
    `. ${score.critical_issues} critical, ${score.high_issues} high-severity issues, ${score.broken_links} broken links.`;

  const issueLines = issues.map(
    (i) => `- [${i.severity}${i.auto_fixable ? ', auto-fixable' : ''}] ${i.code}: ${i.pages} page(s)` +
      (i.example_detail ? ` — ${i.example_detail}` : ''),
  );

  // Page-level content/technical signal straight from seo_pages — only
  // included when it says something, so a clean crawl doesn't manufacture
  // a complaint out of zero counts.
  const pageLines = pageStats
    ? [
        pageStats.missing_title > 0 ? `${pageStats.missing_title} of ${pageStats.total_pages} page(s) have no title tag.` : null,
        pageStats.missing_meta_desc > 0 ? `${pageStats.missing_meta_desc} page(s) have no meta description.` : null,
        pageStats.missing_h1 > 0 ? `${pageStats.missing_h1} page(s) have no H1.` : null,
        pageStats.thin_content > 0 ? `${pageStats.thin_content} page(s) have under 300 words.` : null,
        pageStats.not_indexable > 0 ? `${pageStats.not_indexable} page(s) are marked non-indexable.` : null,
        pageStats.images_missing_alt > 0 ? `${pageStats.images_missing_alt} page(s) have images missing alt text.` : null,
      ].filter(Boolean)
    : [];

  const sections = [
    scoreLine,
    issueLines.length > 0 ? `Issues from the latest crawl:\n${issueLines.join('\n')}` : null,
    pageLines.length > 0 ? `Page-level findings (${pageStats!.total_pages} pages crawled):\n${pageLines.map((l) => `- ${l}`).join('\n')}` : null,
  ].filter(Boolean);

  const user = issueLines.length > 0 || pageLines.length > 0
    ? `${sections.join('\n\n')}\n\nWhat should I fix first?`
    : `${scoreLine}\n\nNo specific issues were flagged in the latest crawl. Briefly say what's working and what to watch.`;

  return { system, user };
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
