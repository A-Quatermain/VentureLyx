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
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/auth.js';
import { syncMarketTargets } from '../lib/marketTargets.js';
import { slugify } from '../lib/slug.js';
import { HttpError, requireProvisioned } from '../plugins/context.js';
import { moduleWriteGate } from '../lib/moduleAccess.js';
import { ingestFile } from '../lib/growContactImportXlsx.js';
import { logTimeline } from '../lib/timeline.js';
import { getOrCreateDefaultPipeline, type PipelineStage as PipelineStageRow } from '../lib/growPromote.js';
import type { Querier } from '../lib/db.js';
import {
  readImportUpload, guessMapping, parseMoney, parseDateOnly, splitImportRows,
  findExistingCustomers, resolveOrCreateCustomers,
} from '../lib/operateImport.js';

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

const WORK_ORDER_STATUSES = ['scheduled', 'dispatched', 'in_progress', 'complete', 'cancelled'] as const;

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

// ---- Import existing customers (onboarding/migration) ----------------------
// Part of the same unified "import your data" flow as invoices/jobs below —
// shares lib/operateImport.ts's generic framework (readImportUpload,
// guessMapping, splitImportRows, findExistingCustomers). Standalone from
// invoices/jobs: a client can bring in a customer list with no invoices or
// jobs attached to it at all. Supersedes the older one-shot
// POST /operate/customers/import (no preview, no dedupe, always created a
// new party) — that route and its only caller (CustomerImportDrawer) are
// removed in the same change that adds this.
const CUSTOMER_IMPORT_FIELDS = ['name', 'email', 'phone', 'company', 'address', 'city', 'lifecycle'] as const;
type CustomerImportField = (typeof CUSTOMER_IMPORT_FIELDS)[number];

const CUSTOMER_IMPORT_ALIASES: Record<CustomerImportField, string[]> = {
  name: ['name', 'customername', 'fullname', 'contactname', 'client'],
  email: ['email', 'emailaddress', 'customeremail'],
  phone: ['phone', 'phonenumber', 'mobile', 'cell', 'telephone'],
  company: ['company', 'companyname', 'business', 'businessname'],
  address: ['address', 'addressline1', 'street', 'streetaddress'],
  city: ['city'],
  lifecycle: ['lifecycle', 'stage', 'customerstatus'],
};

type CustomerImportMapping = Partial<Record<CustomerImportField, string>>;

const CUSTOMER_LIFECYCLES = ['new', 'working', 'qualified', 'customer', 'lost', 'dormant'] as const;

interface CustomerImportRow {
  line: number;
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  address: string | null;
  city: string | null;
  lifecycle: (typeof CUSTOMER_LIFECYCLES)[number];
  key: string;
}

interface CustomerImportRejection {
  line: number;
  label: string;
  reason: string;
}

function shapeCustomerImportRow(
  record: Record<string, string>, line: number, mapping: CustomerImportMapping,
): { row: CustomerImportRow } | { rejection: CustomerImportRejection } {
  const get = (f: CustomerImportField): string | undefined => {
    const h = mapping[f];
    return h ? record[h]?.trim() : undefined;
  };

  const name = get('name') || null;
  const email = get('email')?.toLowerCase() || null;
  if (!name && !email) {
    return { rejection: { line, label: '(unknown)', reason: 'No name or email' } };
  }
  const lifecycleRaw = (get('lifecycle') || '').toLowerCase().trim();
  const lifecycle = (CUSTOMER_LIFECYCLES as readonly string[]).includes(lifecycleRaw)
    ? (lifecycleRaw as CustomerImportRow['lifecycle'])
    : 'customer';

  return {
    row: {
      line, name, email,
      phone: get('phone') || null,
      company: get('company') || null,
      address: get('address') || null,
      city: get('city') || null,
      lifecycle,
      key: email ?? name!.toLowerCase(),
    },
  };
}

function splitCustomerImportRows(
  records: Array<{ record: Record<string, string>; line: number }>,
  mapping: CustomerImportMapping,
): { accepted: CustomerImportRow[]; rejections: CustomerImportRejection[] } {
  return splitImportRows(records, (record, line) => shapeCustomerImportRow(record, line, mapping));
}

// ---- Import existing (open) jobs (onboarding/migration) --------------------
// Same shared framework as customers/invoices above. Jobs have no natural
// unique key the way an invoice_number or a customer's email does — two
// rows CAN legitimately describe the same customer's same-titled job twice
// (a recurring "Monthly cleaning"). Re-import dedupes on a best-effort
// signature instead: this customer + this exact title + this exact
// scheduled date (or all three with no date, if none was given) — good
// enough to make re-running the same file a no-op, honestly short of a
// real identifier.
const JOB_IMPORT_FIELDS = ['title', 'customer_name', 'customer_email', 'status', 'scheduled_date', 'notes'] as const;
type JobImportField = (typeof JOB_IMPORT_FIELDS)[number];

const JOB_IMPORT_ALIASES: Record<JobImportField, string[]> = {
  title: ['title', 'job', 'jobtitle', 'service', 'description'],
  customer_name: ['customername', 'customer', 'name', 'client', 'clientname'],
  customer_email: ['customeremail', 'email', 'clientemail'],
  status: ['status', 'jobstatus'],
  scheduled_date: ['scheduleddate', 'scheduled', 'date', 'jobdate'],
  notes: ['notes', 'description', 'details', 'memo'],
};

type JobImportMapping = Partial<Record<JobImportField, string>>;

interface JobImportRow {
  line: number;
  title: string;
  customerName: string | null;
  customerEmail: string | null;
  customerKey: string;
  status: (typeof WORK_ORDER_STATUSES)[number];
  scheduledDate: string | null;
  notes: string | null;
  signature: string;
}

interface JobImportRejection {
  line: number;
  label: string;
  reason: string;
}

