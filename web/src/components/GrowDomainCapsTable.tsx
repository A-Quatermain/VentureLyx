'use client';

import { useState } from 'react';
import { mutate } from 'swr';
import { Plus, Trash, Warning } from '@phosphor-icons/react';
import { useApi } from '@/lib/useApi';
import { apiFetch, ApiError } from '@/lib/api';
import type { GrowDomainPolicy } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';

export const DOMAIN_POLICIES_KEY = '/grow/domain-policies';
const SCHEDULE_PROJECTION_KEY_PREFIX = '/grow/campaigns/';

async function refreshDependents(campaignId: string) {
  await Promise.all([
    mutate(DOMAIN_POLICIES_KEY),
    mutate(`${SCHEDULE_PROJECTION_KEY_PREFIX}${campaignId}/schedule-projection`),
  ]);
}

function CapCell({
  policy, canEdit, onSaved, campaignId,
}: { policy: GrowDomainPolicy; canEdit: boolean; onSaved: () => void; campaignId: string }) {
  const [value, setValue] = useState(String(policy.daily_cap));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = value !== String(policy.daily_cap);

  async function save() {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
      setError('Enter a whole number');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (policy.is_saved && policy.id) {
        await apiFetch(`/grow/domain-policies/${policy.id}`, {
          method: 'PATCH', body: JSON.stringify({ daily_cap: parsed }),
        });
      } else {
        await apiFetch('/grow/domain-policies', {
          method: 'POST', body: JSON.stringify({ domain: policy.domain, daily_cap: parsed }),
        });
      }
      await refreshDependents(campaignId);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save this cap.');
    } finally {
      setSaving(false);
    }
  }

  if (!canEdit) {
    return <span className="font-mono tabular-nums" data-numeric>{policy.daily_cap}</span>;
  }

  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        min={0}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="w-20 rounded-lg border border-border bg-background px-2 py-1.5 text-sm font-mono tabular-nums text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
      />
      {dirty && (
        <Button
          variant="ghost"
          className="!min-h-0 px-2 py-1 text-xs"
          onClick={save}
          disabled={saving}
        >
          {saving ? '…' : policy.is_saved ? 'Save' : 'Set cap'}
        </Button>
      )}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}

function AddDomainRow({ campaignId, onAdded }: { campaignId: string; onAdded: () => void }) {
  const [domain, setDomain] = useState('');
  const [cap, setCap] = useState('25');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add() {
    if (!domain.trim()) return;
    const parsed = Number(cap);
    if (!Number.isInteger(parsed) || parsed < 0) {
      setError('Enter a whole number for the cap');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch('/grow/domain-policies', {
        method: 'POST', body: JSON.stringify({ domain: domain.trim().toLowerCase(), daily_cap: parsed }),
      });
      await refreshDependents(campaignId);
      setDomain('');
      setCap('25');
      onAdded();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not add this domain.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
      <input
        placeholder="e.g. protonmail.com"
        value={domain}
        onChange={(e) => setDomain(e.target.value)}
        className="min-w-[180px] flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
      />
      <input
        type="number"
        min={0}
        value={cap}
        onChange={(e) => setCap(e.target.value)}
        className="w-24 rounded-lg border border-border bg-background px-3 py-2 text-sm font-mono tabular-nums text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
      />
      <Button onClick={add} disabled={busy || !domain.trim()}>
        <Plus size={14} weight="bold" className="mr-1.5 inline" /> {busy ? 'Adding…' : 'Add domain cap'}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}

export function GrowDomainCapsTable({ campaignId, canEdit }: { campaignId: string; canEdit: boolean }) {
  const { data: policies, isLoading, error, mutate: revalidate } = useApi<GrowDomainPolicy[]>(DOMAIN_POLICIES_KEY);

  async function onDelete(policy: GrowDomainPolicy) {
    if (!policy.id) return;
    if (!window.confirm(`Remove the cap for ${policy.domain}? It will fall back to the '*' default rule.`)) return;
    try {
      await apiFetch(`/grow/domain-policies/${policy.id}`, { method: 'DELETE' });
      await refreshDependents(campaignId);
    } catch {
      // Table re-fetches regardless; a failed delete just leaves the row as-is.
    }
  }

  return (
    <Card className="p-0">
      <div className="border-b border-border px-4 py-3">
        <p className="text-sm font-semibold">Per-recipient-domain caps</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Sorted by how many enrolled contacts sit on each domain — the ones actually constraining the campaign
          surface first. <span className="font-mono">*</span> is the default rule every other domain falls back to.
        </p>
      </div>
      {isLoading ? (
        <div className="p-4"><Skeleton className="h-40 rounded-lg bg-muted" /></div>
      ) : error || !policies ? (
        <p className="p-4 text-sm text-destructive">Could not load domain caps.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2 font-medium">Domain</th>
                <th className="px-4 py-2 font-medium">Enrolled</th>
                <th className="px-4 py-2 font-medium">Daily cap</th>
                <th className="px-4 py-2 font-medium">Sent today</th>
                <th className="px-4 py-2 font-medium">Remaining</th>
                {canEdit && <th className="px-4 py-2 font-medium" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {policies.map((p) => (
                <tr key={p.id ?? p.domain}>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-1.5">
                      <span className={p.is_default ? 'font-mono font-semibold' : ''}>{p.domain}</span>
                      {p.is_consumer && (
                        <span
                          title="Consumer inbox — tighter filtering, keep this cap conservative"
                          className="flex items-center gap-1 rounded-full bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-warning"
                        >
                          <Warning size={10} weight="fill" /> consumer
                        </span>
                      )}
                      {!p.is_saved && !p.is_default && (
                        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                          no cap set — using {'*'}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 font-mono tabular-nums" data-numeric>{p.enrolled_contacts}</td>
                  <td className="px-4 py-2.5">
                    <CapCell policy={p} canEdit={canEdit} campaignId={campaignId} onSaved={() => revalidate()} />
                  </td>
                  <td className="px-4 py-2.5 font-mono tabular-nums" data-numeric>{p.sent_today}</td>
                  <td className="px-4 py-2.5 font-mono tabular-nums" data-numeric>{p.remaining}</td>
                  {canEdit && (
                    <td className="px-4 py-2.5 text-right">
                      {p.is_saved && !p.is_default && (
                        <button
                          type="button"
                          onClick={() => onDelete(p)}
                          aria-label={`Remove cap for ${p.domain}`}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Trash size={14} />
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canEdit && !isLoading && !error && <AddDomainRow campaignId={campaignId} onAdded={() => revalidate()} />}
    </Card>
  );
}
