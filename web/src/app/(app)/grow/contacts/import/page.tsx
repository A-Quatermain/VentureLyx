'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import { mutate } from 'swr';
import {
  UploadSimple, FileCsv, CheckCircle, WarningCircle, CaretLeft, Plus, Trash, ArrowRight,
} from '@phosphor-icons/react';
import { apiFetch, ApiError } from '@/lib/api';
import type {
  GrowImportInspectResponse, GrowImportMapping, GrowImportPreviewResponse, GrowImportCommitResponse,
} from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

type Step = 'pick' | 'map' | 'preview' | 'done';

const PERSON_FIELDS = [
  { key: 'email', label: 'Email', required: true },
  { key: 'first_name', label: 'First name', required: false },
  { key: 'contact_name', label: 'Contact name', required: false },
  { key: 'role', label: 'Role', required: false },
  { key: 'phone', label: 'Phone', required: false },
] as const;

const ORG_FIELDS = [
  { key: 'entity_name', label: 'Organization name' },
  { key: 'external_id', label: 'External ID' },
  { key: 'region', label: 'Region' },
  { key: 'city', label: 'City' },
  { key: 'state', label: 'State' },
  { key: 'tier', label: 'Tier' },
  { key: 'enrollment', label: 'Enrollment' },
  { key: 'is_chain', label: 'Is chain (multi-location)' },
  { key: 'domain_rank', label: 'Domain rank' },
  { key: 'is_free_provider', label: 'Is free provider' },
  { key: 'fes_eo', label: 'FES-EO scholarship' },
  { key: 'ftc', label: 'FTC scholarship' },
  { key: 'fes_ua', label: 'FES-UA scholarship' },
  { key: 'pep', label: 'PEP scholarship' },
  { key: 'non_profit', label: 'Non-profit' },
  { key: 'religious', label: 'Religious affiliation' },
  { key: 'recipient_domain', label: 'Recipient domain (derived from email if unmapped)' },
  { key: 'suppress_reason', label: 'Suppression reason (present = never imported)' },
  { key: 'sendable', label: 'Sendable flag ("False" = never imported)' },
] as const;

const STEPS: { key: Step; label: string }[] = [
  { key: 'pick', label: 'Upload' },
  { key: 'map', label: 'Map columns' },
  { key: 'preview', label: 'Preview' },
  { key: 'done', label: 'Done' },
];

const selectCls =
  'min-h-[38px] w-full rounded-lg border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';
const inputCls =
  'min-h-[38px] rounded-lg border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';

function buildFormData(file: File, mapping?: GrowImportMapping) {
  const fd = new FormData();
  fd.append('file', file, file.name);
  if (mapping) fd.append('mapping', JSON.stringify(mapping));
  return fd;
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
            {i < idx ? <CheckCircle size={13} weight="fill" /> : i + 1}
          </span>
          <span className={`text-xs font-medium ${i === idx ? 'text-foreground' : 'text-muted-foreground'}`}>{s.label}</span>
          {i < STEPS.length - 1 && <span className="mx-2 h-px w-6 bg-border" />}
        </div>
      ))}
    </div>
  );
}

function ColumnSelect({
  headers,
  value,
  onChange,
}: {
  headers: string[];
  value: string | null | undefined;
  onChange: (v: string) => void;
}) {
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value)} className={selectCls}>
      <option value="">— not mapped —</option>
      {headers.map((h) => (
        <option key={h} value={h}>{h}</option>
      ))}
    </select>
  );
}

