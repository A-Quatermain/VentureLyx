'use client';

import Link from 'next/link';
import { useApi } from '@/lib/useApi';
import { PageHeader } from '@/components/Primitives';
import { Card } from '@/components/ui/Card';
import { SkeletonCard } from '@/components/ui/Skeleton';
import type { AdminOrganization } from '@/lib/types';

function fmt(d: string): string {
  return new Date(d).toLocaleDateString();
}

export default function AdminOrganizationsPage() {
  const { data: orgs, isLoading, error } = useApi<AdminOrganization[]>('/admin/organizations');

  return (
    <div>
      <PageHeader eyebrow="Staff only" title="Organizations" subtitle={orgs ? `${orgs.length} organizations` : undefined} />
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
