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
import type { Querier } from '../lib/db.js';
import { syncMarketTargets } from '../lib/marketTargets.js';
import { slugify } from '../lib/slug.js';
import { HttpError } from '../plugins/context.js';

async function logTimeline(
  q: Querier,
  entry: {
    orgId: string | null; partyId?: string | null; eventType: string; title: string;
    body?: string | null; actorUserId?: string | null; actorLabel?: string | null;
    module?: string; payload?: unknown;
  },
): Promise<void> {
  await q.exec(
    `INSERT INTO timeline_events
       (org_id, party_id, event_type, module, title, body, actor_type, actor_user_id, actor_label, payload)
     VALUES ($1,$2,$3,$4,$5,$6,'user',$7,$8,$9)`,
    [
      entry.orgId, entry.partyId ?? null, entry.eventType, entry.module ?? 'operate',
      entry.title, entry.body ?? null, entry.actorUserId ?? null, entry.actorLabel ?? null,
      entry.payload ? JSON.stringify(entry.payload) : '{}',
    ],
  );
}

const partyInput = z.object({
  kind: z.enum(['person', 'company']).default('person'),
  display_name: z.string().min(1),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  company_name: z.string().nullable().optional(),
  is_lead: z.boolean().default(true),
  is_customer: z.boolean().default(false),
  is_vendor: z.boolean().default(false),
  lifecycle: z.enum(['new', 'working', 'qualified', 'customer', 'lost', 'dormant']).default('new'),
  city: z.string().nullable().optional(),
  address_line1: z.string().nullable().optional(),
  address_line2: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
  postal_code: z.string().nullable().optional(),
  country: z.string().length(2).default('US'),
  notes: z.string().nullable().optional(),
  tags: z.array(z.string()).default([]),
});

const contactInput = z.object({
  channel: z.enum(['email', 'phone', 'sms', 'whatsapp', 'url']),
  value: z.string().min(1),
  label: z.string().nullable().optional(),
  is_primary: z.boolean().default(false),
});

const partyListQuery = z.object({
  q: z.string().trim().min(1).optional(),
  role: z.enum(['lead', 'customer', 'vendor']).optional(),
  lifecycle: z.enum(['new', 'working', 'qualified', 'customer', 'lost', 'dormant']).optional(),
  page: z.coerce.number().int().min(1).default(1),
});

