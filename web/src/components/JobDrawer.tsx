'use client';

import { useState } from 'react';
import { mutate } from 'swr';
import { apiFetch, ApiError } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import type { PartyListItem } from '@/lib/types';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerFooter } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';

const inputCls =
  'min-h-[42px] w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';
const labelCls = 'flex flex-col gap-1 text-sm text-muted-foreground';

// toLocalInput/fromLocalInput: <input type="datetime-local"> wants and
// returns "YYYY-MM-DDTHH:mm" with no timezone; the API wants a real ISO
// datetime (zod's z.string().datetime()). New Date(...).toISOString()
// round-trips through UTC, which is the simplest correct thing a v1 job
// scheduler needs — per-timezone display can follow later.
function toIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function JobDrawer({
  open,
  onOpenChange,
  partyId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-filled when opened from a customer's own page; omitted on the standalone Jobs page, which shows a picker instead. */
  partyId?: string;
  onSaved?: () => void;
}) {
  const { data: parties } = useApi<PartyListItem[]>(partyId ? null : '/operate/parties?page=1');
  const [selectedParty, setSelectedParty] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [scheduledStart, setScheduledStart] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setSelectedParty('');
    setTitle('');
    setDescription('');
    setScheduledStart('');
    setError(null);
  }

  async function onSave() {
    const party = partyId ?? selectedParty;
    if (!party) {
      setError('Pick a customer.');
      return;
    }
    if (!title.trim()) {
      setError('Title is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/operate/jobs', {
        method: 'POST',
        body: JSON.stringify({
          party_id: party,
          title: title.trim(),
          description: description.trim() || null,
          scheduled_start: toIso(scheduledStart),
        }),
      });
      await mutate((key: string) => typeof key === 'string' && key.startsWith('/operate/jobs'), undefined, { revalidate: true });
      await mutate((key: string) => typeof key === 'string' && key.startsWith('/operate/parties/'), undefined, { revalidate: true });
      await mutate('/operate/schedule');
      reset();
      onOpenChange(false);
      onSaved?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create this job.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer open={open} onOpenChange={(next) => { if (!next) reset(); onOpenChange(next); }}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>New job</DrawerTitle>
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
            Title<span className="text-primary">*</span>
            <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} placeholder="Pool heater repair" />
          </label>
          <label className={labelCls}>
            Scheduled for
            <input type="datetime-local" value={scheduledStart} onChange={(e) => setScheduledStart(e.target.value)} className={inputCls} />
          </label>
          <label className={`${labelCls} flex-1`}>
            Notes
            <textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} className={`${inputCls} min-h-[100px] resize-none py-2`} />
          </label>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DrawerFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={onSave} disabled={busy}>{busy ? 'Creating…' : 'Create job'}</Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
