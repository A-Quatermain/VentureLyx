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
import { syncMarketTargets } from '../lib/marketTargets.js';
import { slugify } from '../lib/slug.js';
import { HttpError } from '../plugins/context.js';
import { moduleWriteGate } from '../lib/moduleAccess.js';
import { ingestFile } from '../lib/growContactImportXlsx.js';
import { logTimeline } from '../lib/timeline.js';
import { getOrCreateDefaultPipeline, type PipelineStage as PipelineStageRow } from '../lib/growPromote.js';

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
  // Every route below is Operate-scoped; this file's registration is the
  // module boundary. Reads pass through untouched (moduleWriteGate no-ops
  // on GET/HEAD) — only POST/PATCH/DELETE can be turned off.
  app.addHook('preHandler', moduleWriteGate('operate'));

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

      // Matched by email, same as the Grow -> Operate bridge's own dedupe
      // (lib/growPromote.ts) — a party isn't only the ones a reply created;
      // this also shows campaigns an as-yet-unreplied contact is enrolled
      // in, for a party that already existed from manual/website entry.
      // "Opens" is deliberately absent: Grow has no open-tracking pixel, so
      // showing one would be a fabricated number.
      const campaigns = await db.rows(
        `SELECT gc.id AS campaign_id, gc.name AS campaign_name, gc.status,
                e.state, e.current_step,
                count(m.id) FILTER (WHERE m.status = 'sent')::int AS emails_sent,
                count(DISTINCT ev.id) FILTER (WHERE ev.type = 'reply')::int AS replies
           FROM party_contacts pc
           JOIN grow_contacts c ON c.email = pc.value AND pc.channel = 'email'
           JOIN grow_enrollments e ON e.contact_id = c.id
           JOIN grow_campaigns gc ON gc.id = e.campaign_id
      LEFT JOIN grow_messages m ON m.campaign_id = gc.id AND m.contact_id = c.id
      LEFT JOIN grow_events ev ON ev.contact_id = c.id AND ev.type = 'reply'
          WHERE pc.party_id = $1
          GROUP BY gc.id, gc.name, gc.status, e.state, e.current_step
          ORDER BY gc.created_at DESC`,
        [id],
      );

      const jobs = await db.rows(
        `SELECT id, number, title, status, scheduled_at, created_at
           FROM work_orders WHERE party_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [id],
      );
      const quotes = await db.rows(
        `SELECT id, number, status, total::text, sent_at, created_at
           FROM quotes WHERE party_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [id],
      );
      const invoiceList = await db.rows(
        `SELECT id, number, status, total::text, amount_paid::text, due_on, created_at
           FROM invoices WHERE party_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [id],
      );

      return {
        party, contacts, money: { ...money, last_payment: lastPayment },
        campaigns, jobs, quotes, invoices: invoiceList,
      };
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

  // ---- Bulk-import customers from a CSV/XLSX file ---------------------------
  // Deliberately simpler than Grow's contact importer (growContactImport*.ts):
  // fixed column names matched flexibly by alias, no mapping screen, no saved
  // import profile. Grow's richer pipeline exists because marketing contacts
  // have many optional fields and get re-imported repeatedly; a customer list
  // is name/contact/city/company and is typically imported once. Reuses
  // ingestFile() — the actual CSV/XLSX parsing, not the contact-shaping logic
  // — since turning a file into rows is identical work either way.
  const IMPORT_COLUMN_ALIASES: Record<string, string[]> = {
    name: ['name', 'fullname', 'customername', 'contactname', 'client'],
    email: ['email', 'emailaddress'],
    phone: ['phone', 'phonenumber', 'mobile', 'cell', 'telephone'],
    city: ['city'],
    company: ['company', 'companyname', 'business', 'businessname'],
  };

  function findColumn(headers: string[], field: keyof typeof IMPORT_COLUMN_ALIASES): string | null {
    const aliases = IMPORT_COLUMN_ALIASES[field]!;
    for (const h of headers) {
      if (aliases.includes(h.toLowerCase().replace(/[^a-z0-9]/g, ''))) return h;
    }
    return null;
  }

  app.post('/operate/customers/import', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();

    const fields: Record<string, string> = {};
    let file: { buffer: Buffer; filename: string } | null = null;
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        const buffer = await part.toBuffer();
        if (part.file.truncated) throw new HttpError(400, 'File is too large (15MB limit)', 'file_too_large');
        file = { buffer, filename: part.filename };
      } else {
        fields[part.fieldname] = String(part.value ?? '');
      }
    }
    if (!file) throw new HttpError(400, 'No file was uploaded', 'no_file');

    const { headers, records } = ingestFile(file.buffer, file.filename);
    if (headers.length === 0) throw new HttpError(400, 'No columns found in this file', 'empty_file');

    const nameCol = findColumn(headers, 'name');
    if (!nameCol) {
      throw new HttpError(400, 'Could not find a name column — expected a header like "Name"', 'missing_column');
    }
    const emailCol = findColumn(headers, 'email');
    const phoneCol = findColumn(headers, 'phone');
    const cityCol = findColumn(headers, 'city');
    const companyCol = findColumn(headers, 'company');

    return req.db(async (db) => {
      let imported = 0;
      const skipped: Array<{ line: number; reason: string }> = [];

      for (const { record, line } of records) {
        const name = record[nameCol]?.trim();
        if (!name) {
          skipped.push({ line, reason: 'Missing name' });
          continue;
        }
        const email = emailCol ? record[emailCol]?.trim() : '';
        const phone = phoneCol ? record[phoneCol]?.trim() : '';
        const city = cityCol ? record[cityCol]?.trim() : '';
        const company = companyCol ? record[companyCol]?.trim() : '';

        const party = await db.one<{ id: string }>(
          `INSERT INTO parties (org_id, kind, display_name, company_name, is_lead, is_customer, lifecycle, city)
           VALUES (app.current_org(), 'person', $1, $2, false, true, 'customer', $3)
           RETURNING id`,
          [name, company || null, city || null],
        );
        const partyId = party!.id;

        if (email) {
          await db.exec(
            `INSERT INTO party_contacts (org_id, party_id, channel, value, is_primary)
             VALUES (app.current_org(), $1, 'email', $2, true)
             ON CONFLICT DO NOTHING`,
            [partyId, email],
          );
        }
        if (phone) {
          await db.exec(
            `INSERT INTO party_contacts (org_id, party_id, channel, value, is_primary)
             VALUES (app.current_org(), $1, 'phone', $2, true)
             ON CONFLICT DO NOTHING`,
            [partyId, phone],
          );
        }
        await logTimeline(db, {
          orgId: req.ctx.orgId, partyId, eventType: 'party.created',
          title: `Added ${name} (CSV import)`, actorUserId: sess.user_id, actorLabel: sess.full_name,
        });
        imported++;
      }

      await audit(db, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'operate.customers.import',
        entityType: 'parties', ip: req.ip, diff: { imported, skipped: skipped.length, filename: file.filename },
      });

      return { imported, skipped };
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

  // ---- Leads --------------------------------------------------------------
  // The list itself is GET /operate/leads in routes/data.ts (extended there,
  // not duplicated here, since it already backed the Operate Kanban widget —
  // see that file's comment). These two actions are the write side.
  app.post('/operate/leads/:id/start-working', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    return req.db(async (db) => {
      const party = await db.one<{ id: string; display_name: string; lifecycle: string }>(
        `UPDATE parties SET
            owner_user_id = COALESCE(owner_user_id, $2),
            lifecycle = CASE WHEN lifecycle = 'new' THEN 'working' ELSE lifecycle END,
            last_activity_at = now()
          WHERE id = $1 AND is_lead AND deleted_at IS NULL
        RETURNING id, display_name, lifecycle`,
        [id, sess.user_id],
      );
      if (!party) throw new HttpError(404, 'Lead not found', 'not_found');

      await logTimeline(db, {
        orgId: req.ctx.orgId, partyId: id, eventType: 'lead.started',
        title: `${sess.full_name} started working this lead`,
        actorUserId: sess.user_id, actorLabel: sess.full_name,
      });
      return party;
    });
  });

  app.patch('/operate/leads/:id/tag', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { tag } = z.object({ tag: z.enum(['interested', 'not_now', 'not_a_fit', 'question']) }).parse(req.body);

    return req.db(async (db) => {
      // The human call always wins, and is recorded as having won — reply_tag_source
      // flips to 'human' here and growPromote.ts never overwrites a 'human'
      // tag on a later reply (COALESCE only fills a NULL tag, and a fresh
      // reply still carries the AI's own call on ITS OWN timeline event
      // regardless, so the override never rewrites history).
      const party = await db.one<{ id: string; reply_tag: string }>(
        `UPDATE parties SET reply_tag = $2, reply_tag_source = 'human'
          WHERE id = $1 AND is_lead AND deleted_at IS NULL
        RETURNING id, reply_tag`,
        [id, tag],
      );
      if (!party) throw new HttpError(404, 'Lead not found', 'not_found');

      await logTimeline(db, {
        orgId: req.ctx.orgId, partyId: id, eventType: 'lead.tag_overridden',
        title: `Tag set to "${tag}"`, actorUserId: sess.user_id, actorLabel: sess.full_name,
        payload: { tag, tag_source: 'human' },
      });
      return party;
    });
  });

  // ---- Pipeline -------------------------------------------------------------
  // Reads/writes the exact same deals/pipelines tables the Command Center
  // funnel reads (api/src/routes/data.ts's /command/summary) — moving a card
  // here is immediately what the funnel shows, by construction, not by
  // keeping two queries in sync by hand.
  app.get('/operate/pipeline', async (req) => {
    req.requireRole('viewer');
    return req.db(async (db) => {
      const pipeline = await getOrCreateDefaultPipeline(db);
      const deals = await db.rows(
        `SELECT d.id, d.title, d.stage, d.status, d.value::text, d.owner_user_id,
                d.created_at, d.updated_at,
                p.id AS party_id, p.display_name AS party_name,
                u.full_name AS owner_name,
                CASE WHEN t.source = 'grow' THEN 'Campaign: ' || t.campaign
                     WHEN t.id IS NOT NULL THEN 'Website'
                     ELSE 'Manual' END AS source,
                extract(day FROM now() - d.updated_at)::int AS days_in_stage
           FROM deals d
           JOIN parties p ON p.id = d.party_id
      LEFT JOIN users u ON u.id = d.owner_user_id
      LEFT JOIN attribution_touches t ON t.id = d.source_touch_id
          WHERE d.pipeline_id = $1 AND d.status = 'open'
          ORDER BY d.updated_at DESC`,
        [pipeline.id],
      );
      return { pipeline, deals };
    });
  });

  const dealStageInput = z.object({ stage: z.string().min(1) });

  app.patch('/operate/pipeline/deals/:id/stage', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { stage } = dealStageInput.parse(req.body);

    return req.db(async (db) => {
      const deal = await db.one<{ id: string; pipeline_id: string | null; party_id: string; title: string; stage: string }>(
        `SELECT id, pipeline_id, party_id, title, stage FROM deals WHERE id = $1 AND status = 'open'`,
        [id],
      );
      if (!deal) throw new HttpError(404, 'Deal not found', 'not_found');

      const pipeline = deal.pipeline_id
        ? await db.one<{ stages: PipelineStageRow[] }>(`SELECT stages FROM pipelines WHERE id = $1`, [deal.pipeline_id])
        : null;
      const stageDef = pipeline?.stages.find((s) => s.key === stage);
      if (!stageDef) throw new HttpError(400, `"${stage}" is not a stage in this pipeline`, 'invalid_input');

      const updated = await db.one(
        `UPDATE deals SET
            stage = $2,
            status = CASE WHEN $3 THEN 'won' WHEN $4 THEN 'lost' ELSE status END,
            closed_at = CASE WHEN $3 OR $4 THEN now() ELSE closed_at END,
            updated_at = now()
          WHERE id = $1
        RETURNING id, title, stage, status, value::text`,
        [id, stage, stageDef.is_won, stageDef.is_lost],
      );

      // Moving stage is itself a real pipeline-change signal for the party's
      // lifecycle too — a won deal makes them a customer; a lost one keeps
      // them a lead but out of active work.
      if (stageDef.is_won) {
        await db.exec(`UPDATE parties SET is_customer = true, lifecycle = 'customer' WHERE id = $1`, [deal.party_id]);
      } else if (stageDef.is_lost) {
        await db.exec(`UPDATE parties SET lifecycle = 'lost' WHERE id = $1`, [deal.party_id]);
      } else {
        await db.exec(`UPDATE parties SET lifecycle = $2 WHERE id = $1 AND lifecycle NOT IN ('customer','lost')`,
          [deal.party_id, stage === 'new' ? 'new' : stage === 'working' ? 'working' : 'qualified']);
      }

      await logTimeline(db, {
        orgId: req.ctx.orgId, partyId: deal.party_id, eventType: 'deal.stage_changed', module: 'operate',
        title: `${deal.title}: moved from "${deal.stage}" to "${stageDef.label}"`,
        actorUserId: sess.user_id, actorLabel: sess.full_name,
        entityType: 'deal', entityId: id, payload: { from: deal.stage, to: stage },
      });
      return updated;
    });
  });

  const dealCreateInput = z.object({
    party_id: z.string().uuid(),
    title: z.string().min(1),
    // No fabricated values — absent/null until someone who knows the real
    // number sets it, never estimated or defaulted.
    value: z.union([z.number().positive(), z.null()]).optional(),
  });

  app.post('/operate/pipeline/deals', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const body = dealCreateInput.parse(req.body);

    return req.db(async (db) => {
      const party = await db.one<{ id: string }>(
        `SELECT id FROM parties WHERE id = $1 AND deleted_at IS NULL`, [body.party_id],
      );
      if (!party) throw new HttpError(404, 'Party not found', 'not_found');

      const pipeline = await getOrCreateDefaultPipeline(db);
      const deal = await db.one<{ id: string }>(
        `INSERT INTO deals (org_id, pipeline_id, party_id, title, stage, status, value, owner_user_id)
         VALUES (app.current_org(), $1, $2, $3, 'new', 'open', $4, $5)
         RETURNING id`,
        [pipeline.id, body.party_id, body.title, body.value ?? null, sess.user_id],
      );
      await db.exec(`UPDATE parties SET is_lead = true WHERE id = $1 AND lifecycle = 'new'`, [body.party_id]);
      await logTimeline(db, {
        orgId: req.ctx.orgId, partyId: body.party_id, eventType: 'deal.created', module: 'operate',
        title: `Entered pipeline: ${body.title}`, actorUserId: sess.user_id, actorLabel: sess.full_name,
        entityType: 'deal', entityId: (deal as { id: string }).id,
      });
      await audit(db, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'operate.deal.create',
        entityType: 'deals', entityId: (deal as { id: string }).id, ip: req.ip,
      });
      return deal;
    });
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
