'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CaretUp, CaretDown } from '@phosphor-icons/react';
import { useApi, useRole, atLeast } from '@/lib/useApi';
import type { PartyListItem, Lifecycle } from '@/lib/types';
import { formatMoney } from '@/lib/format';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { SkeletonCard } from '@/components/ui/Skeleton';
import { CustomerDrawer } from '@/components/CustomerDrawer';
import { CustomerImportDrawer } from '@/components/CustomerImportDrawer';
import { toneSoft, type Tone } from '@/components/ui/tone';

type ChipFilter = 'all' | 'lead' | 'customer' | 'dormant';
const CHIPS: { key: ChipFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'lead', label: 'Leads' },
  { key: 'customer', label: 'Customers' },
  { key: 'dormant', label: 'Dormant' },
];

const LIFECYCLE_TONE: Record<Lifecycle, Tone> = {
  new: 'primary',
  working: 'primary',
  qualified: 'primary',
  customer: 'success',
  lost: 'destructive',
  dormant: 'muted',
};

type SortKey = 'name' | 'value' | 'activity';

function relativeTime(iso: string | null): string {
  if (!iso) return 'No activity yet';
  const hours = Math.round((Date.now() - new Date(iso).getTime()) / 3_600_000);
  if (hours < 1) return 'Just now';
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function LifecycleChip({ value }: { value: Lifecycle }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${toneSoft[LIFECYCLE_TONE[value]]}`}>
      {value}
    </span>
  );
}

function SortableTh({
  label,
  active,
  dir,
  align = 'left',
  onClick,
}: {
  label: string;
  active: boolean;
  dir: 1 | -1;
  align?: 'left' | 'right';
  onClick: () => void;
}) {
  return (
    <th className={`px-4 py-2 font-medium ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <button
        onClick={onClick}
        className={`inline-flex items-center gap-1 hover:text-foreground ${
          align === 'right' ? 'flex-row-reverse' : ''
        } ${active ? 'text-foreground' : ''}`}
      >
        {label}
        {active && (dir === -1 ? <CaretDown size={11} weight="bold" /> : <CaretUp size={11} weight="bold" />)}
      </button>
    </th>
  );
}

export default function CustomersPage() {
  const router = useRouter();
  const role = useRole();
  const canEdit = atLeast(role, 'staff');

  const [chip, setChip] = useState<ChipFilter>('all');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortKey>('activity');
  const [sortDir, setSortDir] = useState<1 | -1>(-1);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);

  const params = new URLSearchParams();
  if (q.trim()) params.set('q', q.trim());
  if (chip === 'lead') params.set('role', 'lead');
  if (chip === 'customer') params.set('role', 'customer');
  if (chip === 'dormant') params.set('lifecycle', 'dormant');
  params.set('page', String(page));

  const { data: items, isLoading, error } = useApi<PartyListItem[]>(`/operate/parties?${params.toString()}`);

  const sorted = useMemo(() => {
    const rows = [...(items ?? [])];
    rows.sort((a, b) => {
      let cmp = 0;
      if (sort === 'name') cmp = a.display_name.localeCompare(b.display_name);
      else if (sort === 'value') cmp = Number(a.lifetime_value) - Number(b.lifetime_value);
      else {
        cmp =
          new Date(a.last_activity_at ?? a.first_seen_at).getTime() -
          new Date(b.last_activity_at ?? b.first_seen_at).getTime();
      }
      return cmp * sortDir;
    });
    return rows;
  }, [items, sort, sortDir]);

  function toggleSort(key: SortKey) {
    if (sort === key) {
      setSortDir((d) => (d === 1 ? -1 : 1));
    } else {
      setSort(key);
      setSortDir(key === 'name' ? 1 : -1);
    }
  }

  const isFiltered = chip !== 'all' || !!q.trim();

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="font-display text-lg font-bold tracking-tight">Customers</p>
          <p className="text-sm text-muted-foreground">Every lead and customer, in one list.</p>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/operate" className="text-sm text-primary">
            ← Operate
          </Link>
          {canEdit && !adding && !importing && (
            <>
              <Button variant="ghost" onClick={() => setImporting(true)}>
                Import CSV
              </Button>
              <Link href="/operate/invoices/import" className="text-sm font-medium text-primary hover:underline">
                Import invoices
              </Link>
              <Button onClick={() => setAdding(true)}>Add customer</Button>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-full border border-border bg-surface p-1 shadow-sm">
          {CHIPS.map((c) => (
            <button
              key={c.key}
              onClick={() => {
                setChip(c.key);
                setPage(1);
              }}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
                chip === c.key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
          placeholder="Search name, company, phone, email…"
          className="min-h-[38px] w-full max-w-xs rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
        />
      </div>

      <Card className="overflow-x-auto p-0">
        {isLoading ? (
          <SkeletonCard />
        ) : error ? (
          <p className="p-4 text-sm text-destructive">
            {error instanceof Error ? error.message : 'Could not load customers.'}
          </p>
        ) : sorted.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
            <p className="max-w-sm text-sm text-muted-foreground">
              {isFiltered
                ? 'No customers match this search or filter.'
                : 'No customers yet — add them by CSV import, one at a time, or by importing your existing invoices. This is what makes revenue tracking work.'}
            </p>
            {canEdit && !isFiltered && (
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" onClick={() => setImporting(true)}>
                  Import CSV
                </Button>
                <Link href="/operate/invoices/import">
                  <Button variant="ghost">Import invoices</Button>
                </Link>
                <Button onClick={() => setAdding(true)}>Add your first customer</Button>
              </div>
            )}
          </div>
        ) : (
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <SortableTh label="Name" active={sort === 'name'} dir={sortDir} onClick={() => toggleSort('name')} />
                <th className="px-4 py-2 font-medium">City</th>
                <th className="px-4 py-2 font-medium">Phone</th>
                <SortableTh
                  label="Lifetime value"
                  active={sort === 'value'}
                  dir={sortDir}
                  align="right"
                  onClick={() => toggleSort('value')}
                />
                <th className="px-4 py-2 font-medium">Lifecycle</th>
                <SortableTh
                  label="Last activity"
                  active={sort === 'activity'}
                  dir={sortDir}
                  onClick={() => toggleSort('activity')}
                />
              </tr>
            </thead>
            <tbody>
              {sorted.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => router.push(`/operate/customers/${p.id}`)}
                  className="cursor-pointer border-b border-border last:border-0 hover:bg-muted"
                >
                  <td className="px-4 py-2">
                    <p className="font-medium">{p.display_name}</p>
                    {p.company_name && <p className="text-xs text-muted-foreground">{p.company_name}</p>}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">{p.city ?? '—'}</td>
                  <td className="px-4 py-2 text-muted-foreground">{p.phone ?? '—'}</td>
                  <td className="px-4 py-2 text-right font-mono" data-numeric>
                    {formatMoney(p.lifetime_value)}
                  </td>
                  <td className="px-4 py-2">
                    <LifecycleChip value={p.lifecycle} />
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">{relativeTime(p.last_activity_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">Page {page}</p>
        <div className="flex gap-2">
          <Button variant="ghost" disabled={page === 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
            Prev
          </Button>
          <Button variant="ghost" disabled={(items?.length ?? 0) < 50} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </div>
      </div>

      <CustomerDrawer
        open={adding}
        onOpenChange={setAdding}
        onSaved={(id) => router.push(`/operate/customers/${id}`)}
      />
      <CustomerImportDrawer open={importing} onOpenChange={setImporting} />
    </div>
  );
}
