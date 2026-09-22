'use client';

import { CheckCircle, XCircle } from '@phosphor-icons/react';
import { useApi } from '@/lib/useApi';
import { PageHeader } from '@/components/Primitives';
import { Card } from '@/components/ui/Card';
import { SkeletonCard } from '@/components/ui/Skeleton';
import type { AdminUser } from '@/lib/types';

function fmt(d: string | null): string {
  return d ? new Date(d).toLocaleString() : '—';
}

export default function AdminUsersPage() {
  const { data: users, isLoading, error } = useApi<AdminUser[]>('/admin/users');

  return (
    <div>
      <PageHeader eyebrow="Staff only" title="Users" subtitle={users ? `${users.length} accounts` : undefined} />
      {isLoading && <SkeletonCard />}
      {error && <p className="text-sm text-destructive">Could not load users.</p>}
      {users && (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">2FA</th>
                <th className="px-4 py-3">Staff</th>
                <th className="px-4 py-3">Last login</th>
                <th className="px-4 py-3">Created</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3">{u.email}</td>
                  <td className="px-4 py-3">{u.full_name || '—'}</td>
                  <td className="px-4 py-3">
                    {u.mfa_enabled
                      ? <CheckCircle size={16} weight="fill" className="text-success" />
                      : <XCircle size={16} weight="fill" className="text-muted-foreground/40" />}
                  </td>
                  <td className="px-4 py-3">
                    {u.is_platform_staff
                      ? <CheckCircle size={16} weight="fill" className="text-primary" />
                      : <span className="text-muted-foreground/40">&mdash;</span>}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{fmt(u.last_login_at)}</td>
                  <td className="px-4 py-3 text-muted-foreground">{fmt(u.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
