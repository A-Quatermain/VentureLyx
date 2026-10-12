// Venturelyx :: Grow contacts import — shared parsing/validation core.
//
// This is the canonical logic for turning a row of contact-ish data into a
// grow_contacts insert row. It started life inline in
// scripts/import-contacts.js (a CLI that only ever sees one fixed,
// known-shape CSV) and was extracted here unchanged so the upload endpoint
// (api/src/routes/grow.ts, POST /grow/contacts/import/*) can reuse it
// exactly rather than re-deriving the same rules a second time — same
// strict boolean parsing, same rejection codes, same reasons.
//
// A real TypeScript source, not plain .js with a hand-written .d.ts: this
// file used to be the latter specifically so scripts/import-contacts.js
// (a plain Node ESM CLI, no build step) could import it directly. That
// broke the production API — tsconfig.json's `include` is `src/**/*.ts`
// only, so tsc never emitted the .js file into dist/lib/, and dist/routes/
// grow.js's `import '../lib/growContactImport.js'` had nothing to resolve
// at runtime (ERR_MODULE_NOT_FOUND, the whole API crash-looping on start —
// not just Grow, every route in the same process). scripts/import-contacts.js
// now imports the compiled output at api/dist/lib/growContactImport.js
// instead of this source file directly, so `npm run build` must have run
// in api/ first — same requirement the API itself already has.
//
// The canonical record shape (every function here reads/writes exactly
// these keys, unchanged from the original script):
//   email, first_name, contact_name, role, contact_rank, external_id,
//   entity_name, region, city, state, phone, recipient_domain,
//   is_free_provider, enrollment, tier, is_chain, domain_rank,
//   fes_eo, ftc, fes_ua, pep, non_profit, religious,
//   suppress_reason, sendable   (control fields — never stored)
//   grade_levels, denomination  (optional, routed into attrs jsonb — see
//     GrowContactRow.attrs)

export interface GrowContactRow {
  org_id: string;
  email: string;
  first_name: string | null;
  contact_name: string | null;
  role: string | null;
  contact_rank: number;
  entity_external_id: string | null;
  entity_name: string | null;
  region: string | null;
  city: string | null;
  state: string | null;
  phone: string | null;
  recipient_domain: string;
  is_free_provider: boolean;
  enrollment: number | null;
  tier: string | null;
  is_chain: boolean;
  domain_rank: number | null;
  fes_eo: boolean | null;
  ftc: boolean | null;
  fes_ua: boolean | null;
  pep: boolean | null;
  non_profit: boolean | null;
  religious: boolean | null;
  /** Fields with no dedicated typed column — currently grade_levels and
   *  denomination (growContactImportMapping.ts's OrgField list), routed
   *  here instead of growing the typed-column list for data that's
   *  descriptive metadata, not something queries filter/group on. Never
   *  populated by scripts/import-contacts.js's fixed CSV shape (always
   *  {} there) — only the upload endpoint's mapped-file path can produce
   *  non-empty attrs. NOT in INSERT_COLUMNS: the upload endpoint's own
   *  INSERT appends this column itself (needs JSON.stringify for jsonb),
   *  so the CLI script sharing INSERT_COLUMNS is unaffected either way. */
  attrs: Record<string, string>;
}

export interface Rejection {
  line: number;
  email: string;
  code: string;
  detail: string;
}

export interface RecordEntry {
  /** The canonical field shape toContact()/processRecords() read — see the
   *  key list at the top of this file. */
  record: Record<string, string>;
  line: number;
}

// ---- CSV parsing ------------------------------------------------------------
// Hand-rolled rather than a dependency: real source files have quoted
// fields with embedded commas (e.g. `"ALEXANDER SCHOOL, INC."`), so a naive
// split(',') silently misaligns columns on those rows. Plain RFC4180 —
// quotes, doubled-quote escaping, CRLF — nothing schools-specific.

export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"') { inQuotes = true; i += 1; continue; }
    if (ch === ',') { row.push(field); field = ''; i += 1; continue; }
    if (ch === '\r') { i += 1; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }
    field += ch; i += 1;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/** Array-of-arrays (first row = header) -> [{ record: {header: value}, line }]. Shared
 *  by the CSV and XLSX ingestion paths — XLSX is read into the same array-of-arrays
 *  shape via sheet_to_json({header:1}) before reaching here. */
