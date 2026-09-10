'use client';

import { useState } from 'react';
import { mutate } from 'swr';
import { apiFetch, ApiError } from '@/lib/api';
import { atLeast, useApi, useRole } from '@/lib/useApi';
import type { SeoSiteConfig } from '@/lib/types';
import { Button } from '@/components/ui/Button';

// Lets an admin flip workers/seo/crawler.py's fetch mode for this site —
// headless-browser rendering for client-rendered SPAs vs. plain HTTP for
// static sites — without SSH+SQL. Previously only settable by re-running
// scripts/seed_sites.py by hand (see nppools.com, which migrated to a
// client-rendered platform after being seeded static).
export function RenderToggle({ siteId }: { siteId: string }) {
  const key = `/seo/sites/${siteId}`;
  const role = useRole();
  const { data } = useApi<SeoSiteConfig>(key);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!atLeast(role, 'admin') || !data) return null;
  const site = data;

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(key, { method: 'PATCH', body: JSON.stringify({ render: !site.render }) });
      await mutate(key);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not update rendering.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button variant="ghost" onClick={toggle} disabled={busy}>
        {busy ? 'Updating…' : site.render ? 'Rendering: On (browser fetch)' : 'Rendering: Off (static fetch)'}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
