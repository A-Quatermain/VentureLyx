/**
 * Venturelyx :: Free Growth Scan funnel + the admin leads/checkout console
 * built on top of it.
 *
 * Deliberately mirrors routes/waitlist.ts's shape for the public half: no
 * session, no org context, runs through withPlatform. Unlike waitlist, a
 * scan needs somewhere real to write ScaleSEO's crawl output, so it gets a
 * full organization (status='prospect') rather than a row in a side table
 * — see the chat response this shipped with for why that's the better
 * trade (reuses the unmodified ScaleSEO pipeline) once scoped correctly
 * (no membership until conversion; hidden from every customer-facing
 * admin view by status; never picked up by a recurring crawl scheduler).
 *
 * Every dollar amount Stripe actually charges originates here, from
 * deal_checkout_sessions — never from a value a browser submits. Checkout
 * line items are always built with price_data/product_data from those
 * stored cents, so an admin's per-deal override and the catalog default go
 * through the exact same code path.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withPlatform, withTenant, type Querier } from '../lib/db.js';
import { HttpError } from '../plugins/context.js';
import { requireStaffOrNotFound } from '../lib/staffGuard.js';
import { stripe, resolvePrice, getOrCreateStripeCustomer } from '../lib/stripe.js';
import { slugify } from '../lib/slug.js';
import { newSessionToken, hashToken, hashPassword, audit, SESSION_COOKIE, SESSION_TTL_DAYS, sessionCookieOptions } from '../lib/auth.js';
import { sendEmail } from '../lib/email.js';
import { growthScanReportEmail, paymentLinkEmail } from '../lib/emailTemplates.js';

const APP_BASE_URL = process.env.APP_BASE_URL ?? 'https://app.venturelyx.com';
const INTAKE_TOKEN_TTL_DAYS = 14;

// Mirrors db/migrations/023_monetization_v2.sql's seed exactly — new scan
// orgs are created at request time, long after that one-time migration
// backfill ran, so this is the live code path every real scan goes through.
const GROWTH_SCAN_STAGES = [
  { key: 'new_scan', label: 'New Scan', probability: 5, is_won: false, is_lost: false },
  { key: 'active_prospect', label: 'Active Prospect', probability: 10, is_won: false, is_lost: false },
  { key: 'growth_review', label: 'Growth Review', probability: 25, is_won: false, is_lost: false },
  { key: 'proposal', label: 'Proposal', probability: 40, is_won: false, is_lost: false },
  { key: 'approved_for_intake', label: 'Approved for Intake', probability: 60, is_won: false, is_lost: false },
  { key: 'intake_started', label: 'Intake Started', probability: 70, is_won: false, is_lost: false },
  { key: 'payment_pending', label: 'Payment Pending', probability: 85, is_won: false, is_lost: false },
  { key: 'paid', label: 'Paid', probability: 95, is_won: false, is_lost: false },
  { key: 'onboarding', label: 'Onboarding', probability: 98, is_won: false, is_lost: false },
  { key: 'active_customer', label: 'Active Customer', probability: 100, is_won: true, is_lost: false },
];

// plan_key -> {setup, monthly} Stripe lookup_keys (scripts/stripeCatalog.ts
// is the source of truth for what these resolve to). Used only to read a
// DEFAULT price for the admin to see/override — never to charge directly;
// every actual charge goes through deal_checkout_sessions' stored cents.
const PLAN_LOOKUP_KEYS: Record<string, { setup: string | null; monthly: string }> = {
  platform: { setup: null, monthly: 'platform_monthly' },
  growth_partner: { setup: null, monthly: 'growth_partner_monthly' },
  launch_growth: { setup: 'launch_growth_setup', monthly: 'launch_growth_monthly' },
  founding: { setup: 'founding_setup', monthly: 'founding_monthly' },
};
const PLAN_LABEL: Record<string, string> = {
  platform: 'Platform', growth_partner: 'Growth Partner', launch_growth: 'Launch & Growth', founding: 'Founding Business',
};

async function getPlatformSetting<T>(q: Querier, key: string, fallback: T): Promise<T> {
  const row = await q.one<{ value: T }>(`SELECT value FROM platform_settings WHERE key = $1`, [key]);
  return row ? row.value : fallback;
}

function scanKeyGenerator(req: FastifyRequest): string {
  return `scan:${(req.headers['cf-connecting-ip'] as string) ?? req.ip}`;
}
function unlockKeyGenerator(req: FastifyRequest): string {
  const body = req.body as { email?: string } | undefined;
  return `unlock:${(body?.email ?? '').toLowerCase()}`;
}

async function latestHealthScore(q: Querier, orgId: string): Promise<number | null> {
  const row = await q.one<{ health: number }>(
    `SELECT sc.health FROM seo_scores sc
       JOIN seo_sites s ON s.id = sc.site_id
      WHERE s.org_id = $1
      ORDER BY sc.computed_at DESC LIMIT 1`,
    [orgId],
  );
  return row?.health ?? null;
}

/** The one deal a prospect org has in the Growth Scan Funnel pipeline —
 *  there's normally exactly one; if staff ever add a second ad hoc deal for
 *  the same org this takes the most recent, same convention admin.ts
 *  already uses (owner lookup's ORDER BY ... LIMIT 1). */
