'use client';

import { useState } from 'react';
import { Package, UsersThree } from '@phosphor-icons/react';
import { useApi, useRole, atLeast } from '@/lib/useApi';
import { API_BASE } from '@/lib/config';
import { apiFetch } from '@/lib/api';
import { mutate } from 'swr';
import { LockedModulePage } from '@/components/LockedModulePage';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import type { SummaryResponse, LeadSourceLead, LeadSourceEnrichmentStatus } from '@/lib/types';

// Same "missing key = enabled" vs "missing key = disabled" split
// moduleAccess.ts's own header documents server-side — LeadSource is the
// one module on this page where a missing key means OFF, not on, because
// nothing predates it.
function leadSourceOn(summary: SummaryResponse | undefined): boolean {
  return summary?.org.modules?.leadsource === true;
}

export default function SourcePage() {
  const { data: summary, isLoading } = useApi<SummaryResponse>('/command/summary');

  if (isLoading) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;

  if (!leadSourceOn(summary)) {
    return (
      <LockedModulePage
        icon={Package}
        label="Source"
        description="Suppliers, RFQs, cost compares. Find and compare vendors, request quotes, and keep your cost of goods under control."
        bullets={[
          'Supplier directory for your industry',
          'Request-for-quote comparisons side by side',
          'Cost tracking against your catalog',
        ]}
      />
    );
  }

  return <LeadSourceTab />;
}

const LEADS_KEY = (status: string, source: string) =>
  `/leadsource/leads?${[status !== 'all' ? `enrichment_status=${status}` : '', source !== 'all' ? `source=${source}` : ''].filter(Boolean).join('&')}`;

const STATUS_LABEL: Record<LeadSourceEnrichmentStatus, string> = {
  new: 'New', enriching: 'Enriching', enriched: 'Enriched', skipped: 'Skipped',
};

function LeadSourceTab() {
  const [status, setStatus] = useState<'all' | LeadSourceEnrichmentStatus>('all');
  const [source, setSource] = useState<'all' | 'fl_sunbiz_cor' | 'fl_sunbiz_fic'>('all');
  const key = LEADS_KEY(status, source);
  const { data: leads, isLoading, error } = useApi<LeadSourceLead[]>(key);
  const role = useRole();
  const canExport = atLeast(role, 'owner');
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  async function setEnrichment(id: string, next: LeadSourceEnrichmentStatus) {
    setUpdatingId(id);
    try {
      await apiFetch(`/leadsource/leads/${id}`, { method: 'PATCH', body: JSON.stringify({ enrichment_status: next }) });
      await mutate(key);
    } finally {
      setUpdatingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="flex items-center gap-2">
          <UsersThree size={18} className="text-primary" />
          <div>
            <p className="font-display text-lg font-bold tracking-tight">LeadSource</p>
            <p className="text-xs text-muted-foreground">New Florida business filings, matched to your configured counties.</p>
          </div>
        </div>
        {canExport && (
          <a
            href={`${API_BASE}/leadsource/leads/export.csv`}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-muted"
          >
            Export CSV
          </a>
        )}
      </Card>

      <div className="flex flex-wrap gap-2">
        {(['all', 'new', 'enriching', 'enriched', 'skipped'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={`rounded-full px-3 py-1.5 text-xs font-medium ${status === s ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/70'}`}
          >
            {s === 'all' ? 'All statuses' : STATUS_LABEL[s]}
          </button>
        ))}
        {(['all', 'fl_sunbiz_cor', 'fl_sunbiz_fic'] as const).map((s) => (
          <button
            key={s}
            onClick={() => setSource(s)}
            className={`rounded-full px-3 py-1.5 text-xs font-medium ${source === s ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/70'}`}
          >
            {s === 'all' ? 'All sources' : s === 'fl_sunbiz_cor' ? 'Corporate filings' : 'Fictitious names'}
          </button>
        ))}
      </div>

      <Card className="overflow-x-auto p-0">
        {isLoading ? (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        ) : error ? (
          <p className="p-4 text-sm text-destructive">Could not load leads.</p>
        ) : !leads || leads.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            No leads yet — the next scheduled ingest will bring in anything matching your Settings.
          </p>
        ) : (
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead>
              <tr className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2 font-medium">Business</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Principal address</th>
                <th className="px-4 py-2 font-medium">Filed</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {leads.map((l) => (
                <tr key={l.id}>
                  <td className="px-4 py-3 font-medium">{l.business_name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{l.business_type}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {l.principal_address}, {l.principal_city} {l.principal_state} {l.principal_zip}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{l.file_date}</td>
                  <td className="px-4 py-3">
                    <select
                      value={l.enrichment_status}
                      disabled={updatingId === l.id}
                      onChange={(e) => setEnrichment(l.id, e.target.value as LeadSourceEnrichmentStatus)}
                      className="rounded-full border border-border bg-surface px-2 py-1 text-xs"
                    >
                      {(['new', 'enriching', 'enriched', 'skipped'] as const).map((s) => (
                        <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
