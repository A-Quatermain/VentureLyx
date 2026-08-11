/**
 * Venturelyx :: request context plugin.
 *
 * Resolves the session cookie into a tenant context and attaches helpers.
 * Routes never read cookies or build tenant context themselves.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { withPlatform, withTenant, type Querier, type TenantContext } from '../lib/db.js';
import {
  SESSION_COOKIE, atLeast, loadSession, type Role, type SessionRow,
} from '../lib/auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionRow | null;
    ctx: TenantContext;
    role: Role | null;
    /** Run a query inside this request's tenant context. */
    db<T>(fn: (q: Querier) => Promise<T>): Promise<T>;
    /** 401 unless signed in and MFA satisfied. */
    requireAuth(): asserts this is FastifyRequest & { session: SessionRow };
    /** 401/403 unless signed in with an org and at least `needed`. */
    requireRole(needed: Role): void;
  }
}

class HttpError extends Error {
  constructor(public statusCode: number, message: string, public code?: string) {
    super(message);
  }
}

export default fp(async function contextPlugin(app: FastifyInstance) {
  app.decorateRequest('session', null);
  app.decorateRequest('ctx', null as never);
  app.decorateRequest('role', null);

  app.addHook('onRequest', async (req: FastifyRequest) => {
    req.ctx = { orgId: null, userId: null, isStaff: false };
    req.session = null;
    req.role = null;

    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) return;

    // Session lookup spans tenants (we do not know the org yet), so it runs
    // on the platform context. Everything after uses the resolved org.
    const s = await withPlatform((q) => loadSession(q, token));
    if (!s) return;

    req.session = s;
    req.ctx = {
      orgId: s.org_id,
      userId: s.user_id,
      // Staff mode is only active for platform staff on requests with no org
      // selected. A staff member viewing one client is scoped like anyone else.
      isStaff: s.is_platform_staff && !s.org_id,
    };

    if (s.org_id) {
      const m = await withPlatform((q) =>
        q.one<{ role: Role }>(
          `SELECT role FROM memberships WHERE user_id = $1 AND org_id = $2`,
          [s.user_id, s.org_id],
        ),
      );
      req.role = m?.role ?? null;
      // Membership revoked while the session lived on.
      if (!m && !s.is_platform_staff) {
        req.session = null;
        req.ctx = { orgId: null, userId: null, isStaff: false };
      }
    }
  });

  app.decorateRequest('db', function <T>(this: FastifyRequest, fn: (q: Querier) => Promise<T>) {
    return withTenant(this.ctx, fn);
  });

  app.decorateRequest('requireAuth', function (this: FastifyRequest) {
    if (!this.session) throw new HttpError(401, 'Sign in to continue', 'not_authenticated');
    if (!this.session.mfa_satisfied) {
      throw new HttpError(401, 'Two-factor verification required', 'mfa_required');
    }
  });

  app.decorateRequest('requireRole', function (this: FastifyRequest, needed: Role) {
    this.requireAuth();
    if (!this.ctx.orgId) throw new HttpError(400, 'Select a business first', 'no_org');
    if (!this.role || !atLeast(this.role, needed)) {
      throw new HttpError(403, 'You do not have access to do that', 'forbidden');
    }
  });

  app.setErrorHandler((err, req: FastifyRequest, reply: FastifyReply) => {
    const status = (err as HttpError).statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err, url: req.url }, 'request failed');
      return reply.status(500).send({
        error: 'Something went wrong on our side. Try again.',
        code: 'internal_error',
      });
    }
    return reply.status(status).send({
      error: err.message,
      code: (err as HttpError).code ?? 'error',
    });
  });
});

export { HttpError };
