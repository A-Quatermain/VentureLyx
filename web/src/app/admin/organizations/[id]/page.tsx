'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { mutate } from 'swr';
import { useApi } from '@/lib/useApi';
import { apiFetch, ApiError } from '@/lib/api';
import { PageHeader } from '@/components/Primitives';
import { Card } from '@/components/ui/Card';
import { SkeletonCard } from '@/components/ui/Skeleton';
import type { AdminOrganizationDetail } from '@/lib/types';

// Same key convention as api/src/routes/admin.ts's MODULE_KEYS — matches
// organizations.modules' own documented shape (001_platform_core.sql),
// not web/src/lib/modules.ts's hyphenated route-slug keys.
const MODULE_TOGGLES = [
  { key: 'build', label: 'Build' },
  { key: 'source', label: 'Source' },
  { key: 'operate', label: 'Operate' },
  { key: 'scaleseo', label: 'ScaleSEO' },
  { key: 'grow', label: 'Grow' },
  { key: 'ai_team', label: 'AI Team' },
  { key: 'reviews', label: 'Reviews' },
] as const;

function fmt(d: string): string {
  return new Date(d).toLocaleString();
}

export default function AdminOrganizationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const key = `/admin/organizations/${id}`;
  const { data: org, isLoading, error } = useApi<AdminOrganizationDetail>(key);
  const [saving, setSaving] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function toggleModule(moduleKey: string, next: boolean) {
    setSaving(moduleKey);
    setSaveError(null);
    try {
      await apiFetch(`/admin/organizations/${id}/modules`, {
        method: 'PATCH',
        body: JSON.stringify({ modules: { [moduleKey]: next } }),
      });
      await mutate(key);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'Could not save that change.');
    } finally {
      setSaving(null);
    }
  }

  if (isLoading) return <SkeletonCard />;
  if (error || !org) return <p className="text-sm text-destructive">Could not load this organization.</p>;

  return (
    <div>
      <PageHeader eyebrow="Staff only" title={org.name} subtitle={`${org.slug} · ${org.status}${org.vertical ? ` · ${org.vertical}` : ''}`} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-6">
          <h2 className="font-display font-bold tracking-tight">Module access</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Manual entitlement for founding clients ahead of Stripe. Doesn&rsquo;t yet gate access anywhere
            else in the app — this records intent only.
          </p>
          {saveError && <p className="mt-3 text-sm text-destructive">{saveError}</p>}
          <div className="mt-4 flex flex-col gap-2">
            {MODULE_TOGGLES.map((m) => {
              const on = !!org.modules?.[m.key];
              return (
                <label key={m.key} className="flex items-center justify-between rounded-lg border border-border px-3 py-2.5">
                  <span className="text-sm font-medium">{m.label}</span>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={saving === m.key}
                    onChange={(e) => toggleModule(m.key, e.target.checked)}
                    className="h-5 w-5 rounded border-border accent-[hsl(var(--primary))]"
                  />
                </label>
              );
            })}
          </div>
        </Card>

        <Card className="p-6">
          <h2 className="font-display font-bold tracking-tight">Sites</h2>
          {org.sites.length === 0 && <p className="mt-2 text-sm text-muted-foreground">No sites.</p>}
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {org.sites.map((s) => (
              <li key={s.id} className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                <span className="font-mono text-xs text-muted-foreground">{s.id}</span>
                <span className="text-muted-foreground">{s.is_primary ? 'primary' : 'secondary'}{s.in_health_score ? '' : ' · excluded from score'}</span>
              </li>
            ))}
          </ul>
        </Card>

        <Card className="p-6 lg:col-span-2">
          <h2 className="font-display font-bold tracking-tight">Members</h2>
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <th className="py-2">Email</th>
                <th className="py-2">Name</th>
                <th className="py-2">Role</th>
                <th className="py-2">Member since</th>
              </tr>
            </thead>
            <tbody>
              {org.members.map((m) => (
                <tr key={m.id} className="border-b border-border last:border-0">
                  <td className="py-2">{m.email}</td>
                  <td className="py-2">{m.full_name || '—'}</td>
                  <td className="py-2 text-muted-foreground">{m.role}</td>
                  <td className="py-2 text-muted-foreground">{fmt(m.member_since)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </div>
  );
}
