/**
 * Venturelyx :: Command Center + ScaleSEO routes.
 *
 * Every query here runs through req.db(), which means RLS scopes it to the
 * caller's org automatically. None of these statements carry an org_id filter
 * and none of them need one.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

export default async function dataRoutes(app: FastifyInstance) {

  // ---- Command Center summary -------------------------------------------
  app.get('/command/summary', async (req) => {
    req.requireRole('viewer');

    return req.db(async (q) => {
      const [org, money, opportunities, seo, leads, work] = await Promise.all([
        q.one<{ name: string; vertical: string | null; modules: unknown }>(
          `SELECT name, vertical, modules FROM organizations WHERE id = app.current_org()`,
        ),

        // Collected this month, and what is still outstanding.
        q.one<{ collected: string; outstanding: string; last_month: string }>(
          `SELECT
             COALESCE((SELECT sum(amount) FROM payments
                        WHERE received_at >= date_trunc('month', now())
                          AND status = 'succeeded'), 0)::text AS collected,
             COALESCE((SELECT sum(total - amount_paid) FROM invoices
                        WHERE status IN ('sent','partial','overdue')), 0)::text AS outstanding,
             COALESCE((SELECT sum(amount) FROM payments
                        WHERE received_at >= date_trunc('month', now()) - interval '1 month'
                          AND received_at <  date_trunc('month', now())
                          AND status = 'succeeded'), 0)::text AS last_month`,
        ),

        q.rows(
          `SELECT id, title, rationale, est_value_monthly::text, effort, confidence,
                  score::text, kind, module
             FROM growth_opportunities
            WHERE status = 'open'
            ORDER BY score DESC NULLS LAST, est_value_monthly DESC NULLS LAST
            LIMIT 5`,
        ),

        q.one(
          `SELECT sc.health, sc.technical, sc.content, sc.performance, sc.local_seo,
                  sc.pages, sc.broken_links, sc.critical_issues, sc.high_issues,
                  sc.computed_at, s.key AS site_key, s.url AS site_url
             FROM seo_scores sc
             JOIN seo_sites s ON s.id = sc.site_id
            WHERE s.is_primary
            ORDER BY sc.computed_at DESC
            LIMIT 1`,
        ),

        q.one<{ new_leads: number; stale: number }>(
          `SELECT
             (SELECT count(*) FROM parties
               WHERE is_lead AND deleted_at IS NULL
                 AND first_seen_at >= now() - interval '7 days')::int AS new_leads,
             (SELECT count(*) FROM parties
               WHERE is_lead AND deleted_at IS NULL AND lifecycle IN ('new','working')
                 AND (last_activity_at IS NULL OR last_activity_at < now() - interval '5 days')
             )::int AS stale`,
        ),

        q.one<{ today_total: number; today_done: number; week: number }>(
          `SELECT
             (SELECT count(*) FROM work_orders
               WHERE scheduled_start::date = current_date)::int AS today_total,
             (SELECT count(*) FROM work_orders
               WHERE scheduled_start::date = current_date AND status = 'complete')::int AS today_done,
             (SELECT count(*) FROM work_orders
               WHERE scheduled_start >= date_trunc('week', now())
                 AND scheduled_start <  date_trunc('week', now()) + interval '7 days')::int AS week`,
        ),
      ]);

      // Revenue by acquisition channel — the claim no single-purpose tool can make.
      const channels = await q.rows<{ channel: string; amount: string }>(
        `SELECT COALESCE(t.channel, 'direct') AS channel,
                sum(p.amount)::text AS amount
           FROM payments p
           JOIN parties  pa ON pa.id = p.party_id
      LEFT JOIN attribution_touches t ON t.id = pa.first_touch_id
          WHERE p.received_at >= date_trunc('month', now())
            AND p.status = 'succeeded'
          GROUP BY 1
          ORDER BY sum(p.amount) DESC`,
      );

      return { org, money, channels, opportunities, seo, leads, work };
    });
  });

  // ---- open signals (the "worth doing" list) ----------------------------
  app.get('/command/signals', async (req) => {
    req.requireRole('viewer');
    return req.db((q) =>
      q.rows(
        `SELECT id, module, signal_type, severity, summary, detail, detected_at
           FROM signals
          WHERE resolved_at IS NULL
          ORDER BY severity, detected_at DESC
          LIMIT 50`,
      ),
    );
  });

  // ---- ScaleSEO: sites --------------------------------------------------
  app.get('/seo/sites', async (req) => {
    req.requireRole('viewer');
    return req.db((q) =>
      q.rows(
        `SELECT s.id, s.key, s.name, s.url, s.enabled, s.render, s.max_pages,
                s.last_crawl_at, s.next_crawl_at, s.crawl_schedule,
                sc.health, sc.pages, sc.critical_issues, sc.high_issues
           FROM seo_sites s
      LEFT JOIN LATERAL (
             SELECT * FROM seo_scores WHERE site_id = s.id
              ORDER BY computed_at DESC LIMIT 1
           ) sc ON true
          ORDER BY s.is_primary DESC, s.name`,
      ),
    );
  });

  // ---- ScaleSEO: health detail -----------------------------------------
  app.get('/seo/health/:siteId', async (req) => {
    req.requireRole('viewer');
    const { siteId } = z.object({ siteId: z.string().uuid() }).parse(req.params);

    return req.db(async (q) => {
      const score = await q.one(
        `SELECT sc.*, c.started_at, c.pages_crawled, c.status AS crawl_status
           FROM seo_scores sc
           JOIN seo_crawls c ON c.id = sc.crawl_id
          WHERE sc.site_id = $1
          ORDER BY sc.computed_at DESC LIMIT 1`,
        [siteId],
      );

      // Grouped by issue code: one thing to do, not one row per URL.
      const issues = await q.rows(
        `SELECT i.code, i.severity, i.auto_fixable, count(*)::int AS pages,
                (array_agg(i.url ORDER BY i.url))[1:3] AS examples,
                (array_agg(i.detail ORDER BY i.url))[1] AS example_detail
           FROM seo_issues i
          WHERE i.crawl_id = (SELECT crawl_id FROM seo_scores
                               WHERE site_id = $1 ORDER BY computed_at DESC LIMIT 1)
          GROUP BY i.code, i.severity, i.auto_fixable
          ORDER BY CASE i.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2
                                   WHEN 'medium' THEN 3 ELSE 4 END, count(*) DESC`,
        [siteId],
      );

      const trend = await q.rows(
        `SELECT health, computed_at FROM seo_scores
          WHERE site_id = $1 ORDER BY computed_at DESC LIMIT 12`,
        [siteId],
      );

      return { score, issues, trend };
    });
  });

  // ---- ScaleSEO: pages --------------------------------------------------
  app.get('/seo/pages/:siteId', async (req) => {
    req.requireRole('viewer');
    const { siteId } = z.object({ siteId: z.string().uuid() }).parse(req.params);

    return req.db((q) =>
      q.rows(
        `SELECT url, status_code, title, title_len, meta_desc_len, h1_count,
                word_count, images_total, images_no_alt, response_ms, indexable,
                schema_types
           FROM seo_pages
          WHERE crawl_id = (SELECT id FROM seo_crawls WHERE site_id = $1
                             AND status = 'ok' ORDER BY started_at DESC LIMIT 1)
          ORDER BY url`,
        [siteId],
      ),
    );
  });

  // ---- ScaleSEO: local rankings ----------------------------------------
  app.get('/seo/rankings', async (req) => {
    req.requireRole('viewer');
    return req.db((q) =>
      q.rows(
        `SELECT phrase, location_name, position, previous, movement, checked_on
           FROM seo_rank_current
          ORDER BY position NULLS LAST, phrase`,
      ),
    );
  });

  // ---- ScaleSEO: queue a crawl -----------------------------------------
  app.post('/seo/crawl/:siteId', async (req) => {
    req.requireRole('manager');
    const { siteId } = z.object({ siteId: z.string().uuid() }).parse(req.params);

    return req.db(async (q) => {
      const site = await q.one<{ id: string; key: string }>(
        `SELECT id, key FROM seo_sites WHERE id = $1 AND enabled`, [siteId],
      );
      if (!site) return { queued: false, reason: 'Site not found or not enabled' };

      const job = await q.one<{ id: number }>(
        `INSERT INTO job_queue (org_id, kind, payload, dedupe_key, priority)
         VALUES (app.current_org(), 'seo.crawl',
                 jsonb_build_object('site_id', $1::text, 'trigger', 'manual'),
                 'seo.crawl:' || $1::text, 50)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [siteId],
      );

      return job
        ? { queued: true, jobId: job.id }
        : { queued: false, reason: 'A check is already running for this site' };
    });
  });

  // ---- Operate: leads needing attention --------------------------------
  app.get('/operate/leads', async (req) => {
    req.requireRole('viewer');
    return req.db((q) =>
      q.rows(
        `SELECT p.id, p.display_name, p.lifecycle, p.city, p.last_activity_at,
                p.first_seen_at, t.channel, t.source,
                (SELECT value FROM party_contacts
                  WHERE party_id = p.id AND channel = 'phone' AND is_primary LIMIT 1) AS phone
           FROM parties p
      LEFT JOIN attribution_touches t ON t.id = p.first_touch_id
          WHERE p.is_lead AND p.deleted_at IS NULL
            AND p.lifecycle IN ('new','working','qualified')
          ORDER BY p.last_activity_at NULLS FIRST, p.first_seen_at DESC
          LIMIT 25`,
      ),
    );
  });

  // ---- Operate: money ---------------------------------------------------
  app.get('/operate/money', async (req) => {
    req.requireRole('viewer');
    return req.db(async (q) => ({
      overdue: await q.rows(
        `SELECT i.number, i.total::text, (i.total - i.amount_paid)::text AS owed,
                i.due_on, p.display_name,
                (current_date - i.due_on)::int AS days_overdue
           FROM invoices i JOIN parties p ON p.id = i.party_id
          WHERE i.status IN ('sent','partial','overdue') AND i.due_on < current_date
          ORDER BY i.due_on
          LIMIT 20`,
      ),
      upcoming: await q.one<{ count: number; total: string }>(
        `SELECT count(*)::int AS count,
                COALESCE(sum(total - amount_paid), 0)::text AS total
           FROM invoices
          WHERE status IN ('sent','partial') AND due_on >= current_date`,
      ),
    }));
  });
}
