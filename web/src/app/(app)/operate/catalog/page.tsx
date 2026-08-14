'use client';

import { useState } from 'react';
import Link from 'next/link';
import { mutate } from 'swr';
import { useApi, useRole, atLeast } from '@/lib/useApi';
import { apiFetch, ApiError } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import type { CatalogItem, CatalogKind } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { SkeletonCard } from '@/components/ui/Skeleton';

const KINDS: CatalogKind[] = ['service', 'product', 'package', 'fee'];
const CATALOG_KEY = '/operate/catalog';

interface FormState {
  kind: CatalogKind;
  name: string;
  description: string;
  unit: string;
  unit_price: string;
  taxable: boolean;
  is_active: boolean;
}

const BLANK_FORM: FormState = {
  kind: 'service',
  name: '',
  description: '',
  unit: 'each',
  unit_price: '',
  taxable: true,
  is_active: true,
};

function toPayload(f: FormState) {
  return {
    kind: f.kind,
    name: f.name,
    description: f.description || null,
    unit: f.unit,
    unit_price: f.unit_price === '' ? null : Number(f.unit_price),
    taxable: f.taxable,
    is_active: f.is_active,
  };
}

export default function CatalogPage() {
  const { data: items, isLoading, error } = useApi<CatalogItem[]>(CATALOG_KEY);
  const role = useRole();
  const canEdit = atLeast(role, 'staff');
  const canDelete = atLeast(role, 'manager');

  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-display text-lg font-bold text-deepwater">Catalog</p>
          <p className="text-sm text-ink-2">What the business sells — feeds job and invoice lines.</p>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/operate" className="text-sm text-pool">
            ← Operate
          </Link>
          {canEdit && !adding && (
            <Button onClick={() => setAdding(true)}>Add item</Button>
          )}
        </div>
      </div>

      <Card className="overflow-x-auto p-0">
        {isLoading ? (
          <SkeletonCard />
        ) : error ? (
          <p className="p-4 text-sm text-alert">
            {error instanceof Error ? error.message : 'Could not load the catalog.'}
          </p>
        ) : (
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-line-2 text-xs text-ink-3">
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Kind</th>
                <th className="px-4 py-2 font-medium">Price</th>
                <th className="px-4 py-2 font-medium">Unit</th>
                <th className="px-4 py-2 font-medium">Taxable</th>
                <th className="px-4 py-2 font-medium">Active</th>
                {canEdit && <th className="px-4 py-2 font-medium" />}
              </tr>
            </thead>
            <tbody>
              {adding && (
                <CatalogFormRow
                  initial={BLANK_FORM}
                  onCancel={() => setAdding(false)}
                  onSaved={() => setAdding(false)}
                  columns={canEdit ? 7 : 6}
                />
              )}
              {(items ?? []).map((item) =>
                editingId === item.id ? (
                  <CatalogFormRow
                    key={item.id}
                    initial={{
                      kind: item.kind,
                      name: item.name,
                      description: item.description ?? '',
                      unit: item.unit,
                      unit_price: item.unit_price ?? '',
                      taxable: item.taxable,
                      is_active: item.is_active,
                    }}
                    itemId={item.id}
                    onCancel={() => setEditingId(null)}
                    onSaved={() => setEditingId(null)}
                    columns={canEdit ? 7 : 6}
                  />
                ) : (
                  <CatalogDisplayRow
                    key={item.id}
                    item={item}
                    canEdit={canEdit}
                    canDelete={canDelete}
                    onEdit={() => setEditingId(item.id)}
                  />
                ),
              )}
              {!adding && (items?.length ?? 0) === 0 && (
                <tr>
                  <td colSpan={canEdit ? 7 : 6} className="px-4 py-6 text-center text-sm text-ink-2">
                    Nothing in the catalog yet.
                    {canEdit && ' Add the first item above.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

function CatalogDisplayRow({
  item,
  canEdit,
  canDelete,
  onEdit,
}: {
  item: CatalogItem;
  canEdit: boolean;
  canDelete: boolean;
  onEdit: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function onDelete() {
    if (!confirm(`Delete "${item.name}"? This can't be undone.`)) return;
    setBusy(true);
    try {
      await apiFetch(`/operate/catalog/${item.id}`, { method: 'DELETE' });
      await mutate(CATALOG_KEY);
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Could not delete this item.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className="border-b border-line-2 last:border-0 hover:bg-card-sunk">
      <td className="px-4 py-2 text-ink">
        {item.name}
        {item.description && <p className="text-xs text-ink-3">{item.description}</p>}
      </td>
      <td className="px-4 py-2 text-ink-2 capitalize">{item.kind}</td>
      <td className="px-4 py-2 font-mono" data-numeric>
        {item.unit_price !== null ? formatMoney(item.unit_price) : '—'}
      </td>
      <td className="px-4 py-2 text-ink-2">{item.unit}</td>
      <td className="px-4 py-2 text-ink-2">{item.taxable ? 'Yes' : 'No'}</td>
      <td className="px-4 py-2">
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            item.is_active ? 'bg-growth-soft text-growth' : 'bg-line-2 text-ink-3'
          }`}
        >
          {item.is_active ? 'Active' : 'Inactive'}
        </span>
      </td>
      {canEdit && (
        <td className="px-4 py-2 text-right">
          <div className="flex justify-end gap-2">
            <button onClick={onEdit} className="text-xs text-pool hover:underline">
              Edit
            </button>
            {canDelete && (
              <button
                onClick={onDelete}
                disabled={busy}
                className="text-xs text-alert hover:underline disabled:opacity-50"
              >
                Delete
              </button>
            )}
          </div>
        </td>
      )}
    </tr>
  );
}

function CatalogFormRow({
  initial,
  itemId,
  onCancel,
  onSaved,
  columns,
}: {
  initial: FormState;
  itemId?: string;
  onCancel: () => void;
  onSaved: () => void;
  columns: number;
}) {
  const [form, setForm] = useState<FormState>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSave() {
    if (!form.name.trim()) {
      setError('Name is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (itemId) {
        await apiFetch(`/operate/catalog/${itemId}`, {
          method: 'PATCH',
          body: JSON.stringify(toPayload(form)),
        });
      } else {
        await apiFetch('/operate/catalog', {
          method: 'POST',
          body: JSON.stringify(toPayload(form)),
        });
      }
      await mutate(CATALOG_KEY);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save this item.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr className="border-b border-line-2 bg-card-sunk last:border-0">
      <td className="px-4 py-2" colSpan={columns}>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-ink-2">
            Name
            <input
              autoFocus
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="min-h-[36px] w-40 rounded-button border border-line-2 bg-daylight px-2 text-sm text-ink outline-none focus:border-pool"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-2">
            Kind
            <select
              value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value as CatalogKind })}
              className="min-h-[36px] rounded-button border border-line-2 bg-daylight px-2 text-sm text-ink outline-none focus:border-pool"
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-2">
            Price
            <input
              type="number"
              step="0.01"
              value={form.unit_price}
              onChange={(e) => setForm({ ...form, unit_price: e.target.value })}
              className="min-h-[36px] w-24 rounded-button border border-line-2 bg-daylight px-2 text-sm text-ink outline-none focus:border-pool"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-2">
            Unit
            <input
              value={form.unit}
              onChange={(e) => setForm({ ...form, unit: e.target.value })}
              className="min-h-[36px] w-20 rounded-button border border-line-2 bg-daylight px-2 text-sm text-ink outline-none focus:border-pool"
            />
          </label>
          <label className="flex items-center gap-1.5 text-xs text-ink-2">
            <input
              type="checkbox"
              checked={form.taxable}
              onChange={(e) => setForm({ ...form, taxable: e.target.checked })}
            />
            Taxable
          </label>
          <label className="flex items-center gap-1.5 text-xs text-ink-2">
            <input
              type="checkbox"
              checked={form.is_active}
              onChange={(e) => setForm({ ...form, is_active: e.target.checked })}
            />
            Active
          </label>
          <label className="flex flex-1 flex-col gap-1 text-xs text-ink-2">
            Description
            <input
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="min-h-[36px] w-full min-w-[140px] rounded-button border border-line-2 bg-daylight px-2 text-sm text-ink outline-none focus:border-pool"
            />
          </label>
          <div className="flex gap-2">
            <Button onClick={onSave} disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </Button>
            <Button variant="ghost" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
        {error && <p className="mt-2 text-xs text-alert">{error}</p>}
      </td>
    </tr>
  );
}
