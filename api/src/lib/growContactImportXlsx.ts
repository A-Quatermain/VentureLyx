/**
 * Venturelyx :: Grow contacts import — file ingestion (CSV + XLSX + HTML).
 *
 * Turns an uploaded file's raw bytes into {headers, records} — records
 * keyed by the file's OWN column names, ready for
 * growContactImportMapping.ts's applyMapping(). CSV goes straight through
 * growContactImport.ts's parser; XLSX goes through SheetJS with two
 * fallbacks for real-world messy spreadsheets:
 *
 *   1. Wrong sheet / banner rows: picks the sheet with the most non-empty
 *      rows (not just SheetNames[0]), then scans its first 10 rows for the
 *      one that looks most like a header row rather than a title/banner
 *      row above the real table.
 *   2. Not actually a valid workbook (SheetJS throws, or finds nothing
 *      usable — a common case: a file with an .xlsx extension that is
 *      actually plain CSV/TSV text someone renamed): falls back to
 *      treating the raw bytes as CSV text.
 *
 * Checked BEFORE either of those, regardless of filename extension: some
 * real-world exports (Florida DOE's private-school directory among them)
 * are an HTML <table> saved with a .xls extension, not a real spreadsheet
 * at all. SheetJS's format sniffer sees the leading `<` byte and routes it
 * to its SpreadsheetML (Excel XML) parser, not HTML — wrong format, so it
 * throws (or worse, half-parses garbage) rather than reading the table.
 * Content-sniffed, not extension-based, since the extension is exactly
 * what's lying here.
 */
import * as XLSX from 'xlsx';
import { parseCsvRows, rowsToRecords, type RecordEntry } from './growContactImport.js';

function looksLikeHtml(buffer: Buffer): boolean {
  const head = buffer.subarray(0, 1024).toString('utf8').trim().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || /^<\?xml[\s\S]{0,200}<html/i.test(head) || head.startsWith('<table');
}

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'",
};

function decodeEntities(s: string): string {
  return s.replace(/&(nbsp|amp|lt|gt|quot|#39|apos);/gi, (m) => ENTITIES[m.toLowerCase()] ?? m);
}

function cellText(cellHtml: string): string {
  return decodeEntities(
    cellHtml
      .replace(/<(br|p|div)\b[^>]*>/gi, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' '),
  ).trim();
}

/** Parses the first <table> in an HTML document — "the first table", per
 *  the brief, not "the biggest" (pickBestSheet's rule for real
 *  spreadsheets): an HTML export realistically has at most one real data
 *  table, with any others being layout chrome around it. */
function ingestHtmlTable(html: string): IngestResult {
  const tableMatch = html.match(/<table[\s\S]*?<\/table>/i);
  if (!tableMatch) {
    return { headers: [], records: [], note: 'This looked like an HTML file, but no <table> was found in it.' };
  }
  const rowMatches = tableMatch[0].match(/<tr[\s\S]*?<\/tr>/gi) ?? [];
  const aoa: string[][] = rowMatches.map((rowHtml) => {
    const cellMatches = rowHtml.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) ?? [];
    return cellMatches.map(cellText);
  });
  const { headers, records } = rowsToRecords(aoa);
  return { headers, records, note: 'Parsed as an HTML table (the file was HTML despite its extension).' };
}

export interface IngestResult {
  headers: string[];
  records: RecordEntry[];
  /** What actually happened, surfaced to the UI so a fallback isn't silent. */
  note: string | null;
}

const HEADER_SCAN_ROWS = 10;

function isCsvName(filename: string): boolean {
  return /\.(csv|tsv|txt)$/i.test(filename);
}

function nonEmptyCellCount(row: unknown[]): number {
  return row.filter((c) => c != null && String(c).trim() !== '').length;
}

/** Among a sheet's first HEADER_SCAN_ROWS rows, the header row is the one
 *  with the most non-empty cells — a banner/title row above it typically
 *  has just one or two filled cells (a merged title), while the real
 *  header row has one filled cell per column. */
function findHeaderRowIndex(aoa: unknown[][]): number {
  let bestIdx = 0;
  let bestScore = -1;
  for (let i = 0; i < Math.min(HEADER_SCAN_ROWS, aoa.length); i++) {
    const score = nonEmptyCellCount(aoa[i] ?? []);
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  return bestIdx;
}

function pickBestSheet(workbook: XLSX.WorkBook): { name: string; aoa: unknown[][] } | null {
  let best: { name: string; aoa: unknown[][]; rows: number } | null = null;
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', raw: false });
    const rows = aoa.filter((r) => nonEmptyCellCount(r) > 0).length;
    if (rows === 0) continue;
    if (!best || rows > best.rows) best = { name, aoa, rows };
  }
  return best;
}

function ingestCsvText(text: string, note: string | null): IngestResult {
  const { headers, records } = rowsToRecords(parseCsvRows(text));
  return { headers, records, note };
}

export function ingestFile(buffer: Buffer, filename: string): IngestResult {
  if (looksLikeHtml(buffer)) {
    return ingestHtmlTable(buffer.toString('utf8'));
  }
  if (isCsvName(filename)) {
    return ingestCsvText(buffer.toString('utf8'), null);
  }

  let workbook: XLSX.WorkBook | null = null;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' });
  } catch {
    workbook = null;
  }

  const best = workbook ? pickBestSheet(workbook) : null;
  if (!best) {
    // Not a workbook SheetJS could read at all, or every sheet was empty —
    // the most common real cause is a CSV that got an .xlsx extension.
    return ingestCsvText(
      buffer.toString('utf8'),
      "Couldn't read this as a spreadsheet, so it was parsed as plain CSV text instead.",
    );
  }

  const headerRowIdx = findHeaderRowIndex(best.aoa);
  const dataRows = best.aoa.slice(headerRowIdx);
  const { headers, records } = rowsToRecords(dataRows);

  const notes: string[] = [];
  if (workbook!.SheetNames.length > 1) notes.push(`used sheet "${best.name}" (of ${workbook!.SheetNames.length})`);
  if (headerRowIdx > 0) notes.push(`skipped ${headerRowIdx} row(s) above the header`);

  return { headers, records, note: notes.length > 0 ? notes.join('; ') : null };
}
