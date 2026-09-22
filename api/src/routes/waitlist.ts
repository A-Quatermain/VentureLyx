/**
 * Venturelyx :: waitlist capture.
 *
 * Public, unauthenticated by necessity — nobody submitting this has an
 * account yet. Runs through withPlatform (lib/db.ts), the same staff-mode
 * bypass session lookup already uses pre-auth, since there is no org
 * context to run a tenant-scoped query in and none should exist here (see
 * db/migrations/015_waitlist.sql's header for why this table isn't
 * tenant-scoped at all).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withPlatform } from '../lib/db.js';

const waitlistInput = z.object({
  email: z.string().trim().toLowerCase().email(),
  business_name: z.string().trim().max(200).optional(),
  website_url: z.string().trim().max(500).optional(),
  phone: z.string().trim().max(50).optional(),
  interest: z.string().trim().max(200).optional(),
  source_page: z.string().trim().max(200).optional(),
});

export default async function waitlistRoutes(app: FastifyInstance) {
  app.post('/waitlist', {
    // Tighter than the global 300/min (server.ts) — this is a public,
    // unauthenticated write endpoint with no session to key off of, the
    // shape most worth throttling hard.
    config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
  }, async (req, reply) => {
    const body = waitlistInput.parse(req.body);

    // ON CONFLICT (email) DO NOTHING: idempotent on email per the brief —
    // a double submit (double-click, a retried request after a flaky
    // connection) must not create a duplicate row or silently overwrite
    // whatever a staff member has since typed into notes/status for it.
    await withPlatform((q) =>
      q.exec(
        `INSERT INTO waitlist (email, business_name, website_url, phone, interest, source_page)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (email) DO NOTHING`,
        [
          body.email, body.business_name ?? null, body.website_url ?? null,
          body.phone ?? null, body.interest ?? null, body.source_page ?? null,
        ],
      ),
    );

    // TODO: email the team on each new submission once transactional email
    // is set up (no provider is configured anywhere in this app yet — see
    // the chat response this shipped with). Until then, the row itself is
    // the only record; the admin console's Waitlist page is how this gets
    // seen.

    reply.status(201);
    return { ok: true };
  });
}
