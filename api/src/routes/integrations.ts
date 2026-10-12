/**
 * Venturelyx :: third-party integrations.
 *
 * Google Search Console today; the shape (OAuth -> encrypted refresh token in
 * `integrations` -> a job_queue-driven sync) is meant to be the template for
 * GA4 and GBP later.
 *
 * The refresh token never leaves this process unencrypted after the OAuth
 * callback completes — it's encrypted with the same AES-256-GCM vault
 * (encryptSecret/decryptSecret, VAULT_KEY) every other credential in this app
 * uses, and no GET route ever returns it.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, encryptSecret } from '../lib/auth.js';
import { HttpError, requireProvisioned } from '../plugins/context.js';
import { moduleWriteGate } from '../lib/moduleAccess.js';

const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const GSC_PROVIDER = 'google_search_console';
const STATE_COOKIE = 'vx_gsc_oauth_state';

const REDIRECT_URI = process.env.GOOGLE_OAUTH_REDIRECT_URI
  ?? 'https://api.venturelyx.com/v1/integrations/gsc/oauth/callback';
const APP_BASE_URL = process.env.APP_BASE_URL ?? 'https://app.venturelyx.com';

function normalizeHost(siteUrl: string): string {
  return siteUrl
    .replace(/^sc-domain:/, '')
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/$/, '')
    .toLowerCase();
}

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
}

interface GscSiteEntry {
  siteUrl: string;
  permissionLevel: string;
}

export default async function integrationsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireProvisioned);

  // ---- connection status (never the credential itself) ---------------------
  app.get('/integrations/gsc/status', async (req) => {
    req.requireRole('viewer');
    return req.db(async (q) => {
      const row = await q.one<{
        external_id: string | null; status: string; last_sync_at: string | null; last_error: string | null;
      }>(
        `SELECT external_id, status, last_sync_at, last_error
           FROM integrations WHERE org_id = app.current_org() AND provider = $1`,
        [GSC_PROVIDER],
      );
      return {
        connected: row?.status === 'connected',
        propertyUrl: row?.external_id ?? null,
        status: row?.status ?? 'disconnected',
        lastSyncAt: row?.last_sync_at ?? null,
        lastError: row?.last_error ?? null,
      };
    });
  });

  // ---- start the OAuth dance -------------------------------------------------
  // A real browser navigation (the Settings button does window.location, not
  // fetch), so the response here is a redirect, not JSON.
  app.get('/integrations/gsc/oauth/start', async (req, reply) => {
    req.requireRole('admin');
    if (!process.env.GOOGLE_CLIENT_ID) {
      return reply.redirect(`${APP_BASE_URL}/settings?gsc=error&reason=not_configured`);
    }

    const state = randomBytes(24).toString('base64url');
    reply.setCookie(STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/v1/integrations/gsc',
      maxAge: 600,
    });

    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', process.env.GOOGLE_CLIENT_ID);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent'); // forces a refresh_token even on a repeat connect
    url.searchParams.set('scope', GSC_SCOPE);
    url.searchParams.set('state', state);

    return reply.redirect(url.toString());
  });

  // ---- Google redirects back here -------------------------------------------
  app.get('/integrations/gsc/oauth/callback', async (req, reply) => {
    const fail = (reason: string) => reply.redirect(`${APP_BASE_URL}/settings?gsc=error&reason=${reason}`);

    try {
      req.requireRole('admin');
    } catch {
      return fail('not_authenticated');
    }
    const orgId = req.ctx.orgId!;
    const sess = req.requireAuth();

    const { code, state, error } = z.object({
      code: z.string().optional(),
      state: z.string().optional(),
      error: z.string().optional(),
    }).parse(req.query);

    reply.clearCookie(STATE_COOKIE, { path: '/v1/integrations/gsc' });
    if (error) return fail('access_denied');

    const expectedState = req.cookies?.[STATE_COOKIE];
    if (!code || !state || !expectedState || state !== expectedState) {
      return fail('bad_state');
    }
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
      return fail('not_configured');
    }

    try {
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          redirect_uri: REDIRECT_URI,
          grant_type: 'authorization_code',
        }),
      });
      if (!tokenRes.ok) {
        req.log.error({ status: tokenRes.status, body: await tokenRes.text() }, 'gsc token exchange failed');
        return fail('token_exchange_failed');
      }
      const tokens = (await tokenRes.json()) as GoogleTokenResponse;
      if (!tokens.refresh_token) {
        // Google only issues a refresh_token on first consent (or with
        // prompt=consent, which /start always sends) — this branch is a
        // genuine failure, not a missing-scope edge case.
        return fail('no_refresh_token');
      }

      const sitesRes = await fetch('https://www.googleapis.com/webmasters/v3/sites', {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (!sitesRes.ok) {
        req.log.error({ status: sitesRes.status }, 'gsc sites list failed');
        return fail('sites_list_failed');
      }
      const sitesBody = (await sitesRes.json()) as { siteEntry?: GscSiteEntry[] };
      const entries = sitesBody.siteEntry ?? [];
      if (entries.length === 0) return fail('no_properties');

      const primarySite = await req.db((q) =>
        q.one<{ url: string }>(
          `SELECT url FROM seo_sites WHERE org_id = $1 AND is_primary LIMIT 1`,
          [orgId],
        ),
      );
      const primaryHost = primarySite ? normalizeHost(primarySite.url) : null;
      const matched =
        entries.find((e) => primaryHost && normalizeHost(e.siteUrl) === primaryHost)
        ?? (entries.length === 1 ? entries[0] : null);
      // Multiple properties with no match to the primary site: pick the first
      // one the account owns rather than blocking on a property picker UI
      // that doesn't exist yet — connecting the wrong property just shows
      // wrong-but-real numbers, which the owner can fix by reconnecting;
      // showing none at all is strictly worse.
      const chosen = matched ?? entries.find((e) => e.permissionLevel.startsWith('siteOwner')) ?? entries[0]!;

      const { enc, iv, tag } = encryptSecret(tokens.refresh_token);

      await req.db(async (q) => {
        await q.exec(
          `DELETE FROM integrations WHERE org_id = app.current_org() AND provider = $1 AND external_id <> $2`,
          [GSC_PROVIDER, chosen.siteUrl],
        );
        await q.exec(
          `INSERT INTO integrations (org_id, provider, external_id, display_name, status,
                                      scopes, credential_enc, credential_iv, credential_tag,
                                      expires_at, last_error)
           VALUES (app.current_org(), $1, $2, $2, 'connected', $3, $4, $5, $6,
                   now() + ($7 || ' seconds')::interval, NULL)
           ON CONFLICT (org_id, provider, external_id) DO UPDATE
             SET status = 'connected', scopes = $3, credential_enc = $4, credential_iv = $5,
                 credential_tag = $6, expires_at = now() + ($7 || ' seconds')::interval,
                 last_error = NULL`,
          [GSC_PROVIDER, chosen.siteUrl, [GSC_SCOPE], enc, iv, tag, tokens.expires_in],
        );

        if (primarySite) {
          const dedupe = `seo.gsc_sync:${orgId}:${new Date().toISOString().slice(0, 10)}`;
          await q.exec(
            `INSERT INTO job_queue (org_id, kind, payload, dedupe_key, priority)
             VALUES (app.current_org(), 'seo.gsc_sync',
                     jsonb_build_object('property', $1::text, 'trigger', 'connect'),
                     $2, 50)
             ON CONFLICT DO NOTHING`,
            [chosen.siteUrl, dedupe],
          );
        }

        await audit(q, {
          orgId, actorUser: sess.user_id, action: 'integrations.gsc.connect',
          entityType: 'integrations', ip: req.ip, diff: { propertyUrl: chosen.siteUrl },
        });
      });

      return reply.redirect(`${APP_BASE_URL}/settings?gsc=connected`);
    } catch (err) {
      req.log.error({ err }, 'gsc oauth callback failed');
      return fail('unexpected');
    }
  });

  // ---- disconnect -------------------------------------------------------
  app.post('/integrations/gsc/disconnect', { preHandler: moduleWriteGate('scaleseo') }, async (req) => {
    req.requireRole('admin');
    const sess = req.requireAuth();

    return req.db(async (q) => {
      const deleted = await q.one(
        `DELETE FROM integrations WHERE org_id = app.current_org() AND provider = $1 RETURNING id`,
        [GSC_PROVIDER],
      );
      if (!deleted) throw new HttpError(404, 'Google Search Console is not connected', 'not_found');
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'integrations.gsc.disconnect', ip: req.ip,
      });
      return { ok: true };
    });
  });
}
