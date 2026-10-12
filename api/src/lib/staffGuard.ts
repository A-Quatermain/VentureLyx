/**
 * Venturelyx :: shared staff-only route guard.
 *
 * "Staff-only" means invisible, not forbidden — a non-staff caller gets
 * reply.callNotFound() (byte-identical to a route that was never
 * registered), never 401/403, which would confirm the surface exists.
 * Checks req.session.is_platform_staff directly, not req.ctx.isStaff —
 * ctx.isStaff goes false the moment a staff user selects an org, which an
 * admin/growth-scan console must not be gated on.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

export function requireStaffOrNotFound(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!req.session?.mfa_satisfied || !req.session.is_platform_staff) {
    reply.callNotFound();
    return false;
  }
  return true;
}