async function growthScanDeal(q: Querier, orgId: string): Promise<{ id: string; stage: string; pipeline_id: string } | null> {
  return q.one(
    `SELECT d.id, d.stage, d.pipeline_id FROM deals d
       JOIN pipelines p ON p.id = d.pipeline_id
      WHERE d.org_id = $1 AND p.name = 'Growth Scan Funnel'
      ORDER BY d.created_at DESC LIMIT 1`,
    [orgId],
  );
}

export default async function growthScanRoutes(app: FastifyInstance) {
  // =========================================================================
  // PUBLIC — no session, no org context. Mirrors routes/waitlist.ts's shape.
  // =========================================================================

  app.post('/growth-scan', {
    // Each scan is a real crawl — uncapped this is a real abuse/cost
    // surface, not just a write to throttle. Keyed by IP (the plugin
    // default via cf-connecting-ip, same as server.ts's global limiter),
    // not email — nobody has given an email yet at this step.
    config: { rateLimit: { max: 3, timeWindow: '1 day', keyGenerator: scanKeyGenerator } },
  }, async (req, reply) => {
    const { url } = z.object({ url: z.string().trim().url() }).parse(req.body);

    let host: string;
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { host = url; }
    const baseSlug = slugify(host) || 'scan';

    const result = await withPlatform(async (q) => {
      let slug = baseSlug;
      const collision = await q.one(`SELECT 1 FROM organizations WHERE slug = $1`, [slug]);
      if (collision) slug = `${baseSlug}-${randomBytes(3).toString('hex')}`;

      const org = await q.one<{ id: string }>(
        `INSERT INTO organizations (slug, name, website_url, status)
         VALUES ($1,$2,$3,'prospect') RETURNING id`,
        [slug, host, url],
      );
      const orgId = org!.id;

      // enabled=false, is_primary=false: this site must never be picked up
      // by a recurring crawl scheduler (scripts/crawl.py --all-due,
      // worker/aiVisibilityCheck.js --all-due) — a lead that never converts
      // would otherwise get crawled and AI-checked forever. The one crawl
      // it does get is enqueued directly below, not through that path.
      const site = await q.one<{ id: string }>(
        `INSERT INTO seo_sites (org_id, key, name, url, enabled, is_primary)
         VALUES ($1,$2,$3,$4,false,false) RETURNING id`,
        [orgId, slug, host, url],
      );

      await q.exec(
        `INSERT INTO job_queue (org_id, kind, payload, dedupe_key, priority)
         VALUES ($1,'seo.crawl', jsonb_build_object('site_id',$2::text,'trigger','growth_scan'),
                 'seo.crawl:' || $2::text, 50)
         ON CONFLICT DO NOTHING`,
        [orgId, site!.id],
      );

      // Every prospect org gets its own Growth Scan Funnel pipeline at
      // creation — 023's migration-time seed only covered orgs that
      // existed at migration time, not ones created afterward.
      await q.exec(
        `INSERT INTO pipelines (org_id, name, stages, is_default)
         VALUES ($1,'Growth Scan Funnel',$2::jsonb,false)`,
        [orgId, JSON.stringify(GROWTH_SCAN_STAGES)],
      );

      return { scanId: orgId };
    });

    reply.status(201);
    return result;
  });

  app.get('/growth-scan/:id/summary', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    return withPlatform(async (q) => {
      const org = await q.one<{ id: string }>(`SELECT id FROM organizations WHERE id = $1 AND status = 'prospect'`, [id]);
      if (!org) throw new HttpError(404, 'Scan not found', 'not_found');

      const health = await latestHealthScore(q, id);
      return { healthScore: health, status: health === null ? 'pending' : 'ready' };
    });
  });

  app.post('/growth-scan/:id/unlock', {
    config: { rateLimit: { max: 5, timeWindow: '30 minutes', hook: 'preHandler', keyGenerator: unlockKeyGenerator } },
  }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { email } = z.object({ email: z.string().trim().toLowerCase().email() }).parse(req.body);

    await withPlatform(async (q) => {
      const org = await q.one<{ id: string; name: string }>(
        `SELECT id, name FROM organizations WHERE id = $1 AND status = 'prospect'`, [id],
      );
      if (!org) throw new HttpError(404, 'Scan not found', 'not_found');

      // Idempotent on double-submit, same idiom as waitlist's ON CONFLICT —
      // a repeat unlock just re-sends the report rather than creating a
      // second lead/deal for the same scan.
      const existingDeal = await growthScanDeal(q, id);
      if (!existingDeal) {
        const pipeline = await q.one<{ id: string }>(
          `SELECT id FROM pipelines WHERE org_id = $1 AND name = 'Growth Scan Funnel'`, [id],
        );
        const party = await q.one<{ id: string }>(
          `INSERT INTO parties (org_id, kind, display_name, is_lead, lifecycle)
           VALUES ($1,'company',$2,true,'new') RETURNING id`,
          [id, org.name],
        );
        await q.exec(
          `INSERT INTO party_contacts (org_id, party_id, channel, value, is_primary)
           VALUES ($1,$2,'email',$3,true)
           ON CONFLICT (org_id, party_id, channel, value) DO NOTHING`,
          [id, party!.id, email],
        );
        await q.exec(
          `INSERT INTO deals (org_id, pipeline_id, party_id, title, stage, status)
           VALUES ($1,$2,$3,$4,'new_scan','open')`,
          [id, pipeline!.id, party!.id, `${org.name} — Growth Scan`],
        );
      }

      const health = await latestHealthScore(q, id);
      const { subject, html, text } = growthScanReportEmail(`${APP_BASE_URL}/growth-scan/${id}`, health);
      await sendEmail(q, { to: email, subject, html, text, template: 'growth_scan_report', orgId: id });
    });

    return { ok: true };
  });

  // =========================================================================
  // STAFF ADMIN — the leads console. Staff-only means invisible, not
  // forbidden (requireStaffOrNotFound), same as every other admin route.
  // =========================================================================

  app.get('/admin/growth-scans', async (req, reply) => {
    if (!requireStaffOrNotFound(req, reply)) return;
    const { includeArchived } = z.object({ includeArchived: z.coerce.boolean().default(false) }).parse(req.query);

    return withPlatform((q) =>
      q.rows(
        `SELECT o.id AS org_id, o.name, o.website_url, o.prospect_archived_at,
                d.id AS deal_id, d.stage, d.status AS deal_status, d.created_at AS lead_created_at,
                pc.value AS contact_email,
                score_row.health
           FROM organizations o
      LEFT JOIN LATERAL (
                  SELECT d.id, d.stage, d.status, d.created_at, d.party_id FROM deals d
                    JOIN pipelines p ON p.id = d.pipeline_id
                   WHERE d.org_id = o.id AND p.name = 'Growth Scan Funnel'
                   ORDER BY d.created_at DESC LIMIT 1
                ) d ON true
      LEFT JOIN LATERAL (
                  SELECT value FROM party_contacts
                   WHERE party_id = d.party_id AND channel = 'email' AND is_primary LIMIT 1
                ) pc ON true
      LEFT JOIN LATERAL (
                  SELECT sc.health FROM seo_scores sc JOIN seo_sites s ON s.id = sc.site_id
                   WHERE s.org_id = o.id ORDER BY sc.computed_at DESC LIMIT 1
                ) score_row ON true
          WHERE o.status = 'prospect' AND o.deleted_at IS NULL
            AND ($1 OR o.prospect_archived_at IS NULL)
          ORDER BY o.created_at DESC`,
        [includeArchived],
      ),
    );
  });

  app.patch('/admin/growth-scans/:dealId/archive', async (req, reply) => {
    if (!requireStaffOrNotFound(req, reply)) return;
    return setArchived(req, reply, true);
  });
  app.patch('/admin/growth-scans/:dealId/restore', async (req, reply) => {
    if (!requireStaffOrNotFound(req, reply)) return;
    return setArchived(req, reply, false);
  });

  async function setArchived(req: FastifyRequest, _reply: unknown, archived: boolean) {
    const { dealId } = z.object({ dealId: z.string().uuid() }).parse(req.params);
    return withPlatform(async (q) => {
      const deal = await q.one<{ org_id: string }>(`SELECT org_id FROM deals WHERE id = $1`, [dealId]);
      if (!deal) throw new HttpError(404, 'Lead not found', 'not_found');
      await q.exec(
        `UPDATE organizations SET prospect_archived_at = ${archived ? 'now()' : 'NULL'} WHERE id = $1`,
        [deal.org_id],
      );
      await audit(q, { orgId: null, actorUser: req.session!.user_id, action: `admin.growth_scan.${archived ? 'archive' : 'restore'}`, staffMode: true, entityType: 'organizations', entityId: deal.org_id, ip: req.ip });
      return { ok: true };
    });
  }

  app.post('/admin/growth-scans/:dealId/approve-intake', async (req, reply) => {
    if (!requireStaffOrNotFound(req, reply)) return;
    const { dealId } = z.object({ dealId: z.string().uuid() }).parse(req.params);

    const token = newSessionToken();
    const result = await withPlatform(async (q) => {
      const deal = await q.one<{ org_id: string }>(`SELECT org_id FROM deals WHERE id = $1`, [dealId]);
      if (!deal) throw new HttpError(404, 'Lead not found', 'not_found');

      await q.exec(`UPDATE deals SET stage = 'approved_for_intake', updated_at = now() WHERE id = $1`, [dealId]);
      await q.exec(
        `INSERT INTO deal_intakes (org_id, deal_id, intake_token_hash, intake_token_expires_at)
         VALUES ($1,$2,$3, now() + ($4 || ' days')::interval)
         ON CONFLICT (deal_id) DO UPDATE SET
           intake_token_hash = EXCLUDED.intake_token_hash,
           intake_token_expires_at = EXCLUDED.intake_token_expires_at`,
        [deal.org_id, dealId, hashToken(token), INTAKE_TOKEN_TTL_DAYS],
      );
      await audit(q, { orgId: null, actorUser: req.session!.user_id, action: 'admin.growth_scan.approve_intake', staffMode: true, entityType: 'deals', entityId: dealId, ip: req.ip });
      return { intakeUrl: `${APP_BASE_URL}/intake/${token}` };
    });
    return result;
  });

  const checkoutInput = z.object({
    planKey: z.enum(['platform', 'growth_partner', 'launch_growth', 'founding']),
    setupFeeCentsOverride: z.number().int().min(0).optional(),
    monthlyCentsOverride: z.number().int().min(1).optional(),
  });

  app.post('/admin/growth-scans/:dealId/checkout', async (req, reply) => {
    if (!requireStaffOrNotFound(req, reply)) return;
    const { dealId } = z.object({ dealId: z.string().uuid() }).parse(req.params);
    const body = checkoutInput.parse(req.body);
    const result = await createCheckoutForDeal(req, dealId, body);
    return result;
  });

  app.post('/admin/growth-scans/:dealId/checkout/regenerate', async (req, reply) => {
    if (!requireStaffOrNotFound(req, reply)) return;
    const { dealId } = z.object({ dealId: z.string().uuid() }).parse(req.params);

    const prior = await withPlatform((q) =>
      q.one<{ plan_key: string; setup_fee_cents: number; monthly_cents: number }>(
        `SELECT plan_key, setup_fee_cents, monthly_cents FROM deal_checkout_sessions
          WHERE deal_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [dealId],
      ),
    );
    if (!prior) throw new HttpError(400, 'No prior checkout to regenerate from — create one first.', 'no_prior_checkout');

    return createCheckoutForDeal(req, dealId, {
      planKey: prior.plan_key as never,
      setupFeeCentsOverride: prior.setup_fee_cents,
      monthlyCentsOverride: prior.monthly_cents,
    });
  });

  app.post('/admin/growth-scans/:dealId/checkout/resend-email', async (req, reply) => {
    if (!requireStaffOrNotFound(req, reply)) return;
    const { dealId } = z.object({ dealId: z.string().uuid() }).parse(req.params);

    await withPlatform(async (q) => {
      const deal = await q.one<{ org_id: string }>(`SELECT org_id FROM deals WHERE id = $1`, [dealId]);
      if (!deal) throw new HttpError(404, 'Lead not found', 'not_found');

      const session = await q.one<{ checkout_url: string; plan_key: string; status: string }>(
        `SELECT checkout_url, plan_key, status FROM deal_checkout_sessions
          WHERE deal_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [dealId],
      );
      if (!session || session.status !== 'open' || !session.checkout_url) {
        throw new HttpError(400, 'No open checkout link for this lead — create one first.', 'no_open_checkout');
      }
      const org = await q.one<{ name: string }>(`SELECT name FROM organizations WHERE id = $1`, [deal.org_id]);
      const contact = await q.one<{ value: string }>(
        `SELECT pc.value FROM party_contacts pc JOIN deals d ON d.party_id = pc.party_id
          WHERE d.id = $1 AND pc.channel = 'email' AND pc.is_primary LIMIT 1`,
        [dealId],
      );
      if (!contact) throw new HttpError(400, 'This lead has no contact email yet.', 'no_contact_email');

      const { subject, html, text } = paymentLinkEmail(org!.name, PLAN_LABEL[session.plan_key] ?? session.plan_key, session.checkout_url);
      await sendEmail(q, { to: contact.value, subject, html, text, template: 'payment_link', orgId: deal.org_id });
      await audit(q, { orgId: null, actorUser: req.session!.user_id, action: 'admin.growth_scan.resend_payment_email', staffMode: true, entityType: 'deals', entityId: dealId, ip: req.ip });
    });
    return { ok: true };
  });

  async function createCheckoutForDeal(
    req: FastifyRequest, dealId: string,
    body: { planKey: 'platform' | 'growth_partner' | 'launch_growth' | 'founding'; setupFeeCentsOverride?: number; monthlyCentsOverride?: number },
  ) {
    const lookupKeys = PLAN_LOOKUP_KEYS[body.planKey]!;
    const [setupPrice, monthlyPrice] = await Promise.all([
      lookupKeys.setup ? resolvePrice(lookupKeys.setup) : Promise.resolve(null),
      resolvePrice(lookupKeys.monthly),
    ]);
    const setupFeeCents = body.setupFeeCentsOverride ?? setupPrice?.unit_amount ?? 0;
    const monthlyCents = body.monthlyCentsOverride ?? monthlyPrice.unit_amount ?? 0;

    return withPlatform(async (q) => {
      const deal = await q.one<{ org_id: string }>(`SELECT org_id FROM deals WHERE id = $1`, [dealId]);
      if (!deal) throw new HttpError(404, 'Lead not found', 'not_found');
      const org = await q.one<{ name: string }>(`SELECT name FROM organizations WHERE id = $1`, [deal.org_id]);
      const contact = await q.one<{ value: string }>(
        `SELECT pc.value FROM party_contacts pc JOIN deals d ON d.party_id = pc.party_id
          WHERE d.id = $1 AND pc.channel = 'email' AND pc.is_primary LIMIT 1`,
        [dealId],
      );
      if (!contact) throw new HttpError(400, 'This lead has no contact email yet — unlock the scan or run intake first.', 'no_contact_email');

      const customerId = await getOrCreateStripeCustomer(q, deal.org_id, org!.name, contact.value);

      const lineItems: Array<{ price_data: { currency: string; unit_amount: number; recurring?: { interval: 'month' }; product_data: { name: string } }; quantity: number }> = [];
      if (setupFeeCents > 0) {
        lineItems.push({
          price_data: { currency: 'usd', unit_amount: setupFeeCents, product_data: { name: `${PLAN_LABEL[body.planKey]} — one-time setup` } },
          quantity: 1,
        });
      }
      lineItems.push({
        price_data: { currency: 'usd', unit_amount: monthlyCents, recurring: { interval: 'month' }, product_data: { name: `Venturelyx — ${PLAN_LABEL[body.planKey]}` } },
        quantity: 1,
      });

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        line_items: lineItems as never,
        subscription_data: { metadata: { org_id: deal.org_id, deal_id: dealId, plan_key: body.planKey } },
        metadata: { org_id: deal.org_id, deal_id: dealId, plan_key: body.planKey },
        success_url: `${APP_BASE_URL}/pricing-review/${dealId}?paid=1`,
        cancel_url: `${APP_BASE_URL}/pricing-review/${dealId}?paid=0`,
      });

      await q.exec(`UPDATE deal_checkout_sessions SET status = 'canceled' WHERE deal_id = $1 AND status = 'open'`, [dealId]);
      await q.exec(
        `INSERT INTO deal_checkout_sessions
           (org_id, deal_id, plan_key, setup_fee_cents, monthly_cents, stripe_checkout_session_id, checkout_url, created_by, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, to_timestamp($9))`,
        [deal.org_id, dealId, body.planKey, setupFeeCents, monthlyCents, session.id, session.url, req.session!.user_id, session.expires_at],
      );
      await q.exec(`UPDATE deals SET stage = 'payment_pending', updated_at = now() WHERE id = $1`, [dealId]);
      await audit(q, {
        orgId: null, actorUser: req.session!.user_id, action: 'admin.growth_scan.checkout_created', staffMode: true,
        entityType: 'deals', entityId: dealId, ip: req.ip,
        diff: { planKey: body.planKey, setupFeeCents, monthlyCents },
      });

      return { checkoutUrl: session.url };
    });
  }

  // =========================================================================
  // CLIENT-FACING, token-gated. No session cookie involved — reached the
  // same way /invite/accept and /reset-password are, by the token in the
  // URL, so these are always public routes regardless of org state.
  // =========================================================================

  const intakeInput = z.object({
    business_name: z.string().trim().max(200).optional(),
    primary_contact: z.string().trim().max(200).optional(),
    contact_email: z.string().trim().toLowerCase().email().optional(),
    phone: z.string().trim().max(50).optional(),
    website_url: z.string().trim().max(500).optional(),
    address_line1: z.string().trim().max(200).optional(),
    address_line2: z.string().trim().max(200).optional(),
    city: z.string().trim().max(100).optional(),
    region: z.string().trim().max(100).optional(),
    postal_code: z.string().trim().max(20).optional(),
    service_area: z.string().trim().max(200).optional(),
    business_category: z.string().trim().max(200).optional(),
    main_services: z.string().trim().max(1000).optional(),
    current_crm: z.string().trim().max(200).optional(),
    website_platform: z.string().trim().max(200).optional(),
    gbp_status: z.string().trim().max(200).optional(),
    social_accounts: z.string().trim().max(1000).optional(),
    primary_goals: z.string().trim().max(1000).optional(),
    biggest_problem: z.string().trim().max(1000).optional(),
    preferred_onboarding_date: z.string().trim().optional(),
  });

  app.get('/intake/:token', {
    config: { rateLimit: { max: 30, timeWindow: '10 minutes' } },
  }, async (req) => {
    const { token } = z.object({ token: z.string().min(1) }).parse(req.params);
    return withPlatform(async (q) => {
      const row = await q.one<{ deal_id: string; submitted_at: Date | null }>(
        `SELECT deal_id, submitted_at FROM deal_intakes
          WHERE intake_token_hash = $1 AND intake_token_expires_at > now()`,
        [hashToken(token)],
      );
      if (!row) throw new HttpError(400, 'This intake link is invalid or has expired.', 'invalid_token');
      return { dealId: row.deal_id, alreadySubmitted: !!row.submitted_at };
    });
  });

  app.post('/intake/:token', {
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
  }, async (req) => {
    const { token } = z.object({ token: z.string().min(1) }).parse(req.params);
    const body = intakeInput.parse(req.body);

    await withPlatform(async (q) => {
      const row = await q.one<{ deal_id: string }>(
        `SELECT deal_id FROM deal_intakes
          WHERE intake_token_hash = $1 AND intake_token_expires_at > now()`,
        [hashToken(token)],
      );
      if (!row) throw new HttpError(400, 'This intake link is invalid or has expired.', 'invalid_token');

      await q.exec(
        `UPDATE deal_intakes SET
           business_name=$2, primary_contact=$3, contact_email=$4, phone=$5, website_url=$6,
           address_line1=$7, address_line2=$8, city=$9, region=$10, postal_code=$11,
           service_area=$12, business_category=$13, main_services=$14, current_crm=$15,
           website_platform=$16, gbp_status=$17, social_accounts=$18, primary_goals=$19,
           biggest_problem=$20, preferred_onboarding_date=$21::date, submitted_at = now()
         WHERE deal_id = $1`,
        [
          row.deal_id, body.business_name ?? null, body.primary_contact ?? null, body.contact_email ?? null,
          body.phone ?? null, body.website_url ?? null, body.address_line1 ?? null, body.address_line2 ?? null,
          body.city ?? null, body.region ?? null, body.postal_code ?? null, body.service_area ?? null,
          body.business_category ?? null, body.main_services ?? null, body.current_crm ?? null,
          body.website_platform ?? null, body.gbp_status ?? null, body.social_accounts ?? null,
          body.primary_goals ?? null, body.biggest_problem ?? null, body.preferred_onboarding_date ?? null,
        ],
      );
      await q.exec(`UPDATE deals SET stage = 'intake_started', updated_at = now() WHERE id = $1`, [row.deal_id]);
    });
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Self-service $129 Platform signup. Shorter than the sales-assisted
  // funnel above — "basic business info" IS the intake (no separate
  // approved_for_intake step, no staff-generated checkout) — but it still
  // creates a prospect org, not an onboarding one: a real user+membership
  // exists immediately (unlike the token-only sales flow), yet
  // requireProvisioned still locks them out of every business-tool route
  // until /billing/checkout's webhook confirms payment. Skips straight to
  // 'intake_started' unless platform_settings.self_service_requires_approval
  // is on, in which case it queues like any other lead at 'new_scan'.
  // -------------------------------------------------------------------------
  const selfServiceInput = z.object({
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(12, 'Use at least 12 characters').max(200),
    full_name: z.string().trim().min(1).max(200),
    business_name: z.string().trim().min(1).max(200),
    website_url: z.string().trim().url().optional(),
  });

  app.post('/growth-scan/self-service', {
    config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
  }, async (req, reply) => {
    const body = selfServiceInput.parse(req.body);
    const passwordHash = await hashPassword(body.password);
    const token = newSessionToken();
    const baseSlug = slugify(body.business_name) || 'business';

    let created: { orgId: string; requiresApproval: boolean } | null = null;
    try {
      created = await withPlatform(async (q) => {
        const user = await q.one<{ id: string }>(
          `INSERT INTO users (email, password_hash, full_name) VALUES ($1,$2,$3) RETURNING id`,
          [body.email, passwordHash, body.full_name],
        );

        let slug = baseSlug;
        const collision = await q.one(`SELECT 1 FROM organizations WHERE slug = $1`, [slug]);
        if (collision) slug = `${baseSlug}-${randomBytes(3).toString('hex')}`;

        const org = await q.one<{ id: string }>(
          `INSERT INTO organizations (slug, name, website_url, status, created_by)
           VALUES ($1,$2,$3,'prospect',$4) RETURNING id`,
          [slug, body.business_name, body.website_url ?? null, user!.id],
        );
        const orgId = org!.id;

        await q.exec(
          `INSERT INTO memberships (org_id, user_id, role, accepted_at) VALUES ($1,$2,'owner', now())`,
          [orgId, user!.id],
        );

        const party = await q.one<{ id: string }>(
          `INSERT INTO parties (org_id, kind, display_name, is_lead, lifecycle)
           VALUES ($1,'company',$2,true,'new') RETURNING id`,
          [orgId, body.business_name],
        );
        await q.exec(
          `INSERT INTO party_contacts (org_id, party_id, channel, value, is_primary) VALUES ($1,$2,'email',$3,true)`,
          [orgId, party!.id, body.email],
        );
        await q.exec(
          `INSERT INTO pipelines (org_id, name, stages, is_default) VALUES ($1,'Growth Scan Funnel',$2::jsonb,false)`,
          [orgId, JSON.stringify(GROWTH_SCAN_STAGES)],
        );
        const requiresApproval = await getPlatformSetting(q, 'self_service_requires_approval', false);
        const pipeline = await q.one<{ id: string }>(`SELECT id FROM pipelines WHERE org_id = $1 AND name = 'Growth Scan Funnel'`, [orgId]);
        await q.exec(
          `INSERT INTO deals (org_id, pipeline_id, party_id, title, stage, status)
           VALUES ($1,$2,$3,$4,$5,'open')`,
          [orgId, pipeline!.id, party!.id, `${body.business_name} — Platform signup`, requiresApproval ? 'new_scan' : 'intake_started'],
        );

        await q.exec(
          `INSERT INTO sessions (user_id, org_id, token_hash, ip, user_agent, mfa_satisfied, expires_at)
           VALUES ($1,$2,$3,$4,$5,true, now() + ($6 || ' days')::interval)`,
          [user!.id, orgId, hashToken(token), req.ip, req.headers['user-agent']?.slice(0, 400) ?? null, SESSION_TTL_DAYS],
        );
        await audit(q, { orgId, actorUser: user!.id, action: 'auth.register_self_service', ip: req.ip });

        return { orgId, requiresApproval };
      });
    } catch (err) {
      // users_email_key unique_violation — never reveal by a distinct
      // error whether an email is already registered (same rule as
      // /auth/register).
      if ((err as { code?: string }).code !== '23505') throw err;
    }

    if (!created) throw new HttpError(401, 'Email or password is incorrect', 'bad_credentials');

    reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions());
    return { ok: true, orgId: created.orgId, requiresApproval: created.requiresApproval };
  });

  app.get('/pricing-review/:dealId', async (req) => {
    const { dealId } = z.object({ dealId: z.string().uuid() }).parse(req.params);
    return withPlatform(async (q) => {
      const deal = await q.one<{ stage: string }>(`SELECT stage FROM deals WHERE id = $1`, [dealId]);
      if (!deal) throw new HttpError(404, 'Not found', 'not_found');
      const session = await q.one(
        `SELECT plan_key, setup_fee_cents, monthly_cents, status, checkout_url
           FROM deal_checkout_sessions WHERE deal_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [dealId],
      );
      return { stage: deal.stage, checkout: session };
    });
  });
}