const PARTY_FIELDS = `id, kind, display_name, first_name, last_name, company_name,
  is_lead, is_customer, is_vendor, lifecycle, city, address_line1, address_line2,
  region, postal_code, country, notes, tags, first_seen_at, last_activity_at`;

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

  // ---- Customers (parties) -------------------------------------------------
  // GET /parties returns lifetime value and open balance computed straight
  // from invoices — that table is real (docs/OPERATE-SPEC.md section 3) even
  // though the invoice CRUD/UI isn't built yet (step 5). An org with no
  // invoices just gets '0.00', which is honest, not a placeholder.
  app.get('/operate/parties', async (req) => {
    req.requireRole('viewer');
    const { q, role, lifecycle, page } = partyListQuery.parse(req.query);
    const offset = (page - 1) * 50;

    return req.db((db) =>
      db.rows(
        `SELECT p.id, p.display_name, p.company_name, p.lifecycle, p.city,
                p.last_activity_at, p.first_seen_at,
                (SELECT value FROM party_contacts
                  WHERE party_id = p.id AND channel = 'phone' AND is_primary LIMIT 1) AS phone,
                (SELECT value FROM party_contacts
                  WHERE party_id = p.id AND channel = 'email' AND is_primary LIMIT 1) AS email,
                COALESCE(inv.lifetime_value, '0.00') AS lifetime_value,
                COALESCE(inv.open_balance, '0.00') AS open_balance,
                t.channel AS first_touch_channel
           FROM parties p
           LEFT JOIN attribution_touches t ON t.id = p.first_touch_id
           LEFT JOIN LATERAL (
             SELECT sum(amount_paid)::text AS lifetime_value,
                    sum(total - amount_paid) FILTER (WHERE status IN ('sent', 'partial'))::text AS open_balance
               FROM invoices WHERE party_id = p.id
           ) inv ON true
          WHERE p.deleted_at IS NULL
            AND ($1::text IS NULL OR p.display_name ILIKE '%' || $1 || '%'
                 OR p.company_name ILIKE '%' || $1 || '%'
                 OR EXISTS (SELECT 1 FROM party_contacts pc
                             WHERE pc.party_id = p.id AND pc.value ILIKE '%' || $1 || '%'))
            AND ($2::text IS NULL
                 OR ($2 = 'lead' AND p.is_lead)
                 OR ($2 = 'customer' AND p.is_customer)
                 OR ($2 = 'vendor' AND p.is_vendor))
            AND ($3::text IS NULL OR p.lifecycle = $3)
          ORDER BY p.last_activity_at DESC NULLS LAST, p.first_seen_at DESC
          LIMIT 50 OFFSET $4`,
        [q ?? null, role ?? null, lifecycle ?? null, offset],
      ),
    );
  });

  app.get('/operate/parties/:id', async (req) => {
    req.requireRole('viewer');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    return req.db(async (db) => {
      const party = await db.one(
        `SELECT p.id, p.kind, p.display_name, p.first_name, p.last_name, p.company_name,
                p.is_lead, p.is_customer, p.is_vendor, p.lifecycle, p.city, p.address_line1,
                p.address_line2, p.region, p.postal_code, p.country, p.notes, p.tags,
                p.first_seen_at, p.last_activity_at,
                t.channel AS first_touch_channel, t.source AS first_touch_source,
                t.occurred_at AS first_touch_at
           FROM parties p
           LEFT JOIN attribution_touches t ON t.id = p.first_touch_id
          WHERE p.id = $1 AND p.deleted_at IS NULL`,
        [id],
      );
      if (!party) throw new HttpError(404, 'Customer not found', 'not_found');

      const contacts = await db.rows(
        `SELECT id, channel, value, label, is_primary
           FROM party_contacts WHERE party_id = $1 ORDER BY is_primary DESC, created_at`,
        [id],
      );

      const money = await db.one(
        `SELECT COALESCE(sum(amount_paid), 0)::text AS lifetime_value,
                COALESCE(sum(total - amount_paid) FILTER (WHERE status IN ('sent', 'partial')), 0)::text AS open_balance
           FROM invoices WHERE party_id = $1`,
        [id],
      );

      const lastPayment = await db.one(
        `SELECT amount::text, received_at
           FROM payments WHERE party_id = $1
          ORDER BY received_at DESC LIMIT 1`,
        [id],
      );

      return { party, contacts, money: { ...money, last_payment: lastPayment } };
    });
  });

  app.post('/operate/parties', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const body = partyInput.parse(req.body);

    return req.db(async (db) => {
      const party = await db.one(
        `INSERT INTO parties
           (org_id, kind, display_name, first_name, last_name, company_name,
            is_lead, is_customer, is_vendor, lifecycle, city, address_line1,
            address_line2, region, postal_code, country, notes, tags)
         VALUES (app.current_org(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         RETURNING ${PARTY_FIELDS}`,
        [
          body.kind, body.display_name, body.first_name ?? null, body.last_name ?? null,
          body.company_name ?? null, body.is_lead, body.is_customer, body.is_vendor,
          body.lifecycle, body.city ?? null, body.address_line1 ?? null,
          body.address_line2 ?? null, body.region ?? null, body.postal_code ?? null,
          body.country, body.notes ?? null, body.tags,
        ],
      );
      const p = party as { id: string; display_name: string };
      await audit(db, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'operate.party.create',
        entityType: 'parties', entityId: p.id, ip: req.ip,
      });
      await logTimeline(db, {
        orgId: req.ctx.orgId, partyId: p.id, eventType: 'party.created',
        title: `Added ${p.display_name}`, actorUserId: sess.user_id, actorLabel: sess.full_name,
      });
      return party;
    });
  });

  app.patch('/operate/parties/:id', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = partyInput.partial().parse(req.body);

    if (Object.keys(body).length === 0) {
      throw new HttpError(400, 'Nothing to update', 'invalid_input');
    }

    const fields: string[] = [];
    const values: unknown[] = [];
    let i = 1;
    for (const [key, value] of Object.entries(body)) {
      fields.push(`${key} = $${i}`);
      values.push(value);
      i += 1;
    }
    values.push(id);

    return req.db(async (db) => {
      // Editing the record is the only "activity" signal available before
      // Jobs/Invoices (spec steps 4-5) exist to bump it naturally.
      const party = await db.one(
        `UPDATE parties SET ${fields.join(', ')}, updated_at = now(), last_activity_at = now()
          WHERE id = $${i} AND deleted_at IS NULL
        RETURNING ${PARTY_FIELDS}`,
        values,
      );
      if (!party) throw new HttpError(404, 'Customer not found', 'not_found');
      await audit(db, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'operate.party.update',
        entityType: 'parties', entityId: id, ip: req.ip, diff: body,
      });
      await logTimeline(db, {
        orgId: req.ctx.orgId, partyId: id, eventType: 'party.updated',
        title: 'Details updated', actorUserId: sess.user_id, actorLabel: sess.full_name, payload: body,
      });
      return party;
    });
  });

  app.delete('/operate/parties/:id', async (req) => {
    req.requireRole('manager');
    const sess = req.requireAuth();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    return req.db(async (db) => {
      const party = await db.one<{ id: string; display_name: string }>(
        `UPDATE parties SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL
         RETURNING id, display_name`,
        [id],
      );
      if (!party) throw new HttpError(404, 'Customer not found', 'not_found');
      await audit(db, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'operate.party.delete',
        entityType: 'parties', entityId: id, ip: req.ip,
      });
      await logTimeline(db, {
        orgId: req.ctx.orgId, partyId: id, eventType: 'party.deleted',
        title: `Removed ${party.display_name}`, actorUserId: sess.user_id, actorLabel: sess.full_name,
      });
      return { ok: true };
    });
  });

  app.post('/operate/parties/:id/contacts', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = contactInput.parse(req.body);

    return req.db(async (db) => {
      const party = await db.one(`SELECT id FROM parties WHERE id = $1 AND deleted_at IS NULL`, [id]);
      if (!party) throw new HttpError(404, 'Customer not found', 'not_found');

      // party_contacts_party_id_channel_idx allows only one is_primary row per
      // (party, channel) — demote the current one before inserting a new one.
      if (body.is_primary) {
        await db.exec(
          `UPDATE party_contacts SET is_primary = false WHERE party_id = $1 AND channel = $2 AND is_primary`,
          [id, body.channel],
        );
      }

      const contact = await db.one(
        `INSERT INTO party_contacts (org_id, party_id, channel, value, label, is_primary)
         VALUES (app.current_org(), $1,$2,$3,$4,$5)
         RETURNING id, channel, value, label, is_primary`,
        [id, body.channel, body.value, body.label ?? null, body.is_primary],
      );
      await db.exec(`UPDATE parties SET last_activity_at = now() WHERE id = $1`, [id]);
      await audit(db, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'operate.party.contact.create',
        entityType: 'party_contacts', entityId: (contact as { id: string }).id, ip: req.ip,
      });
      await logTimeline(db, {
        orgId: req.ctx.orgId, partyId: id, eventType: 'contact.added',
        title: `Added ${body.channel}: ${body.value}`, actorUserId: sess.user_id, actorLabel: sess.full_name,
      });
      return contact;
    });
  });

  app.patch('/operate/parties/contacts/:id', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = contactInput.partial().parse(req.body);

    if (Object.keys(body).length === 0) {
      throw new HttpError(400, 'Nothing to update', 'invalid_input');
    }

    return req.db(async (db) => {
      const existing = await db.one<{ party_id: string; channel: string }>(
        `SELECT party_id, channel FROM party_contacts WHERE id = $1`,
        [id],
      );
      if (!existing) throw new HttpError(404, 'Contact not found', 'not_found');

      if (body.is_primary) {
        await db.exec(
          `UPDATE party_contacts SET is_primary = false
            WHERE party_id = $1 AND channel = $2 AND is_primary AND id <> $3`,
          [existing.party_id, body.channel ?? existing.channel, id],
        );
      }

      const fields: string[] = [];
      const values: unknown[] = [];
      let i = 1;
      for (const [key, value] of Object.entries(body)) {
        fields.push(`${key} = $${i}`);
        values.push(value);
        i += 1;
      }
      values.push(id);

      const contact = await db.one(
        `UPDATE party_contacts SET ${fields.join(', ')} WHERE id = $${i}
         RETURNING id, channel, value, label, is_primary`,
        values,
      );
      await audit(db, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'operate.party.contact.update',
        entityType: 'party_contacts', entityId: id, ip: req.ip, diff: body,
      });
      return contact;
    });
  });

  app.delete('/operate/parties/contacts/:id', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    return req.db(async (db) => {
      const deleted = await db.one(`DELETE FROM party_contacts WHERE id = $1 RETURNING id`, [id]);
      if (!deleted) throw new HttpError(404, 'Contact not found', 'not_found');
      await audit(db, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'operate.party.contact.delete',
        entityType: 'party_contacts', entityId: id, ip: req.ip,
      });
      return { ok: true };
    });
  });

  app.get('/operate/parties/:id/timeline', async (req) => {
    req.requireRole('viewer');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    return req.db((db) =>
      db.rows(
        `SELECT id, event_type, module, title, body, actor_type, actor_label, occurred_at
           FROM timeline_events
          WHERE party_id = $1
          ORDER BY occurred_at DESC
          LIMIT 100`,
        [id],
      ),
    );
  });

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
      // A new service immediately crosses with every active location — the
      // Coverage tab should show it (as a gap, until a page is built) the
      // moment it's added, not only after the next service-area edit.
      await syncMarketTargets(q);
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
      // Toggling is_active (or kind) changes what counts as a coverage gap.
      await syncMarketTargets(q);
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
