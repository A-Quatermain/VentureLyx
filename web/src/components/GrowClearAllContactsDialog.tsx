'use client';

import { useState } from 'react';
import { WarningCircle } from '@phosphor-icons/react';
import { apiFetch, ApiError } from '@/lib/api';
import type { GrowClearAllContactsResponse } from '@/lib/types';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';

/** For undoing a bad import wholesale — refuses if a campaign is running or
 *  if the org has ever sent real mail (api/src/routes/grow.ts's clear-all
 *  guards), so the errors it can get back are specific, not generic. */
export function GrowClearAllContactsDialog({
  open,
  onOpenChange,
  orgName,
  onCleared,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgName: string;
  onCleared: (deleted: number) => void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setTyped('');
    setError(null);
  }

  async function onConfirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<GrowClearAllContactsResponse>('/grow/contacts/clear-all', {
        method: 'POST',
        body: JSON.stringify({ confirm: typed }),
      });
      onCleared(res.deleted);
      onOpenChange(false);
      reset();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not clear contacts.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) reset(); onOpenChange(next); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Clear all contacts</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-2.5 rounded-lg bg-destructive/10 px-3 py-2.5 text-sm text-destructive">
            <WarningCircle size={18} weight="fill" className="mt-0.5 shrink-0" />
            <p>
              This permanently deletes every contact for <span className="font-medium">{orgName}</span>, along with
              any enrollments still open. It&apos;s meant for undoing a bad import — it refuses if a campaign is
              running, or if this org has ever sent real mail.
            </p>
          </div>
          <label className="flex flex-col gap-1 text-sm text-muted-foreground">
            Type <span className="font-mono font-medium text-foreground">{orgName}</span> to confirm
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoFocus
              className="min-h-[42px] w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
          </label>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button variant="attention" onClick={onConfirm} disabled={busy || typed.trim() !== orgName}>
            {busy ? 'Clearing…' : 'Clear all contacts'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