export function rowsToRecords(rows: unknown[][]): { headers: string[]; records: RecordEntry[] } {
  const filtered = rows.filter((r) => !(r.length === 0 || (r.length === 1 && (r[0] ?? '') === '')));
  if (filtered.length === 0) return { headers: [], records: [] };
  const headers = filtered[0]!.map((h) => String(h ?? '').trim());
  const records = filtered.slice(1).map((r, idx) => {
    const record: Record<string, string> = {};
    headers.forEach((h, ci) => { record[h] = r[ci] == null ? '' : String(r[ci]); });
    return { record, line: idx + 2 }; // header is line 1, matching what a human sees in an editor
  });
  return { headers, records };
}

export function parseCsvRecords(text: string): { headers: string[]; records: RecordEntry[] } {
  return rowsToRecords(parseCsvRows(text));
}

// ---- Field parsing / validation ------------------------------------------------

export class RejectError extends Error {
  code: string;
  constructor(code: string, detail?: string) {
    super(detail ?? code);
    this.code = code;
  }
}

export function requireNonEmpty(value: string | null | undefined, field: string): string {
  const v = (value ?? '').trim();
  if (!v) throw new RejectError(`missing_${field}`, `missing ${field}`);
  return v;
}

export function trimOrNull(value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  return v === '' ? null : v;
}

// Strict on purpose: the source data holds Python's str(bool) output
// ("True"/"False"), so anything else (blank where not allowed, "TRUE",
// "1", "yes", a typo) rejects the row instead of silently becoming
// `false`. Callers that map an arbitrary uploaded file (growContactImportMapping.ts)
// decide what an *unmapped* field defaults to before calling this — this
// function itself never guesses.
export function parseStrictBool(
  value: string | null | undefined,
  field: string,
  { nullable = false }: { nullable?: boolean } = {},
): boolean | null {
  const v = (value ?? '').trim();
  if (v === '') {
    if (nullable) return null;
    throw new RejectError(`missing_${field}`, `missing ${field}`);
  }
  if (v === 'True') return true;
  if (v === 'False') return false;
  throw new RejectError(`unparseable_bool_${field}`, `unparseable boolean for ${field}: "${value}"`);
}

const INT_RE = /^-?\d+$/;

export function parseIntStrict(value: string | null | undefined, field: string): number {
  const v = (value ?? '').trim();
  if (!INT_RE.test(v)) throw new RejectError(`invalid_${field}`, `invalid ${field}: "${value}"`);
  return Number(v);
}

export function parseIntNullable(value: string | null | undefined, field: string): number | null {
  const v = (value ?? '').trim();
  if (v === '') return null;
  if (!INT_RE.test(v)) throw new RejectError(`invalid_${field}`, `invalid ${field}: "${value}"`);
  return Number(v);
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Columns in grow_contacts insert order (see db/migrations/009_grow.sql).
// party_id and source_profile are left null, attrs stays at its '{}'
// default: every field a source row can carry that grow_contacts can
// represent has a typed column, so there's nothing left over to put there.
export const INSERT_COLUMNS = [
  'org_id', 'email', 'first_name', 'contact_name', 'role', 'contact_rank',
  'entity_external_id', 'entity_name', 'region', 'city', 'state', 'phone',
  'recipient_domain', 'is_free_provider', 'enrollment', 'tier', 'is_chain', 'domain_rank',
  'fes_eo', 'ftc', 'fes_ua', 'pep', 'non_profit', 'religious',
] as const;

// The only two OrgFields (growContactImportMapping.ts) with no dedicated
// typed column — see GrowContactRow.attrs's own comment for why.
const ATTRS_KEYS = ['grade_levels', 'denomination'] as const;

function buildAttrs(record: Record<string, string>): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const key of ATTRS_KEYS) {
    const value = trimOrNull(record[key]);
    if (value) attrs[key] = value;
  }
  return attrs;
}

