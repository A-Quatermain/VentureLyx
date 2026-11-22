'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useApi } from '@/lib/useApi';
import { apiFetch, ApiError } from '@/lib/api';
import { PageHeader } from '@/components/Primitives';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { SkeletonCard } from '@/components/ui/Skeleton';
import type { AdminOrganization } from '@/lib/types';

function fmt(d: string): string {
  return new Date(d).toLocaleDateString();
}

export default function AdminOrganizationsPage() {
  const { data: orgs, isLoading, error } = useApi<AdminOrganization[]>('/admin/organizations');
  const [granting, setGranting] = useState(false);
  const [grantResult, setGrantResult] = useState<string | null>(null);

  async function grantLeadSourceToAll() {
    if (!confirm('Grant LeadSource to every ACTIVE organization? This cannot be bulk-undone — you\'d have to revoke each one individually.')) return;
    setGranting(true);
    setGrantResult(null);
    try {
      const result = await apiFetch<{ org_count: number; changed_count: number }>('/admin/organizations/grant-module', {
        method: 'POST',
        body: JSON.stringify({ module: 'leadsource' }),
      });
      setGrantResult(`Granted to ${result.changed_count} of ${result.org_count} active orgs (${result.org_count - result.changed_count} already had it).`);
    } catch (err) {
      setGrantResult(err instanceof ApiError ? err.message : 'Could not grant LeadSource.');
    } finally {
      setGranting(false);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PageHeader eyebrow="Staff only" title="Organizations" subtitle={orgs ? `${orgs.length} organizations` : undefined} />
        <Button variant="ghost" onClick={grantLeadSourceToAll} disabled={granting} className="shrink-0">
          {granting ? 'Granting…' : 'Grant LeadSource to all active orgs'}
        </Button>
      </div>
      {grantResult && <p className="mb-3 text-sm text-muted-foreground">{grantResult}</p>}
      {isLoading && <SkeletonCard />}
      {error && <p className="text-sm text-destructive">Could not load organizations.</p>}
      {orgs && (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Owner</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Members</th>
                <th className="px-4 py-3">Sites</th>
                <th className="px-4 py-3">Modules on</th>
                <th className="px-4 py-3">Created</th>
              </tr>
            </thead>
            <tbody>
              {orgs.map((o) => (
                <tr key={o.id} className="border-b border-border last:border-0 hover:bg-muted/50">
                  <td className="px-4 py-3">
                    <Link href={`/admin/organizations/${o.id}`} className="font-medium text-primary hover:underline">
                      {o.name}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{o.owner_email ?? '—'}</td>
                  <td className="px-4 py-3 text-muted-foreground">{o.status}</td>
                  <td className="px-4 py-3 font-mono tabular-nums">{o.member_count}</td>
                  <td className="px-4 py-3 font-mono tabular-nums">{o.site_count}</td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {Object.entries(o.modules ?? {}).filter(([, on]) => on).map(([k]) => k).join(', ') || '—'}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{fmt(o.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
