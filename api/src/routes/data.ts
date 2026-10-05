/**
 * Venturelyx :: Command Center + ScaleSEO routes.
 *
 * Every query here runs through req.db(), which means RLS scopes it to the
 * caller's org automatically. None of these statements carry an org_id filter
 * and none of them need one.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/auth.js';
import { HttpError } from '../plugins/context.js';
import { moduleWriteGate } from '../lib/moduleAccess.js';
import { slugify } from '../lib/slug.js';

// This file mixes two modules (plus Command Center, which is never gated)
// under one router, so the module boundary is per-route here, not a
// plugin-wide hook like operate.ts/grow.ts/reviews.ts: only the /seo/*
// writes below get { preHandler: SCALESEO_WRITE }. The /command/* and
// /operate/leads|schedule|money routes are GET-only today regardless, so
// there's nothing currently to gate on them even if they were Operate's.
const SCALESEO_WRITE = { preHandler: moduleWriteGate('scaleseo') };

export default async function dataRoutes(app: FastifyInstance) {

  // ---- Command Center summary -------------------------------------------
  app.get('/command/summary', async (req) => {
    req.requireRole('viewer');

    return req.db(async (q) => {
      const [org, money, opportunities, seo, leads, work, pipeline, reputation, expenses, pipelineFunnel] = await Promise.all([
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

        q.one<{ pipeline_value: string; open_deals: number }>(
          `SELECT COALESCE(sum(value), 0)::text AS pipeline_value, count(*)::int AS open_deals
             FROM deals WHERE status = 'open'`,
        ),

        q.one<{ avg_rating: string | null; review_count: number }>(
          `SELECT avg(rating)::numeric(3,1)::text AS avg_rating, count(*)::int AS review_count FROM reviews`,
        ),

        q.one<{ this_month: string }>(
          `SELECT COALESCE(sum(amount), 0)::text AS this_month
             FROM expenses WHERE incurred_on >= date_trunc('month', now())`,
        ),

        // Sales pipeline funnel — parties.lifecycle is the real, populated
        // field (deals.stage/value exist but nothing writes them yet), so
        // these four stages are friendlier display labels over four of its
        // six real values. lost/dormant are deliberately excluded from an
        // *active* pipeline view. Dollar values still come from deals
        // (correctly $0 today — no deal has ever been created) rather than
        // inventing a number parties has no column for.
        q.rows<{ stage: string; count: number; value: string }>(
          `SELECT stages.label AS stage,
                  count(DISTINCT p.id)::int AS count,
                  COALESCE(sum(d.value), 0)::text AS value
             FROM (VALUES ('New Lead',1,'new'),('Contacted',2,'working'),
                          ('Quoted',3,'qualified'),('Won',4,'customer'))
                    AS stages(label, ord, lifecycle)
        LEFT JOIN parties p ON p.lifecycle = stages.lifecycle AND p.is_lead AND p.deleted_at IS NULL
        LEFT JOIN deals d ON d.party_id = p.id AND d.status = 'open'
            GROUP BY stages.label, stages.ord
            ORDER BY stages.ord`,
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

      return { org, money, channels, opportunities, seo, leads, work, pipeline, reputation, expenses, pipelineFunnel };
    });
  });

  // ---- Command Center: revenue trend --------------------------------------
  // Real months from payments, not sampled/hardcoded — an org with zero
  // succeeded payments (true for every org today) gets six real $0 months,
  // not fabricated numbers.
  app.get('/command/revenue-trend', async (req) => {
    req.requireRole('viewer');
    return req.db((q) =>
      q.rows<{ month: string; month_key: string; amount: string }>(
        `SELECT to_char(gs, 'Mon') AS month,
                to_char(gs, 'YYYY-MM') AS month_key,
                COALESCE((
                  SELECT sum(amount) FROM payments
                   WHERE status = 'succeeded'
                     AND date_trunc('month', received_at) = gs
                ), 0)::text AS amount
           FROM generate_series(
                  date_trunc('month', now()) - interval '5 months',
                  date_trunc('month', now()),
                  interval '1 month'
                ) AS gs
          ORDER BY gs`,
      ),
    );
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
                s.environment, s.is_primary, s.in_health_score,
                s.last_crawl_at, s.next_crawl_at, s.crawl_schedule,
                sc.health, sc.pages, sc.critical_issues, sc.high_issues,
                (SELECT count(*)::int FROM seo_crawls WHERE site_id = s.id) AS crawl_count,
                (SELECT count(*)::int FROM seo_pages p
                   JOIN seo_crawls c ON c.id = p.crawl_id
                  WHERE c.site_id = s.id) AS page_count,
                (SELECT count(*)::int FROM seo_issues i
                   JOIN seo_crawls c ON c.id = i.crawl_id
                  WHERE c.site_id = s.id) AS issue_count
           FROM seo_sites s
      LEFT JOIN LATERAL (
             SELECT * FROM seo_scores WHERE site_id = s.id
              ORDER BY computed_at DESC LIMIT 1
           ) sc ON true
          ORDER BY s.is_primary DESC, s.name`,
      ),
    );
  });

  // ---- ScaleSEO: single site config (crawler settings, not health) ------
  app.get('/seo/sites/:siteId', async (req) => {
    req.requireRole('viewer');
    const { siteId } = z.object({ siteId: z.string().uuid() }).parse(req.params);
    return req.db(async (q) => {
      const site = await q.one(
        `SELECT id, key, name, url, enabled, render, max_pages, concurrency,
                delay_ms, timeout_s, respect_robots, crawl_schedule,
                environment, is_primary, in_health_score
           FROM seo_sites WHERE id = $1`,
        [siteId],
      );
      if (!site) throw new HttpError(404, 'Site not found', 'not_found');
      return site;
    });
  });

  // ---- ScaleSEO: create a site --------------------------------------------
  // Mirrors the onboarding INSERT in routes/auth.ts (key = slugify(hostname),
  // immediately queue a crawl) — this is the same action for an org that
  // already finished onboarding and needs a second site (a new location, a
  // staging rebuild, etc).
  const seoSiteCreateInput = z.object({
    url: z.string().trim().url(),
    name: z.string().trim().min(1).max(200),
    environment: z.enum(['production', 'staging', 'development']).default('production'),
    is_primary: z.boolean().default(false),
    render: z.boolean().default(false),
    in_health_score: z.boolean().default(true),
  });

  app.post('/seo/sites', SCALESEO_WRITE, async (req, reply) => {
    req.requireRole('admin');
    const sess = req.requireAuth();
    const body = seoSiteCreateInput.parse(req.body);

    let host: string;
    try { host = new URL(body.url).hostname.replace(/^www\./, ''); }
    catch { host = body.url; }
    const baseKey = slugify(host) || slugify(body.name) || 'site';

    return req.db(async (q) => {
      if (body.is_primary) {
        await q.exec(`UPDATE seo_sites SET is_primary = false WHERE org_id = app.current_org() AND is_primary`);
      }

      let site: { id: string } | null = null;
      let key = baseKey;
      // seo_sites_org_id_key_key (org_id, key) is unique — a second site on
      // the same hostname (e.g. a staging subdomain sharing the apex) is a
      // real scenario, not a bug, so retry once with a short random suffix
      // rather than reject the request.
      for (let attempt = 0; attempt < 2 && !site; attempt++) {
        try {
          site = await q.one<{ id: string }>(
            `INSERT INTO seo_sites (org_id, key, name, url, environment, is_primary, render, in_health_score)
             VALUES (app.current_org(), $1, $2, $3, $4, $5, $6, $7)
             RETURNING id`,
            [key, body.name, body.url, body.environment, body.is_primary, body.render, body.in_health_score],
          );
        } catch (err) {
          const constraint = (err as { constraint?: string }).constraint;
          if (attempt === 0 && constraint === 'seo_sites_org_id_key_key') {
            key = `${baseKey}-${randomBytes(2).toString('hex')}`;
            continue;
          }
          throw err;
        }
      }
      if (!site) throw new HttpError(500, 'Could not create this site', 'internal_error');

      const job = await q.one<{ id: number }>(
        `INSERT INTO job_queue (org_id, kind, payload, dedupe_key, priority)
         VALUES (app.current_org(), 'seo.crawl',
                 jsonb_build_object('site_id', $1::text, 'trigger', 'manual'),
                 'seo.crawl:' || $1::text, 50)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [site.id],
      );

      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'seo.site.create',
        entityType: 'seo_sites', entityId: site.id, ip: req.ip, diff: body,
      });

      reply.status(201);
      return { id: site.id, crawlQueued: !!job };
    });
  });

  // ---- ScaleSEO: edit a site ---------------------------------------------
  // `render` decides whether workers/seo/crawler.py fetches this site with a
  // headless browser (client-rendered SPAs) or plain HTTP (static sites) —
  // previously only settable by re-running scripts/seed_sites.py by hand
  // (see nppools.com, which migrated to a client-rendered platform after
  // being seeded static). `in_health_score` excludes a work-in-progress
  // rebuild from the brand's headline score without hiding it. Admin-gated
  // like other technical/ops toggles (PATCH /orgs/current, PUT
  // /service-area), not a day-to-day edit.
  const seoSiteUpdateInput = z.object({
    url: z.string().trim().url().optional(),
    name: z.string().trim().min(1).max(200).optional(),
    environment: z.enum(['production', 'staging', 'development']).optional(),
    is_primary: z.boolean().optional(),
    render: z.boolean().optional(),
    in_health_score: z.boolean().optional(),
  });

  app.patch('/seo/sites/:siteId', SCALESEO_WRITE, async (req) => {
    req.requireRole('admin');
    const sess = req.requireAuth();
    const { siteId } = z.object({ siteId: z.string().uuid() }).parse(req.params);
    const body = seoSiteUpdateInput.parse(req.body);

    return req.db(async (q) => {
      if (body.is_primary) {
        await q.exec(
          `UPDATE seo_sites SET is_primary = false WHERE org_id = app.current_org() AND is_primary AND id != $1`,
          [siteId],
        );
      }
      const site = await q.one(
        `UPDATE seo_sites SET
                url = COALESCE($1, url),
                name = COALESCE($2, name),
                environment = COALESCE($3, environment),
                is_primary = COALESCE($4, is_primary),
                render = COALESCE($5, render),
                in_health_score = COALESCE($6, in_health_score)
          WHERE id = $7
         RETURNING id, key, name, url, enabled, render, max_pages, concurrency,
                   delay_ms, timeout_s, respect_robots, crawl_schedule,
                   environment, is_primary, in_health_score`,
        [body.url ?? null, body.name ?? null, body.environment ?? null, body.is_primary ?? null,
         body.render ?? null, body.in_health_score ?? null, siteId],
      );
      if (!site) throw new HttpError(404, 'Site not found', 'not_found');
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'seo.site.update',
        entityType: 'seo_sites', entityId: siteId, ip: req.ip, diff: body,
      });
      return site;
    });
  });

  // ---- ScaleSEO: delete a site --------------------------------------------
  // Every child table (seo_crawls, seo_pages, seo_issues, seo_keywords,
  // seo_scores, seo_links, seo_competitors, seo_ga4_daily, seo_gsc_daily,
  // seo_local_visibility) has ON DELETE CASCADE on site_id — the DB does the
  // actual cleanup; this route's own job is confirming to the caller what
  // that cascade is about to take, which the frontend shows before the user
  // ever gets here.
  app.delete('/seo/sites/:siteId', SCALESEO_WRITE, async (req, reply) => {
    req.requireRole('admin');
    const sess = req.requireAuth();
    const { siteId } = z.object({ siteId: z.string().uuid() }).parse(req.params);

    await req.db(async (q) => {
      const site = await q.one<{ id: string; name: string }>(
        `SELECT id, name FROM seo_sites WHERE id = $1`, [siteId],
      );
      if (!site) throw new HttpError(404, 'Site not found', 'not_found');
      await q.exec(`DELETE FROM seo_sites WHERE id = $1`, [siteId]);
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'seo.site.delete',
        entityType: 'seo_sites', entityId: siteId, ip: req.ip, diff: { name: site.name },
      });
    });
    reply.status(204);
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
  app.post('/seo/crawl/:siteId', SCALESEO_WRITE, async (req) => {
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

  // ---- ScaleSEO: keywords -------------------------------------------------
  // All tracked keywords for the site, not just seo_rank_current's ranked
  // subset — a keyword can be tracked before it's ever been checked, and
  // that's a real state ("—" for position), not one to hide.
  app.get('/seo/keywords/:siteId', async (req) => {
    req.requireRole('viewer');
    const { siteId } = z.object({ siteId: z.string().uuid() }).parse(req.params);
    return req.db((q) =>
      q.rows(
        `SELECT k.id, k.phrase, k.search_volume, k.difficulty, k.intent, k.is_branded,
                k.est_value_monthly::text, r.position, r.checked_on
           FROM seo_keywords k
      LEFT JOIN LATERAL (
                  SELECT position, checked_on FROM seo_rankings
                   WHERE keyword_id = k.id AND engine = 'google'
                   ORDER BY checked_on DESC LIMIT 1
                ) r ON true
          WHERE k.site_id = $1 AND k.is_tracked
          ORDER BY k.est_value_monthly DESC NULLS LAST, k.phrase`,
        [siteId],
      ),
    );
  });

  // ---- ScaleSEO: coverage gaps ----------------------------------------------
  // catalog_items x locations, crossed into market_targets whenever either
  // side changes (see lib/marketTargets.ts). "Covered" isn't guessed here —
  // workers/seo/coverage.py sets market_targets.status = 'published' after
  // each crawl, and only when a crawled page's URL or title actually
  // contains both the service name and the location name. A gap is anything
  // still short of that (or, defensively, a combination that predates the
  // crossing and has no row at all), ranked by how many other services are
  // missing in the same area — a location missing several services is the
  // more urgent pattern to act on, which is also how the top gaps get
  // chosen for the signals workers/seo/coverage.py writes.
  app.get('/seo/coverage-gaps', async (req) => {
    req.requireRole('viewer');
    return req.db((q) =>
      q.rows(
        `SELECT catalog_item_id, service_name, location_id, location_name,
                market_target_id, status,
                count(*) OVER (PARTITION BY location_id)::int AS uncovered_in_location
           FROM (
                SELECT ci.id AS catalog_item_id, ci.name AS service_name,
                       l.id AS location_id, l.name AS location_name,
                       mt.id AS market_target_id, mt.status
                  FROM catalog_items ci
                  JOIN locations l ON l.org_id = ci.org_id AND l.is_active
             LEFT JOIN market_targets mt ON mt.catalog_item_id = ci.id AND mt.location_id = l.id
                 WHERE ci.is_active AND ci.kind = 'service'
                   AND (mt.id IS NULL OR (mt.is_served AND mt.status <> 'published'))
              ) gaps
          ORDER BY uncovered_in_location DESC, location_name, service_name`,
      ),
    );
  });

  // ---- ScaleSEO: Google Search Console queries ------------------------------
  // Real query-level performance, straight from seo_gsc_daily (daily.sync
  // populates it once Google Search Console is connected — see
  // routes/integrations.ts). No GSC connection means no data to show, and
  // this deliberately returns an empty/disconnected shape rather than
  // anything resembling ranking numbers — the frontend's job is to show a
  // connect prompt, never to fill the gap with plausible-looking numbers.
  app.get('/seo/gsc-queries/:siteId', async (req) => {
    req.requireRole('viewer');
    const { siteId } = z.object({ siteId: z.string().uuid() }).parse(req.params);
    const { sort } = z.object({ sort: z.enum(['impressions', 'position']).default('impressions') })
      .parse(req.query);

    return req.db(async (q) => {
      const integration = await q.one<{ status: string }>(
        `SELECT status FROM integrations
          WHERE org_id = app.current_org() AND provider = 'google_search_console'`,
      );
      if (integration?.status !== 'connected') {
        return { connected: false, rows: [] };
      }

      const order = sort === 'position' ? 'position ASC NULLS LAST' : 'impressions DESC';
      const rows = await q.rows(
        `SELECT query, page, sum(clicks)::int AS clicks, sum(impressions)::int AS impressions,
                CASE WHEN sum(impressions) > 0
                     THEN round(sum(clicks)::numeric / sum(impressions), 4) ELSE NULL END AS ctr,
                round(avg(position), 1) AS position
           FROM seo_gsc_daily
          WHERE site_id = $1 AND date >= current_date - 28 AND query <> ''
          GROUP BY query, page
          ORDER BY ${order}
          LIMIT 200`,
        [siteId],
      );
      return { connected: true, rows };
    });
  });

  // ---- ScaleSEO: competitors -----------------------------------------------
  app.get('/seo/competitors/:siteId', async (req) => {
    req.requireRole('viewer');
    const { siteId } = z.object({ siteId: z.string().uuid() }).parse(req.params);
    return req.db((q) =>
      q.rows(
        `SELECT c.id, c.name, c.domain, c.discovered,
                avg(cr.position)::numeric(5,1)::text AS avg_position,
                count(cr.id)::int AS tracked_keywords
           FROM seo_competitors c
      LEFT JOIN seo_competitor_rankings cr ON cr.competitor_id = c.id
                 AND cr.checked_on = (SELECT max(checked_on) FROM seo_competitor_rankings
                                       WHERE competitor_id = c.id)
          WHERE c.site_id = $1 AND c.is_tracked
          GROUP BY c.id, c.name, c.domain, c.discovered
          ORDER BY avg_position ASC NULLS LAST, c.name`,
        [siteId],
      ),
    );
  });

  // ---- ScaleSEO: crawl history ----------------------------------------------
  app.get('/seo/crawl-history/:siteId', async (req) => {
    req.requireRole('viewer');
    const { siteId } = z.object({ siteId: z.string().uuid() }).parse(req.params);
    return req.db((q) =>
      q.rows(
        `SELECT c.id, c.started_at, c.finished_at, c.status, c.pages_crawled,
                c.trigger, c.error, sc.health
           FROM seo_crawls c
      LEFT JOIN seo_scores sc ON sc.crawl_id = c.id
          WHERE c.site_id = $1
          ORDER BY c.started_at DESC
          LIMIT 50`,
        [siteId],
      ),
    );
  });

  // ---- ScaleSEO: AI-drafted content pages -----------------------------------
  const contentPageInput = z.object({
    kind: z.string().min(1).default('service_page'),
    url: z.string().nullable().optional(),
    slug: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    meta_description: z.string().nullable().optional(),
    h1: z.string().nullable().optional(),
    body: z.string().nullable().optional(),
    generated_by: z.string().nullable().optional(),
  });

  app.get('/seo/content-pages', async (req) => {
    req.requireRole('viewer');
    return req.db((q) =>
      q.rows(
        `SELECT id, kind, url, slug, title, meta_description, h1, status,
                generated_by, published_at, created_at, updated_at
           FROM content_pages
          ORDER BY created_at DESC
          LIMIT 100`,
      ),
    );
  });

  app.post('/seo/content-pages', SCALESEO_WRITE, async (req) => {
    req.requireRole('staff');
    const body = contentPageInput.parse(req.body);
    return req.db((q) =>
      q.one(
        `INSERT INTO content_pages
           (org_id, kind, url, slug, title, meta_description, h1, body, generated_by, status)
         VALUES (app.current_org(), $1,$2,$3,$4,$5,$6,$7,$8,'draft')
         RETURNING id, kind, url, slug, title, meta_description, h1, body, status,
                   generated_by, published_at, created_at, updated_at`,
        [
          body.kind, body.url ?? null, body.slug ?? null, body.title ?? null,
          body.meta_description ?? null, body.h1 ?? null, body.body ?? null,
          body.generated_by ?? null,
        ],
      ),
    );
  });

  // ---- Operate: leads (all pipeline stages) ------------------------------
  // Was restricted to new/working/qualified ("needing attention"). The
  // Kanban pipeline (Operate) and the Command Center's Customers metric
  // both need every stage — new|working|qualified|customer|lost|dormant —
  // so the filter is gone. LIMIT bumped from 25 (a short "attention" list)
  // to 500 (the whole pipeline); real pagination is parties.js's job later
  // per OPERATE-SPEC.md, not this endpoint, for now.
  app.get('/operate/leads', async (req) => {
    req.requireRole('viewer');
    return req.db((q) =>
      q.rows(
        `SELECT p.id, p.display_name, p.lifecycle, p.city, p.last_activity_at,
                p.first_seen_at, t.channel, t.source,
                (SELECT value FROM party_contacts
                  WHERE party_id = p.id AND channel = 'phone' AND is_primary LIMIT 1) AS phone,
                d.title AS deal_title, d.value::text AS deal_value
           FROM parties p
      LEFT JOIN attribution_touches t ON t.id = p.first_touch_id
      LEFT JOIN LATERAL (
                SELECT title, value FROM deals
                 WHERE party_id = p.id AND status = 'open'
                 ORDER BY created_at DESC LIMIT 1
              ) d ON true
          WHERE p.is_lead AND p.deleted_at IS NULL
          ORDER BY p.last_activity_at NULLS FIRST, p.first_seen_at DESC
          LIMIT 500`,
      ),
    );
  });

  // ---- Operate: upcoming job schedule ------------------------------------
  // Read-only, same shape as every other Operate list here — no write
  // surface, no new table. Feeds the Job Scheduling widget on the Kanban's
  // sidebar; work_orders has no other list endpoint today (only the
  // today/week counts in /command/summary), so this is additive, not a
  // replacement for anything.
  app.get('/operate/schedule', async (req) => {
    req.requireRole('viewer');
    return req.db((q) =>
      q.rows<{ id: string; title: string; status: string; scheduled_start: string | null; display_name: string }>(
        `SELECT wo.id, wo.title, wo.status, wo.scheduled_start, p.display_name
           FROM work_orders wo
           JOIN parties p ON p.id = wo.party_id
          WHERE wo.scheduled_start >= now() - interval '1 hour'
            AND wo.status NOT IN ('cancelled')
          ORDER BY wo.scheduled_start ASC
          LIMIT 8`,
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
