'use client';

import { useState } from 'react';
import { mutate } from 'swr';
import { Trash } from '@phosphor-icons/react';
import { apiFetch, ApiError } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import type { PartyListItem } from '@/lib/types';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerFooter } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';

const inputCls =
  'min-h-[42px] w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';
const labelCls = 'flex flex-col gap-1 text-sm text-muted-foreground';

interface LineForm {
  description: string;
  quantity: string;
  unit_price: string;
}

const BLANK_LINE: LineForm = { description: '', quantity: '1', unit_price: '' };

export function InvoiceDrawer({
  open,
  onOpenChange,
  partyId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-filled when opened from a customer's own page; omitted on the standalone Invoices page, which shows a picker instead. */
  partyId?: string;
  onSaved?: () => void;
}) {
  const { data: parties } = useApi<PartyListItem[]>(partyId ? null : '/operate/parties?page=1');
  const [selectedParty, setSelectedParty] = useState('');
  const [dueOn, setDueOn] = useState('');
  const [lines, setLines] = useState<LineForm[]>([{ ...BLANK_LINE }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const total = lines.reduce((sum, l) => sum + (Number(l.quantity) || 0) * (Number(l.unit_price) || 0), 0);

  function reset() {
    setSelectedParty('');
    setDueOn('');
    setLines([{ ...BLANK_LINE }]);
    setError(null);
  }

  function updateLine(i: number, patch: Partial<LineForm>) {
    setLines(lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }

  async function onSave() {
    const party = partyId ?? selectedParty;
    if (!party) {
      setError('Pick a customer.');
      return;
    }
    const cleanLines = lines
      .filter((l) => l.description.trim() && Number(l.unit_price) >= 0)
      .map((l) => ({
        description: l.description.trim(),
        quantity: Number(l.quantity) || 1,
        unit_price: Number(l.unit_price) || 0,
      }));
    if (cleanLines.length === 0) {
      setError('Add at least one line with a description and price.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/operate/invoices', {
        method: 'POST',
        body: JSON.stringify({ party_id: party, due_on: dueOn || null, lines: cleanLines }),
      });
      await mutate((key: string) => typeof key === 'string' && key.startsWith('/operate/invoices'), undefined, { revalidate: true });
      await mutate((key: string) => typeof key === 'string' && key.startsWith('/operate/parties/'), undefined, { revalidate: true });
      await mutate('/operate/money');
      reset();
      onOpenChange(false);
      onSaved?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create this invoice.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer open={open} onOpenChange={(next) => { if (!next) reset(); onOpenChange(next); }}>
      <DrawerContent className="max-w-lg">
        <DrawerHeader>
          <DrawerTitle>New invoice</DrawerTitle>
        </DrawerHeader>

        <div className="flex flex-1 flex-col gap-4">
          {!partyId && (
            <label className={labelCls}>
              Customer<span className="text-primary">*</span>
              <select value={selectedParty} onChange={(e) => setSelectedParty(e.target.value)} className={inputCls}>
                <option value="">Select a customer…</option>
                {(parties ?? []).map((p) => (
                  <option key={p.id} value={p.id}>{p.display_name}</option>
                ))}
              </select>
            </label>
          )}
          <label className={labelCls}>
            Due date
            <input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} className={inputCls} />
            <span className="text-xs text-muted-foreground/70">Leave blank for 30 days after sending.</span>
          </label>

          <div className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">Line items</p>
            {lines.map((line, i) => (
              <div key={i} className="flex items-start gap-2">
                <input
                  value={line.description}
                  onChange={(e) => updateLine(i, { description: e.target.value })}
                  placeholder="Description"
                  className={`${inputCls} flex-1`}
                />
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={line.quantity}
                  onChange={(e) => updateLine(i, { quantity: e.target.value })}
                  className={`${inputCls} w-16`}
                  title="Quantity"
                />
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={line.unit_price}
                  onChange={(e) => updateLine(i, { unit_price: e.target.value })}
                  placeholder="Price"
                  className={`${inputCls} w-24`}
                />
                <button
                  type="button"
                  onClick={() => setLines(lines.length > 1 ? lines.filter((_, idx) => idx !== i) : lines)}
                  className="flex min-h-[42px] w-8 shrink-0 items-center justify-center text-muted-foreground hover:text-destructive"
                >
                  <Trash size={14} />
                </button>
              </div>
            ))}
            <Button variant="ghost" onClick={() => setLines([...lines, { ...BLANK_LINE }])} className="self-start">
              + Add line
            </Button>
          </div>

          <div className="flex items-center justify-between border-t border-border pt-3 text-sm font-semibold">
            <span>Total</span>
            <span className="font-mono tabular-nums">${total.toFixed(2)}</span>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DrawerFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={onSave} disabled={busy}>{busy ? 'Creating…' : 'Create invoice'}</Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
