/**
 * Venturelyx :: platform admin "Billing / Stripe" panel.
 *
 * Read-only against Stripe + the existing billing tables. The ONLY write
 * path (sync-catalog) spawns the already-compiled stripeCatalog.js as a
 * child process rather than importing scripts/stripeCatalog.ts directly —
 * that script's main() runs at top-level import time, so importing it here
 * would re-run catalog sync (including deactivating the old v1 catalog) on
 * every API boot. Spawning is also exactly what running
 * `npm run stripe:catalog` by hand does, so there is one source of catalog
 * logic, never a second copy drifting from the first.
 *
 * Platform-staff only (requireStaffOrNotFound, same gate every other
 * admin.ts route uses) — this is the PLATFORM's Stripe account, never a
 * per-org setting. A tenant org admin is never platform staff, so reusing
 * that existing gate as-is is sufficient; see docs/specs/admin-stripe-panel.md.
 *
 * Secrets never leave this file in full — only a prefix + last 4 chars, the
 * same masking convention a card number gets, never the value itself.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { execFile } from 'node:child_process';
import { z } from 'zod';
import { withPlatform, type Querier } from '../lib/db.js';
import { requireStaffOrNotFound } from '../lib/staffGuard.js';
import { stripe, fetchAuthoritativeLiveMode } from '../lib/stripe.js';
import { LOOKUP_KEY_MODULES, modulesForLookupKeys } from '../lib/billingEntitlements.js';
import { CATALOG } from '../lib/stripeCatalogSpec.js';
import { stripeKeyMode } from '../lib/stripeKeyMode.js';

// Verified live against the running container (infra/caddy/Caddyfile's
// static host mapping + the route's actual /v1 prefix in server.ts) — not
// read from any env var, since none exists for "this API's own public base
// URL" today. Same literal-constant pattern routes/billing.ts already uses
// for APP_BASE_URL's fallback.
const WEBHOOK_PUBLIC_URL = 'https://api.venturelyx.com/v1/billing/webhook';

async function auditAdminBilling(q: Querier, req: FastifyRequest, action: string, diff?: unknown): Promise<void> {
  await q.exec(
    `INSERT INTO audit_log (org_id, actor_user, actor_type, action, staff_mode, ip, diff)
     VALUES (NULL, $1, 'user', $2, true, $3, $4)`,
    [req.session!.user_id, action, req.ip, diff ? JSON.stringify(diff) : null],
  );
}

function maskKey(value: string | undefined): { configured: boolean; mode: 'live' | 'test' | null; masked: string | null } {
  if (!value) return { configured: false, mode: null, masked: null };
  const mode = stripeKeyMode(value);
  const prefixMatch = value.match(/^(sk|rk|pk)_(live|test)_/);
  const prefix = prefixMatch?.[0] ?? value.slice(0, 8);
  const last4 = value.slice(-4);
  return { configured: true, mode, masked: `${prefix}••••${last4}` };
}

interface CatalogPriceStatus {
  lookupKey: string;
  expectedCents: number;
  interval: 'month' | null;
  stripePriceId: string | null;
  stripeCents: number | null;
  requiresModuleMapping: boolean;
  modulesMatch: boolean;
  ok: boolean;
}

interface CatalogProductStatus {
  productKey: string;
  productName: string;
  prices: CatalogPriceStatus[];
}

async function buildCatalogStatus(): Promise<CatalogProductStatus[]> {
  const allLookupKeys = CATALOG.flatMap((p) => p.prices.map((pr) => pr.lookupKey));
  const found = new Map<string, { id: string; unit_amount: number | null }>();
  for (let i = 0; i < allLookupKeys.length; i += 10) {
    const batch = allLookupKeys.slice(i, i + 10);
    const prices = await stripe.prices.list({ lookup_keys: batch, limit: 100 });
    for (const p of prices.data) {
      if (p.lookup_key) found.set(p.lookup_key, { id: p.id, unit_amount: p.unit_amount });
    }
  }

  return CATALOG.map((product) => ({
    productKey: product.productKey,
    productName: product.productName,
    prices: product.prices.map((price) => {
      const match = found.get(price.lookupKey);
      const requiresModuleMapping = !!price.interval;
      const modulesMatch = !requiresModuleMapping || price.lookupKey in LOOKUP_KEY_MODULES;
      return {
        lookupKey: price.lookupKey,
        expectedCents: price.unitAmountCents,
        interval: price.interval ?? null,
        stripePriceId: match?.id ?? null,
        stripeCents: match?.unit_amount ?? null,
        requiresModuleMapping,
        modulesMatch,
        ok: !!match && modulesMatch,
      };
    }),
  }));
}

export default async function adminBillingRoutes(app: FastifyInstance) {
  app.get('/admin/billing/status', async (req, reply) => {
    if (!requireStaffOrNotFound(req, reply)) return;

    const secretKey = maskKey(process.env.STRIPE_SECRET_KEY);
    const publishableKey = maskKey(process.env.STRIPE_PUBLISHABLE_KEY);
    const webhookSecretConfigured = !!process.env.STRIPE_WEBHOOK_SECRET;

    // Authoritative — asks Stripe itself, never trusts the sk_/rk_ prefix
    // for the one thing this panel exists to get right. hintMismatch would
    // mean our prefix parsing disagrees with Stripe's own answer, which
    // should never happen and is worth a loud banner if it ever does.
    const liveMode = await fetchAuthoritativeLiveMode();
    const hintMismatch = secretKey.mode !== null && (secretKey.mode === 'live') !== liveMode;

    const [catalog, lastEvent, recentEntitlements] = await withPlatform(async (q) => {
      await auditAdminBilling(q, req, 'admin.billing.status.view');
      return Promise.all([
        buildCatalogStatus(),
        q.one<{ event_type: string; processed_at: string }>(
          `SELECT event_type, processed_at FROM stripe_events ORDER BY processed_at DESC LIMIT 1`,
        ),
        q.rows<{ org_id: string; org_name: string; status: string; price_lookup_keys: string[]; updated_at: string }>(
          `SELECT bs.org_id, o.name AS org_name, bs.status, bs.price_lookup_keys, bs.updated_at
             FROM billing_subscriptions bs
             JOIN organizations o ON o.id = bs.org_id
            ORDER BY bs.updated_at DESC
            LIMIT 20`,
        ),
      ]);
    });

    return {
      mode: liveMode ? 'live' : 'test',
      modeConfirmedViaStripe: true,
      keys: {
        secretKey,
        publishableKey,
        webhookSecretConfigured,
        modeMismatch: !!secretKey.mode && !!publishableKey.mode && secretKey.mode !== publishableKey.mode,
        hintMismatch,
      },
      webhook: {
        expectedUrl: WEBHOOK_PUBLIC_URL,
        lastEvent: lastEvent ? { type: lastEvent.event_type, processedAt: lastEvent.processed_at } : null,
        note: 'Only successfully-verified events are recorded — a bad signature (e.g. a stale whsec_ after rotation) never writes a row here, it just looks like no new events.',
      },
      catalog,
      recentEntitlements: recentEntitlements.map((r) => ({
        orgId: r.org_id,
        orgName: r.org_name,
        status: r.status,
        modules: Array.from(modulesForLookupKeys(r.price_lookup_keys)),
        updatedAt: r.updated_at,
      })),
    };
  });

  const syncCatalogInput = z.object({ confirm: z.literal(true) });

  app.post('/admin/billing/sync-catalog', async (req, reply) => {
    if (!requireStaffOrNotFound(req, reply)) return;
    syncCatalogInput.parse(req.body);

    // Authoritative here too — the spawned script does its own independent
    // balance.retrieve() check and will refuse without --allow-live anyway,
    // but this layer's own decision of which flag to pass must agree, not
    // fall back to a prefix guess.
    const liveMode = await fetchAuthoritativeLiveMode();
    const args = ['dist/scripts/stripeCatalog.js', ...(liveMode ? ['--allow-live'] : [])];
    const output = await new Promise<{ ok: boolean; log: string }>((resolve) => {
      execFile('node', args, { cwd: process.cwd(), timeout: 30_000 }, (err, stdout, stderr) => {
        resolve({ ok: !err, log: `${stdout}${stderr}` });
      });
    });

    await withPlatform((q) =>
      auditAdminBilling(q, req, 'admin.billing.sync_catalog', { mode: liveMode ? 'live' : 'test', ok: output.ok }),
    );

    if (!output.ok) {
      reply.status(500);
    }
    return output;
  });
}
