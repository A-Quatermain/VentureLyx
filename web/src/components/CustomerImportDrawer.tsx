'use client';

import { useRef, useState } from 'react';
import { mutate } from 'swr';
import { apiFetch, ApiError } from '@/lib/api';
import type { CustomerImportResult } from '@/lib/types';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerFooter } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';

// Deliberately simple next to Grow's contact importer: a fixed set of
// columns matched by alias (name/email/phone/city/company), no mapping
// screen. A customer list is usually imported once; Grow's richer pipeline
// exists for repeated marketing-contact imports with many optional fields.
export function CustomerImportDrawer({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported?: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CustomerImportResult | null>(null);

  function reset() {
    setFile(null);
    setError(null);
    setResult(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  async function onImport() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await apiFetch<CustomerImportResult>('/operate/customers/import', { method: 'POST', body: form });
      setResult(res);
      await mutate((key: string) => typeof key === 'string' && key.startsWith('/operate/parties'), undefined, {
        revalidate: true,
      });
      onImported?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not import this file.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Import customers</DrawerTitle>
        </DrawerHeader>

        <div className="flex flex-1 flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            A CSV or Excel file with a <span className="font-medium text-foreground">Name</span> column, plus
            any of Email, Phone, City, or Company. Each row becomes a customer.
          </p>

          <input
            ref={inputRef}
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setResult(null);
              setError(null);
            }}
            className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-lg file:border-0 file:bg-primary/10 file:px-3 file:py-2 file:text-sm file:font-medium file:text-primary hover:file:bg-primary/20"
          />

          {error && <p className="text-sm text-destructive">{error}</p>}

          {result && (
            <div className="rounded-lg bg-muted p-3 text-sm">
              <p className="font-medium text-foreground">
                Imported {result.imported} customer{result.imported === 1 ? '' : 's'}.
              </p>
              {result.skipped.length > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Skipped {result.skipped.length} row{result.skipped.length === 1 ? '' : 's'}:{' '}
                  {result.skipped
                    .slice(0, 3)
                    .map((s) => `line ${s.line} (${s.reason})`)
                    .join(', ')}
                  {result.skipped.length > 3 ? '…' : ''}
                </p>
              )}
            </div>
          )}
        </div>

        <DrawerFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {result ? 'Close' : 'Cancel'}
          </Button>
          {!result && (
            <Button onClick={onImport} disabled={!file || busy}>
              {busy ? 'Importing…' : 'Import'}
            </Button>
          )}
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
