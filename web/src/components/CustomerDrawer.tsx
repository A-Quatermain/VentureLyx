'use client';

import { useState } from 'react';
import { mutate } from 'swr';
import { apiFetch, ApiError } from '@/lib/api';
import type { ContactChannel, Lifecycle, Party, PartyContact } from '@/lib/types';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerFooter } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';

const LIFECYCLES: Lifecycle[] = ['new', 'working', 'qualified', 'customer', 'lost', 'dormant'];

interface FormState {
  display_name: string;
  company_name: string;
  phone: string;
  email: string;
  city: string;
  lifecycle: Lifecycle;
  is_lead: boolean;
  is_customer: boolean;
  notes: string;
}

function toFormState(party?: Party, contacts?: PartyContact[]): FormState {
  const phone = contacts?.find((c) => c.channel === 'phone' && c.is_primary)?.value ?? '';
  const email = contacts?.find((c) => c.channel === 'email' && c.is_primary)?.value ?? '';
  return {
    display_name: party?.display_name ?? '',
    company_name: party?.company_name ?? '',
    phone,
    email,
    city: party?.city ?? '',
    lifecycle: party?.lifecycle ?? 'new',
    is_lead: party?.is_lead ?? true,
    is_customer: party?.is_customer ?? false,
    notes: party?.notes ?? '',
  };
}

// Creates or updates the one primary contact for a channel. A drawer field
// is a single text box, but contacts are their own sub-resource
// (docs/OPERATE-SPEC.md's POST/PATCH/DELETE /parties/contacts endpoints) —
// this reconciles the two without ever creating a duplicate primary.
async function syncContact(partyId: string, channel: ContactChannel, existing: PartyContact[], rawValue: string) {
  const value = rawValue.trim();
  const current = existing.find((c) => c.channel === channel && c.is_primary);
  if (!value) {
    if (current) await apiFetch(`/operate/parties/contacts/${current.id}`, { method: 'DELETE' });
    return;
  }
  if (current) {
    if (current.value !== value) {
      await apiFetch(`/operate/parties/contacts/${current.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ value }),
      });
    }
  } else {
    await apiFetch(`/operate/parties/${partyId}/contacts`, {
      method: 'POST',
      body: JSON.stringify({ channel, value, is_primary: true }),
    });
  }
}

const inputCls =
  'min-h-[42px] w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';
const labelCls = 'flex flex-col gap-1 text-sm text-muted-foreground';

export function CustomerDrawer({
  open,
  onOpenChange,
  party,
  contacts,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Omit for "add customer"; pass the existing record for "edit". */
  party?: Party;
  contacts?: PartyContact[];
  onSaved: (partyId: string) => void;
}) {
  const [form, setForm] = useState<FormState>(() => toFormState(party, contacts));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isEdit = !!party;

  function reset() {
    setForm(toFormState(party, contacts));
    setError(null);
  }

  async function onSave() {
    if (!form.display_name.trim()) {
      setError('Name is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload = {
        display_name: form.display_name.trim(),
        company_name: form.company_name.trim() || null,
        city: form.city.trim() || null,
        lifecycle: form.lifecycle,
        is_lead: form.is_lead,
        is_customer: form.is_customer,
        notes: form.notes.trim() || null,
      };

      const partyId = isEdit
        ? party!.id
        : (await apiFetch<Party>('/operate/parties', { method: 'POST', body: JSON.stringify(payload) })).id;

      if (isEdit) {
        await apiFetch(`/operate/parties/${partyId}`, { method: 'PATCH', body: JSON.stringify(payload) });
      }

      await Promise.all([
        syncContact(partyId, 'phone', contacts ?? [], form.phone),
        syncContact(partyId, 'email', contacts ?? [], form.email),
      ]);

      await mutate((key: string) => typeof key === 'string' && key.startsWith('/operate/parties'), undefined, {
        revalidate: true,
      });
      onSaved(partyId);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save this customer.');
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
          <DrawerTitle>{isEdit ? 'Edit customer' : 'Add customer'}</DrawerTitle>
        </DrawerHeader>

        <div className="flex flex-1 flex-col gap-4">
          <label className={labelCls}>
            Name<span className="text-primary">*</span>
            <input
              autoFocus
              value={form.display_name}
              onChange={(e) => setForm({ ...form, display_name: e.target.value })}
              className={inputCls}
            />
          </label>
          <label className={labelCls}>
            Company
            <input
              value={form.company_name}
              onChange={(e) => setForm({ ...form, company_name: e.target.value })}
              className={inputCls}
            />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className={labelCls}>
              Phone
              <input
                type="tel"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                className={inputCls}
              />
            </label>
            <label className={labelCls}>
              Email
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
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
              Lifecycle
              <select
                value={form.lifecycle}
                onChange={(e) => setForm({ ...form, lifecycle: e.target.value as Lifecycle })}
                className={inputCls}
              >
                {LIFECYCLES.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex gap-5">
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={form.is_lead}
                onChange={(e) => setForm({ ...form, is_lead: e.target.checked })}
              />
              Lead
            </label>
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <input
                type="checkbox"
                checked={form.is_customer}
                onChange={(e) => setForm({ ...form, is_customer: e.target.checked })}
              />
              Customer
            </label>
          </div>
          <label className={`${labelCls} flex-1`}>
            Notes
            <textarea
              rows={4}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              className={`${inputCls} min-h-[100px] resize-none py-2`}
            />
          </label>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DrawerFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={busy}>
            {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Add customer'}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
