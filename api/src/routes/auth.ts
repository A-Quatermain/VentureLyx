/**
 * Venturelyx :: authentication routes.
 *
 * Flow: POST /auth/login -> (if 2FA on) POST /auth/mfa -> session usable.
 * Sessions exist from the first step but carry mfa_satisfied=false until the
 * code is verified, and requireAuth() rejects those.
 */
import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withPlatform } from '../lib/db.js';
import {
  SESSION_COOKIE, SESSION_TTL_DAYS, audit, hashToken, newSessionToken,
  newTotpSecret, makeTotp, verifyPassword, verifyTotp, hashPassword,
} from '../lib/auth.js';
import { slugify } from '../lib/slug.js';
import { HttpError } from '../plugins/context.js';
import { sendEmail } from '../lib/email.js';
import { passwordResetEmail, emailVerificationEmail, orgInviteEmail } from '../lib/emailTemplates.js';

const LOCK_AFTER = 8;
const LOCK_MINUTES = 15;

const APP_BASE_URL = process.env.APP_BASE_URL ?? 'https://app.venturelyx.com';
const RESET_TOKEN_TTL_MIN = 30;
const VERIFY_TOKEN_TTL_HOURS = 24;
const INVITE_TOKEN_TTL_DAYS = 7;

// Rate-limited by the email in the request body, not by IP — the brief's
// own wording ("per email," not "per requester") matters here: without
// this, every request from behind one corporate NAT or VPN would share a
// single IP-keyed bucket, and an attacker rotating IPs would face no limit
// at all on hammering one victim's inbox with reset emails.
function emailKeyGenerator(req: FastifyRequest): string {
  const body = req.body as { email?: string } | undefined;
  return `forgot:${(body?.email ?? '').toLowerCase()}`;
}

