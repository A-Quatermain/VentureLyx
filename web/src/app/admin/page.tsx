'use client';

import Link from 'next/link';
import { Users, Buildings, ListChecks } from '@phosphor-icons/react';
import { useApi } from '@/lib/useApi';
import { PageHeader } from '@/components/Primitives';
import { Card } from '@/components/ui/Card';
import type { AdminSummary } from '@/lib/types';

const TILES = [
  { key: 'userCount', label: 'Users', icon: Users, href: '/admin/users' },
  { key: 'orgCount', label: 'Organizations', icon: Buildings, href: '/admin/organizations' },
  { key: 'waitlistNewCount', label: 'New waitlist signups', icon: ListChecks, href: '/admin/waitlist' },
] as const;

export default function AdminDashboardPage() {
  const { data, isLoading } = useApi<AdminSummary>('/admin/summary');

  return (
    <div>
      <PageHeader eyebrow="Staff only" title="Admin" subtitle="Platform-wide view — every visit here is logged to audit_log." />
      <div className="grid gap-4 sm:grid-cols-3">
        {TILES.map((t) => (
          <Link key={t.key} href={t.href}>
            <Card className="p-6 transition-shadow hover:shadow-md">
              <t.icon size={24} weight="duotone" className="text-primary" />
              <div className="mt-4 font-mono text-3xl font-semibold tabular-nums">
                {isLoading || !data ? '—' : data[t.key]}
              </div>
              <div className="mt-1 text-sm text-muted-foreground">{t.label}</div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
