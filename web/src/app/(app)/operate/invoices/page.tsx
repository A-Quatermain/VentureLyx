'use client';

import { useState } from 'react';
import { mutate } from 'swr';
import Link from 'next/link';
import { Receipt, DownloadSimple } from '@phosphor-icons/react';
import { useApi, useRole, atLeast } from '@/lib/useApi';
import { apiFetch, ApiError } from '@/lib/api';
import { API_BASE } from '@/lib/config';
import type { InvoiceListItem, InvoiceStatus } from '@/lib/types';
import { formatMoney } from '@/lib/format';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { PageHeader } from '@/components/Primitives';
import { InvoiceDrawer } from '@/components/InvoiceDrawer';

const TABS: Array<{ key: InvoiceStatus | 'overdue' | 'all'; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'draft', label: 'Draft' },
  { key: 'sent', label: 'Sent' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'paid', label: 'Paid' },
];

const STATUS_TONE: Record<InvoiceStatus, string> = {
  draft: 'bg-muted text-muted-foreground',
  sent: 'bg-primary/10 text-primary',
  partial: 'bg-warning/10 text-warning',
  paid: 'bg-success/10 text-success',
  void: 'bg-muted text-muted-foreground',
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function InvoicesPage() {
  const role = useRole();
  const canEdit = atLeast(role, 'staff');
  const [tab, setTab] = useState<InvoiceStatus | 'overdue' | 'all'>('all');
  const [adding, setAdding] = useState(false);
  const key = tab === 'all' ? '/operate/invoices' : tab === 'overdue' ? '/operate/invoices?overdue=true' : `/operate/invoices?status=${tab}`;
  const { data: invoices, isLoading } = useApi<InvoiceListItem[]>(key);

  const outstanding = (invoices ?? []).filter((i) => i.status === 'sent' || i.status === 'partial')
    .reduce((sum, i) => sum + Number(i.balance), 0);
  const overdueCount = (invoices ?? []).filter((i) => i.is_overdue).length;

  async function send(id: string) {
    try {
      await apiFetch(`/operate/invoices/${id}/send`, { method: 'POST' });
      await mutate((k: string) => typeof k === 'string' && k.startsWith('/operate/invoices'), undefined, { revalidate: true });
      await mutate('/operate/money');
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Could not send this invoice.');
    }
  }

  async function recordPayment(inv: InvoiceListItem) {
    const input = prompt(`Record a payment for ${inv.number} (balance $${inv.balance})`, inv.balance);
    if (!input) return;
    const amount = Number(input);
    if (!Number.isFinite(amount) || amount <= 0) {
      alert('Enter a valid amount.');
      return;
    }
    try {
      await apiFetch(`/operate/invoices/${inv.id}/payments`, { method: 'POST', body: JSON.stringify({ amount }) });
      await mutate((k: string) => typeof k === 'string' && k.startsWith('/operate/invoices'), undefined, { revalidate: true });
      await mutate('/operate/money');
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Could not record this payment.');
    }
  }

  return (
    <div className="p-4">
      <PageHeader
        eyebrow="Operate"
        title="Invoices"
        subtitle="Create, send, and get paid."
        actions={canEdit && (
          <div className="flex items-center gap-2">
            <Link href="/operate/invoices/import" className="text-sm font-medium text-primary hover:underline">
              Import invoices
            </Link>
            <Button onClick={() => setAdding(true)}>
              <Receipt size={14} weight="bold" className="mr-1.5 inline" /> New invoice
            </Button>
          </div>
        )}
      />

      <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Outstanding</p>
          <p className="mt-1 font-mono text-xl font-semibold tabular-nums">{formatMoney(outstanding)}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Overdue</p>
          <p className="mt-1 font-mono text-xl font-semibold tabular-nums">{overdueCount}</p>
        </Card>
        <Card className="p-4 sm:col-span-1">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Export for accounting</p>
          <div className="mt-1 flex gap-3 text-sm">
            <a href={`${API_BASE}/operate/invoices/export.csv`} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
              <DownloadSimple size={13} weight="bold" /> Invoices
            </a>
            <a href={`${API_BASE}/operate/payments/export.csv`} className="inline-flex items-center gap-1 font-medium text-primary hover:underline">
              <DownloadSimple size={13} weight="bold" /> Payments
            </a>
          </div>
          <p className="mt-1 text-xs text-muted-foreground/70">QuickBooks-compatible CSV. Full accounting sync is coming soon.</p>
        </Card>
      </div>

      <div className="mb-4 flex w-fit gap-1 rounded-full border border-border bg-surface p-1 shadow-sm">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === t.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-16 rounded-xl bg-muted" />
          <Skeleton className="h-16 rounded-xl bg-muted" />
        </div>
      ) : !invoices || invoices.length === 0 ? (
        <Card className="p-8 text-center">
          <Receipt size={28} className="mx-auto mb-2 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {tab === 'all' ? 'No invoices yet.' : `No ${TABS.find((t) => t.key === tab)?.label.toLowerCase()} invoices.`}
          </p>
          {canEdit && tab === 'all' && (
            <div className="mt-3 flex flex-wrap items-center justify-center gap-3">
              <Button onClick={() => setAdding(true)}>
                <Receipt size={14} weight="bold" className="mr-1.5 inline" /> Create your first invoice
              </Button>
              <Link href="/operate/invoices/import" className="text-sm font-medium text-primary hover:underline">
                or import your existing invoices →
              </Link>
            </div>
          )}
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {invoices.map((inv) => (
            <Card key={inv.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-semibold">{inv.number}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${inv.is_overdue ? 'bg-destructive/10 text-destructive' : STATUS_TONE[inv.status]}`}>
                    {inv.is_overdue ? 'overdue' : inv.status}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  <Link href={`/operate/customers/${inv.party_id}`} className="hover:underline">{inv.party_name}</Link>
                  {' · due '}{formatDate(inv.due_on)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <div className="text-right">
                  <p className="font-mono text-sm font-semibold tabular-nums">{formatMoney(inv.total)}</p>
                  {Number(inv.balance) > 0 && Number(inv.balance) !== Number(inv.total) && (
                    <p className="text-xs text-muted-foreground">{formatMoney(inv.balance)} due</p>
                  )}
                </div>
                {canEdit && inv.status === 'draft' && (
                  <Button variant="ghost" onClick={() => send(inv.id)}>Send</Button>
                )}
                {canEdit && (inv.status === 'sent' || inv.status === 'partial') && (
                  <Button variant="ghost" onClick={() => recordPayment(inv)}>Record payment</Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      <InvoiceDrawer open={adding} onOpenChange={setAdding} />
    </div>
  );
}
