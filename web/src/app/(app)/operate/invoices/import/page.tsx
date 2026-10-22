'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { mutate } from 'swr';
import { UploadSimple, FileCsv, CheckCircle, WarningCircle, CaretLeft, DownloadSimple } from '@phosphor-icons/react';
import { apiFetch, ApiError } from '@/lib/api';
import type {
  InvoiceImportInspectResponse, InvoiceImportMapping, InvoiceImportPreviewResponse,
  InvoiceImportCommitResponse, InvoiceImportField, InvoiceImportRejection,
} from '@/lib/types';
import { formatMoney } from '@/lib/format';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { PageHeader } from '@/components/Primitives';

type Step = 'pick' | 'map' | 'preview' | 'done';

const FIELDS: Array<{ key: InvoiceImportField; label: string; required?: boolean }> = [
  { key: 'customer_name', label: 'Customer name' },
  { key: 'customer_email', label: 'Customer email' },
  { key: 'invoice_number', label: 'Invoice number' },
  { key: 'total', label: 'Total', required: true },
  { key: 'amount_paid', label: 'Amount paid' },
  { key: 'issue_date', label: 'Issue date' },
  { key: 'due_date', label: 'Due date' },
  { key: 'paid_date', label: 'Paid date' },
  { key: 'status', label: 'Status' },
  { key: 'description', label: 'Description / line item' },
];

const STEPS: { key: Step; label: string }[] = [
  { key: 'pick', label: 'Upload' },
  { key: 'map', label: 'Map columns' },
  { key: 'preview', label: 'Preview' },
  { key: 'done', label: 'Done' },
];

const selectCls =
  'min-h-[38px] w-full rounded-lg border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';

function buildFormData(file: File, mapping?: InvoiceImportMapping) {
  const fd = new FormData();
  fd.append('file', file, file.name);
  if (mapping) fd.append('mapping', JSON.stringify(mapping));
  return fd;
}

