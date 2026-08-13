'use client';

import { useState } from 'react';
import { mutate } from 'swr';
import { apiFetch, ApiError } from '@/lib/api';
import { atLeast, useRole } from '@/lib/useApi';
import type { CrawlResponse } from '@/lib/types';
import { Button } from '@/components/ui/Button';

export function CrawlButton({ siteId }: { siteId: string }) {
  const role = useRole();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // UI gating only — the API's own requireRole('manager') is what actually
  // enforces this; a stale/wrong client-side role read must still fail
  // gracefully via the 403 branch below, not be treated as impossible.
  if (!atLeast(role, 'manager')) return null;

  async function onClick() {
    setBusy(true);
    setMessage(null);
    try {
      const res = await apiFetch<CrawlResponse>(`/seo/crawl/${siteId}`, { method: 'POST' });
      setMessage(res.queued ? 'Crawl queued.' : (res.reason ?? 'Not queued.'));
      if (res.queued) await mutate(() => true);
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : 'Could not queue a crawl.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Button variant="ghost" onClick={onClick} disabled={busy}>
        {busy ? 'Queuing…' : 'Run a check now'}
      </Button>
      {message && <span className="text-xs text-ink-3">{message}</span>}
    </div>
  );
}
