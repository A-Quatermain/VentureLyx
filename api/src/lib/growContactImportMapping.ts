/**
 * Venturelyx :: Grow contacts import — column mapping & wide-format unpivot.
 *
 * growContactImport.ts is the canonical row validator, shared unchanged
 * with scripts/import-contacts.js (which imports the compiled output at
 * api/dist/lib/growContactImport.js). This file is everything upstream of
 * that: turning an arbitrary uploaded file's own
 * column names into the canonical record shape toContact() expects, and
 * — for a "wide" file (one row per organization, several contact-shaped
 * column groups) — unpivoting one source row into several candidate
 * contact records, one per non-empty contact slot.
 */
import type { RecordEntry } from './growContactImport.js';

export type PersonField = 'email' | 'first_name' | 'last_name' | 'contact_name' | 'role' | 'phone' | 'contact_rank';
export type OrgField =
  | 'external_id' | 'entity_name' | 'region' | 'city' | 'state' | 'tier' | 'enrollment'
  | 'is_chain' | 'domain_rank' | 'is_free_provider'
  | 'fes_eo' | 'ftc' | 'fes_ua' | 'pep' | 'non_profit' | 'religious'
  | 'grade_levels' | 'denomination'
  | 'recipient_domain' | 'suppress_reason' | 'sendable';

export const PERSON_FIELDS: PersonField[] = ['email', 'first_name', 'last_name', 'contact_name', 'role', 'phone', 'contact_rank'];
export const ORG_FIELDS: OrgField[] = [
  'external_id', 'entity_name', 'region', 'city', 'state', 'tier', 'enrollment',
  'is_chain', 'domain_rank', 'is_free_provider',
  'fes_eo', 'ftc', 'fes_ua', 'pep', 'non_profit', 'religious',
  'grade_levels', 'denomination',
  'recipient_domain', 'suppress_reason', 'sendable',
];

export const FIELD_LABELS: Record<PersonField | OrgField, string> = {
  email: 'Email', first_name: 'First name', last_name: 'Last name', contact_name: 'Contact name', role: 'Role',
  phone: 'Phone', contact_rank: 'Contact rank',
  external_id: 'External ID', entity_name: 'Organization name', region: 'Region', city: 'City',
  state: 'State', tier: 'Tier', enrollment: 'Enrollment',
  is_chain: 'Is chain (multi-location)', domain_rank: 'Domain rank', is_free_provider: 'Is free provider',
  fes_eo: 'FES-EO scholarship', ftc: 'FTC scholarship', fes_ua: 'FES-UA scholarship', pep: 'PEP scholarship',
  non_profit: 'Non-profit', religious: 'Religious affiliation',
  grade_levels: 'Grade levels (stored as metadata)', denomination: 'Denomination (stored as metadata)',
  recipient_domain: 'Recipient domain (derived from email if unmapped)',
  suppress_reason: 'Suppression reason (present = never imported)',
  sendable: "Sendable flag (\"False\" = never imported)",
};

export const REQUIRED_PERSON_FIELDS: PersonField[] = ['email'];
export const REQUIRED_ORG_FIELDS: OrgField[] = [];

export interface SlotMapping {
  label: string;
  /** Fixed contact_rank for every contact from this slot, or null to read
   *  it from a mapped column (fields.contact_rank) instead. */
  rank: number | null;
  fields: Partial<Record<PersonField, string | null>>;
}

export interface MappingConfig {
  format: 'long' | 'wide';
  shared: Partial<Record<OrgField, string | null>>;
  slots: SlotMapping[];
}

// A field a general upload commonly won't carry at all — rather than reject
// every row with "missing X", an unmapped field here gets this value
// instead of blank. Only applies when the field has NO source column
// chosen; a column that IS mapped but blank on a given row still goes
// through the normal strict parser and can still reject that row.
const DEFAULT_WHEN_UNMAPPED: Partial<Record<OrgField, string>> = {
  is_free_provider: 'False',
  is_chain: 'False',
  sendable: 'True',
};

function cell(row: Record<string, string>, column: string | null | undefined): string {
  if (!column) return '';
  return row[column] ?? '';
}

/** Builds the canonical record for one slot on one source row, or null if
 *  this slot has nothing in it for this row (wide format: a school with no
 *  second contact simply doesn't produce a second contact row). */
