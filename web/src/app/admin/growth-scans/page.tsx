'use client';

import { useState } from 'react';
import { mutate } from 'swr';
import { useApi } from '@/lib/useApi';
import { apiFetch, ApiError } from '@/lib/api';
import { PageHeader } from '@/components/Primitives';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { SkeletonCard } from '@/components/ui/Skeleton';

interface GrowthScanLead {
  org_id: string;
  name: string;
  website_url: string | null;
  prospect_archived_at: string | null;
  deal_id: string | null;
  stage: string | null;
  deal_status: string | null;
  lead_created_at: string | null;
  contact_email: string | null;
  health: number | null;
}

const PLAN_OPTIONS = [
  { key: 'platform', label: 'Platform ($129/mo)' },
  { key: 'growth_partner', label: 'Growth Partner ($349/mo)' },
  { key: 'launch_growth', label: 'Launch & Growth ($750 + $499/mo)' },
  { key: 'founding', label: 'Founding Business ($750 + $399/mo, 12mo)' },
];

function fmt(d: string | null): string {
  return d ? new Date(d).toLocaleString() : '—';
}

function Row({ lead, swrKey }: { lead: GrowthScanLead; swrKey: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState('launch_growth');

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await mutate(swrKey);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Action failed.');
    } finally {
      setBusy(false);
    }
  }

  const archived = !!lead.prospect_archived_at;

  return (
    <tr className="border-b border-border align-top last:border-0">
      <td className="px-4 py-3">
        <p className="font-medium">{lead.name}</p>
        <p className="text-xs text-muted-foreground">{lead.contact_email ?? 'no email yet'}</p>
      </td>
      <td className="px-4 py-3 text-muted-foreground">{lead.health ?? '—'}</td>
      <td className="px-4 py-3 text-muted-foreground">{lead.stage ?? '—'}</td>
      <td className="px-4 py-3 text-muted-foreground">{fmt(lead.lead_created_at)}</td>
      <td className="px-4 py-3">
        {lead.deal_id && !archived && (
          <div className="flex flex-wrap items-center gap-2">
            <Button className="min-h-0 px-3 py-1.5 text-xs" disabled={busy} onClick={() => act(() => apiFetch(`/admin/growth-scans/${lead.deal_id}/approve-intake`, { method: 'POST' }))}>
              Approve for intake
            </Button>
            <select value={plan} onChange={(e) => setPlan(e.target.value)} className="rounded-lg border border-border bg-background px-2 py-1 text-xs">
              {PLAN_OPTIONS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
            <Button variant="ghost" className="min-h-0 px-3 py-1.5 text-xs" disabled={busy} onClick={() => act(() => apiFetch(`/admin/growth-scans/${lead.deal_id}/checkout`, { method: 'POST', body: JSON.stringify({ planKey: plan }) }))}>
              Create checkout
            </Button>
            <Button variant="ghost" className="min-h-0 px-3 py-1.5 text-xs" disabled={busy} onClick={() => act(() => apiFetch(`/admin/growth-scans/${lead.deal_id}/checkout/resend-email`, { method: 'POST' }))}>
              Resend payment email
            </Button>
            <Button variant="ghost" className="min-h-0 px-3 py-1.5 text-xs" disabled={busy} onClick={() => act(() => apiFetch(`/admin/growth-scans/${lead.deal_id}/archive`, { method: 'PATCH' }))}>
              Archive
            </Button>
          </div>
        )}
        {archived && (
          <Button variant="ghost" className="min-h-0 px-3 py-1.5 text-xs" disabled={busy} onClick={() => act(() => apiFetch(`/admin/growth-scans/${lead.deal_id}/restore`, { method: 'PATCH' }))}>
            Restore
          </Button>
        )}
        {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      </td>
    </tr>
  );
}

export default function AdminGrowthScansPage() {
  const [includeArchived, setIncludeArchived] = useState(false);
  const key = `/admin/growth-scans${includeArchived ? '?includeArchived=true' : ''}`;
  const { data, isLoading } = useApi<GrowthScanLead[]>(key);

  return (
    <div>
      <PageHeader eyebrow="Staff only" title="Growth Scan Leads" subtitle="Everyone who ran a free scan — separate from the real customer list." />

      <div className="mb-4">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input type="checkbox" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />
          Include archived (stale) leads
        </label>
      </div>

      <Card className="overflow-x-auto p-0">
        {isLoading ? (
          <SkeletonCard />
        ) : !data || data.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No leads yet.</p>
        ) : (
          <table className="w-full min-w-[900px] text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2">Lead</th>
                <th className="px-4 py-2">Score</th>
                <th className="px-4 py-2">Stage</th>
                <th className="px-4 py-2">Created</th>
                <th className="px-4 py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.map((lead) => <Row key={lead.org_id} lead={lead} swrKey={key} />)}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
