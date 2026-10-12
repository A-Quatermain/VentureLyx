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

// Access tiers. A prospect org (organizations.status = 'prospect') is
// 'pre_payment' — Stripe has never confirmed a payment for this org.
// In practice no membership is ever created on a prospect org before
// conversion (routes/growthScans.ts's intake/checkout flow is entirely
// token-based, no login involved, deliberately — see that file's header),
// so this tier mostly exists as a defense-in-depth backstop rather than
// something a real request hits today. 'onboarding' and 'full' are
// treated identically — db/migrations's setup.ts onboarding checklist is
// itself the "authenticated onboarding area" the brief asked to keep
// reachable, so there's no narrower tier to carve out yet.
export type AccessTier = 'pre_payment' | 'onboarding' | 'full';

function tierForStatus(status: string | null): AccessTier {
  if (status === 'prospect') return 'pre_payment';
  return 'full'; // onboarding/active/paused/churned — see module comment
}

declare module 'fastify' {
  interface FastifyRequest {
    session: SessionRow | null;
    ctx: TenantContext;
    role: Role | null;
    accessTier: AccessTier;
    /** Run a query inside this request's tenant context. */
    db<T>(fn: (q: Querier) => Promise<T>): Promise<T>;
    /** 401 unless signed in and MFA satisfied. Returns the session so callers
     *  get a non-null reference that survives awaits. */
    requireAuth(): SessionRow;
    /** 401/403 unless signed in with an org and at least `needed`. */
    requireRole(needed: Role): void;
  }
}

class HttpError extends Error {
  constructor(public statusCode: number, message: string, public code?: string) {
    super(message);
  }
}

// Administrative kill switch (db/migrations/025_payment_gate_toggle.sql,
// platform_settings.payment_gate_enabled) — OFF by default per explicit
// instruction: until venturelyx.com and every module are fully working,
// no org should be locked out of anything for not having paid. Flipping
// it back to true re-enables requireProvisioned below with no redeploy.
// Cached briefly, not refetched on every request — this is an admin
// toggle expected to change rarely, not per-request state.
let gateCache: { enabled: boolean; expiresAt: number } | null = null;
const GATE_CACHE_TTL_MS = 30_000;

async function isPaymentGateEnabled(): Promise<boolean> {
  if (gateCache && gateCache.expiresAt > Date.now()) return gateCache.enabled;
  const row = await withPlatform((q) =>
    q.one<{ value: boolean }>(`SELECT value FROM platform_settings WHERE key = 'payment_gate_enabled'`),
  );
  // Missing row defaults to OFF, not the usual deny-by-default — this
  // specific flag's safe default right now IS "don't block anyone."
  const enabled = row?.value ?? false;
  gateCache = { enabled, expiresAt: Date.now() + GATE_CACHE_TTL_MS };
  return enabled;
}

/**
 * The pre-payment lockout: attach via `app.addHook('preHandler',
 * requireProvisioned)` at the top of a business-tool route file (same
 * attachment point moduleWriteGate already uses in operate.ts/grow.ts/
 * reviews.ts) — data.ts, operate.ts, grow.ts, reviews.ts, ai.ts,
 * locations.ts, integrations.ts. Deliberately NOT attached to auth.ts,
 * billing.ts, settings.ts, or setup.ts (the onboarding checklist IS the
 * "authenticated onboarding area" the brief says to keep reachable) — a
 * pre-payment org still needs to sign in, see its billing/settings page,
 * and pay. Unlike moduleWriteGate, this blocks reads too: there is no
 * existing customer data to protect reads for on an org that has never
 * paid, so "read-only while locked" doesn't apply here the way it does to
 * a toggled-off module on an established customer.
 */
export async function requireProvisioned(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (req.ctx.isStaff || !req.ctx.orgId) return;
  if (!(await isPaymentGateEnabled())) return;
  if (req.accessTier === 'pre_payment') {
    throw new HttpError(403, 'Finish setting up and paying for your plan to access this.', 'payment_required');
  }
}

export default fp(async function contextPlugin(app: FastifyInstance) {
  app.decorateRequest('session', null);
  app.decorateRequest('ctx', null as never);
  app.decorateRequest('role', null);
  app.decorateRequest('accessTier', 'full');

  app.addHook('onRequest', async (req: FastifyRequest) => {
    req.ctx = { orgId: null, userId: null, isStaff: false };
    req.session = null;
    req.role = null;
    req.accessTier = 'full';

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
      // Same round trip carries organizations.status — the access-tier gate
      // below needs it on every request and this avoids a second query.
      const m = await withPlatform((q) =>
        q.one<{ role: Role; status: string }>(
          `SELECT m.role, o.status
             FROM memberships m JOIN organizations o ON o.id = m.org_id
            WHERE m.user_id = $1 AND m.org_id = $2`,
          [s.user_id, s.org_id],
        ),
      );
      req.role = m?.role ?? null;
      req.accessTier = tierForStatus(m?.status ?? null);
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

  app.decorateRequest('requireAuth', function (this: FastifyRequest): SessionRow {
    if (!this.session) throw new HttpError(401, 'Sign in to continue', 'not_authenticated');
    if (!this.session.mfa_satisfied) {
      throw new HttpError(401, 'Two-factor verification required', 'mfa_required');
    }
    return this.session;
  });

  app.decorateRequest('requireRole', function (this: FastifyRequest, needed: Role) {
    this.requireAuth();
    if (!this.ctx.orgId) throw new HttpError(400, 'Select a business first', 'no_org');
    if (!this.role || !atLeast(this.role, needed)) {
      throw new HttpError(403, 'You do not have access to do that', 'forbidden');
    }
  });

  app.setErrorHandler((err: unknown, req: FastifyRequest, reply: FastifyReply) => {
    // Zod throws on bad input. Without this it falls through to the 500
    // branch and the user sees "something went wrong on our side" for what is
    // actually their typo, while the log fills with stack traces.
    if ((err as { name?: string }).name === 'ZodError') {
      const issues = (err as { issues?: Array<{ path: (string|number)[]; message: string }> }).issues ?? [];
      const first = issues[0];
      return reply.status(400).send({
        error: first ? `${first.path.join('.')}: ${first.message}` : 'Check the details you entered',
        code: 'invalid_input',
        fields: issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
      });
    }

    const e = err as HttpError & { message?: string };
    const status = e.statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err, url: req.url }, 'request failed');
      return reply.status(500).send({
        error: 'Something went wrong on our side. Try again.',
        code: 'internal_error',
      });
    }
    return reply.status(status).send({
      error: e.message ?? 'Request failed',
      code: e.code ?? 'error',
    });
  });
});

export { HttpError };
