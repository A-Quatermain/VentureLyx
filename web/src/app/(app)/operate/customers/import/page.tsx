'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { mutate } from 'swr';
import { CaretLeft, CheckCircle, WarningCircle } from '@phosphor-icons/react';
import { apiFetch, ApiError } from '@/lib/api';
import type {
  CustomerImportInspectResponse, CustomerImportMapping, CustomerImportPreviewResponse,
  CustomerImportCommitResponse, CustomerImportField, GenericImportRejection,
} from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { PageHeader } from '@/components/Primitives';
import {
  type ImportStep, ImportStepIndicator, ImportDropZone, ImportStat, ImportDownloadLink,
  buildImportFormData, downloadRejectionsCsv, importSelectCls,
} from '@/components/ImportFlowShared';

const FIELDS: Array<{ key: CustomerImportField; label: string; required?: boolean }> = [
  { key: 'name', label: 'Name' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone' },
  { key: 'company', label: 'Company' },
  { key: 'address', label: 'Address' },
  { key: 'city', label: 'City' },
  { key: 'lifecycle', label: 'Lifecycle (new/working/qualified/customer/lost/dormant)' },
];

function downloadRejected(rejections: GenericImportRejection[]) {
  downloadRejectionsCsv(
    rejections,
    [{ key: 'line', header: 'line' }, { key: 'label', header: 'customer' }, { key: 'reason', header: 'reason' }],
    'rejected-customer-rows.csv',
  );
}

export default function ImportCustomersPage() {
  const [step, setStep] = useState<ImportStep>('pick');
  const [file, setFile] = useState<File | null>(null);
  const [inspect, setInspect] = useState<CustomerImportInspectResponse | null>(null);
  const [mapping, setMapping] = useState<CustomerImportMapping>({});
  const [preview, setPreview] = useState<CustomerImportPreviewResponse | null>(null);
  const [commitResult, setCommitResult] = useState<CustomerImportCommitResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function onFilePicked(f: File) {
    setFile(f);
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<CustomerImportInspectResponse>('/operate/customers/import/inspect', {
        method: 'POST', body: buildImportFormData(f),
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
      const res = await apiFetch<CustomerImportPreviewResponse>('/operate/customers/import/preview', {
        method: 'POST', body: buildImportFormData(file, mapping),
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
      const res = await apiFetch<CustomerImportCommitResponse>('/operate/customers/import/commit', {
        method: 'POST', body: buildImportFormData(file, mapping),
      });
      setCommitResult(res);
      setStep('done');
      await mutate((k: string) => typeof k === 'string' && (k.startsWith('/operate/parties') || k === '/command/summary' || k === '/setup/progress'), undefined, { revalidate: true });
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
        title="Import customers"
        subtitle="Bring your existing customer list in from a spreadsheet."
        actions={
          <Link href="/operate/customers" className="inline-flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground">
            <CaretLeft size={14} weight="bold" /> Customers
          </Link>
        }
      />

      <ImportStepIndicator current={step} />
      {error && (
        <Card className="mb-4 flex items-center gap-2 border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <WarningCircle size={16} weight="fill" /> {error}
        </Card>
      )}

      {step === 'pick' && (
        <ImportDropZone
          busy={busy}
          inputRef={fileInputRef}
          onPick={onFilePicked}
          hint="Name or email, plus phone, company, address, and city if you have them — most spreadsheet exports already have these."
        />
      )}

      {step === 'map' && inspect && (
        <Card className="p-5">
          <p className="mb-3 text-sm font-semibold">{file?.name} <span className="text-xs text-muted-foreground">· {inspect.rowCount} rows</span></p>
          {inspect.note && <p className="mb-3 text-xs text-muted-foreground">{inspect.note}</p>}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {FIELDS.map((f) => (
              <label key={f.key} className="flex flex-col gap-1 text-sm text-muted-foreground">
                {f.label}
                <select
                  value={mapping[f.key] ?? ''}
                  onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value || undefined })}
                  className={importSelectCls}
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
            Every row needs a name or an email. Everything else is optional — an existing customer gets matched
            and filled in, never overwritten.
          </p>
          <div className="mt-4 flex items-center gap-3">
            <Button variant="ghost" onClick={() => setStep('pick')}>Back</Button>
            <Button onClick={onPreview} disabled={busy || (!mapping.name && !mapping.email)}>
              {busy ? 'Checking…' : 'Preview import'}
            </Button>
          </div>
        </Card>
      )}

      {step === 'preview' && preview && (
        <div className="flex flex-col gap-4">
          <Card className="p-5">
            <p className="text-sm font-semibold">
              {preview.acceptedCount} customer{preview.acceptedCount === 1 ? '' : 's'} ·{' '}
              {preview.customersNew} new, {preview.customersLinked} linked to an existing customer
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <ImportStat label="Will import" value={preview.acceptedCount} />
              <ImportStat label="New" value={preview.customersNew} />
              <ImportStat label="Linked" value={preview.customersLinked} />
              <ImportStat label="Rejected" value={preview.rejectedCount} tone={preview.rejectedCount > 0 ? 'destructive' : undefined} />
            </div>
          </Card>

          {preview.rejections.length > 0 && (
            <Card className="p-0">
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <p className="text-sm font-semibold">Rejected rows ({preview.rejections.length})</p>
                <ImportDownloadLink onClick={() => downloadRejected(preview.rejections)} count={preview.rejections.length} />
              </div>
              <ul className="max-h-64 divide-y divide-border overflow-y-auto">
                {preview.rejections.slice(0, 20).map((r) => (
                  <li key={r.line} className="px-4 py-2 text-xs text-muted-foreground">
                    Line {r.line} ({r.label}): {r.reason}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <div className="flex items-center gap-3">
            <Button variant="ghost" onClick={() => setStep('map')}>Back</Button>
            <Button onClick={onCommit} disabled={busy || preview.acceptedCount === 0}>
              {busy ? 'Importing…' : `Import ${preview.acceptedCount} customer${preview.acceptedCount === 1 ? '' : 's'}`}
            </Button>
          </div>
        </div>
      )}

      {step === 'done' && commitResult && (
        <Card className="flex flex-col items-center gap-3 p-8 text-center">
          <CheckCircle size={32} weight="fill" className="text-success" />
          <p className="text-sm font-semibold">
            {commitResult.created} new customer{commitResult.created === 1 ? '' : 's'}, {commitResult.linked} linked to an existing one
          </p>
          {commitResult.rejectedCount > 0 && (
            <ImportDownloadLink onClick={() => downloadRejected(commitResult.rejections)} count={commitResult.rejectedCount} />
          )}
          <Link href="/operate/customers" className="mt-2">
            <Button>Go to Customers</Button>
          </Link>
        </Card>
      )}
    </div>
  );
}
