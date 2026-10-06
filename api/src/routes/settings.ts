/**
 * Venturelyx :: Settings — business profile and AI configuration.
 *
 * Business-identity changes (name/website/industry/service area) and
 * anything touching AI provider keys or spend are gated at admin, one
 * grade above the OPERATE-SPEC.md default of staff for creating/editing —
 * these aren't day-to-day operational edits.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, encryptSecret } from '../lib/auth.js';
import { estimateCost, KNOWN_MODELS } from '../lib/ai.js';
import { HttpError } from '../plugins/context.js';
import { moduleWriteGate } from '../lib/moduleAccess.js';

const businessProfileInput = z.object({
  name: z.string().trim().min(1).max(200),
  website_url: z.string().trim().url().nullable().optional(),
  vertical: z.string().trim().max(100).nullable().optional(),
  service_area: z.string().trim().max(200).nullable().optional(),
});

const productUrlInput = z.object({
  label: z.string().trim().min(1).max(60),
  url: z.string().trim().url(),
});

const growSenderProfileInput = z.object({
  // The brand/product name that reads on a "who is this from" glance —
  // {{sender_name}} — distinct from organizations.name, which is this
  // app's own label for the org (can be a longer legal-ish name like
  // "CampusPath Education" rather than the shorter "CampusPath" people
  // actually reply to).
  sender_name: z.string().trim().max(100).nullable().optional(),
  website_url: z.string().trim().url().nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  contact_email: z.string().trim().toLowerCase().email().nullable().optional(),
  // CAN-SPAM §7704(a)(5): a real physical postal address is legally
  // required in every commercial email, not optional metadata — free text
  // since it's rendered as-is into the unsubscribe footer, never parsed.
  mailing_address: z.string().trim().max(500).nullable().optional(),
  product_urls: z.array(productUrlInput).max(20).default([]),
}).refine(
  (body) => new Set(body.product_urls.map((p) => p.label)).size === body.product_urls.length,
  { message: 'Product labels must be unique — {{product_url:Label}} can only resolve to one URL.', path: ['product_urls'] },
);

const aiSettingsInput = z.object({
  providerPreference: z.enum(['auto', 'anthropic', 'openai']).optional(),
  spendCapMonthly: z.number().positive().nullable().optional(),
  modelOverrides: z
    .record(z.string(), z.object({ provider: z.enum(['anthropic', 'openai']), model: z.string() }).nullable())
    .optional(),
});

export default async function settingsRoutes(app: FastifyInstance) {

  // ---- Business profile ----------------------------------------------------
  // Same fields the onboarding wizard collects — an owner who skipped intake
  // (no website yet, filled in later) completes it here instead.
  app.get('/orgs/current', async (req) => {
    req.requireRole('viewer');
    return req.db((q) =>
      q.one(
        `SELECT id, name, website_url, vertical, settings->>'service_area' AS service_area
           FROM organizations WHERE id = app.current_org()`,
      ),
    );
  });

  app.patch('/orgs/current', async (req) => {
    req.requireRole('admin');
    const sess = req.requireAuth();
    const body = businessProfileInput.parse(req.body);

    return req.db(async (q) => {
      // Saving this form at all is what "Confirm your business details"
      // (guided setup's step 2) means — merged on unconditionally, after
      // the service_area branch, not a separate "confirm" button.
      const org = await q.one(
        `UPDATE organizations
            SET name = $1, website_url = $2, vertical = $3,
                settings = (CASE WHEN $4::text IS NULL THEN settings - 'service_area'
                                 ELSE jsonb_set(settings, '{service_area}', to_jsonb($4::text), true) END)
                           || '{"setup_confirmed_profile": true}'::jsonb
          WHERE id = app.current_org()
        RETURNING id, name, website_url, vertical, settings->>'service_area' AS service_area`,
        [body.name, body.website_url ?? null, body.vertical ?? null, body.service_area ?? null],
      );
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'orgs.update',
        entityType: 'organizations', entityId: req.ctx.orgId ?? undefined, ip: req.ip, diff: body,
      });
      return org;
    });
  });

  // ---- Grow sender profile ----------------------------------------------------
  // Website, phone, product links, and the physical mailing address
  // CAN-SPAM requires in every commercial email — resolved as
  // {{sender_website}}, {{sender_phone}}, {{product_url:<label>}}, and the
  // unsubscribe footer respectively (api/src/lib/growTemplate.ts,
  // routes/grow.ts). One row per org; a fresh org just reads back nulls
  // and an empty product list rather than a 404, same as the business
  // profile above.
  app.get('/grow/sender-profile', async (req) => {
    req.requireRole('viewer');
    return req.db(async (q) => {
      const row = await q.one<{
        sender_name: string | null; website_url: string | null; phone: string | null;
        contact_email: string | null; mailing_address: string | null;
        product_urls: Array<{ label: string; url: string }>;
      }>(
        `SELECT sender_name, website_url, phone, contact_email, mailing_address, product_urls
           FROM grow_sender_profiles WHERE org_id = app.current_org()`,
      );
      return {
        sender_name: row?.sender_name ?? null,
        website_url: row?.website_url ?? null,
        phone: row?.phone ?? null,
        contact_email: row?.contact_email ?? null,
        mailing_address: row?.mailing_address ?? null,
        product_urls: row?.product_urls ?? [],
      };
    });
  });

  app.put('/grow/sender-profile', { preHandler: moduleWriteGate('grow') }, async (req) => {
    req.requireRole('admin');
    const sess = req.requireAuth();
    const body = growSenderProfileInput.parse(req.body);

    return req.db(async (q) => {
      const profile = await q.one(
        `INSERT INTO grow_sender_profiles (org_id, sender_name, website_url, phone, contact_email, mailing_address, product_urls)
         VALUES (app.current_org(), $1, $2, $3, $4, $5, $6)
         ON CONFLICT (org_id) DO UPDATE
           SET sender_name = EXCLUDED.sender_name, website_url = EXCLUDED.website_url, phone = EXCLUDED.phone,
               contact_email = EXCLUDED.contact_email, mailing_address = EXCLUDED.mailing_address,
               product_urls = EXCLUDED.product_urls
         RETURNING sender_name, website_url, phone, contact_email, mailing_address, product_urls`,
        [
          body.sender_name ?? null, body.website_url ?? null, body.phone ?? null,
          body.contact_email ?? null, body.mailing_address ?? null, JSON.stringify(body.product_urls),
        ],
      );
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'grow_sender_profiles.update',
        entityType: 'grow_sender_profiles', ip: req.ip, diff: body,
      });
      return profile;
    });
  });

  // ---- AI configuration ------------------------------------------------------
  app.get('/settings/ai', async (req) => {
    req.requireRole('admin');

    return req.db(async (q) => {
      const row = await q.one<{ settings: Record<string, unknown> | null }>(
        `SELECT settings FROM organizations WHERE id = app.current_org()`,
      );
      const s = row?.settings ?? {};

      const connected = await q.rows<{ provider: string }>(
        `SELECT provider FROM integrations
          WHERE org_id = app.current_org() AND external_id = 'byo' AND status = 'connected'`,
      );

      const usageRows = await q.rows<{ feature: string; provider: string; model: string; approx_tokens: number }>(
        `SELECT feature, provider, model, approx_tokens FROM ai_usage
          WHERE org_id = app.current_org() AND created_at >= date_trunc('month', now())`,
      );

      const byFeature: Record<string, { calls: number; tokens: number; estimatedCost: number }> = {};
      let totalEstimatedCost = 0;
      for (const u of usageRows) {
        const cost = estimateCost(u.model, u.approx_tokens);
        totalEstimatedCost += cost;
        const bucket = byFeature[u.feature] ?? { calls: 0, tokens: 0, estimatedCost: 0 };
        bucket.calls += 1;
        bucket.tokens += u.approx_tokens;
        bucket.estimatedCost += cost;
        byFeature[u.feature] = bucket;
      }

      const pref = s.ai_provider;
      const cap = s.ai_spend_cap_monthly;
      return {
        providerPreference: pref === 'anthropic' || pref === 'openai' ? pref : 'auto',
        spendCapMonthly: typeof cap === 'number' ? cap : null,
        modelOverrides: s.ai_model_overrides ?? {},
        connectedProviders: connected.map((c) => c.provider),
        hasSharedAnthropic: !!process.env.ANTHROPIC_API_KEY,
        hasSharedOpenai: !!process.env.OPENAI_API_KEY,
        knownModels: KNOWN_MODELS,
        usageThisMonth: { byFeature, totalEstimatedCost },
      };
    });
  });

  app.patch('/settings/ai', async (req) => {
    req.requireRole('admin');
    const sess = req.requireAuth();
    const body = aiSettingsInput.parse(req.body);

    return req.db(async (q) => {
      const current = await q.one<{ settings: Record<string, unknown> | null }>(
        `SELECT settings FROM organizations WHERE id = app.current_org()`,
      );
      const merged = {
        ...(current?.settings ?? {}),
        ...(body.providerPreference !== undefined ? { ai_provider: body.providerPreference } : {}),
        ...(body.spendCapMonthly !== undefined ? { ai_spend_cap_monthly: body.spendCapMonthly } : {}),
        ...(body.modelOverrides !== undefined ? { ai_model_overrides: body.modelOverrides } : {}),
      };
      await q.exec(`UPDATE organizations SET settings = $1 WHERE id = app.current_org()`, [JSON.stringify(merged)]);
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'settings.ai.update', ip: req.ip, diff: body,
      });
      return { ok: true };
    });
  });

  // Bring-your-own provider keys. Stored the same way every other
  // credential in this app is (integrations.credential_enc/iv/tag, AES-256-GCM
  // via VAULT_KEY) — never returned by any GET, only a connected/disconnected
  // status.
  app.put('/settings/ai/keys/:provider', async (req) => {
    req.requireRole('admin');
    const sess = req.requireAuth();
    const { provider } = z.object({ provider: z.enum(['anthropic', 'openai']) }).parse(req.params);
    const { apiKey } = z.object({ apiKey: z.string().trim().min(20).max(300) }).parse(req.body);

    const { enc, iv, tag } = encryptSecret(apiKey);
    const displayName = provider === 'anthropic' ? 'Anthropic (own key)' : 'OpenAI (own key)';

    return req.db(async (q) => {
      await q.exec(
        `INSERT INTO integrations (org_id, provider, external_id, display_name, status,
                                    credential_enc, credential_iv, credential_tag)
         VALUES (app.current_org(), $1, 'byo', $2, 'connected', $3, $4, $5)
         ON CONFLICT (org_id, provider, external_id) DO UPDATE
           SET status = 'connected', display_name = $2,
               credential_enc = $3, credential_iv = $4, credential_tag = $5`,
        [provider, displayName, enc, iv, tag],
      );
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: `settings.ai_key.${provider}.set`, ip: req.ip,
      });
      return { ok: true, provider };
    });
  });

  app.delete('/settings/ai/keys/:provider', async (req) => {
    req.requireRole('admin');
    const sess = req.requireAuth();
    const { provider } = z.object({ provider: z.enum(['anthropic', 'openai']) }).parse(req.params);

    return req.db(async (q) => {
      const deleted = await q.one(
        `DELETE FROM integrations
          WHERE org_id = app.current_org() AND provider = $1 AND external_id = 'byo'
        RETURNING id`,
        [provider],
      );
      if (!deleted) throw new HttpError(404, 'No key connected for this provider', 'not_found');
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: `settings.ai_key.${provider}.remove`, ip: req.ip,
      });
      return { ok: true };
    });
  });
}
