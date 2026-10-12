'use client';

import { useState, type FormEvent } from 'react';
import { apiFetch, ApiError } from '@/lib/api';
import { useApi } from '@/lib/useApi';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

const inputCls =
  'min-h-[42px] rounded-lg border border-border bg-background px-3 text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';

interface ScanSummary {
  healthScore: number | null;
  status: 'pending' | 'ready';
}

function ScanResult({ scanId }: { scanId: string }) {
  // Polls every 5s while the crawl is still running — a real crawl takes
  // longer than one request/response cycle. Stops once status is 'ready'.
  const { data } = useApi<ScanSummary>(`/growth-scan/${scanId}/summary`, { refreshInterval: (d) => (d?.status === 'ready' ? 0 : 5000) });
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function unlock(e: FormEvent) {
    e.preventDefault();
    setStatus('submitting');
    setError(null);
    try {
      await apiFetch(`/growth-scan/${scanId}/unlock`, { method: 'POST', body: JSON.stringify({ email }) });
      setStatus('done');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
      setStatus('error');
    }
  }

  return (
    <div className="mt-6">
      {!data || data.status === 'pending' ? (
        <p className="text-sm text-muted-foreground">Scanning your site — this takes about a minute…</p>
      ) : (
        <div className="rounded-lg border border-border p-5 text-center">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Health score</p>
          <p className="mt-1 font-display text-4xl font-bold tabular-nums">{data.healthScore}/100</p>
        </div>
      )}

      {status === 'done' ? (
        <p className="mt-4 text-sm font-medium text-success">Check your inbox — your full report is on its way.</p>
      ) : (
        <form onSubmit={unlock} className="mt-4 flex flex-col gap-2">
          <label className="text-sm text-muted-foreground">
            Get the full report (issues, opportunities, next steps) by email
          </label>
          <div className="flex gap-2">
            <input
              type="email" required placeholder="you@business.com"
              value={email} onChange={(e) => setEmail(e.target.value)}
              className={`${inputCls} flex-1`}
            />
            <Button type="submit" disabled={status === 'submitting'}>
              {status === 'submitting' ? 'Sending…' : 'Get my report'}
            </Button>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </form>
      )}
    </div>
  );
}

export default function GrowthScanPage() {
  const [url, setUrl] = useState('');
  const [scanId, setScanId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { scanId: id } = await apiFetch<{ scanId: string }>('/growth-scan', {
        method: 'POST', body: JSON.stringify({ url }),
      });
      setScanId(id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md p-8">
        <p className="font-display text-lg font-bold tracking-tight">Free Growth Scan</p>
        <p className="mt-1 text-sm text-muted-foreground">
          See your site&rsquo;s health score and growth opportunities in under a minute. No obligation.
        </p>

        {!scanId ? (
          <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm text-muted-foreground">
              Your website
              <input
                type="url" required placeholder="https://yourbusiness.com"
                value={url} onChange={(e) => setUrl(e.target.value)}
                className={inputCls}
              />
            </label>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={busy} className="mt-2">
              {busy ? 'Starting scan…' : 'Scan my site'}
            </Button>
          </form>
        ) : (
          <ScanResult scanId={scanId} />
        )}
      </Card>
    </main>
  );
}