function shapeJobImportRow(
  record: Record<string, string>, line: number, mapping: JobImportMapping,
): { row: JobImportRow } | { rejection: JobImportRejection } {
  const get = (f: JobImportField): string | undefined => {
    const h = mapping[f];
    return h ? record[h]?.trim() : undefined;
  };

  const title = get('title') || null;
  if (!title) {
    return { rejection: { line, label: '(unknown)', reason: 'Missing title' } };
  }
  const customerName = get('customer_name') || null;
  const customerEmail = get('customer_email')?.toLowerCase() || null;
  if (!customerName && !customerEmail) {
    return { rejection: { line, label: title, reason: 'No customer name or email' } };
  }

  const statusRaw = (get('status') || '').toLowerCase().replace(/\s+/g, '_');
  const status = (WORK_ORDER_STATUSES as readonly string[]).includes(statusRaw)
    ? (statusRaw as JobImportRow['status'])
    : 'scheduled';
  const scheduledDate = parseDateOnly(get('scheduled_date'));
  const customerKey = customerEmail ?? customerName!.toLowerCase();

  return {
    row: {
      line, title, customerName, customerEmail, customerKey, status,
      scheduledDate, notes: get('notes') || null,
      signature: `${customerKey}|${title.toLowerCase()}|${scheduledDate ?? ''}`,
    },
  };
}

function splitJobImportRows(
  records: Array<{ record: Record<string, string>; line: number }>,
  mapping: JobImportMapping,
): { accepted: JobImportRow[]; rejections: JobImportRejection[] } {
  return splitImportRows(records, (record, line) => shapeJobImportRow(record, line, mapping));
}

// ---- Import existing invoices (onboarding/migration) -----------------------
// Mirrors Grow's contact-import SHAPE (inspect -> preview -> commit,
// alias-based column matching, lenient optional fields) without its saved-
// mapping-profile machinery (grow_import_profiles) — this is a one-time
// historical migration, not a recurring import, same reasoning
// POST /operate/customers/import's own header comment already gives for why
// it stays simpler than Grow's pipeline.
const INVOICE_IMPORT_FIELDS = [
  'customer_name', 'customer_email', 'invoice_number', 'issue_date', 'due_date',
  'description', 'total', 'amount_paid', 'paid_date', 'status',
] as const;
type InvoiceImportField = (typeof INVOICE_IMPORT_FIELDS)[number];

const INVOICE_IMPORT_ALIASES: Record<InvoiceImportField, string[]> = {
  customer_name: ['customername', 'customer', 'name', 'client', 'clientname'],
  customer_email: ['customeremail', 'email', 'clientemail'],
  invoice_number: ['invoicenumber', 'invoiceno', 'number', 'invoiceid', 'invoice'],
  issue_date: ['issuedate', 'invoicedate', 'date', 'issued'],
  due_date: ['duedate', 'due'],
  description: ['description', 'lineitem', 'lineitems', 'items', 'service', 'memo'],
  total: ['total', 'amount', 'invoicetotal', 'amountdue', 'grandtotal'],
  amount_paid: ['amountpaid', 'paid', 'paidamount'],
  paid_date: ['paiddate', 'paymentdate', 'datepaid'],
  status: ['status', 'invoicestatus'],
};

type InvoiceImportMapping = Partial<Record<InvoiceImportField, string>>;

interface InvoiceImportRow {
  line: number;
  customerName: string | null;
  customerEmail: string | null;
  invoiceNumber: string | null;
  issuedOn: string;
  dueOn: string;
  description: string;
  total: number;
  amountPaid: number;
  paidDate: string | null;
  status: 'paid' | 'partial' | 'sent';
  customerKey: string;
}

interface InvoiceImportRejection {
  line: number;
  customer: string;
  reason: string;
}

