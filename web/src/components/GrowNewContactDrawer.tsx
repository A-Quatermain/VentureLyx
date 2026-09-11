'use client';

import { useState } from 'react';
import { apiFetch, ApiError } from '@/lib/api';
import type { GrowContactCreateResponse } from '@/lib/types';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerFooter } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';

const inputCls =
  'min-h-[42px] w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';
const labelCls = 'flex flex-col gap-1 text-sm text-muted-foreground';

interface FormState {
  email: string;
  first_name: string;
  contact_name: string;
  role: string;
  entity_name: string;
  region: string;
  city: string;
  state: string;
  contact_rank: string;
  tier: string;
}

const INITIAL: FormState = {
  email: '', first_name: '', contact_name: '', role: '', entity_name: '',
  region: '', city: '', state: '', contact_rank: '1', tier: '',
};

/** A manual, one-at-a-time way to add a contact — for a test address, not a
 *  replacement for the CSV/XLSX import flow (still the only path for a real
 *  list). recipient_domain and is_free_provider are derived server-side
 *  from the email. */
export function GrowNewContactDrawer({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (contact: GrowContactCreateResponse) => void;
}) {
  const [form, setForm] = useState<FormState>(INITIAL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setForm(INITIAL);
    setError(null);
  }

  async function onSave() {
    if (!form.email.trim()) {
      setError('Email is required.');
      return;
    }
    const rank = Number(form.contact_rank);
    if (!Number.isInteger(rank) || rank < 1) {
      setError('Contact rank must be a whole number of at least 1.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const contact = await apiFetch<GrowContactCreateResponse>('/grow/contacts', {
        method: 'POST',
        body: JSON.stringify({
          email: form.email.trim(),
          first_name: form.first_name.trim() || undefined,
          contact_name: form.contact_name.trim() || undefined,
          role: form.role.trim() || undefined,
          entity_name: form.entity_name.trim() || undefined,
          region: form.region.trim() || undefined,
          city: form.city.trim() || undefined,
          state: form.state.trim() || undefined,
          contact_rank: rank,
          tier: form.tier.trim() || undefined,
        }),
      });
      onCreated(contact);
      onOpenChange(false);
      reset();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create this contact.');
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
          <DrawerTitle>New contact</DrawerTitle>
        </DrawerHeader>

        <div className="flex flex-1 flex-col gap-4">
          <label className={labelCls}>
            Email<span className="text-primary">*</span>
            <input
              autoFocus
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              placeholder="alex@example.com"
              className={inputCls}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className={labelCls}>
              First name
              <input
                value={form.first_name}
                onChange={(e) => setForm({ ...form, first_name: e.target.value })}
                className={inputCls}
              />
            </label>
            <label className={labelCls}>
              Contact name
              <input
                value={form.contact_name}
                onChange={(e) => setForm({ ...form, contact_name: e.target.value })}
                className={inputCls}
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className={labelCls}>
              Role
              <input
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value })}
                className={inputCls}
              />
            </label>
            <label className={labelCls}>
              Entity name
              <input
                value={form.entity_name}
                onChange={(e) => setForm({ ...form, entity_name: e.target.value })}
                className={inputCls}
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className={labelCls}>
              City
              <input
                value={form.city}
                onChange={(e) => setForm({ ...form, city: e.target.value })}
                className={inputCls}
              />
            </label>
            <label className={labelCls}>
              State
              <input
                value={form.state}
                onChange={(e) => setForm({ ...form, state: e.target.value })}
                className={inputCls}
              />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className={labelCls}>
              Region
              <input
                value={form.region}
                onChange={(e) => setForm({ ...form, region: e.target.value })}
                className={inputCls}
              />
            </label>
            <label className={labelCls}>
              Tier
              <input
                value={form.tier}
                onChange={(e) => setForm({ ...form, tier: e.target.value })}
                placeholder="e.g. A"
                className={inputCls}
              />
            </label>
          </div>
          <label className={labelCls}>
            Contact rank
            <input
              type="number"
              min={1}
              value={form.contact_rank}
              onChange={(e) => setForm({ ...form, contact_rank: e.target.value })}
              className={`${inputCls} w-24 font-mono tabular-nums`}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            Recipient domain and consumer-provider flagging are derived from the email automatically.
          </p>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DrawerFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={busy}>
            {busy ? 'Creating…' : 'Create contact'}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
