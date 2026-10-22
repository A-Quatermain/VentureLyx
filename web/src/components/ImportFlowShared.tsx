'use client';

import { UploadSimple, CheckCircle, DownloadSimple } from '@phosphor-icons/react';
import { Card } from '@/components/ui/Card';

// Shared pieces for Operate's "import your data" flow (customers, jobs —
// invoices already shipped its own copy of this same shape before this file
// existed; not retrofitted, to avoid touching tested, working code). Each
// entity importer still owns its field list, its preview summary, and its
// "done" summary — those differ meaningfully per entity — this only holds
// the scaffolding that's identical regardless of what's being imported.

export type ImportStep = 'pick' | 'map' | 'preview' | 'done';

export const IMPORT_STEPS: { key: ImportStep; label: string }[] = [
  { key: 'pick', label: 'Upload' },
  { key: 'map', label: 'Map columns' },
  { key: 'preview', label: 'Preview' },
  { key: 'done', label: 'Done' },
];

export const importSelectCls =
  'min-h-[38px] w-full rounded-lg border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';

export function buildImportFormData(file: File, mapping?: Record<string, string | undefined>): FormData {
  const fd = new FormData();
  fd.append('file', file, file.name);
  if (mapping) fd.append('mapping', JSON.stringify(mapping));
  return fd;
}

export function csvEscape(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Generic "download the rejected rows" — `columns` names which fields of
 *  each rejection row become which CSV column, in order. */
export function downloadRejectionsCsv<T>(
  rows: T[], columns: Array<{ key: keyof T; header: string }>, filename: string,
) {
  const header = columns.map((c) => c.header).join(',');
  const body = rows.map((r) => columns.map((c) => csvEscape(String(r[c.key] ?? ''))).join(','));
  const csv = [header, ...body].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function ImportStepIndicator({ current }: { current: ImportStep }) {
  const idx = IMPORT_STEPS.findIndex((s) => s.key === current);
  return (
    <div className="mb-4 flex items-center gap-1">
      {IMPORT_STEPS.map((s, i) => (
        <div key={s.key} className="flex items-center gap-1">
          <span
            className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold ${
              i < idx ? 'bg-success/10 text-success' : i === idx ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
            }`}
          >
            {i < idx ? <CheckCircle size={14} weight="fill" /> : i + 1}
          </span>
          <span className={`text-xs ${i === idx ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>{s.label}</span>
          {i < IMPORT_STEPS.length - 1 && <span className="mx-1 h-px w-6 bg-border" />}
        </div>
      ))}
    </div>
  );
}

export function ImportDropZone({
  busy, hint, onPick, inputRef,
}: {
  busy: boolean;
  hint: string;
  onPick: (file: File) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <Card
      className="flex flex-col items-center gap-3 border-2 border-dashed border-border p-10 text-center transition hover:border-primary/40"
      onClick={() => inputRef.current?.click()}
      role="button"
    >
      <UploadSimple size={28} className="text-muted-foreground" />
      <p className="text-sm font-medium">{busy ? 'Reading your file…' : 'Click to upload a CSV or XLSX'}</p>
      <p className="max-w-sm text-xs text-muted-foreground">{hint}</p>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,.xlsx,.xls"
        className="hidden"
        onChange={(e) => e.target.files?.[0] && onPick(e.target.files[0])}
      />
    </Card>
  );
}

export function ImportStat({ label, value, tone }: { label: string; value: number; tone?: 'destructive' }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`font-mono text-xl font-semibold tabular-nums ${tone === 'destructive' ? 'text-destructive' : ''}`}>{value}</p>
    </div>
  );
}

export function ImportDownloadLink({ onClick, count }: { onClick: () => void; count: number }) {
  return (
    <button onClick={onClick} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
      <DownloadSimple size={13} weight="bold" /> Download the {count} rejected row{count === 1 ? '' : 's'}
    </button>
  );
}