export default function GrowContactsImportPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>('pick');
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [headers, setHeaders] = useState<string[]>([]);
  const [rowCount, setRowCount] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [usedSavedProfile, setUsedSavedProfile] = useState(false);
  const [mapping, setMapping] = useState<GrowImportMapping | null>(null);

  const [summary, setSummary] = useState<GrowImportPreviewResponse | null>(null);
  const [result, setResult] = useState<GrowImportCommitResponse | null>(null);

  async function onFileChosen(f: File) {
    setFile(f);
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<GrowImportInspectResponse>('/grow/contacts/import/inspect', {
        method: 'POST',
        body: buildFormData(f),
      });
      setHeaders(res.headers);
      setRowCount(res.rowCount);
      setNote(res.note);
      setUsedSavedProfile(res.usedSavedProfile);
      setMapping(res.suggestedMapping);
      setStep('map');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not read this file.');
    } finally {
      setBusy(false);
    }
  }

  function onDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) onFileChosen(f);
  }

  function setFormat(format: 'long' | 'wide') {
    setMapping((m) => {
      if (!m) return m;
      if (format === 'long') return { ...m, format, slots: [m.slots[0] ?? { label: 'Contact', rank: null, fields: {} }] };
      if (m.slots.length < 2) {
        return { ...m, format, slots: [...m.slots, { label: `Contact ${m.slots.length + 1}`, rank: m.slots.length + 1, fields: {} }] };
      }
      return { ...m, format };
    });
  }

  function setSharedField(field: string, column: string) {
    setMapping((m) => m && { ...m, shared: { ...m.shared, [field]: column || null } });
  }

  function setSlotField(slotIdx: number, field: string, column: string) {
    setMapping((m) => m && {
      ...m,
      slots: m.slots.map((s, i) => (i === slotIdx ? { ...s, fields: { ...s.fields, [field]: column || null } } : s)),
    });
  }

  function setSlotLabel(slotIdx: number, label: string) {
    setMapping((m) => m && { ...m, slots: m.slots.map((s, i) => (i === slotIdx ? { ...s, label } : s)) });
  }

  function setSlotRank(slotIdx: number, rank: number) {
    setMapping((m) => m && { ...m, slots: m.slots.map((s, i) => (i === slotIdx ? { ...s, rank } : s)) });
  }

  function addSlot() {
    setMapping((m) => m && {
      ...m,
      slots: [...m.slots, { label: `Contact ${m.slots.length + 1}`, rank: m.slots.length + 1, fields: {} }],
    });
  }

  function removeSlot(idx: number) {
    setMapping((m) => (m && m.slots.length > 1 ? { ...m, slots: m.slots.filter((_, i) => i !== idx) } : m));
  }

  async function onPreview() {
    if (!file || !mapping) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<GrowImportPreviewResponse>('/grow/contacts/import/preview', {
        method: 'POST',
        body: buildFormData(file, mapping),
      });
      setSummary(res);
      setStep('preview');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not preview this import.');
    } finally {
      setBusy(false);
    }
  }

  async function onCommit() {
    if (!file || !mapping) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<GrowImportCommitResponse>('/grow/contacts/import/commit', {
        method: 'POST',
        body: buildFormData(file, mapping),
      });
      setResult(res);
      setStep('done');
      await Promise.all([
        mutate((key: string) => typeof key === 'string' && key.startsWith('/grow/contacts'), undefined, { revalidate: true }),
        mutate('/grow/stats'),
      ]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not import this file.');
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setStep('pick');
    setFile(null);
    setError(null);
    setHeaders([]);
    setMapping(null);
    setSummary(null);
    setResult(null);
  }

  const missingRequired =
    mapping?.slots.some((s) => !s.fields.email) ?? true;

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <Link
            href="/grow/contacts"
            className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <CaretLeft size={14} weight="bold" /> Contacts
          </Link>
          <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">Import contacts</h1>
        </div>
      </div>

      <StepIndicator current={step} />

      {error && (
        <Card className="border-destructive/40 bg-destructive/5 p-4">
          <p className="text-sm text-destructive">{error}</p>
        </Card>
      )}

      {step === 'pick' && (
        <Card className="p-0">
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            className={`flex cursor-pointer flex-col items-center gap-3 rounded-xl border-2 border-dashed px-6 py-16 text-center transition-colors ${
              dragOver ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40'
            }`}
          >
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
              {busy ? (
                <UploadSimple size={26} weight="duotone" className="animate-pulse text-primary" />
              ) : (
                <FileCsv size={26} weight="duotone" className="text-primary" />
              )}
            </div>
            <div>
              <p className="text-sm font-medium">{busy ? 'Reading your file…' : 'Drop a CSV or Excel file here'}</p>
              <p className="mt-1 text-sm text-muted-foreground">or click to browse — .csv, .xlsx, .xls</p>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onFileChosen(f);
                e.target.value = '';
              }}
            />
          </div>
        </Card>
      )}

      {step === 'map' && mapping && (
        <>
          <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <p className="text-sm font-medium">{file?.name}</p>
              <p className="text-xs text-muted-foreground">
                {rowCount} row{rowCount === 1 ? '' : 's'} detected
                {usedSavedProfile && ' · using your saved mapping from a previous import'}
              </p>
              {note && <p className="mt-1 text-xs text-warning">{note}</p>}
            </div>
            <div className="flex gap-1 rounded-full border border-border bg-surface p-1 shadow-sm">
              <button
                onClick={() => setFormat('long')}
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                  mapping.format === 'long' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
                }`}
              >
                One contact per row
              </button>
              <button
                onClick={() => setFormat('wide')}
                className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                  mapping.format === 'wide' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
                }`}
              >
                Multiple contacts per row
              </button>
            </div>
          </Card>

          <Card className="p-0">
            <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
              <p className="text-sm font-semibold">
                {mapping.format === 'wide' ? 'Contact columns (one group per contact)' : 'Contact columns'}
              </p>
              {mapping.format === 'wide' && (
                <Button variant="ghost" onClick={addSlot}>
                  <Plus size={14} weight="bold" className="mr-1 inline" /> Add contact
                </Button>
              )}
            </div>
            <ul className="divide-y divide-border">
              {mapping.slots.map((slot, i) => (
                <li key={i} className="flex flex-col gap-3 p-4">
                  {mapping.format === 'wide' && (
                    <div className="flex flex-wrap items-end gap-3">
                      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        Label
                        <input
                          value={slot.label}
                          onChange={(e) => setSlotLabel(i, e.target.value)}
                          className={`${inputCls} w-40`}
                        />
                      </label>
                      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        Contact rank
                        <input
                          type="number"
                          min={1}
                          value={slot.rank ?? ''}
                          onChange={(e) => setSlotRank(i, Number(e.target.value))}
                          className={`${inputCls} w-24 font-mono tabular-nums`}
                        />
                      </label>
                      {mapping.slots.length > 1 && (
                        <Button variant="ghost" className="ml-auto" onClick={() => removeSlot(i)}>
                          <Trash size={14} />
                        </Button>
                      )}
                    </div>
                  )}
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    {PERSON_FIELDS.map((f) => (
                      <label key={f.key} className="flex flex-col gap-1 text-xs text-muted-foreground">
                        {f.label}{f.required && <span className="text-primary"> *</span>}
                        <ColumnSelect
                          headers={headers}
                          value={slot.fields[f.key]}
                          onChange={(v) => setSlotField(i, f.key, v)}
                        />
                      </label>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          <Card className="p-0">
            <div className="border-b border-border px-4 py-3">
              <p className="text-sm font-semibold">Organization columns (shared across every contact)</p>
            </div>
            <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
              {ORG_FIELDS.map((f) => (
                <label key={f.key} className="flex flex-col gap-1 text-xs text-muted-foreground">
                  {f.label}
                  <ColumnSelect
                    headers={headers}
                    value={mapping.shared[f.key]}
                    onChange={(v) => setSharedField(f.key, v)}
                  />
                </label>
              ))}
            </div>
          </Card>

          <div className="flex items-center justify-between">
            <Button variant="ghost" onClick={reset}>Choose a different file</Button>
            <Button onClick={onPreview} disabled={busy || missingRequired}>
              {busy ? 'Checking…' : 'Preview import'} <ArrowRight size={14} weight="bold" className="ml-1.5 inline" />
            </Button>
          </div>
          {missingRequired && (
            <p className="-mt-2 text-right text-xs text-muted-foreground">Map an Email column for every contact first.</p>
          )}
        </>
      )}

      {step === 'preview' && summary && (
        <>
          {summary.note && (
            <Card className="border-warning/40 bg-warning/5 p-4">
              <p className="text-sm text-warning">{summary.note}</p>
            </Card>
          )}

          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Card className="p-4 text-center">
              <p className="font-mono text-2xl font-semibold tabular-nums" data-numeric>{summary.totalRows}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">Rows read</p>
            </Card>
            <Card className="p-4 text-center">
              <p className="font-mono text-2xl font-semibold tabular-nums text-success" data-numeric>{summary.acceptedCount}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">Will import</p>
            </Card>
            <Card className="p-4 text-center">
              <p className="font-mono text-2xl font-semibold tabular-nums text-destructive" data-numeric>{summary.rejectedCount}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">Rejected</p>
            </Card>
            <Card className="p-4 text-center">
              <p className="font-mono text-2xl font-semibold tabular-nums" data-numeric>{summary.uniqueDomains}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">Unique domains</p>
            </Card>
          </div>

          <Card className="p-0">
            <div className="border-b border-border px-4 py-3">
              <p className="text-sm font-semibold">By tier</p>
            </div>
            {summary.byTier.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">No tier data on the rows being imported.</p>
            ) : (
              <ul className="divide-y divide-border">
                {summary.byTier.map((t) => (
                  <li key={t.tier} className="flex items-center justify-between px-4 py-2 text-sm">
                    <span>{t.tier}</span>
                    <span className="font-mono tabular-nums text-muted-foreground" data-numeric>{t.count}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {summary.rejectionsByCode.length > 0 && (
            <Card className="p-0">
              <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                <WarningCircle size={16} className="text-destructive" />
                <p className="text-sm font-semibold">Rejected rows, by reason</p>
              </div>
              <ul className="divide-y divide-border">
                {summary.rejectionsByCode.map((g) => (
                  <li key={g.code} className="p-4">
                    <p className="text-sm font-medium">
                      {g.code.replace(/_/g, ' ')} <span className="text-muted-foreground">— {g.count}</span>
                    </p>
                    <ul className="mt-1.5 space-y-0.5">
                      {g.examples.map((ex, i) => (
                        <li key={i} className="text-xs text-muted-foreground">
                          line {ex.line} ({ex.email}): {ex.detail}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <div className="flex items-center justify-between">
            <Button variant="ghost" onClick={() => setStep('map')}>← Back to mapping</Button>
            <Button onClick={onCommit} disabled={busy || summary.acceptedCount === 0}>
              {busy ? 'Importing…' : `Import ${summary.acceptedCount} contact${summary.acceptedCount === 1 ? '' : 's'}`}
            </Button>
          </div>
        </>
      )}

      {step === 'done' && result && (
        <Card className="flex flex-col items-center gap-3 p-10 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-success/10">
            <CheckCircle size={28} weight="fill" className="text-success" />
          </div>
          <h2 className="font-display text-xl font-bold tracking-tight">Import complete</h2>
          <p className="max-w-sm text-sm text-muted-foreground">
            <span className="font-mono tabular-nums text-foreground" data-numeric>{result.inserted}</span> new contact
            {result.inserted === 1 ? '' : 's'} added
            {result.alreadyExisted > 0 && `, ${result.alreadyExisted} already existed and were skipped`}
            {result.rejectedCount > 0 && `, ${result.rejectedCount} rejected`}.
            This mapping is now saved — the next import for this org starts pre-filled with it.
          </p>
          <div className="mt-2 flex items-center gap-3">
            <Button variant="ghost" onClick={reset}>Import another file</Button>
            <Link href="/grow/contacts">
              <Button>View contacts</Button>
            </Link>
          </div>
        </Card>
      )}
    </div>
  );
}
