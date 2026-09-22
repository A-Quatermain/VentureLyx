/**
 * Venturelyx :: Reviews & Reputation.
 *
 * No automated review source is connected yet — reviews.source defaults to
 * 'manual' (an owner typing one in), same posture as the schema comment in
 * 007_reviews.sql. Role grades follow OPERATE-SPEC.md's ground rules:
 * reading is viewer, creating/editing is staff.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/auth.js';
import { HttpError } from '../plugins/context.js';
import { moduleWriteGate } from '../lib/moduleAccess.js';

const REVIEW_FIELDS = `id, source, author_name, rating, body, reviewed_at,
  response_body, response_status, responded_at`;

const reviewInput = z.object({
  source: z.enum(['manual', 'google', 'facebook', 'yelp']).default('manual'),
  author_name: z.string().trim().min(1).max(200),
  rating: z.number().int().min(1).max(5),
  body: z.string().nullable().optional(),
  reviewed_at: z.string().datetime().nullable().optional(),
});

export default async function reviewsRoutes(app: FastifyInstance) {
  // Every route below is Reviews-scoped; this file's registration is the
  // module boundary. Reads pass through untouched — only POST/PATCH/DELETE
  // can be turned off.
  app.addHook('preHandler', moduleWriteGate('reviews'));

  app.get('/reviews', async (req) => {
    req.requireRole('viewer');
    return req.db((q) =>
      q.rows(`SELECT ${REVIEW_FIELDS} FROM reviews ORDER BY reviewed_at DESC LIMIT 200`),
    );
  });

  app.post('/reviews', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const body = reviewInput.parse(req.body);

    return req.db(async (q) => {
      const review = await q.one(
        `INSERT INTO reviews (org_id, source, author_name, rating, body, reviewed_at)
         VALUES (app.current_org(), $1,$2,$3,$4, COALESCE($5::timestamptz, now()))
         RETURNING ${REVIEW_FIELDS}`,
        [body.source, body.author_name, body.rating, body.body ?? null, body.reviewed_at ?? null],
      );
      const r = review as { id: string };
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'reviews.create',
        entityType: 'reviews', entityId: r.id, ip: req.ip,
      });
      return review;
    });
  });

  // Saves an AI-drafted (or hand-written) reply. response_status is
  // 'drafted' (saved, not yet posted anywhere real) or 'published' (the
  // owner has posted it on the actual review platform themselves — there's
  // no API integration to post it for them yet, so this just records that
  // it happened).
  app.patch('/reviews/:id', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      response_body: z.string().min(1),
      response_status: z.enum(['drafted', 'published']),
    }).parse(req.body);

    return req.db(async (q) => {
      const review = await q.one(
        `UPDATE reviews
            SET response_body = $2, response_status = $3,
                responded_at = now(), responded_by = $4
          WHERE id = $1
        RETURNING ${REVIEW_FIELDS}`,
        [id, body.response_body, body.response_status, sess.user_id],
      );
      if (!review) throw new HttpError(404, 'Review not found', 'not_found');
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'reviews.respond',
        entityType: 'reviews', entityId: id, ip: req.ip, diff: body,
      });
      return review;
    });
  });
}
