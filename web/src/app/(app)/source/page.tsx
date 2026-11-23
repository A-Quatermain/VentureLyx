'use client';

import { useState } from 'react';
import { Package, UsersThree, MagicWand, X } from '@phosphor-icons/react';
import { useApi, useRole, atLeast } from '@/lib/useApi';
import { API_BASE } from '@/lib/config';
import { apiFetch } from '@/lib/api';
import { mutate } from 'swr';
import { LockedModulePage } from '@/components/LockedModulePage';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import type {
  SummaryResponse, LeadSourceLead, LeadSourceEnrichmentStatus,
  LeadSourceFilters, LeadSourceSavedSearch, LeadSourceSearchResult,
} from '@/lib/types';

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

  return <LeadSourceShell />;
}

function LeadSourceShell() {
  const [tab, setTab] = useState<'leads' | 'search'>('leads');
  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-2">
        {(['leads', 'search'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-full px-3 py-1.5 text-xs font-medium ${tab === t ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/70'}`}
          >
            {t === 'leads' ? 'Your leads' : 'Search'}
          </button>
        ))}
      </div>
      {tab === 'leads' ? <LeadSourceTab /> : <LeadSourceSearchPanel />}
    </div>
  );
}

function ChipInput({ values, onChange, placeholder }: { values: string[]; onChange: (v: string[]) => void; placeholder: string }) {
  const [draft, setDraft] = useState('');
  function add() {
    const v = draft.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft('');
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-surface p-1.5">
      {values.map((v) => (
        <span key={v} className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
          {v}
          <button type="button" onClick={() => onChange(values.filter((x) => x !== v))} className="hover:text-destructive">
            <X size={11} weight="bold" />
          </button>
        </span>
      ))}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } }}
        onBlur={add}
        placeholder={values.length === 0 ? placeholder : ''}
        className="min-w-[80px] flex-1 bg-transparent px-1 py-0.5 text-xs outline-none"
      />
    </div>
  );
}

const DEFAULT_FILTERS: LeadSourceFilters = {
  counties: [], zips: [], filing_types: ['DOMP', 'FLAL', 'FORP', 'FORL'], file_date_window_days: 30, name_keywords: [], include_dba: false,
};

