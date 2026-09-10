/**
 * Venturelyx :: Grow contacts import — file ingestion (CSV + XLSX).
 *
 * Turns an uploaded file's raw bytes into {headers, records} — records
 * keyed by the file's OWN column names, ready for
 * growContactImportMapping.ts's applyMapping(). CSV goes straight through
 * growContactImport.js's parser; XLSX goes through SheetJS with two
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
 */
import * as XLSX from 'xlsx';
import { parseCsvRows, rowsToRecords, type RecordEntry } from './growContactImport.js';

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