export function toContact(record: Record<string, string>, org: string): GrowContactRow {
  const email = requireNonEmpty(record.email, 'email');
  if (!EMAIL_RE.test(email)) {
    throw new RejectError('invalid_email_format', `invalid email format: "${record.email}"`);
  }

  const recipient_domain = requireNonEmpty(record.recipient_domain, 'recipient_domain');

  // Suppressed-at-source and not-sendable-at-source are both reasons to
  // leave a contact out of the active list entirely, not reasons to import
  // it and hope grow_suppressions (a separate table, out of scope here)
  // gets backfilled later. Checked before anything else so they win over a
  // coincidentally-also-broken field elsewhere in the row.
  const suppressReason = trimOrNull(record.suppress_reason);
  if (suppressReason) {
    throw new RejectError('suppressed', `suppressed at source: ${suppressReason}`);
  }
  const sendable = parseStrictBool(record.sendable, 'sendable');
  if (sendable === false) {
    throw new RejectError('not_sendable', 'marked not sendable at source');
  }

  return {
    org_id: org,
    email,
    first_name: trimOrNull(record.first_name),
    contact_name: trimOrNull(record.contact_name),
    role: trimOrNull(record.role),
    contact_rank: parseIntStrict(record.contact_rank, 'contact_rank'),
    entity_external_id: trimOrNull(record.external_id),
    entity_name: trimOrNull(record.entity_name),
    region: trimOrNull(record.region),
    city: trimOrNull(record.city),
    state: trimOrNull(record.state),
    phone: trimOrNull(record.phone),
    recipient_domain,
    is_free_provider: parseStrictBool(record.is_free_provider, 'is_free_provider') as boolean,
    enrollment: parseIntNullable(record.enrollment, 'enrollment'),
    tier: trimOrNull(record.tier),
    is_chain: parseStrictBool(record.is_chain, 'is_chain') as boolean,
    domain_rank: parseIntNullable(record.domain_rank, 'domain_rank'),
    fes_eo: parseStrictBool(record.fes_eo, 'fes_eo', { nullable: true }),
    ftc: parseStrictBool(record.ftc, 'ftc', { nullable: true }),
    fes_ua: parseStrictBool(record.fes_ua, 'fes_ua', { nullable: true }),
    pep: parseStrictBool(record.pep, 'pep', { nullable: true }),
    non_profit: parseStrictBool(record.non_profit, 'non_profit', { nullable: true }),
    religious: parseStrictBool(record.religious, 'religious', { nullable: true }),
    attrs: buildAttrs(record),
  };
}

/** Validates + dedupes an already-extracted list of {record, line} entries.
 *  Shared by the CLI (its records come 1:1 from parseCsvRecords, a fixed
 *  known CSV shape) and the upload endpoint (its records come from
 *  growContactImportMapping.ts's unpivot step, an arbitrary mapped file). */
export function processRecords(
  entries: RecordEntry[],
  org: string,
): { accepted: GrowContactRow[]; rejections: Rejection[] } {
  const accepted: GrowContactRow[] = [];
  const rejections: Rejection[] = [];
  const seenEmails = new Map<string, number>(); // email -> first line seen, for in-file dedupe

  for (const { record, line } of entries) {
    try {
      const email = (record.email ?? '').trim();
      if (email && seenEmails.has(email)) {
        throw new RejectError(
          'duplicate_email_in_file',
          `duplicate email in file (first seen at line ${seenEmails.get(email)})`,
        );
      }
      const contact = toContact(record, org);
      seenEmails.set(contact.email, line);
      accepted.push(contact);
    } catch (err) {
      if (!(err instanceof RejectError)) throw err; // a real bug, don't swallow it
      rejections.push({ line, email: record.email || '(missing)', code: err.code, detail: err.message });
    }
  }

  return { accepted, rejections };
}

export function processRows(
  text: string,
  org: string,
): { totalRows: number; accepted: GrowContactRow[]; rejections: Rejection[] } {
  const { records } = parseCsvRecords(text);
  const { accepted, rejections } = processRecords(records, org);
  return { totalRows: records.length, accepted, rejections };
}

export interface ImportSummary {
  totalRows: number;
  acceptedCount: number;
  rejectedCount: number;
  byTier: Array<{ tier: string; count: number }>;
  uniqueDomains: number;
  rejectionsByCode: Array<{
    code: string;
    count: number;
    examples: Array<{ line: number; email: string; detail: string }>;
  }>;
}

/** Same shape both the CLI's printReport() and the upload endpoint's JSON
 *  response build from — one definition of "what does a dry run report". */
export function summarize({
  totalRows,
  accepted,
  rejections,
}: {
  totalRows: number;
  accepted: GrowContactRow[];
  rejections: Rejection[];
}): ImportSummary {
  const byTier = new Map<string, number>();
  const domains = new Set<string>();
  for (const c of accepted) {
    const tier = c.tier ?? '(none)';
    byTier.set(tier, (byTier.get(tier) ?? 0) + 1);
    domains.add(c.recipient_domain);
  }

  const byCode = new Map<string, Rejection[]>();
  for (const r of rejections) {
    if (!byCode.has(r.code)) byCode.set(r.code, []);
    byCode.get(r.code)!.push(r);
  }

  return {
    totalRows,
    acceptedCount: accepted.length,
    rejectedCount: rejections.length,
    byTier: [...byTier.entries()].sort((a, b) => b[1] - a[1]).map(([tier, count]) => ({ tier, count })),
    uniqueDomains: domains.size,
    rejectionsByCode: [...byCode.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .map(([code, list]) => ({
        code,
        count: list.length,
        examples: list.slice(0, 5).map((r) => ({ line: r.line, email: r.email, detail: r.detail })),
      })),
  };
}