function shapeInvoiceImportRow(
  record: Record<string, string>,
  line: number,
  mapping: InvoiceImportMapping,
): { row: InvoiceImportRow } | { rejection: InvoiceImportRejection } {
  const get = (f: InvoiceImportField): string | undefined => {
    const h = mapping[f];
    return h ? record[h]?.trim() : undefined;
  };

  const customerName = get('customer_name') || null;
  const customerEmail = get('customer_email')?.toLowerCase() || null;
  if (!customerName && !customerEmail) {
    return { rejection: { line, customer: '(unknown)', reason: 'No customer name or email' } };
  }
  const total = parseMoney(get('total'));
  if (total === null || total < 0) {
    return {
      rejection: { line, customer: customerName ?? customerEmail!, reason: 'Missing or invalid total' },
    };
  }

  const explicitStatus = (get('status') || '').toLowerCase().trim();
  const amountPaidRaw = get('amount_paid');
  // Numbers win over labels when both are given; the label only fills a gap
  // when amount_paid itself is missing — a common shape for a historical
  // export that says "Status: Paid" with no separate paid-amount column.
  // A mapped column with a genuinely blank cell comes back as '' from the
  // CSV parser, not undefined — both count as "not given" here, or the
  // gap-fill never actually fires for the one shape it exists for.
  const amountPaid = amountPaidRaw !== undefined && amountPaidRaw !== ''
    ? (parseMoney(amountPaidRaw) ?? 0)
    : (explicitStatus === 'paid' ? total : 0);

  const issuedOn = parseDateOnly(get('issue_date')) ?? new Date().toISOString().slice(0, 10);
  const dueOn = parseDateOnly(get('due_date'))
    ?? new Date(new Date(issuedOn).getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
  const paidDate = parseDateOnly(get('paid_date'));
  const invoiceNumber = get('invoice_number') || null;
  const description = get('description') || 'Imported invoice';

  const status: InvoiceImportRow['status'] =
    amountPaid >= total && total > 0 ? 'paid' : amountPaid > 0 ? 'partial' : 'sent';

  return {
    row: {
      line, customerName, customerEmail, invoiceNumber, issuedOn, dueOn, description,
      total, amountPaid, paidDate, status,
      customerKey: customerEmail ?? customerName!.toLowerCase(),
    },
  };
}

function splitInvoiceImportRows(
  records: Array<{ record: Record<string, string>; line: number }>,
  mapping: InvoiceImportMapping,
): { accepted: InvoiceImportRow[]; rejections: InvoiceImportRejection[] } {
  return splitImportRows(records, (record, line) => shapeInvoiceImportRow(record, line, mapping));
}

// Dedupes against both already-imported invoice numbers (existingNumbers,
// a DB lookup the caller already has) AND a duplicate invoice_number WITHIN
// this same file — the latter matters because two colliding INSERTs in one
// transaction would hit invoices' UNIQUE (org_id, number) constraint and
// roll back the ENTIRE commit, not just that one row. A numberless row
// never collides with anything here (it always gets a fresh generated
// number at insert time).
function dedupeImportedInvoices(
  accepted: InvoiceImportRow[], existingNumbers: Set<string>,
): { newRows: InvoiceImportRow[]; alreadyImported: number } {
  const seenInFile = new Set<string>();
  const newRows: InvoiceImportRow[] = [];
  let alreadyImported = 0;
  for (const r of accepted) {
    if (r.invoiceNumber && (existingNumbers.has(r.invoiceNumber) || seenInFile.has(r.invoiceNumber))) {
      alreadyImported++;
      continue;
    }
    if (r.invoiceNumber) seenInFile.add(r.invoiceNumber);
    newRows.push(r);
  }
  return { newRows, alreadyImported };
}

export default async function operateRoutes(app: FastifyInstance) {
  // A pre-payment org (never-paid prospect) is locked out entirely, reads
  // included — see plugins/context.ts's requireProvisioned. Every route
  // below is also Operate-scoped; this file's registration is the module
  // boundary for that separate, narrower concern. Reads pass through
  // moduleWriteGate untouched (it no-ops on GET/HEAD) — only POST/PATCH/
  // DELETE can be turned off by an entitlement toggle.
  app.addHook('preHandler', requireProvisioned);
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
        `SELECT id, number, title, status, scheduled_start AS scheduled_at, created_at
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

  // ---- Import existing customers (onboarding/migration) ------------------
  app.post('/operate/customers/import/inspect', async (req) => {
    req.requireRole('staff');
    const { buffer, filename } = await readImportUpload(req);
    const { headers, records, note } = ingestFile(buffer, filename);
    if (headers.length === 0) throw new HttpError(400, 'No columns found in this file', 'empty_file');

    return {
      headers,
      rowCount: records.length,
      sampleRows: records.slice(0, 5).map((r) => r.record),
      suggestedMapping: guessMapping(headers, CUSTOMER_IMPORT_ALIASES),
      note,
    };
  });

  app.post('/operate/customers/import/preview', async (req) => {
    req.requireRole('staff');
    const { buffer, filename, fields } = await readImportUpload(req);
    const { mapping } = importMappingField.parse(fields);
    const { records, note } = ingestFile(buffer, filename);
    const { accepted, rejections } = splitCustomerImportRows(records, mapping as CustomerImportMapping);

    return req.db(async (q) => {
      const uniqueKeys = [...new Set(accepted.map((r) => r.key))];
      const matched = await findExistingCustomers(q, accepted.map((r) => ({ name: r.name, email: r.email })));
      const customersLinked = uniqueKeys.filter((k) => matched.has(k)).length;
      const customersNew = uniqueKeys.length - customersLinked;

      return {
        totalRows: records.length,
        acceptedCount: accepted.length,
        rejectedCount: rejections.length,
        customersNew,
        customersLinked,
        rejections,
        note,
      };
    });
  });

  app.post('/operate/customers/import/commit', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const { buffer, filename, fields } = await readImportUpload(req);
    const { mapping } = importMappingField.parse(fields);
    const { records } = ingestFile(buffer, filename);
    const { accepted, rejections } = splitCustomerImportRows(records, mapping as CustomerImportMapping);

    return req.db(async (q) => {
      const uniqueByKey = new Map<string, CustomerImportRow>();
      for (const r of accepted) if (!uniqueByKey.has(r.key)) uniqueByKey.set(r.key, r);

      const matched = await findExistingCustomers(q, [...uniqueByKey.values()].map((r) => ({ name: r.name, email: r.email })));

      let created = 0;
      const linked = matched.size;
      for (const r of uniqueByKey.values()) {
        const existingId = matched.get(r.key);
        if (existingId) {
          // Fill blanks only — an import must never overwrite a real,
          // already-on-file detail with whatever a spreadsheet happened to say.
          await q.exec(
            `UPDATE parties SET
                company_name = COALESCE(company_name, $2),
                city = COALESCE(city, $3),
                address_line1 = COALESCE(address_line1, $4)
              WHERE id = $1`,
            [existingId, r.company, r.city, r.address],
          );
          if (r.email) {
            await q.exec(
              `INSERT INTO party_contacts (org_id, party_id, channel, value, is_primary)
               SELECT app.current_org(), $1, 'email', $2, true
                WHERE NOT EXISTS (SELECT 1 FROM party_contacts WHERE party_id = $1 AND channel = 'email')`,
              [existingId, r.email],
            );
          }
          if (r.phone) {
            await q.exec(
              `INSERT INTO party_contacts (org_id, party_id, channel, value, is_primary)
               SELECT app.current_org(), $1, 'phone', $2, true
                WHERE NOT EXISTS (SELECT 1 FROM party_contacts WHERE party_id = $1 AND channel = 'phone')`,
              [existingId, r.phone],
            );
          }
          continue;
        }

        const displayName = r.name ?? r.email!;
        const party = await q.one<{ id: string }>(
          `INSERT INTO parties (org_id, kind, display_name, company_name, city, address_line1,
                                 is_lead, is_customer, lifecycle)
           VALUES (app.current_org(), 'person', $1,$2,$3,$4, false, true, $5)
           RETURNING id`,
          [displayName, r.company, r.city, r.address, r.lifecycle],
        );
        if (r.email) {
          await q.exec(
            `INSERT INTO party_contacts (org_id, party_id, channel, value, is_primary)
             VALUES (app.current_org(), $1, 'email', $2, true)`,
            [party!.id, r.email],
          );
        }
        if (r.phone) {
          await q.exec(
            `INSERT INTO party_contacts (org_id, party_id, channel, value, is_primary)
             VALUES (app.current_org(), $1, 'phone', $2, true)`,
            [party!.id, r.phone],
          );
        }
        await logTimeline(q, {
          orgId: req.ctx.orgId, partyId: party!.id, module: 'operate', eventType: 'party.created',
          title: `Added ${displayName} (customer import)`, actorUserId: sess.user_id, actorLabel: sess.full_name,
        });
        created++;
      }

      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'operate.customers.import',
        entityType: 'parties', ip: req.ip,
        diff: { filename, created, linked, rejected: rejections.length },
      });

      return { created, linked, rejectedCount: rejections.length, rejections };
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

  // ---- Log a manual activity (note/call) on a party --------------------
  // Editing the party record already bumps last_activity_at (see PATCH
  // above) but was the only "activity" signal available — there was no way
  // for a human to just log "called, left voicemail" without changing any
  // field. Writes straight to timeline_events via the same logTimeline()
  // every other Operate action and the Grow bridge use, so it reads
  // identically in the Detail screen's timeline.
  const activityInput = z.object({
    kind: z.enum(['note', 'call', 'email', 'meeting']).default('note'),
    body: z.string().trim().min(1).max(4000),
  });

  app.post('/operate/parties/:id/activity', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = activityInput.parse(req.body);

    return req.db(async (db) => {
      const party = await db.one<{ id: string; display_name: string }>(
        `SELECT id, display_name FROM parties WHERE id = $1 AND deleted_at IS NULL`,
        [id],
      );
      if (!party) throw new HttpError(404, 'Customer not found', 'not_found');

      await db.exec(`UPDATE parties SET last_activity_at = now() WHERE id = $1`, [id]);
      await logTimeline(db, {
        orgId: req.ctx.orgId, partyId: id, module: 'operate', eventType: `activity.${body.kind}`,
        title: body.kind === 'note' ? 'Note added' : `Logged a ${body.kind}`,
        body: body.body, actorUserId: sess.user_id, actorLabel: sess.full_name,
      });
      return { ok: true };
    });
  });

  // ---- Jobs / work orders -----------------------------------------------
  // docs/OPERATE-SPEC.md's full shape includes work_order_lines, recurrence
  // generation, and assignee scheduling; docs/specs/operate-definition-of-
  // done.md scopes v1 down to "create, schedule, update status" — the part
  // that closes the lead -> job -> invoice path end to end. Lines/recurrence
  // stay out until a client actually needs them.
  const workOrderInput = z.object({
    party_id: z.string().uuid(),
    title: z.string().trim().min(1),
    description: z.string().trim().nullable().optional(),
    scheduled_start: z.string().datetime().nullable().optional(),
    scheduled_end: z.string().datetime().nullable().optional(),
    address_line1: z.string().trim().nullable().optional(),
    city: z.string().trim().nullable().optional(),
    region: z.string().trim().nullable().optional(),
    postal_code: z.string().trim().nullable().optional(),
  });

  app.get('/operate/jobs', async (req) => {
    req.requireRole('viewer');
    const { status, party } = z.object({
      status: z.enum(WORK_ORDER_STATUSES).optional(),
      party: z.string().uuid().optional(),
    }).parse(req.query);

    return req.db((q) =>
      q.rows(
        `SELECT wo.id, wo.number, wo.title, wo.description, wo.status,
                wo.scheduled_start, wo.scheduled_end, wo.started_at, wo.completed_at,
                wo.party_id, p.display_name AS party_name, wo.created_at
           FROM work_orders wo
           JOIN parties p ON p.id = wo.party_id
          WHERE ($1::text IS NULL OR wo.status = $1)
            AND ($2::uuid IS NULL OR wo.party_id = $2)
          ORDER BY wo.scheduled_start ASC NULLS LAST, wo.created_at DESC
          LIMIT 200`,
        [status ?? null, party ?? null],
      ),
    );
  });

  app.post('/operate/jobs', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const body = workOrderInput.parse(req.body);

    return req.db(async (q) => {
      const party = await q.one<{ id: string; display_name: string }>(
        `SELECT id, display_name FROM parties WHERE id = $1 AND deleted_at IS NULL`,
        [body.party_id],
      );
      if (!party) throw new HttpError(404, 'Customer not found', 'not_found');

      const job = await q.one<{ id: string }>(
        `INSERT INTO work_orders
           (org_id, party_id, title, description, scheduled_start, scheduled_end,
            address_line1, city, region, postal_code)
         VALUES (app.current_org(), $1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, number, title, description, status, scheduled_start,
                   scheduled_end, started_at, completed_at, party_id, created_at`,
        [
          body.party_id, body.title, body.description ?? null,
          body.scheduled_start ?? null, body.scheduled_end ?? null,
          body.address_line1 ?? null, body.city ?? null, body.region ?? null, body.postal_code ?? null,
        ],
      );
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'operate.job.create',
        entityType: 'work_orders', entityId: job!.id, ip: req.ip,
      });
      await logTimeline(q, {
        orgId: req.ctx.orgId, partyId: body.party_id, module: 'operate', eventType: 'job.created',
        title: `Job scheduled: ${body.title}`, actorUserId: sess.user_id, actorLabel: sess.full_name,
        entityType: 'work_orders', entityId: job!.id,
      });
      return job;
    });
  });

  app.patch('/operate/jobs/:id', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = workOrderInput.partial().omit({ party_id: true }).parse(req.body);

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

    return req.db(async (q) => {
      const job = await q.one<{ id: string; party_id: string; title: string }>(
        `UPDATE work_orders SET ${fields.join(', ')}, updated_at = now()
          WHERE id = $${i}
        RETURNING id, number, title, description, status, scheduled_start,
                  scheduled_end, started_at, completed_at, party_id, created_at`,
        values,
      );
      if (!job) throw new HttpError(404, 'Job not found', 'not_found');
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'operate.job.update',
        entityType: 'work_orders', entityId: id, ip: req.ip, diff: body,
      });
      return job;
    });
  });

  app.post('/operate/jobs/:id/status', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { status } = z.object({ status: z.enum(WORK_ORDER_STATUSES) }).parse(req.body);

    return req.db(async (q) => {
      const job = await q.one<{ id: string; party_id: string; title: string }>(
        `UPDATE work_orders SET status = $1, updated_at = now(),
                started_at = CASE WHEN $1 = 'in_progress' AND started_at IS NULL THEN now() ELSE started_at END,
                completed_at = CASE WHEN $1 = 'complete' THEN now() ELSE completed_at END
          WHERE id = $2
        RETURNING id, number, title, description, status, scheduled_start,
                  scheduled_end, started_at, completed_at, party_id, created_at`,
        [status, id],
      );
      if (!job) throw new HttpError(404, 'Job not found', 'not_found');
      await logTimeline(q, {
        orgId: req.ctx.orgId, partyId: job.party_id, module: 'operate', eventType: 'job.status_changed',
        title: `${job.title}: ${status.replace(/_/g, ' ')}`, actorUserId: sess.user_id, actorLabel: sess.full_name,
        entityType: 'work_orders', entityId: id,
      });
      return job;
    });
  });

  // ---- Import existing (open) jobs (onboarding/migration) ---------------
  app.post('/operate/jobs/import/inspect', async (req) => {
    req.requireRole('staff');
    const { buffer, filename } = await readImportUpload(req);
    const { headers, records, note } = ingestFile(buffer, filename);
    if (headers.length === 0) throw new HttpError(400, 'No columns found in this file', 'empty_file');

    return {
      headers,
      rowCount: records.length,
      sampleRows: records.slice(0, 5).map((r) => r.record),
      suggestedMapping: guessMapping(headers, JOB_IMPORT_ALIASES),
      note,
    };
  });

  // Signature-based job dedupe needs a RESOLVED party id (two rows naming
  // the same customer by name vs by email must collapse to the same check),
  // but preview must not create anyone — so a row whose customer doesn't
  // exist yet is trivially never "already imported" (there's no party yet
  // to have a job against), and only rows matching an EXISTING customer are
  // checked against that customer's real existing jobs.
  async function findAlreadyImportedJobSignatures(
    q: Querier, rows: JobImportRow[],
  ): Promise<Set<string>> {
    const existingParties = await findExistingCustomers(q, rows.map((r) => ({ name: r.customerName, email: r.customerEmail })));
    const partyIds = [...new Set(rows.filter((r) => existingParties.has(r.customerKey)).map((r) => existingParties.get(r.customerKey)!))];
    if (partyIds.length === 0) return new Set();

    const existingJobs = await q.rows<{ party_id: string; title: string; sched: string | null }>(
      `SELECT party_id, lower(title) AS title, scheduled_start::date::text AS sched
         FROM work_orders WHERE party_id = ANY($1::uuid[])`,
      [partyIds],
    );
    const existingSigs = new Set(existingJobs.map((j) => `${j.party_id}|${j.title}|${j.sched ?? ''}`));

    const matched = new Set<string>();
    for (const r of rows) {
      const partyId = existingParties.get(r.customerKey);
      if (!partyId) continue;
      const sig = `${partyId}|${r.title.toLowerCase()}|${r.scheduledDate ?? ''}`;
      if (existingSigs.has(sig)) matched.add(`${r.line}`);
    }
    return matched;
  }

  app.post('/operate/jobs/import/preview', async (req) => {
    req.requireRole('staff');
    const { buffer, filename, fields } = await readImportUpload(req);
    const { mapping } = importMappingField.parse(fields);
    const { records, note } = ingestFile(buffer, filename);
    const { accepted, rejections } = splitJobImportRows(records, mapping as JobImportMapping);

    return req.db(async (q) => {
      const alreadyImportedLines = await findAlreadyImportedJobSignatures(q, accepted);
      const newRows = accepted.filter((r) => !alreadyImportedLines.has(`${r.line}`));

      const uniqueKeys = [...new Set(newRows.map((r) => r.customerKey))];
      const matched = await findExistingCustomers(q, newRows.map((r) => ({ name: r.customerName, email: r.customerEmail })));
      const customersLinked = uniqueKeys.filter((k) => matched.has(k)).length;
      const customersNew = uniqueKeys.length - customersLinked;

      return {
        totalRows: records.length,
        acceptedCount: newRows.length,
        rejectedCount: rejections.length,
        alreadyImported: alreadyImportedLines.size,
        customersNew,
        customersLinked,
        rejections,
        note,
      };
    });
  });

  app.post('/operate/jobs/import/commit', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const { buffer, filename, fields } = await readImportUpload(req);
    const { mapping } = importMappingField.parse(fields);
    const { records } = ingestFile(buffer, filename);
    const { accepted, rejections } = splitJobImportRows(records, mapping as JobImportMapping);

    return req.db(async (q) => {
      const alreadyImportedLines = await findAlreadyImportedJobSignatures(q, accepted);
      const newRows = accepted.filter((r) => !alreadyImportedLines.has(`${r.line}`));

      const { keyToPartyId, created: partiesCreated, linked: partiesLinked } = await resolveOrCreateCustomers(
        q, newRows.map((r) => ({ name: r.customerName, email: r.customerEmail })),
        { orgId: req.ctx.orgId, actorUserId: sess.user_id, actorLabel: sess.full_name, sourceLabel: 'job import' },
      );

      // A second, in-file dedupe pass: two new rows for the SAME brand-new
      // customer with the same title+date would otherwise both insert,
      // since neither matched anything in the database above.
      const seenSignatures = new Set<string>();
      let created = 0;
      let skippedInFile = 0;
      for (const r of newRows) {
        const partyId = keyToPartyId.get(r.customerKey)!;
        const sig = `${partyId}|${r.title.toLowerCase()}|${r.scheduledDate ?? ''}`;
        if (seenSignatures.has(sig)) { skippedInFile++; continue; }
        seenSignatures.add(sig);

        const job = await q.one<{ id: string }>(
          `INSERT INTO work_orders (org_id, party_id, title, description, scheduled_start, status)
           VALUES (app.current_org(), $1,$2,$3,$4,$5)
           RETURNING id`,
          [partyId, r.title, r.notes, r.scheduledDate, r.status],
        );
        await logTimeline(q, {
          orgId: req.ctx.orgId, partyId, module: 'operate', eventType: 'job.created',
          title: `Job imported: ${r.title}`, actorUserId: sess.user_id, actorLabel: sess.full_name,
          entityType: 'work_orders', entityId: job!.id,
        });
        created++;
      }

      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'operate.jobs.import',
        entityType: 'work_orders', ip: req.ip,
        diff: { filename, created, partiesCreated, partiesLinked, alreadyImported: alreadyImportedLines.size + skippedInFile, rejected: rejections.length },
      });

      return {
        created, partiesCreated, partiesLinked,
        alreadyImported: alreadyImportedLines.size + skippedInFile,
        rejectedCount: rejections.length, rejections,
      };
    });
  });

  // ---- Invoices and payments ---------------------------------------------
  // v1 scope per docs/specs/operate-definition-of-done.md: create, send,
  // mark paid / record a payment, overdue tracking. No tax engine exists
  // anywhere in this codebase yet, so tax is always 0 — honest, not
  // fabricated, until a real rate is configurable. No void/edit-after-send
  // in v1 (not named in the DoD's flow); draft invoices can still be edited
  // via a future PATCH if a client needs it, not built until asked.
  // Gap-free per-org numbering without a sequence table: an advisory lock
  // scoped to the caller's transaction (auto-released on COMMIT/ROLLBACK)
  // serializes concurrent invoice creates for the same org, per
  // docs/OPERATE-SPEC.md's "allocate inside the insert transaction — SELECT
  // max(...) + 1 outside a transaction races." Shared by the live create
  // route and the bulk import commit below — one numbering rule, not two.
  async function nextInvoiceNumber(q: Querier): Promise<string> {
    await q.exec(`SELECT pg_advisory_xact_lock(hashtext(app.current_org() || ':invoice_number'))`);
    const row = await q.one<{ next: number }>(
      `SELECT COALESCE(max(substring(number from 5)::int), 0) + 1 AS next
         FROM invoices WHERE number LIKE 'INV-%'`,
    );
    return `INV-${String(row!.next).padStart(4, '0')}`;
  }

  const invoiceLineInput = z.object({
    description: z.string().trim().min(1),
    quantity: z.number().positive().default(1),
    unit_price: z.number().min(0),
    taxable: z.boolean().default(true),
  });
  const invoiceInput = z.object({
    party_id: z.string().uuid(),
    work_order_id: z.string().uuid().nullable().optional(),
    due_on: z.string().date().nullable().optional(),
    lines: z.array(invoiceLineInput).min(1),
  });
  const paymentInput = z.object({
    amount: z.number().positive(),
    method: z.enum(['card', 'ach', 'cash', 'check']).nullable().optional(),
  });

  app.get('/operate/invoices', async (req) => {
    req.requireRole('viewer');
    const { status, party, overdue } = z.object({
      status: z.enum(['draft', 'sent', 'partial', 'paid', 'void']).optional(),
      party: z.string().uuid().optional(),
      overdue: z.coerce.boolean().optional(),
    }).parse(req.query);

    return req.db((q) =>
      q.rows(
        `SELECT i.id, i.number, i.status, i.subtotal::text, i.tax::text, i.total::text,
                i.amount_paid::text, (i.total - i.amount_paid)::text AS balance,
                i.issued_on, i.due_on, i.paid_at, i.party_id, p.display_name AS party_name,
                (i.due_on IS NOT NULL AND i.due_on < current_date AND i.status IN ('sent','partial'))
                  AS is_overdue,
                i.created_at
           FROM invoices i
           JOIN parties p ON p.id = i.party_id
          WHERE ($1::text IS NULL OR i.status = $1)
            AND ($2::uuid IS NULL OR i.party_id = $2)
            AND ($3::boolean IS NULL OR
                 (i.due_on IS NOT NULL AND i.due_on < current_date AND i.status IN ('sent','partial')) = $3)
          ORDER BY i.created_at DESC
          LIMIT 200`,
        [status ?? null, party ?? null, overdue ?? null],
      ),
    );
  });

  app.get('/operate/invoices/:id', async (req) => {
    req.requireRole('viewer');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    return req.db(async (q) => {
      const invoice = await q.one(
        `SELECT i.id, i.number, i.status, i.subtotal::text, i.tax::text, i.total::text,
                i.amount_paid::text, (i.total - i.amount_paid)::text AS balance,
                i.issued_on, i.due_on, i.paid_at, i.party_id, p.display_name AS party_name,
                i.created_at
           FROM invoices i JOIN parties p ON p.id = i.party_id
          WHERE i.id = $1`,
        [id],
      );
      if (!invoice) throw new HttpError(404, 'Invoice not found', 'not_found');
      const lines = await q.rows(
        `SELECT id, description, quantity::text, unit_price::text, taxable, position
           FROM invoice_lines WHERE invoice_id = $1 ORDER BY position`,
        [id],
      );
      const payments = await q.rows(
        `SELECT id, amount::text, method, received_at FROM payments
          WHERE invoice_id = $1 ORDER BY received_at DESC`,
        [id],
      );
      return { ...invoice, lines, payments };
    });
  });

  app.post('/operate/invoices', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const body = invoiceInput.parse(req.body);

    return req.db(async (q) => {
      const party = await q.one<{ id: string; display_name: string }>(
        `SELECT id, display_name FROM parties WHERE id = $1 AND deleted_at IS NULL`,
        [body.party_id],
      );
      if (!party) throw new HttpError(404, 'Customer not found', 'not_found');

      const number = await nextInvoiceNumber(q);
      const subtotal = body.lines.reduce((sum, l) => sum + l.quantity * l.unit_price, 0);
      const invoice = await q.one<{ id: string }>(
        `INSERT INTO invoices (org_id, party_id, work_order_id, number, status, subtotal, tax, total, due_on)
         VALUES (app.current_org(), $1,$2,$3,'draft',$4,0,$4,$5)
         RETURNING id, number, status, subtotal::text, tax::text, total::text,
                   amount_paid::text, issued_on, due_on, party_id, created_at`,
        [
          body.party_id, body.work_order_id ?? null, number, subtotal.toFixed(2),
          body.due_on ?? null,
        ],
      );
      let position = 0;
      for (const line of body.lines) {
        await q.exec(
          `INSERT INTO invoice_lines (org_id, invoice_id, description, quantity, unit_price, taxable, position)
           VALUES (app.current_org(), $1,$2,$3,$4,$5,$6)`,
          [invoice!.id, line.description, line.quantity, line.unit_price, line.taxable, position++],
        );
      }
      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'operate.invoice.create',
        entityType: 'invoices', entityId: invoice!.id, ip: req.ip,
      });
      await logTimeline(q, {
        orgId: req.ctx.orgId, partyId: body.party_id, module: 'operate', eventType: 'invoice.created',
        title: `Invoice ${number} created`, actorUserId: sess.user_id, actorLabel: sess.full_name,
        entityType: 'invoices', entityId: invoice!.id,
      });
      return invoice;
    });
  });

  app.post('/operate/invoices/:id/send', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    return req.db(async (q) => {
      const invoice = await q.one<{ id: string; party_id: string; number: string; status: string }>(
        `SELECT id, party_id, number, status FROM invoices WHERE id = $1`,
        [id],
      );
      if (!invoice) throw new HttpError(404, 'Invoice not found', 'not_found');
      if (invoice.status !== 'draft') {
        throw new HttpError(400, 'Only a draft invoice can be sent', 'invalid_state');
      }
      const updated = await q.one(
        `UPDATE invoices SET status = 'sent', issued_on = COALESCE(issued_on, current_date),
                due_on = COALESCE(due_on, current_date + interval '30 days')
          WHERE id = $1
        RETURNING id, number, status, subtotal::text, tax::text, total::text,
                  amount_paid::text, issued_on, due_on, party_id, created_at`,
        [id],
      );
      await logTimeline(q, {
        orgId: req.ctx.orgId, partyId: invoice.party_id, module: 'operate', eventType: 'invoice.sent',
        title: `Invoice ${invoice.number} sent`, actorUserId: sess.user_id, actorLabel: sess.full_name,
        entityType: 'invoices', entityId: id,
      });
      return updated;
    });
  });

  app.post('/operate/invoices/:id/payments', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = paymentInput.parse(req.body);

    return req.db(async (q) => {
      const invoice = await q.one<{
        id: string; party_id: string; number: string; status: string; total: string; amount_paid: string;
      }>(
        `SELECT id, party_id, number, status, total::text, amount_paid::text FROM invoices WHERE id = $1`,
        [id],
      );
      if (!invoice) throw new HttpError(404, 'Invoice not found', 'not_found');
      if (invoice.status === 'draft') {
        throw new HttpError(400, 'Send the invoice before recording a payment against it', 'invalid_state');
      }
      if (invoice.status === 'paid' || invoice.status === 'void') {
        throw new HttpError(400, 'This invoice is already settled', 'invalid_state');
      }

      await q.exec(
        `INSERT INTO payments (org_id, invoice_id, party_id, amount, method, status)
         VALUES (app.current_org(), $1,$2,$3,$4,'succeeded')`,
        [id, invoice.party_id, body.amount.toFixed(2), body.method ?? null],
      );
      const updated = await q.one(
        `UPDATE invoices SET
                amount_paid = amount_paid + $2,
                status = CASE WHEN amount_paid + $2 >= total THEN 'paid' ELSE 'partial' END,
                paid_at = CASE WHEN amount_paid + $2 >= total THEN now() ELSE paid_at END
          WHERE id = $1
        RETURNING id, number, status, subtotal::text, tax::text, total::text,
                  amount_paid::text, issued_on, due_on, paid_at, party_id, created_at`,
        [id, body.amount.toFixed(2)],
      );
      await logTimeline(q, {
        orgId: req.ctx.orgId, partyId: invoice.party_id, module: 'operate', eventType: 'payment.recorded',
        title: `Payment of $${body.amount.toFixed(2)} on invoice ${invoice.number}`,
        actorUserId: sess.user_id, actorLabel: sess.full_name,
        entityType: 'invoices', entityId: id,
      });
      return updated;
    });
  });

  // ---- Import existing invoices (onboarding/migration) ------------------
  app.post('/operate/invoices/import/inspect', async (req) => {
    req.requireRole('staff');
    const { buffer, filename } = await readImportUpload(req);
    const { headers, records, note } = ingestFile(buffer, filename);
    if (headers.length === 0) throw new HttpError(400, 'No columns found in this file', 'empty_file');

    return {
      headers,
      rowCount: records.length,
      sampleRows: records.slice(0, 5).map((r) => r.record),
      suggestedMapping: guessMapping(headers, INVOICE_IMPORT_ALIASES),
      note,
    };
  });

  const importMappingField = z.object({
    mapping: z.string().transform((s, ctx) => {
      try { return JSON.parse(s) as InvoiceImportMapping; } catch {
        ctx.addIssue({ code: 'custom', message: 'mapping must be valid JSON' });
        return {} as InvoiceImportMapping;
      }
    }),
  });

  app.post('/operate/invoices/import/preview', async (req) => {
    req.requireRole('staff');
    const { buffer, filename, fields } = await readImportUpload(req);
    const { mapping } = importMappingField.parse(fields);
    const { records, note } = ingestFile(buffer, filename);
    const { accepted, rejections } = splitInvoiceImportRows(records, mapping);

    return req.db(async (q) => {
      const numbers = accepted.map((r) => r.invoiceNumber).filter((n): n is string => !!n);
      const existingNumbers = numbers.length === 0 ? new Set<string>() : new Set(
        (await q.rows<{ number: string }>(`SELECT number FROM invoices WHERE number = ANY($1::text[])`, [numbers]))
          .map((r) => r.number),
      );
      const { newRows, alreadyImported } = dedupeImportedInvoices(accepted, existingNumbers);

      const uniqueKeys = [...new Set(newRows.map((r) => r.customerKey))];
      const refs = newRows.map((r) => ({ name: r.customerName, email: r.customerEmail }));
      const matched = await findExistingCustomers(q, refs);
      const customersLinked = uniqueKeys.filter((k) => matched.has(k)).length;
      const customersNew = uniqueKeys.length - customersLinked;

      const totalAmount = newRows.reduce((sum, r) => sum + r.total, 0);
      const outstandingAmount = newRows.reduce((sum, r) => sum + (r.status === 'paid' ? 0 : r.total - r.amountPaid), 0);

      return {
        totalRows: records.length,
        acceptedCount: newRows.length,
        rejectedCount: rejections.length,
        alreadyImported,
        customersNew,
        customersLinked,
        totalAmount: totalAmount.toFixed(2),
        outstandingAmount: outstandingAmount.toFixed(2),
        rejections,
        note,
      };
    });
  });

  app.post('/operate/invoices/import/commit', async (req) => {
    req.requireRole('staff');
    const sess = req.requireAuth();
    const { buffer, filename, fields } = await readImportUpload(req);
    const { mapping } = importMappingField.parse(fields);
    const { records } = ingestFile(buffer, filename);
    const { accepted, rejections } = splitInvoiceImportRows(records, mapping);

    return req.db(async (q) => {
      const numbers = accepted.map((r) => r.invoiceNumber).filter((n): n is string => !!n);
      const existingNumbers = numbers.length === 0 ? new Set<string>() : new Set(
        (await q.rows<{ number: string }>(`SELECT number FROM invoices WHERE number = ANY($1::text[])`, [numbers]))
          .map((r) => r.number),
      );
      const { newRows, alreadyImported } = dedupeImportedInvoices(accepted, existingNumbers);

      // Resolve every row's customer BEFORE creating any invoice — two rows
      // for the same customer (by email, else by name) must land on the
      // same party, not create one each. Shared with the jobs importer —
      // see lib/operateImport.ts.
      const { keyToPartyId, created: partiesCreated, linked: partiesLinked } = await resolveOrCreateCustomers(
        q, newRows.map((r) => ({ name: r.customerName, email: r.customerEmail })),
        { orgId: req.ctx.orgId, actorUserId: sess.user_id, actorLabel: sess.full_name, sourceLabel: 'invoice import' },
      );

      let created = 0;
      let paymentsRecorded = 0;
      for (const r of newRows) {
        const partyId = keyToPartyId.get(r.customerKey)!;
        const number = r.invoiceNumber ?? await nextInvoiceNumber(q);
        const invoice = await q.one<{ id: string }>(
          `INSERT INTO invoices (org_id, party_id, number, status, subtotal, tax, total, amount_paid,
                                  issued_on, due_on, paid_at)
           VALUES (app.current_org(), $1,$2,$3,$4,0,$4,$5,$6,$7,$8)
           RETURNING id`,
          [
            partyId, number, r.status, r.total.toFixed(2), r.amountPaid.toFixed(2),
            r.issuedOn, r.dueOn, r.status === 'paid' ? (r.paidDate ?? r.issuedOn) : null,
          ],
        );
        await q.exec(
          `INSERT INTO invoice_lines (org_id, invoice_id, description, quantity, unit_price, position)
           VALUES (app.current_org(), $1,$2,1,$3,0)`,
          [invoice!.id, r.description, r.total.toFixed(2)],
        );
        if (r.amountPaid > 0) {
          await q.exec(
            `INSERT INTO payments (org_id, invoice_id, party_id, amount, received_at, status)
             VALUES (app.current_org(), $1,$2,$3,$4,'succeeded')`,
            [invoice!.id, partyId, r.amountPaid.toFixed(2), r.paidDate ?? r.issuedOn],
          );
          paymentsRecorded++;
        }
        await logTimeline(q, {
          orgId: req.ctx.orgId, partyId, module: 'operate', eventType: 'invoice.created',
          title: `Invoice ${number} imported`, actorUserId: sess.user_id, actorLabel: sess.full_name,
          entityType: 'invoices', entityId: invoice!.id,
        });
        created++;
      }

      await audit(q, {
        orgId: req.ctx.orgId, actorUser: sess.user_id, action: 'operate.invoices.import',
        entityType: 'invoices', ip: req.ip,
        diff: { filename, created, partiesCreated, partiesLinked, paymentsRecorded, alreadyImported, rejected: rejections.length },
      });

      const totalAmount = newRows.reduce((sum, r) => sum + r.total, 0);
      const outstandingAmount = newRows.reduce((sum, r) => sum + (r.status === 'paid' ? 0 : r.total - r.amountPaid), 0);

      return {
        created, partiesCreated, partiesLinked, paymentsRecorded, alreadyImported,
        rejectedCount: rejections.length, rejections,
        totalAmount: totalAmount.toFixed(2), outstandingAmount: outstandingAmount.toFixed(2),
      };
    });
  });

  // ---- Accounting export (v1 = CSV export, not a live sync) -------------
  // One row per invoice line, header names matching the field names
  // QuickBooks Online's own bulk invoice-import template uses, so a
  // bookkeeper can open this straight into that importer. Full API sync
  // (QuickBooks/Xero) is explicitly "coming soon" per the DoD — this is the
  // v1 substitute, not a placeholder for it.
  // Explicit String() first: a caller passing a Date straight through
  // (forgetting ::text in its SQL) must not silently reach .join(',') below
  // and come out as Date.prototype.toString()'s "Thu Oct 22 2026 00:00:00
  // GMT+0000 (...)" — coerce once, here, so every cell is a real string
  // before the quote-escaping check runs.
  function csvCell(value: unknown): string {
    const str = String(value);
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  }

  app.get('/operate/invoices/export.csv', async (req, reply) => {
    req.requireRole('viewer');
    const rows = await req.db((q) =>
      q.rows<{
        number: string; party_name: string; issued_on: string | null; due_on: string | null;
        description: string; quantity: string; unit_price: string;
      }>(
        `SELECT i.number, p.display_name AS party_name, i.issued_on::text, i.due_on::text,
                il.description, il.quantity::text, il.unit_price::text
           FROM invoices i
           JOIN parties p ON p.id = i.party_id
           JOIN invoice_lines il ON il.invoice_id = i.id
          WHERE i.status != 'draft'
          ORDER BY i.number, il.position`,
      ),
    );
    const header = 'InvoiceNo,Customer,InvoiceDate,DueDate,ItemDescription,ItemQuantity,ItemRate,ItemAmount';
    const lines = rows.map((r) => [
      r.number, r.party_name, r.issued_on ?? '', r.due_on ?? '',
      r.description, r.quantity, r.unit_price, (Number(r.quantity) * Number(r.unit_price)).toFixed(2),
    ].map(csvCell).join(','));
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="invoices.csv"')
      .send([header, ...lines].join('\n'));
  });

  app.get('/operate/payments/export.csv', async (req, reply) => {
    req.requireRole('viewer');
    const rows = await req.db((q) =>
      q.rows<{ number: string | null; party_name: string; received_at: string; amount: string; method: string | null }>(
        `SELECT i.number, p.display_name AS party_name,
                to_char(pay.received_at, 'YYYY-MM-DD') AS received_at, pay.amount::text, pay.method
           FROM payments pay
           JOIN parties p ON p.id = pay.party_id
      LEFT JOIN invoices i ON i.id = pay.invoice_id
          ORDER BY pay.received_at DESC`,
      ),
    );
    const header = 'InvoiceNo,Customer,PaymentDate,Amount,PaymentMethod';
    const lines = rows.map((r) => [
      r.number ?? '', r.party_name, r.received_at, r.amount, r.method ?? '',
    ].map(csvCell).join(','));
    reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', 'attachment; filename="payments.csv"')
      .send([header, ...lines].join('\n'));
  });
}