function buildSlotRecord(
  row: Record<string, string>,
  mapping: MappingConfig,
  slot: SlotMapping,
  isWide: boolean,
): Record<string, string> | null {
  const emailValue = cell(row, slot.fields.email).trim();
  if (isWide && !emailValue) return null;

  const record: Record<string, string> = {};

  for (const field of ORG_FIELDS) {
    const column = mapping.shared[field];
    const value = cell(row, column);
    record[field] = !column && field in DEFAULT_WHEN_UNMAPPED ? DEFAULT_WHEN_UNMAPPED[field]! : value;
  }

  record.email = emailValue;
  record.first_name = cell(row, slot.fields.first_name);
  record.role = cell(row, slot.fields.role);
  record.phone = cell(row, slot.fields.phone);
  record.contact_rank = slot.rank != null ? String(slot.rank) : cell(row, slot.fields.contact_rank);

  // contact_name (full name) synthesized from first+last when the file
  // carries them as separate columns and has no full-name column of its
  // own mapped — a mapped contact_name column always wins outright.
  const mappedContactName = cell(row, slot.fields.contact_name).trim();
  const lastNameValue = cell(row, slot.fields.last_name).trim();
  record.contact_name = mappedContactName
    || [record.first_name.trim(), lastNameValue].filter(Boolean).join(' ');

  // recipient_domain defaults to the email's own domain when nothing was
  // mapped (or the mapped column is blank for this row) — most uploaded
  // files won't carry a separate domain column at all.
  if (!(record.recipient_domain ?? '').trim() && emailValue.includes('@')) {
    record.recipient_domain = emailValue.slice(emailValue.indexOf('@') + 1).trim().toLowerCase();
  }

  return record;
}

/** Unpivots raw {row, line} entries (row keyed by the file's own headers)
 *  into canonical {record, line} entries ready for processRecords(). */
export function applyMapping(rawEntries: RecordEntry[], mapping: MappingConfig): RecordEntry[] {
  const isWide = mapping.format === 'wide' && mapping.slots.length > 1;
  const out: RecordEntry[] = [];
  for (const { record: row, line } of rawEntries) {
    for (const slot of mapping.slots) {
      const built = buildSlotRecord(row, mapping, slot, isWide);
      if (built) out.push({ record: built, line });
    }
  }
  return out;
}

/** A saved profile from a *different* file shape (different headers
 *  entirely) is worse than no suggestion — it silently hides a good fresh
 *  guess (including wide-format detection) behind stale column names that
 *  don't exist in the file actually being uploaded. Only offer a saved
 *  mapping as the starting point when every column it references is
 *  actually present this time. */
export function mappingMatchesHeaders(mapping: MappingConfig, headers: string[]): boolean {
  const available = new Set(headers);
  const referenced = [
    ...Object.values(mapping.shared),
    ...mapping.slots.flatMap((s) => Object.values(s.fields)),
  ].filter((v): v is string => !!v);
  if (referenced.length === 0) return false;
  return referenced.every((col) => available.has(col));
}

// ---- Auto-detect ------------------------------------------------------------

function normalize(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, ' ').trim();
}

const ALIASES: Record<PersonField | OrgField, string[]> = {
  email: ['email', 'email address', 'e mail', 'contact email', 'work email'],
  first_name: ['first name', 'firstname', 'fname', 'given name'],
  last_name: ['last name', 'lastname', 'lname', 'surname', 'family name'],
  contact_name: ['contact name', 'full name', 'name'],
  role: ['role', 'title', 'job title', 'position'],
  phone: ['phone', 'phone number', 'telephone', 'tel', 'mobile'],
  contact_rank: ['contact rank', 'rank', 'priority'],
  external_id: ['external id', 'source id', 'record id'],
  entity_name: [
    'entity name', 'organization', 'organization name', 'company', 'company name',
    'school', 'school name', 'business name', 'account name',
  ],
  region: ['region', 'county', 'area'],
  city: ['city', 'town'],
  state: ['state', 'st', 'province'],
  tier: ['tier', 'segment', 'priority tier'],
  enrollment: ['enrollment', 'student count', 'headcount', 'employees'],
  is_chain: ['is chain', 'chain'],
  domain_rank: ['domain rank'],
  is_free_provider: ['is free provider', 'free provider'],
  fes_eo: ['fes eo'],
  ftc: ['ftc'],
  fes_ua: ['fes ua'],
  pep: ['pep'],
  non_profit: ['non profit', 'nonprofit', '501c3'],
  religious: ['religious'],
  grade_levels: ['grade levels', 'grades', 'grade level', 'grades served'],
  denomination: ['denomination', 'religious denomination', 'affiliation'],
  recipient_domain: ['recipient domain', 'domain', 'email domain'],
  suppress_reason: ['suppress reason', 'suppression reason', 'do not contact reason', 'dnc reason'],
  sendable: ['sendable', 'ok to send', 'opt in', 'optin'],
};

