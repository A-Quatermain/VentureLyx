/**
 * Venturelyx :: module access enforcement.
 *
 * organizations.modules (db/migrations/001_platform_core.sql) existed and
 * was returned by /auth/me, but nothing read or wrote it until the admin
 * console's per-org toggle (routes/admin.ts) — so it recorded intent with
 * no enforcement anywhere. This is the enforcement half.
 *
 * Rules, per the brief:
 *   - Reads of existing data stay allowed on a disabled module. Never hide
 *     or destroy a client's data over an entitlement toggle — only new
 *     writes are blocked. moduleWriteGate() only ever inspects
 *     request.method, and only ever blocks the non-GET/HEAD ones.
 *   - Missing key defaults to ENABLED, not disabled. organizations.modules
 *     defaults to '{}'::jsonb for every org that predates this feature —
 *     if an absent key meant "disabled," shipping this would have locked
 *     every existing organization out of every module the moment it
 *     deployed. Only an explicit `false` disables anything.
 *   - Command Center is never gated — it isn't one of the toggleable
 *     modules and has no route file of its own to attach this to; the
 *     /command/* routes in data.ts simply never call this.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from '../plugins/context.js';

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * A Fastify preHandler. Attach to a whole route file with
 * `app.addHook('preHandler', moduleWriteGate('operate'))` when every route
 * in that file belongs to one module (operate.ts, grow.ts, reviews.ts), or
 * to a single route's options (`{ preHandler: moduleWriteGate('scaleseo') }`)
 * when a file mixes modules (data.ts, ai.ts, settings.ts, integrations.ts).
 */
export function moduleWriteGate(moduleKey: string) {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (!WRITE_METHODS.has(req.method)) return;
    if (!req.ctx.orgId) return; // no org context yet — the route's own requireAuth/requireRole handles this

    const enabled = await req.db((q) =>
      q.one<{ modules: Record<string, boolean> | null }>(
        `SELECT modules FROM organizations WHERE id = $1`,
        [req.ctx.orgId],
      ),
    );

    if (enabled?.modules?.[moduleKey] === false) {
      throw new HttpError(
        403,
        `The ${moduleKey} module is turned off for this business. Ask your account team to turn it back on.`,
        'module_disabled',
      );
    }
  };
}
