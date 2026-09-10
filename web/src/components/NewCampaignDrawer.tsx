'use client';

import { useState } from 'react';
import { mutate } from 'swr';
import { apiFetch, ApiError } from '@/lib/api';
import type { GrowCampaign } from '@/lib/types';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerFooter } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';

const CAMPAIGNS_KEY = '/grow/campaigns';

const inputCls =
  'min-h-[42px] w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';
const labelCls = 'flex flex-col gap-1 text-sm text-muted-foreground';

interface FormState {
  name: string;
  timezone: string;
  window_start: string;
  window_end: string;
  weekdays_only: boolean;
  daily_target: string;
}

const INITIAL: FormState = {
  name: '',
  timezone: 'America/New_York',
  window_start: '08:30',
  window_end: '15:30',
  weekdays_only: true,
  daily_target: '100',
};

export function NewCampaignDrawer({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the new campaign's id once it's saved — the caller decides
   *  where to go next (straight to its sequence-step editor). */
  onCreated: (campaignId: string) => void;
}) {
  const [form, setForm] = useState<FormState>(INITIAL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setForm(INITIAL);
    setError(null);
  }

  async function onSave() {
    if (!form.name.trim()) {
      setError('Name is required.');
      return;
    }
    const dailyTarget = Number(form.daily_target);
    if (!Number.isInteger(dailyTarget) || dailyTarget < 1) {
      setError('Daily target must be a whole number of at least 1.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const campaign = await apiFetch<GrowCampaign>(CAMPAIGNS_KEY, {
        method: 'POST',
        body: JSON.stringify({
          name: form.name.trim(),
          timezone: form.timezone.trim() || 'America/New_York',
          window_start: form.window_start,
          window_end: form.window_end,
          weekdays_only: form.weekdays_only,
          daily_target: dailyTarget,
        }),
      });
      await mutate(CAMPAIGNS_KEY);
      onCreated(campaign.id);
      onOpenChange(false);
      reset();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create this campaign.');
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
          <DrawerTitle>New campaign</DrawerTitle>
        </DrawerHeader>

        <div className="flex flex-1 flex-col gap-4">
          <label className={labelCls}>
            Name<span className="text-primary">*</span>
            <input
              autoFocus
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Fall outreach — South Florida"
              className={inputCls}
            />
          </label>
          <label className={labelCls}>
            Timezone
            <input
              value={form.timezone}
              onChange={(e) => setForm({ ...form, timezone: e.target.value })}
              placeholder="America/New_York"
              className={inputCls}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className={labelCls}>
              Window start
              <input
                type="time"
                value={form.window_start}
                onChange={(e) => setForm({ ...form, window_start: e.target.value })}
                className={inputCls}
              />
            </label>
            <label className={labelCls}>
              Window end
              <input
                type="time"
                value={form.window_end}
                onChange={(e) => setForm({ ...form, window_end: e.target.value })}
                className={inputCls}
              />
            </label>
          </div>
          <label className={labelCls}>
            Daily target
            <input
              type="number"
              min={1}
              value={form.daily_target}
              onChange={(e) => setForm({ ...form, daily_target: e.target.value })}
              className={`${inputCls} font-mono tabular-nums`}
            />
          </label>
          <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={form.weekdays_only}
              onChange={(e) => setForm({ ...form, weekdays_only: e.target.checked })}
            />
            Weekdays only
          </label>
          <p className="text-xs text-muted-foreground">
            Starts in <span className="font-medium text-foreground">draft</span> — you&apos;ll write the send
            sequence next, and start it whenever it&apos;s ready.
          </p>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DrawerFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={busy}>
            {busy ? 'Creating…' : 'Create campaign'}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
