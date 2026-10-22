'use client';

import { useState } from 'react';
import { mutate } from 'swr';
import { apiFetch, ApiError } from '@/lib/api';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerFooter } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';

const inputCls =
  'min-h-[42px] w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';
const labelCls = 'flex flex-col gap-1 text-sm text-muted-foreground';

const KINDS = ['note', 'call', 'email', 'meeting'] as const;

export function ActivityDrawer({
  open,
  onOpenChange,
  partyId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  partyId: string;
}) {
  const [kind, setKind] = useState<typeof KINDS[number]>('note');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setKind('note');
    setBody('');
    setError(null);
  }

  async function onSave() {
    if (!body.trim()) {
      setError('Say what happened.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`/operate/parties/${partyId}/activity`, {
        method: 'POST',
        body: JSON.stringify({ kind, body: body.trim() }),
      });
      await mutate(`/operate/parties/${partyId}`);
      await mutate(`/operate/parties/${partyId}/timeline`);
      reset();
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not log this activity.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer open={open} onOpenChange={(next) => { if (!next) reset(); onOpenChange(next); }}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Log activity</DrawerTitle>
        </DrawerHeader>

        <div className="flex flex-1 flex-col gap-4">
          <label className={labelCls}>
            Type
            <select value={kind} onChange={(e) => setKind(e.target.value as typeof KINDS[number])} className={inputCls}>
              {KINDS.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
          </label>
          <label className={`${labelCls} flex-1`}>
            What happened?
            <textarea
              autoFocus
              rows={5}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className={`${inputCls} min-h-[120px] resize-none py-2`}
              placeholder="Called to confirm appointment time, left voicemail."
            />
          </label>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DrawerFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button onClick={onSave} disabled={busy}>{busy ? 'Saving…' : 'Log it'}</Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
