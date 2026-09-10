// Type declarations for growContactImport.js. Hand-written rather than
// generated: the .js file is imported directly (unchanged) by the plain
// Node CLI script at scripts/import-contacts.js, so it stays plain
// JavaScript rather than becoming a .ts file the script would need a
// build step or a loader to run.

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
}

export interface Rejection {
  line: number;
  email: string;
  code: string;
  detail: string;
}

export interface RecordEntry {
  /** The canonical field shape toContact()/processRecords() read — see the
   *  key list at the top of growContactImport.js. */
  record: Record<string, string>;
  line: number;
}

export declare class RejectError extends Error {
  code: string;
  constructor(code: string, detail?: string);
}

export declare function parseCsvRows(text: string): string[][];
export declare function rowsToRecords(rows: unknown[][]): { headers: string[]; records: RecordEntry[] };
export declare function parseCsvRecords(text: string): { headers: string[]; records: RecordEntry[] };

export declare function requireNonEmpty(value: string | null | undefined, field: string): string;
export declare function trimOrNull(value: string | null | undefined): string | null;
export declare function parseStrictBool(
  value: string | null | undefined,
  field: string,
  opts?: { nullable?: boolean },
): boolean | null;
export declare function parseIntStrict(value: string | null | undefined, field: string): number;
export declare function parseIntNullable(value: string | null | undefined, field: string): number | null;

export declare const EMAIL_RE: RegExp;
export declare const INSERT_COLUMNS: readonly string[];

export declare function toContact(record: Record<string, string>, org: string): GrowContactRow;

export declare function processRecords(
  entries: RecordEntry[],
  org: string,
): { accepted: GrowContactRow[]; rejections: Rejection[] };

export declare function processRows(
  text: string,
  org: string,
): { totalRows: number; accepted: GrowContactRow[]; rejections: Rejection[] };

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

export declare function summarize(args: {
  totalRows: number;
  accepted: GrowContactRow[];
  rejections: Rejection[];
}): ImportSummary;
