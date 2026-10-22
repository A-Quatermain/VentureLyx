/**
 * Venturelyx :: shared framework for Operate's "import your existing data"
 * flow (customers, invoices, jobs — one shared shape, not three copies).
 *
 * Each entity importer still writes its OWN field list, aliases, and
 * row-shaping/validation (what's required differs per entity) — this file
 * holds only the genuinely generic parts: reading the uploaded file,
 * guessing a column mapping from header aliases, tolerant value parsing,
 * and resolving/creating the customer a row references, since invoices and
 * jobs both need to "link to the customer, create it if missing" in
 * exactly the same way.
 */
import type { FastifyRequest } from 'fastify';
import { HttpError } from '../plugins/context.js';
import { logTimeline } from './timeline.js';
import type { Querier } from './db.js';

export async function readImportUpload(
  req: FastifyRequest,
): Promise<{ buffer: Buffer; filename: string; fields: Record<string, string> }> {
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
  return { buffer: file.buffer, filename: file.filename, fields };
}

/** Case/punctuation-insensitive header match against a per-field alias
 *  list — the same tolerance rule every importer in this app already
 *  uses (operate.ts's original customer importer, Grow's contact importer). */
export function guessMapping<F extends string>(
  headers: string[], aliases: Record<F, string[]>,
): Partial<Record<F, string>> {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const mapping: Partial<Record<F, string>> = {};
  for (const field of Object.keys(aliases) as F[]) {
    const match = headers.find((h) => aliases[field].includes(norm(h)));
    if (match) mapping[field] = match;
  }
  return mapping;
}

export function parseMoney(raw: string | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[$,\s]/g, '');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function parseDateOnly(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** The shape every importer's "preview"/"commit" route repeats: validate
 *  each parsed row, splitting it into something ready to write or a
 *  reason it can't be. Generic over the row/rejection shape since what's
 *  required differs per entity — only the loop itself is identical. */
export function splitImportRows<T, R>(
  records: Array<{ record: Record<string, string>; line: number }>,
  shape: (record: Record<string, string>, line: number) => { row: T } | { rejection: R },
): { accepted: T[]; rejections: R[] } {
  const accepted: T[] = [];
  const rejections: R[] = [];
  for (const { record, line } of records) {
    const shaped = shape(record, line);
    if ('row' in shaped) accepted.push(shaped.row);
    else rejections.push(shaped.rejection);
  }
  return { accepted, rejections };
}

export interface CustomerRef {
  name: string | null;
  email: string | null;
}

/** The natural key every importer dedupes a customer reference on: email
 *  when given (case-insensitive), else the trimmed display name. Every
 *  caller that resolves customers from CSV rows uses this same key, or
 *  two rows meaning the same person could resolve to two different
 *  parties depending which importer touched them first. */
export function customerKey(ref: CustomerRef): string {
  return (ref.email ?? ref.name!).toLowerCase();
}

/** Bulk lookup only — never creates. Matches by email (party_contacts,
 *  channel='email') first, then by exact display_name, for whichever refs
 *  don't already have an email match. Returns key -> partyId for every
 *  match found; a ref with no match simply has no entry. */
export async function findExistingCustomers(
  q: Querier, refs: CustomerRef[],
): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const emailRefs = refs.filter((r) => r.email);
  if (emailRefs.length > 0) {
    const rows = await q.rows<{ id: string; email: string }>(
      `SELECT p.id, lower(pc.value) AS email FROM party_contacts pc
         JOIN parties p ON p.id = pc.party_id
        WHERE pc.channel = 'email' AND lower(pc.value) = ANY($1::text[]) AND p.deleted_at IS NULL`,
      [emailRefs.map((r) => r.email!.toLowerCase())],
    );
    for (const r of rows) found.set(r.email, r.id);
  }
  const nameRefs = refs.filter((r) => !r.email && r.name && !found.has(customerKey(r)));
  if (nameRefs.length > 0) {
    const rows = await q.rows<{ id: string; name: string }>(
      `SELECT id, lower(display_name) AS name FROM parties
        WHERE lower(display_name) = ANY($1::text[]) AND deleted_at IS NULL`,
      [nameRefs.map((r) => r.name!.toLowerCase())],
    );
    for (const r of rows) found.set(r.name, r.id);
  }
  return found;
}

/**
 * Resolves every unique customer reference in `refs` to a party id,
 * creating a minimal party (name/email only — no phone, address, or
 * lifecycle beyond is_customer) for whichever ones don't already exist.
 * Used by importers that only REFERENCE a customer (invoices, jobs) and
 * need to "create it if missing" without being a customer importer
 * themselves. The dedicated customers importer does NOT use this — it has
 * real per-row fields (phone/company/address) to set on create and fill in
 * on an existing match, which this minimal path intentionally doesn't do.
 */
export async function resolveOrCreateCustomers(
  q: Querier, refs: CustomerRef[],
  ctx: { orgId: string | null; actorUserId: string; actorLabel: string; sourceLabel: string },
): Promise<{ keyToPartyId: Map<string, string>; created: number; linked: number }> {
  const uniqueByKey = new Map<string, CustomerRef>();
  for (const r of refs) if (!uniqueByKey.has(customerKey(r))) uniqueByKey.set(customerKey(r), r);

  const keyToPartyId = await findExistingCustomers(q, [...uniqueByKey.values()]);
  const linked = keyToPartyId.size;

  let created = 0;
  for (const [key, ref] of uniqueByKey) {
    if (keyToPartyId.has(key)) continue;
    const displayName = ref.name ?? ref.email!;
    const party = await q.one<{ id: string }>(
      `INSERT INTO parties (org_id, kind, display_name, is_lead, is_customer, lifecycle)
       VALUES (app.current_org(), 'person', $1, false, true, 'customer')
       RETURNING id`,
      [displayName],
    );
    if (ref.email) {
      await q.exec(
        `INSERT INTO party_contacts (org_id, party_id, channel, value, is_primary)
         VALUES (app.current_org(), $1, 'email', $2, true)`,
        [party!.id, ref.email],
      );
    }
    await logTimeline(q, {
      orgId: ctx.orgId, partyId: party!.id, module: 'operate', eventType: 'party.created',
      title: `Added ${displayName} (${ctx.sourceLabel})`, actorUserId: ctx.actorUserId, actorLabel: ctx.actorLabel,
    });
    keyToPartyId.set(key, party!.id);
    created++;
  }

  return { keyToPartyId, created, linked };
}
