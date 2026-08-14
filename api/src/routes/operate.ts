/**
 * Venturelyx :: Operate routes.
 *
 * Per docs/OPERATE-SPEC.md. Every query runs through req.db() — RLS scopes
 * it to the caller's org via app.current_org(), and no statement here may
 * add an org_id filter; if a query needs one, the route is wrong.
 *
 * Role grades (spec's ground rules): reading is viewer, creating/editing is
 * staff, deleting is manager.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/auth.js';
import { HttpError } from '../plugins/context.js';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const catalogItemInput = z.object({
  kind: z.enum(['service', 'product', 'package', 'fee']).default('service'),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  sku: z.string().nullable().optional(),
  unit: z.string().min(1).default('each'),
  unit_price: z.union([z.number(), z.null()]).optional(),
  cost: z.union([z.number(), z.null()]).optional(),
  taxable: z.boolean().default(true),
  duration_min: z.union([z.number().int(), z.null()]).optional(),
  is_active: z.boolean().default(true),
  priority: z.number().int().default(100),
});

export default async function operateRoutes(app: FastifyInstance) {

  // ---- Catalog ------------------------------------------------------------
  app.get('/operate/catalog', async (req) => {
    req.requireRole('viewer');
    return req.db((q) =>
      q.rows(
        `SELECT id, kind, name, slug, description, sku, unit, unit_price::text,
                cost::text, taxable, duration_min, is_active, priority
           FROM catalog_items
          ORDER BY priority, name`,
      ),
    );
  });

  app.post('/operate/catalog', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const body = catalogItemInput.parse(req.body);
    const slug = slugify(body.name);
    if (!slug) throw new HttpError(400, 'Name must contain at least one letter or number', 'invalid_input');

    return req.db(async (q) => {
      const item = await q.one(
        `INSERT INTO catalog_items
           (org_id, kind, name, slug, description, sku, unit, unit_price, cost,
            taxable, duration_min, is_active, priority)
         VALUES (app.current_org(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING id, kind, name, slug, description, sku, unit, unit_price::text,
                   cost::text, taxable, duration_min, is_active, priority`,
        [
          body.kind, body.name, slug, body.description ?? null, body.sku ?? null,
          body.unit, body.unit_price ?? null, body.cost ?? null, body.taxable,
          body.duration_min ?? null, body.is_active, body.priority,
        ],
      );
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'operate.catalog.create',
        entityType: 'catalog_items', entityId: (item as { id: string }).id, ip: req.ip,
      });
      return item;
    });
  });

  app.patch('/operate/catalog/:id', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = catalogItemInput.partial().parse(req.body);

    if (Object.keys(body).length === 0) {
      throw new HttpError(400, 'Nothing to update', 'invalid_input');
    }

    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    for (const [key, value] of Object.entries(body)) {
      if (key === 'name') {
        fields.push(`name = $${i}`, `slug = $${i + 1}`);
        values.push(value, slugify(value as string));
        i += 2;
      } else {
        fields.push(`${key} = $${i}`);
        values.push(value);
        i += 1;
      }
    }
    values.push(id);

    return req.db(async (q) => {
      const item = await q.one(
        `UPDATE catalog_items SET ${fields.join(', ')}, updated_at = now()
          WHERE id = $${i}
        RETURNING id, kind, name, slug, description, sku, unit, unit_price::text,
                  cost::text, taxable, duration_min, is_active, priority`,
        values,
      );
      if (!item) throw new HttpError(404, 'Catalog item not found', 'not_found');
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'operate.catalog.update',
        entityType: 'catalog_items', entityId: id, ip: req.ip, diff: body,
      });
      return item;
    });
  });

  app.delete('/operate/catalog/:id', async (req) => {
    req.requireRole('manager');
    const sess = req.requireAuth();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    return req.db(async (q) => {
      const deleted = await q.one(`DELETE FROM catalog_items WHERE id = $1 RETURNING id`, [id]);
      if (!deleted) throw new HttpError(404, 'Catalog item not found', 'not_found');
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'operate.catalog.delete',
        entityType: 'catalog_items', entityId: id, ip: req.ip,
      });
      return { ok: true };
    });
  });
}
