/**
 * Venturelyx :: authentication routes.
 *
 * Flow: POST /auth/login -> (if 2FA on) POST /auth/mfa -> session usable.
 * Sessions exist from the first step but carry mfa_satisfied=false until the
 * code is verified, and requireAuth() rejects those.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withPlatform } from '../lib/db.js';
import {
  SESSION_COOKIE, SESSION_TTL_DAYS, audit, hashToken, newSessionToken,
  newTotpSecret, makeTotp, verifyPassword, verifyTotp, hashPassword,
} from '../lib/auth.js';
import { HttpError } from '../plugins/context.js';

const LOCK_AFTER = 8;
const LOCK_MINUTES = 15;

export default async function authRoutes(app: FastifyInstance) {

  const cookieOpts = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
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

    reply.setCookie(SESSION_COOKIE, token, cookieOpts);
    return { mfaRequired: needsMfa, orgId: soleOrg, needsOrgChoice: orgs.length > 1 };
  });

  // ---- verify 2FA -------------------------------------------------------
  app.post('/auth/mfa', {
    config: { rateLimit: { max: 10, timeWindow: '5 minutes' } },
  }, async (req) => {
    const { code } = z.object({ code: z.string().min(6).max(10) }).parse(req.body);
    if (!req.session) throw new HttpError(401, 'Sign in first', 'not_authenticated');
    if (req.session.mfa_satisfied) return { ok: true };

    const row = await withPlatform((q) =>
      q.one<{ totp_secret_enc: Buffer | null; email: string }>(
        `SELECT totp_secret_enc, email FROM users WHERE id = $1`,
        [req.session!.user_id],
      ),
    );
    if (!row?.totp_secret_enc) throw new HttpError(400, 'Two-factor is not set up', 'no_mfa');

    const secret = row.totp_secret_enc.toString('utf8');
    if (!verifyTotp(secret, row.email, code)) {
      throw new HttpError(401, 'That code is not right. Codes change every 30 seconds.', 'bad_code');
    }

    await withPlatform(async (q) => {
      await q.exec(`UPDATE sessions SET mfa_satisfied = true WHERE id = $1`, [req.session!.id]);
      await audit(q, {
        orgId: req.session!.org_id, actorUser: req.session!.user_id,
        action: 'auth.mfa_verified', ip: req.ip,
      });
    });
    return { ok: true };
  });

  // ---- who am I ---------------------------------------------------------
  app.get('/auth/me', async (req) => {
    if (!req.session) return { authenticated: false };

    const orgs = await withPlatform((q) =>
      q.rows<{ id: string; name: string; slug: string; role: string; modules: unknown }>(
        `SELECT o.id, o.name, o.slug, m.role, o.modules
           FROM memberships m JOIN organizations o ON o.id = m.org_id
          WHERE m.user_id = $1 AND o.deleted_at IS NULL
          ORDER BY o.name`,
        [req.session.user_id],
      ),
    );

    return {
      authenticated: true,
      mfaSatisfied: req.session.mfa_satisfied,
      user: {
        id: req.session.user_id,
        email: req.session.email,
        name: req.session.full_name,
        isStaff: req.session.is_platform_staff,
      },
      currentOrgId: req.session.org_id,
      role: req.role,
      organizations: orgs,
    };
  });

  // ---- switch business --------------------------------------------------
  app.post('/auth/org', async (req) => {
    req.requireAuth();
    const { orgId } = z.object({ orgId: z.string().uuid() }).parse(req.body);

    const allowed = await withPlatform((q) =>
      q.one(
        `SELECT 1 FROM memberships WHERE user_id = $1 AND org_id = $2`,
        [req.session!.user_id, orgId],
      ),
    );
    if (!allowed && !req.session!.is_platform_staff) {
      throw new HttpError(403, 'You do not have access to that business', 'forbidden');
    }

    await withPlatform(async (q) => {
      await q.exec(`UPDATE sessions SET org_id = $2 WHERE id = $1`, [req.session!.id, orgId]);
      await audit(q, {
        orgId, actorUser: req.session!.user_id, action: 'auth.switch_org',
        staffMode: !allowed, ip: req.ip,
      });
    });
    return { ok: true, orgId };
  });

  // ---- sign out ---------------------------------------------------------
  app.post('/auth/logout', async (req, reply) => {
    if (req.session) {
      await withPlatform((q) =>
        q.exec(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [req.session!.id]),
      );
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // ---- enrol 2FA --------------------------------------------------------
  app.post('/auth/mfa/setup', async (req) => {
    req.requireAuth();
    const secret = newTotpSecret();
    const uri = makeTotp(secret, req.session!.email).toString();

    await withPlatform((q) =>
      q.exec(
        `UPDATE users SET totp_secret_enc = $2 WHERE id = $1 AND totp_enabled_at IS NULL`,
        [req.session!.user_id, Buffer.from(secret, 'utf8')],
      ),
    );
    return { secret, otpauthUri: uri };
  });

  app.post('/auth/mfa/confirm', async (req) => {
    req.requireAuth();
    const { code } = z.object({ code: z.string().min(6).max(10) }).parse(req.body);

    const row = await withPlatform((q) =>
      q.one<{ totp_secret_enc: Buffer | null }>(
        `SELECT totp_secret_enc FROM users WHERE id = $1`, [req.session!.user_id],
      ),
    );
    if (!row?.totp_secret_enc) throw new HttpError(400, 'Start setup first', 'no_pending_mfa');

    const secret = row.totp_secret_enc.toString('utf8');
    if (!verifyTotp(secret, req.session!.email, code)) {
      throw new HttpError(400, 'That code is not right. Try the next one.', 'bad_code');
    }

    await withPlatform(async (q) => {
      await q.exec(`UPDATE users SET totp_enabled_at = now() WHERE id = $1`, [req.session!.user_id]);
      await audit(q, {
        orgId: req.session!.org_id, actorUser: req.session!.user_id,
        action: 'auth.mfa_enabled', ip: req.ip,
      });
    });
    return { ok: true };
  });

  // ---- change password --------------------------------------------------
  app.post('/auth/password', async (req) => {
    req.requireAuth();
    const body = z.object({
      current: z.string().min(1),
      next: z.string().min(12, 'Use at least 12 characters').max(200),
    }).parse(req.body);

    const row = await withPlatform((q) =>
      q.one<{ password_hash: string | null }>(
        `SELECT password_hash FROM users WHERE id = $1`, [req.session!.user_id],
      ),
    );
    if (!(await verifyPassword(row?.password_hash ?? null, body.current))) {
      throw new HttpError(401, 'Current password is incorrect', 'bad_credentials');
    }

    const hashed = await hashPassword(body.next);
    await withPlatform(async (q) => {
      await q.exec(`UPDATE users SET password_hash = $2 WHERE id = $1`,
        [req.session!.user_id, hashed]);
      // Every other session for this user dies.
      await q.exec(
        `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
        [req.session!.user_id, req.session!.id],
      );
      await audit(q, {
        orgId: req.session!.org_id, actorUser: req.session!.user_id,
        action: 'auth.password_changed', ip: req.ip,
      });
    });
    return { ok: true };
  });
}