export default async function authRoutes(app: FastifyInstance) {

  // Host-only (no domain) scopes this cookie to api.venturelyx.com alone.
  // web/'s Server Components (lib/session.ts) read the cookie off the
  // *browser's request to app.venturelyx.com* and forward it server-side —
  // so a host-only cookie never shows up there in the first place, even
  // though a client-side fetch straight to api.venturelyx.com would still
  // carry it fine. Scoping to the shared parent domain makes the same
  // cookie valid for both, which server-side session reads depend on.
  const cookieOpts = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    domain: process.env.COOKIE_DOMAIN ?? '.venturelyx.com',
    path: '/',
    maxAge: SESSION_TTL_DAYS * 86_400,
  };

  // ---- sign in ----------------------------------------------------------
  app.post('/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
  }, async (req, reply) => {
    const body = z.object({
      email: z.string().email(),
      password: z.string().min(1).max(200),
    }).parse(req.body);

    const user = await withPlatform((q) =>
      q.one<{
        id: string; email: string; password_hash: string | null; full_name: string;
        totp_enabled_at: Date | null; locked_until: Date | null; failed_logins: number;
      }>(
        `SELECT id, email, password_hash, full_name, totp_enabled_at, locked_until, failed_logins
           FROM users WHERE email = $1 AND deleted_at IS NULL`,
        [body.email],
      ),
    );

    if (user?.locked_until && user.locked_until > new Date()) {
      throw new HttpError(429, 'Too many attempts. Try again in a few minutes.', 'locked');
    }

    const ok = await verifyPassword(user?.password_hash ?? null, body.password);

    if (!ok || !user) {
      if (user) {
        await withPlatform((q) =>
          q.exec(
            `UPDATE users
                SET failed_logins = failed_logins + 1,
                    locked_until = CASE WHEN failed_logins + 1 >= $2
                                        THEN now() + ($3 || ' minutes')::interval
                                        ELSE locked_until END
              WHERE id = $1`,
            [user.id, LOCK_AFTER, LOCK_MINUTES],
          ),
        );
      }
      // Same message either way — never reveal whether the email exists.
      throw new HttpError(401, 'Email or password is incorrect', 'bad_credentials');
    }

    const needsMfa = user.totp_enabled_at !== null;
    const token = newSessionToken();

    // Land the user in their most recent org, if they have exactly one.
    const orgs = await withPlatform((q) =>
      q.rows<{ org_id: string }>(
        `SELECT org_id FROM memberships WHERE user_id = $1 ORDER BY created_at LIMIT 2`,
        [user.id],
      ),
    );
    const soleOrg = orgs.length === 1 ? orgs[0]!.org_id : null;

    await withPlatform(async (q) => {
      await q.exec(
        `INSERT INTO sessions (user_id, org_id, token_hash, ip, user_agent,
                               mfa_satisfied, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' days')::interval)`,
        [
          user.id, soleOrg, hashToken(token), req.ip,
          req.headers['user-agent']?.slice(0, 400) ?? null,
          !needsMfa, SESSION_TTL_DAYS,
        ],
      );
      await q.exec(
        `UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = now()
          WHERE id = $1`,
        [user.id],
      );
      await audit(q, {
        orgId: soleOrg, actorUser: user.id, action: 'auth.login', ip: req.ip,
      });
    });

    // Anyone who signed in before the Domain=.venturelyx.com fix has a
    // stale host-only cookie for api.venturelyx.com still sitting in their
    // browser. Both it and the new domain-scoped cookie share the same
    // name, so any request to api.venturelyx.com sends both — and if the
    // server reads the stale one, client-side fetches (which hit
    // api.venturelyx.com directly) start failing with 401 even though the
    // page itself renders fine (server-side reads only ever see the
    // correct, single forwarded value). Explicitly clear the host-only
    // variant on every fresh login so it can't linger.
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    reply.setCookie(SESSION_COOKIE, token, cookieOpts);
    return { mfaRequired: needsMfa, orgId: soleOrg, needsOrgChoice: orgs.length > 1 };
  });

  // ---- register -----------------------------------------------------------
  // Creates a user only — no org. A fresh account has nothing to enroll 2FA
  // against yet, so the session starts mfa_satisfied like a login for a user
  // with no TOTP set up would. POST /orgs (below) is the separate step that
  // gives the account a business; a user can call it more than once.
  app.post('/auth/register', {
    config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
  }, async (req, reply) => {
    const body = z.object({
      email: z.string().email(),
      password: z.string().min(12, 'Use at least 12 characters').max(200),
      full_name: z.string().trim().min(1).max(200),
    }).parse(req.body);

    const passwordHash = await hashPassword(body.password);
    const token = newSessionToken();

    let user: { id: string } | null = null;
    try {
      user = await withPlatform(async (q) => {
        const created = await q.one<{ id: string }>(
          `INSERT INTO users (email, password_hash, full_name)
           VALUES ($1,$2,$3)
           RETURNING id`,
          [body.email, passwordHash, body.full_name],
        );
        await q.exec(
          `INSERT INTO sessions (user_id, org_id, token_hash, ip, user_agent,
                                 mfa_satisfied, expires_at)
           VALUES ($1,NULL,$2,$3,$4,true, now() + ($5 || ' days')::interval)`,
          [
            created!.id, hashToken(token), req.ip,
            req.headers['user-agent']?.slice(0, 400) ?? null, SESSION_TTL_DAYS,
          ],
        );
        await audit(q, { orgId: null, actorUser: created!.id, action: 'auth.register', ip: req.ip });
        await sendVerificationEmail(q, created!.id, body.email);
        return created;
      });
    } catch (err) {
      // users_email_key unique_violation — someone raced us, or the email
      // is already taken. Either way, fall through to the same generic
      // rejection login uses for bad credentials: never reveal by a
      // distinct error whether an email is registered.
      if ((err as { code?: string }).code !== '23505') throw err;
    }

    if (!user) {
      throw new HttpError(401, 'Email or password is incorrect', 'bad_credentials');
    }

    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    reply.setCookie(SESSION_COOKIE, token, cookieOpts);
    return { mfaRequired: false, orgId: null, needsOrgChoice: false };
  });

  // ---- create an organization ----------------------------------------------
  // A user may own more than one — this is a first-class path, not a
  // one-time-only onboarding step, so it's never gated on "does this user
  // already have a business."
  app.post('/orgs', async (req) => {
    const sess = req.requireAuth();
    const body = z.object({
      name: z.string().trim().min(1).max(200),
      website_url: z.string().trim().url().nullable().optional(),
      vertical: z.string().trim().min(1).max(100).nullable().optional(),
      service_area: z.string().trim().max(200).nullable().optional(),
    }).parse(req.body);

    const baseSlug = slugify(body.name);
    if (!baseSlug) throw new HttpError(400, 'Name must contain at least one letter or number', 'invalid_input');

    const result = await withPlatform(async (q) => {
      // organizations.slug is globally unique; two different owners naming
      // their business the same thing is normal, so disambiguate instead of
      // rejecting.
      let slug = baseSlug;
      const collision = await q.one(`SELECT 1 FROM organizations WHERE slug = $1`, [slug]);
      if (collision) slug = `${baseSlug}-${randomBytes(3).toString('hex')}`;

      const org = await q.one<{ id: string; name: string; slug: string }>(
        `INSERT INTO organizations (slug, name, vertical, website_url, status, settings, created_by)
         VALUES ($1,$2,$3,$4,'onboarding',
                 CASE WHEN $5::text IS NULL THEN '{}'::jsonb
                      ELSE jsonb_build_object('service_area', $5::text) END,
                 $6)
         RETURNING id, name, slug`,
        [slug, body.name, body.vertical ?? null, body.website_url ?? null, body.service_area ?? null, sess.user_id],
      );
      const orgId = org!.id;

      await q.exec(
        `INSERT INTO memberships (org_id, user_id, role, accepted_at)
         VALUES ($1,$2,'owner', now())`,
        [orgId, sess.user_id],
      );

      // New sign-ins land in "their most recent org if they have exactly
      // one" (see /auth/login) — setting it here means the very next page
      // load already has this org selected, no separate switch step.
      await q.exec(`UPDATE sessions SET org_id = $2 WHERE id = $1`, [sess.id, orgId]);

      let siteId: string | null = null;
      let crawlQueued = false;
      if (body.website_url) {
        let host: string;
        try { host = new URL(body.website_url).hostname.replace(/^www\./, ''); }
        catch { host = body.website_url; }
        const site = await q.one<{ id: string }>(
          `INSERT INTO seo_sites (org_id, key, name, url, is_primary)
           VALUES ($1,$2,$3,$4,true)
           RETURNING id`,
          [orgId, slugify(host) || slug, body.name, body.website_url],
        );
        siteId = site!.id;
        const job = await q.one<{ id: number }>(
          `INSERT INTO job_queue (org_id, kind, payload, dedupe_key, priority)
           VALUES ($1, 'seo.crawl',
                   jsonb_build_object('site_id', $2::text, 'trigger', 'onboarding'),
                   'seo.crawl:' || $2::text, 50)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [orgId, siteId],
        );
        crawlQueued = !!job;
      }

      await audit(q, {
        orgId, actorUser: sess.user_id, action: 'org.create',
        entityType: 'organizations', entityId: orgId, ip: req.ip,
      });

      return { id: orgId, name: org!.name, slug: org!.slug, siteId, crawlQueued };
    });

    return result;
  });

  // ---- verify 2FA -------------------------------------------------------
  app.post('/auth/mfa', {
    config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
  }, async (req) => {
    const { code } = z.object({ code: z.string().min(6).max(10) }).parse(req.body);
    const sess = req.session;
    if (!sess) throw new HttpError(401, 'Sign in first', 'not_authenticated');
    if (sess.mfa_satisfied) return { ok: true };

    const row = await withPlatform((q) =>
      q.one<{ totp_secret_enc: Buffer | null; email: string }>(
        `SELECT totp_secret_enc, email FROM users WHERE id = $1`,
        [sess.user_id],
      ),
    );
    if (!row?.totp_secret_enc) throw new HttpError(400, 'Two-factor is not set up', 'no_mfa');

    const secret = row.totp_secret_enc.toString('utf8');
    if (!verifyTotp(secret, row.email, code)) {
      throw new HttpError(401, 'That code is not right. Codes change every 30 seconds.', 'bad_code');
    }

    await withPlatform(async (q) => {
      await q.exec(`UPDATE sessions SET mfa_satisfied = true WHERE id = $1`, [sess.id]);
      await audit(q, {
        orgId: sess.org_id, actorUser: sess.user_id,
        action: 'auth.mfa_verified', ip: req.ip,
      });
    });
    return { ok: true };
  });

  // ---- who am I ---------------------------------------------------------
  app.get('/auth/me', async (req) => {
    const sess = req.session;
    if (!sess) return { authenticated: false };

    // Health/siteCount power the org switcher's per-business summary (it's
    // the most-used control in the app — the portfolio view is one tap away
    // rather than a separate screen, per docs/DESIGN.md). Mirrors the
    // in_health_score / is_primary convention from seo_latest_score
    // (migration 004): WIP sites are tracked but never the headline score.
    const orgs = await withPlatform((q) =>
      q.rows<{
        id: string; name: string; slug: string; role: string; modules: unknown;
        health: number | null; siteCount: number;
      }>(
        `SELECT o.id, o.name, o.slug, m.role, o.modules,
                health_row.health, COALESCE(site_row.n, 0)::int AS "siteCount"
           FROM memberships m
           JOIN organizations o ON o.id = m.org_id
      LEFT JOIN LATERAL (
                  SELECT sc.health
                    FROM seo_scores sc
                    JOIN seo_sites s ON s.id = sc.site_id
                   WHERE s.org_id = o.id AND s.is_primary AND s.in_health_score
                   ORDER BY sc.computed_at DESC
                   LIMIT 1
                ) health_row ON true
      LEFT JOIN LATERAL (
                  SELECT count(*)::int AS n FROM seo_sites s WHERE s.org_id = o.id
                ) site_row ON true
          WHERE m.user_id = $1 AND o.deleted_at IS NULL
          ORDER BY o.name`,
        [sess.user_id],
      ),
    );

    return {
      authenticated: true,
      mfaSatisfied: sess.mfa_satisfied,
      user: {
        id: sess.user_id,
        email: sess.email,
        name: sess.full_name,
        isStaff: sess.is_platform_staff,
      },
      currentOrgId: sess.org_id,
      role: req.role,
      organizations: orgs,
    };
  });

  // ---- switch business --------------------------------------------------
  app.post('/auth/org', async (req) => {
    const sess = req.requireAuth();
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.body);

    const allowed = await withPlatform((q) =>
      q.one(
        `SELECT 1 FROM memberships WHERE user_id = $1 AND org_id = $2`,
        [sess.user_id, orgId],
      ),
    );
    if (!allowed && !sess.is_platform_staff) {
      throw new HttpError(403, 'You do not have access to that business', 'forbidden');
    }

    await withPlatform(async (q) => {
      await q.exec(`UPDATE sessions SET org_id = $2 WHERE id = $1`, [sess.id, orgId]);
      await audit(q, {
        orgId, actorUser: sess.user_id, action: 'auth.switch_org',
        staffMode: !allowed, ip: req.ip,
      });
    });
    return { ok: true, orgId };
  });

  // ---- sign out ---------------------------------------------------------
  app.post('/auth/logout', async (req, reply) => {
    const sess = req.session;
    if (sess) {
      await withPlatform((q) =>
        q.exec(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [sess.id]),
      );
    }
    // Clear both variants: the current domain-scoped cookie (must match
    // the domain it was set with, or the browser treats this as clearing
    // an unrelated cookie and leaves the real one behind), and the
    // host-only one pre-fix browsers may still be carrying alongside it.
    reply.clearCookie(SESSION_COOKIE, { path: '/', domain: cookieOpts.domain });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // ---- enrol 2FA --------------------------------------------------------
  app.post('/auth/mfa/setup', async (req) => {
    const sess = req.requireAuth();
    const secret = newTotpSecret();
    const uri = makeTotp(secret, sess.email).toString();

    await withPlatform((q) =>
      q.exec(
        `UPDATE users SET totp_secret_enc = $2 WHERE id = $1 AND totp_enabled_at IS NULL`,
        [sess.user_id, Buffer.from(secret, 'utf8')],
      ),
    );
    return { secret, otpauthUri: uri };
  });

  app.post('/auth/mfa/confirm', async (req) => {
    const sess = req.requireAuth();
    const { code } = z.object({ code: z.string().min(6).max(10) }).parse(req.body);

    const row = await withPlatform((q) =>
      q.one<{ totp_secret_enc: Buffer | null }>(
        `SELECT totp_secret_enc FROM users WHERE id = $1`, [sess.user_id],
      ),
    );
    if (!row?.totp_secret_enc) throw new HttpError(400, 'Start setup first', 'no_pending_mfa');

    const secret = row.totp_secret_enc.toString('utf8');
    if (!verifyTotp(secret, sess.email, code)) {
      throw new HttpError(400, 'That code is not right. Try the next one.', 'bad_code');
    }

    await withPlatform(async (q) => {
      await q.exec(`UPDATE users SET totp_enabled_at = now() WHERE id = $1`, [sess.user_id]);
      await audit(q, {
        orgId: sess.org_id, actorUser: sess.user_id,
        action: 'auth.mfa_enabled', ip: req.ip,
      });
    });
    return { ok: true };
  });

  // ---- change password --------------------------------------------------
  app.post('/auth/password', async (req) => {
    const sess = req.requireAuth();
    const body = z.object({
      current: z.string().min(1),
      next: z.string().min(12, 'Use at least 12 characters').max(200),
    }).parse(req.body);

    const row = await withPlatform((q) =>
      q.one<{ password_hash: string | null }>(
        `SELECT password_hash FROM users WHERE id = $1`, [sess.user_id],
      ),
    );
    if (!(await verifyPassword(row?.password_hash ?? null, body.current))) {
      throw new HttpError(401, 'Current password is incorrect', 'bad_credentials');
    }

    const hashed = await hashPassword(body.next);
    await withPlatform(async (q) => {
      await q.exec(`UPDATE users SET password_hash = $2 WHERE id = $1`,
        [sess.user_id, hashed]);
      // Every other session for this user dies.
      await q.exec(
        `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
        [sess.user_id, sess.id],
      );
      await audit(q, {
        orgId: sess.org_id, actorUser: sess.user_id,
        action: 'auth.password_changed', ip: req.ip,
      });
    });
    return { ok: true };
  });

  // ---- forgot password ---------------------------------------------------
  // Always the same response whether or not the email exists — the actual
  // enumeration-safety work happens inside: a real token is only generated,
  // and a real email only sent, when a matching user is found.
  app.post('/auth/forgot', {
    config: {
      rateLimit: { max: 5, timeWindow: '30 minutes', hook: 'preHandler', keyGenerator: emailKeyGenerator },
    },
  }, async (req) => {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);

    const user = await withPlatform((q) =>
      q.one<{ id: string }>(`SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL`, [email]),
    );

    if (user) {
      const token = newSessionToken();
      await withPlatform(async (q) => {
        await q.exec(
          `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
           VALUES ($1, $2, now() + ($3 || ' minutes')::interval)`,
          [user.id, hashToken(token), RESET_TOKEN_TTL_MIN],
        );
        const { subject, html, text } = passwordResetEmail(`${APP_BASE_URL}/reset-password?token=${token}`);
        await sendEmail(q, { to: email, subject, html, text, template: 'password_reset', userId: user.id });
        await audit(q, { orgId: null, actorUser: user.id, action: 'auth.password_reset_requested', ip: req.ip });
      });
    }

    return { ok: true, message: 'If that email is registered, we sent a reset link.' };
  });

  app.post('/auth/reset', {
    config: { rateLimit: { max: 10, timeWindow: '30 minutes' } },
  }, async (req) => {
    const body = z.object({
      token: z.string().min(1),
      password: z.string().min(12, 'Use at least 12 characters').max(200),
    }).parse(req.body);

    const row = await withPlatform((q) =>
      q.one<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM password_reset_tokens
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
        [hashToken(body.token)],
      ),
    );
    if (!row) throw new HttpError(400, 'This reset link is invalid or has expired.', 'invalid_token');

    const hashed = await hashPassword(body.password);
    await withPlatform(async (q) => {
      await q.exec(`UPDATE password_reset_tokens SET used_at = now() WHERE id = $1`, [row.id]);
      await q.exec(`UPDATE users SET password_hash = $2, failed_logins = 0, locked_until = NULL WHERE id = $1`,
        [row.user_id, hashed]);
      // A reset is exactly the scenario a stolen/forgotten-but-still-live
      // session must not survive — kill every session for this user, not
      // just "every other one" (change-password's own rule): there is no
      // "current session" to spare here, the person isn't logged in yet.
      await q.exec(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [row.user_id]);
      await audit(q, { orgId: null, actorUser: row.user_id, action: 'auth.password_reset_completed', ip: req.ip });
    });
    return { ok: true };
  });

  // ---- email verification -------------------------------------------------
  app.post('/auth/verify-email/confirm', {
    config: { rateLimit: { max: 20, timeWindow: '30 minutes' } },
  }, async (req) => {
    const { token } = z.object({ token: z.string().min(1) }).parse(req.body);

    const row = await withPlatform((q) =>
      q.one<{ id: string; user_id: string }>(
        `SELECT id, user_id FROM email_verification_tokens
          WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
        [hashToken(token)],
      ),
    );
    if (!row) throw new HttpError(400, 'This verification link is invalid or has expired.', 'invalid_token');

    await withPlatform(async (q) => {
      await q.exec(`UPDATE email_verification_tokens SET used_at = now() WHERE id = $1`, [row.id]);
      await q.exec(`UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1`, [row.user_id]);
      await audit(q, { orgId: null, actorUser: row.user_id, action: 'auth.email_verified', ip: req.ip });
    });
    return { ok: true };
  });

  app.post('/auth/verify-email/resend', {
    config: { rateLimit: { max: 5, timeWindow: '30 minutes' } },
  }, async (req) => {
    const sess = req.requireAuth();
    const user = await withPlatform((q) =>
      q.one<{ email: string; email_verified_at: Date | null }>(
        `SELECT email, email_verified_at FROM users WHERE id = $1`, [sess.user_id],
      ),
    );
    if (!user || user.email_verified_at) return { ok: true };
    await withPlatform((q) => sendVerificationEmail(q, sess.user_id, user.email));
    return { ok: true };
  });

  // ---- team invites --------------------------------------------------------
  app.post('/auth/invites', async (req) => {
    req.requireRole('admin');
    const sess = req.requireAuth();
    const orgId = req.ctx.orgId!;
    const body = z.object({
      email: z.string().trim().toLowerCase().email(),
      role: z.enum(['admin', 'manager', 'staff', 'viewer']).default('viewer'),
    }).parse(req.body);

    const token = newSessionToken();
    await withPlatform(async (q) => {
      const org = await q.one<{ name: string }>(`SELECT name FROM organizations WHERE id = $1`, [orgId]);
      await q.exec(
        `INSERT INTO org_invites (org_id, email, role, token_hash, invited_by, expires_at)
         VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' days')::interval)
         ON CONFLICT (org_id, email) WHERE accepted_at IS NULL
         DO UPDATE SET role = EXCLUDED.role, token_hash = EXCLUDED.token_hash,
                       invited_by = EXCLUDED.invited_by, expires_at = EXCLUDED.expires_at,
                       created_at = now()`,
        [orgId, body.email, body.role, hashToken(token), sess.user_id, INVITE_TOKEN_TTL_DAYS],
      );
      const { subject, html, text } = orgInviteEmail(
        org!.name, sess.full_name, `${APP_BASE_URL}/invite/accept?token=${token}`,
      );
      await sendEmail(q, { to: body.email, subject, html, text, template: 'org_invite', orgId });
      await audit(q, { orgId, actorUser: sess.user_id, action: 'auth.invite_sent', ip: req.ip, diff: { email: body.email, role: body.role } });
    });
    return { ok: true };
  });

  app.post('/auth/invites/accept', {
    config: { rateLimit: { max: 10, timeWindow: '30 minutes' } },
  }, async (req, reply) => {
    const body = z.object({
      token: z.string().min(1),
      full_name: z.string().trim().min(1).max(200).optional(),
      password: z.string().min(12).max(200).optional(),
    }).parse(req.body);

    const invite = await withPlatform((q) =>
      q.one<{ id: string; org_id: string; email: string; role: string }>(
        `SELECT id, org_id, email, role FROM org_invites
          WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now()`,
        [hashToken(body.token)],
      ),
    );
    if (!invite) throw new HttpError(400, 'This invite is invalid or has expired.', 'invalid_token');

    const token = newSessionToken();
    await withPlatform(async (q) => {
      let user = await q.one<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [invite.email]);
      if (!user) {
        if (!body.password || !body.full_name) {
          throw new HttpError(400, 'Set a name and password to accept this invite.', 'account_required');
        }
        const passwordHash = await hashPassword(body.password);
        user = await q.one<{ id: string }>(
          `INSERT INTO users (email, password_hash, full_name, email_verified_at)
           VALUES ($1,$2,$3, now()) RETURNING id`,
          [invite.email, passwordHash, body.full_name],
        );
      }

      await q.exec(
        `INSERT INTO memberships (org_id, user_id, role, invited_by, invited_at, accepted_at)
         SELECT $1, $2, $3, invited_by, created_at, now() FROM org_invites WHERE id = $4
         ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role, accepted_at = now()`,
        [invite.org_id, user!.id, invite.role, invite.id],
      );
      await q.exec(`UPDATE org_invites SET accepted_at = now() WHERE id = $1`, [invite.id]);
      await q.exec(
        `INSERT INTO sessions (user_id, org_id, token_hash, ip, user_agent, mfa_satisfied, expires_at)
         VALUES ($1,$2,$3,$4,$5,true, now() + ($6 || ' days')::interval)`,
        [user!.id, invite.org_id, hashToken(token), req.ip, req.headers['user-agent']?.slice(0, 400) ?? null, SESSION_TTL_DAYS],
      );
      await audit(q, { orgId: invite.org_id, actorUser: user!.id, action: 'auth.invite_accepted', ip: req.ip });
    });

    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    reply.setCookie(SESSION_COOKIE, token, cookieOpts);
    return { ok: true, orgId: invite.org_id };
  });
}

async function sendVerificationEmail(q: Parameters<typeof sendEmail>[0], userId: string, email: string): Promise<void> {
  const token = newSessionToken();
  await q.exec(
    `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + ($3 || ' hours')::interval)`,
    [userId, hashToken(token), VERIFY_TOKEN_TTL_HOURS],
  );
  const { subject, html, text } = emailVerificationEmail(`${APP_BASE_URL}/verify-email?token=${token}`);
  await sendEmail(q, { to: email, subject, html, text, template: 'email_verification', userId });
}