function csvEscape(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadRejectedRowsCsv(rejections: InvoiceImportRejection[]) {
  const header = ['line', 'customer', 'reason'];
  const rows = rejections.map((r) => [r.line, r.customer, r.reason].map(csvEscape).join(','));
  const csv = [header.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'rejected-invoice-rows.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function StepIndicator({ current }: { current: Step }) {
  const idx = STEPS.findIndex((s) => s.key === current);
  return (
    <div className="mb-4 flex items-center gap-1">
      {STEPS.map((s, i) => (
        <div key={s.key} className="flex items-center gap-1">
          <span
            className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold ${
              i < idx ? 'bg-success/10 text-success' : i === idx ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
            }`}
          >
            {i < idx ? <CheckCircle size={14} weight="fill" /> : i + 1}
          </span>
          <span className={`text-xs ${i === idx ? 'font-medium text-foreground' : 'text-muted-foreground'}`}>{s.label}</span>
          {i < STEPS.length - 1 && <span className="mx-1 h-px w-6 bg-border" />}
        </div>
      ))}
    </div>
  );
}

export default function ImportInvoicesPage() {
  const [step, setStep] = useState<Step>('pick');
  const [file, setFile] = useState<File | null>(null);
  const [inspect, setInspect] = useState<InvoiceImportInspectResponse | null>(null);
  const [mapping, setMapping] = useState<InvoiceImportMapping>({});
  const [preview, setPreview] = useState<InvoiceImportPreviewResponse | null>(null);
  const [commitResult, setCommitResult] = useState<InvoiceImportCommitResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function onFilePicked(f: File) {
    setFile(f);
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<InvoiceImportInspectResponse>('/operate/invoices/import/inspect', {
        method: 'POST',
        body: buildFormData(f),
      });
      setInspect(res);
      setMapping(res.suggestedMapping);
      setStep('map');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not read this file.');
    } finally {
      setBusy(false);
    }
  }

  async function onPreview() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<InvoiceImportPreviewResponse>('/operate/invoices/import/preview', {
        method: 'POST',
        body: buildFormData(file, mapping),
      });
      setPreview(res);
      setStep('preview');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not preview this import.');
    } finally {
      setBusy(false);
    }
  }

  async function onCommit() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<InvoiceImportCommitResponse>('/operate/invoices/import/commit', {
        method: 'POST',
        body: buildFormData(file, mapping),
      });
      setCommitResult(res);
      setStep('done');
      await mutate((k: string) => typeof k === 'string' && (k.startsWith('/operate/invoices') || k.startsWith('/operate/parties') || k === '/operate/money' || k === '/command/summary'), undefined, { revalidate: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not commit this import.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="p-4">
      <PageHeader
        eyebrow="Operate"
        title="Import existing invoices"
        subtitle="Bring your current-year invoices in from a spreadsheet — customers come in automatically with them."
        actions={
          <Link href="/operate/invoices" className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground">
            <CaretLeft size={14} weight="bold" /> Invoices
          </Link>
        }
      />

      <StepIndicator current={step} />
      {error && (
        <Card className="mb-4 flex items-center gap-2 border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <WarningCircle size={16} weight="fill" /> {error}
        </Card>
      )}

      {step === 'pick' && (
        <Card
          className="flex flex-col items-center gap-3 border-2 border-dashed border-border p-10 text-center transition hover:border-primary/40"
          onClick={() => fileInputRef.current?.click()}
          role="button"
        >
          <UploadSimple size={28} className="text-muted-foreground" />
          <p className="text-sm font-medium">{busy ? 'Reading your file…' : 'Click to upload a CSV or XLSX'}</p>
          <p className="max-w-sm text-xs text-muted-foreground">
            Customer name or email, invoice number, dates, total, and amount paid — most exports from another
            system (QuickBooks, spreadsheets) already have these.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.xlsx,.xls"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && onFilePicked(e.target.files[0])}
          />
        </Card>
      )}

      {step === 'map' && inspect && (
        <Card className="p-5">
          <div className="mb-3 flex items-center gap-2">
            <FileCsv size={16} className="text-muted-foreground" />
            <p className="text-sm font-semibold">{file?.name}</p>
            <span className="text-xs text-muted-foreground">· {inspect.rowCount} rows</span>
          </div>
          {inspect.note && <p className="mb-3 text-xs text-muted-foreground">{inspect.note}</p>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {FIELDS.map((f) => (
              <label key={f.key} className="flex flex-col gap-1 text-sm text-muted-foreground">
                {f.label}{f.required && <span className="text-primary">*</span>}
                <select
                  value={mapping[f.key] ?? ''}
                  onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value || undefined })}
                  className={selectCls}
                >
                  <option value="">— not in this file —</option>
                  {inspect.headers.map((h) => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <p className="mt-3 text-xs text-muted-foreground/70">
            Every row needs a total, and either a customer name or a customer email. Everything else is optional —
            a missing invoice number just gets a new one assigned; a missing status is worked out from the amount paid.
          </p>
          <div className="mt-4 flex items-center gap-3">
            <Button variant="ghost" onClick={() => setStep('pick')}>Back</Button>
            <Button onClick={onPreview} disabled={busy || !mapping.total}>
              {busy ? 'Checking…' : 'Preview import'}
            </Button>
          </div>
        </Card>
      )}

      {step === 'preview' && preview && (
        <div className="flex flex-col gap-4">
          <Card className="p-5">
            <p className="text-sm font-semibold">
              {preview.acceptedCount} invoice{preview.acceptedCount === 1 ? '' : 's'} ·{' '}
              {preview.customersNew + preview.customersLinked} customer{preview.customersNew + preview.customersLinked === 1 ? '' : 's'}{' '}
              ({preview.customersNew} new, {preview.customersLinked} linked) ·{' '}
              {formatMoney(preview.totalAmount)} total · {formatMoney(preview.outstandingAmount)} outstanding
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Will import" value={preview.acceptedCount} />
              <Stat label="Already imported" value={preview.alreadyImported} />
              <Stat label="Rejected" value={preview.rejectedCount} tone={preview.rejectedCount > 0 ? 'destructive' : undefined} />
              <Stat label="Rows in file" value={preview.totalRows} />
            </div>
          </Card>

          {preview.rejections.length > 0 && (
            <Card className="p-0">
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <p className="text-sm font-semibold">Rejected rows ({preview.rejections.length})</p>
                <button
                  onClick={() => downloadRejectedRowsCsv(preview.rejections)}
                  className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                >
                  <DownloadSimple size={13} weight="bold" /> Download list
                </button>
              </div>
              <ul className="max-h-64 divide-y divide-border overflow-y-auto">
                {preview.rejections.slice(0, 20).map((r) => (
                  <li key={r.line} className="px-4 py-2 text-xs text-muted-foreground">
                    Line {r.line} ({r.customer}): {r.reason}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <div className="flex items-center gap-3">
            <Button variant="ghost" onClick={() => setStep('map')}>Back</Button>
            <Button onClick={onCommit} disabled={busy || preview.acceptedCount === 0}>
              {busy ? 'Importing…' : `Import ${preview.acceptedCount} invoice${preview.acceptedCount === 1 ? '' : 's'}`}
            </Button>
          </div>
        </div>
      )}

      {step === 'done' && commitResult && (
        <Card className="flex flex-col items-center gap-3 p-8 text-center">
          <CheckCircle size={32} weight="fill" className="text-success" />
          <p className="text-sm font-semibold">
            Imported {commitResult.created} invoice{commitResult.created === 1 ? '' : 's'}
          </p>
          <p className="max-w-md text-sm text-muted-foreground">
            {commitResult.partiesCreated} new customer{commitResult.partiesCreated === 1 ? '' : 's'},{' '}
            {commitResult.partiesLinked} linked to an existing customer, {commitResult.paymentsRecorded} payment
            {commitResult.paymentsRecorded === 1 ? '' : 's'} recorded · {formatMoney(commitResult.totalAmount)} total ·{' '}
            {formatMoney(commitResult.outstandingAmount)} now outstanding.
            {commitResult.alreadyImported > 0 && ` ${commitResult.alreadyImported} row(s) were already imported and skipped.`}
          </p>
          {commitResult.rejectedCount > 0 && (
            <button
              onClick={() => downloadRejectedRowsCsv(commitResult.rejections)}
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              <DownloadSimple size={13} weight="bold" /> Download the {commitResult.rejectedCount} rejected row(s)
            </button>
          )}
          <Link href="/operate/invoices" className="mt-2">
            <Button>Go to Invoices</Button>
          </Link>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'destructive' }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`font-mono text-xl font-semibold tabular-nums ${tone === 'destructive' ? 'text-destructive' : ''}`}>{value}</p>
    </div>
  );
}