function LeadSourceSearchPanel() {
  const [request, setRequest] = useState('');
  const [filters, setFilters] = useState<LeadSourceFilters>(DEFAULT_FILTERS);
  const [results, setResults] = useState<LeadSourceSearchResult[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [assisting, setAssisting] = useState(false);
  const [running, setRunning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const role = useRole();
  const canEdit = atLeast(role, 'manager');

  const { data: savedSearches, isLoading: loadingSaved } = useApi<LeadSourceSavedSearch[]>(canEdit ? '/leadsource/saved-searches' : null);

  function patch<K extends keyof LeadSourceFilters>(key: K, value: LeadSourceFilters[K]) {
    setFilters((f) => ({ ...f, [key]: value }));
  }

  async function assist() {
    if (!request.trim()) return;
    setAssisting(true);
    setNotice(null);
    try {
      const res = await apiFetch<LeadSourceFilters & { assist_failed: boolean }>('/leadsource/search/assist', {
        method: 'POST', body: JSON.stringify({ request }),
      });
      const { assist_failed, ...rest } = res;
      setFilters(rest);
      if (assist_failed) setNotice('Could not understand that — edit the filters below by hand.');
    } finally {
      setAssisting(false);
    }
  }

  async function runPreview(f: LeadSourceFilters) {
    setRunning(true);
    setSelected(new Set());
    try {
      const res = await apiFetch<LeadSourceSearchResult[]>('/leadsource/search/preview', { method: 'POST', body: JSON.stringify(f) });
      setResults(res);
    } finally {
      setRunning(false);
    }
  }

  async function runSaved(id: string) {
    setRunning(true);
    setSelected(new Set());
    try {
      const res = await apiFetch<LeadSourceSearchResult[]>(`/leadsource/saved-searches/${id}/run`, { method: 'POST' });
      setResults(res);
    } finally {
      setRunning(false);
    }
  }

  async function importSelected() {
    if (!results || selected.size === 0) return;
    setImporting(true);
    try {
      const items = results.filter((r) => selected.has(`${r.source}:${r.source_id}`)).map((r) => ({ source: r.source, source_id: r.source_id }));
      const res = await apiFetch<{ requested: number; imported: number }>('/leadsource/leads/import', { method: 'POST', body: JSON.stringify({ items }) });
      setNotice(`Added ${res.imported} new lead${res.imported === 1 ? '' : 's'} (${res.requested - res.imported} were already in your leads).`);
      setSelected(new Set());
      await mutate((key: string) => typeof key === 'string' && key.startsWith('/leadsource/leads?'));
    } finally {
      setImporting(false);
    }
  }

  async function saveSearch() {
    if (!saveName.trim()) return;
    setSaving(true);
    try {
      await apiFetch('/leadsource/saved-searches', { method: 'POST', body: JSON.stringify({ name: saveName, ...filters }) });
      setSaveName('');
      setNotice(`Saved "${saveName}".`);
      await mutate('/leadsource/saved-searches');
    } finally {
      setSaving(false);
    }
  }

  function toggle(key: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex items-center gap-2">
          <MagicWand size={18} className="text-primary" />
          <p className="font-display text-base font-bold tracking-tight">Describe who you're looking for</p>
        </div>
        <div className="flex gap-2">
          <input
            value={request}
            onChange={(e) => setRequest(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') assist(); }}
            placeholder="e.g. new roofing LLCs in Palm Beach County filed in the last 2 weeks"
            className="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary"
          />
          <Button onClick={assist} disabled={assisting || !request.trim()}>{assisting ? 'Thinking…' : 'Suggest filters'}</Button>
        </div>
        {notice && <p className="text-xs text-muted-foreground">{notice}</p>}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Counties (FL)</label>
            <ChipInput values={filters.counties} onChange={(v) => patch('counties', v.map((x) => x.toUpperCase()))} placeholder="e.g. PALM BEACH" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Zip codes</label>
            <ChipInput values={filters.zips} onChange={(v) => patch('zips', v)} placeholder="e.g. 33401" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Filing types</label>
            <ChipInput values={filters.filing_types} onChange={(v) => patch('filing_types', v.map((x) => x.toUpperCase()))} placeholder="e.g. FLAL" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Name keywords</label>
            <ChipInput values={filters.name_keywords} onChange={(v) => patch('name_keywords', v)} placeholder="e.g. roofing" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-muted-foreground">Filed within (days)</label>
            <input
              type="number" min={1} max={365} value={filters.file_date_window_days}
              onChange={(e) => patch('file_date_window_days', Math.max(1, Math.min(365, Number(e.target.value) || 30)))}
              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
            />
          </div>
          <div className="flex items-center gap-2 pt-5">
            <input type="checkbox" checked={filters.include_dba} onChange={(e) => patch('include_dba', e.target.checked)} id="include_dba" />
            <label htmlFor="include_dba" className="text-sm">Include fictitious names (DBAs)</label>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <Button onClick={() => runPreview(filters)} disabled={running}>{running ? 'Searching…' : 'Run search'}</Button>
          {canEdit && (
            <div className="flex items-center gap-2">
              <input
                value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="Save as…"
                className="rounded-lg border border-border bg-surface px-2 py-1.5 text-xs"
              />
              <Button variant="ghost" onClick={saveSearch} disabled={saving || !saveName.trim()}>Save</Button>
            </div>
          )}
        </div>
      </Card>

      {canEdit && !loadingSaved && savedSearches && savedSearches.length > 0 && (
        <Card className="flex flex-wrap items-center gap-2 p-3">
          <span className="text-xs font-medium text-muted-foreground">Saved searches:</span>
          {savedSearches.map((s) => (
            <button
              key={s.id}
              onClick={() => runSaved(s.id)}
              className="rounded-full bg-muted px-3 py-1 text-xs font-medium hover:bg-muted/70"
            >
              {s.name}
            </button>
          ))}
        </Card>
      )}

      <Card className="overflow-x-auto p-0">
        {results === null ? (
          <p className="p-4 text-sm text-muted-foreground">Describe a search above, or edit the filters, then run it.</p>
        ) : results.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No matches for these filters.</p>
        ) : (
          <>
            <div className="flex items-center justify-between border-b border-border p-3">
              <p className="text-xs text-muted-foreground">{results.length} match{results.length === 1 ? '' : 'es'}</p>
              {canEdit && (
                <Button onClick={importSelected} disabled={selected.size === 0 || importing}>
                  {importing ? 'Adding…' : `Add ${selected.size || ''} to leads`}
                </Button>
              )}
            </div>
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {canEdit && <th className="px-4 py-2" />}
                  <th className="px-4 py-2 font-medium">Business</th>
                  <th className="px-4 py-2 font-medium">Legal type</th>
                  <th className="px-4 py-2 font-medium">Guessed industry</th>
                  <th className="px-4 py-2 font-medium">City / Zip</th>
                  <th className="px-4 py-2 font-medium">Filed</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {results.map((r) => {
                  const key = `${r.source}:${r.source_id}`;
                  return (
                    <tr key={key}>
                      {canEdit && (
                        <td className="px-4 py-3">
                          <input type="checkbox" checked={selected.has(key)} onChange={() => toggle(key)} />
                        </td>
                      )}
                      <td className="px-4 py-3 font-medium">{r.business_name}</td>
                      <td className="px-4 py-3 text-muted-foreground">{r.business_type}</td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {r.business_type_guess ? (
                          <span title="Guessed from the business name, not a recorded fact">{r.business_type_guess} (guessed)</span>
                        ) : '—'}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{r.principal_city} {r.principal_zip}</td>
                      <td className="px-4 py-3 text-muted-foreground">{r.file_date}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </Card>
    </div>
  );
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
                <th className="px-4 py-2 font-medium">Legal type</th>
                <th className="px-4 py-2 font-medium">Guessed industry</th>
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
                    {l.business_type_guess ? `${l.business_type_guess} (guessed)` : '—'}
                  </td>
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
