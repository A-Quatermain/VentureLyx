'use client';

import { useState, useTransition, type ChangeEvent } from 'react';
import { useRouter } from 'next/navigation';
import { mutate } from 'swr';
import { apiFetch } from '@/lib/api';
import type { Organization } from '@/lib/types';

// Switching orgs is a real state change: POST /auth/org updates
// sessions.org_id server-side (that's what makes req.db()'s RLS context
// correct on the next call), then we revalidate every SWR-cached org-scoped
// query and refresh server-rendered data. Never just re-slice a cached
// all-orgs list client-side.
export function OrgSwitcher({
  organizations,
  currentOrgId,
}: {
  organizations: Organization[];
  currentOrgId: string | null | undefined;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [switching, setSwitching] = useState(false);

  async function onChange(e: ChangeEvent<HTMLSelectElement>) {
    const orgId = e.target.value;
    if (orgId === currentOrgId) return;

    setSwitching(true);
    try {
      await apiFetch('/auth/org', { method: 'POST', body: JSON.stringify({ orgId }) });
      await mutate(() => true); // revalidate every SWR-cached org-scoped query
      startTransition(() => router.refresh()); // re-run server components (layout, /auth/me)
    } finally {
      setSwitching(false);
    }
  }

  return (
    <select
      value={currentOrgId ?? ''}
      onChange={onChange}
      disabled={switching || pending}
      aria-label="Switch business"
      className="min-h-[42px] rounded-button border border-line-2 bg-card px-3 text-sm font-medium text-ink outline-none focus:border-pool disabled:opacity-60"
    >
      {!currentOrgId && <option value="">Choose a business…</option>}
      {organizations.map((org) => (
        <option key={org.id} value={org.id}>
          {org.name}
        </option>
      ))}
    </select>
  );
}