function findHeaderFor(headers: string[], field: PersonField | OrgField, used: Set<string>): string | null {
  const aliases = ALIASES[field].map(normalize);
  for (const h of headers) {
    if (used.has(h)) continue;
    if (aliases.includes(normalize(h))) return h;
  }
  return null;
}

/** Best-effort suggestion the mapping screen starts from — the user can
 *  freely edit every dropdown afterward, so a wrong guess just costs a
 *  click, never a bad import. */
export function guessMapping(headers: string[]): MappingConfig {
  const emailLike = headers.filter((h) => normalize(h).split(' ').includes('email'));

  if (emailLike.length >= 2) {
    // Wide format: one email-ish column per contact slot. Derive each
    // slot's prefix (the header with the "email" token removed) and look
    // for sibling columns sharing that prefix for the other person fields.
    const used = new Set<string>();
    const slots: SlotMapping[] = emailLike.map((emailHeader, i) => {
      used.add(emailHeader);
      const prefix = normalize(emailHeader).replace(/\bemail\b/, '').trim();
      const fields: SlotMapping['fields'] = { email: emailHeader };
      for (const pf of PERSON_FIELDS) {
        if (pf === 'email') continue;
        const match = headers.find((h) => {
          if (used.has(h)) return false;
          const n = normalize(h);
          return prefix.length > 0 && n.startsWith(prefix) && ALIASES[pf].some((a) => n.endsWith(normalize(a)));
        });
        if (match) { fields[pf] = match; used.add(match); }
      }
      const label = prefix ? prefix.replace(/\b\w/g, (c) => c.toUpperCase()) : `Contact ${i + 1}`;
      return { label, rank: i + 1, fields };
    });

    const shared: MappingConfig['shared'] = {};
    for (const field of ORG_FIELDS) {
      const h = findHeaderFor(headers, field, used);
      if (h) { shared[field] = h; used.add(h); }
    }
    return { format: 'wide', shared, slots };
  }

  const used = new Set<string>();
  const fields: SlotMapping['fields'] = {};
  for (const pf of PERSON_FIELDS) {
    const h = findHeaderFor(headers, pf, used);
    if (h) { fields[pf] = h; used.add(h); }
  }
  const shared: MappingConfig['shared'] = {};
  for (const field of ORG_FIELDS) {
    const h = findHeaderFor(headers, field, used);
    if (h) { shared[field] = h; used.add(h); }
  }
  return { format: 'long', shared, slots: [{ label: 'Contact', rank: null, fields }] };
}

// ---- Known templates ---------------------------------------------------
// A specific, named header set that skips the manual mapping screen
// entirely when every one of its fields is found (by the same alias
// matching guessMapping already uses) — not "skip mapping whenever
// confident", which would be a much broader, less predictable rule. FLDOE
// (Florida private-school directory) exports are the first case: a fixed
// field set, uploaded repeatedly, so re-confirming the mapping by hand
// every time is pure friction once it's known to be right.
const KNOWN_TEMPLATES: Record<string, (PersonField | OrgField)[]> = {
  fldoe: [
    'email', 'first_name', 'last_name', 'entity_name', 'city', 'state',
    'region' /* county */, 'phone', 'grade_levels', 'denomination', 'contact_rank', 'tier',
  ],
};

/** True when every field a known template needs can be found in these
 *  headers — guessMapping() is expected to resolve all of them correctly
 *  at that point, so the caller can skip straight to preview. */
export function matchesKnownTemplate(headers: string[]): boolean {
  return Object.values(KNOWN_TEMPLATES).some((fields) => {
    const used = new Set<string>();
    return fields.every((field) => {
      const h = findHeaderFor(headers, field, used);
      if (h) used.add(h);
      return !!h;
    });
  });
}
