'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api';
import type { CreateOrgResponse, SeoHealthDetail } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

const inputCls =
  'min-h-[42px] rounded-none border border-border bg-background px-3 text-foreground outline-none focus:border-primary';

type Step = 'form' | 'crawling' | 'done';

export default function OnboardingPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [vertical, setVertical] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<Step>('form');
  const [siteId, setSiteId] = useState<string | null>(null);
  const [health, setHealth] = useState<number | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const org = await apiFetch<CreateOrgResponse>('/orgs', {
        method: 'POST',
        body: JSON.stringify({
          name,
          website_url: websiteUrl.trim() || null,
          vertical: vertical.trim() || null,
        }),
      });
      if (org.crawlQueued && org.siteId) {
        setSiteId(org.siteId);
        setStep('crawling');
      } else {
        router.push('/home');
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
      setBusy(false);
    }
  }

  // seo_scores only gets a row once a crawl finishes (GET /seo/health/:siteId
  // returns score: null until then) — poll until it lands rather than
  // guessing a fixed delay.
  useEffect(() => {
    if (step !== 'crawling' || !siteId) return;
    let cancelled = false;

    async function poll() {
      try {
        const detail = await apiFetch<SeoHealthDetail>(`/seo/health/${siteId}`);
        if (cancelled) return;
        if (detail.score?.health != null) {
          setHealth(detail.score.health);
          setStep('done');
        }
      } catch {
        // Transient — the next tick tries again.
      }
    }

    poll();
    const id = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [step, siteId]);

  useEffect(() => {
    if (step !== 'done') return;
    const t = setTimeout(() => router.push('/home'), 1500);
    return () => clearTimeout(t);
  }, [step, router]);

  if (step === 'crawling' || step === 'done') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6">
        <Card className="w-full max-w-sm p-8 text-center">
          <p className="font-display text-lg font-black tracking-tight">Venturelyx</p>
          {step === 'crawling' ? (
            <>
              <div className="mt-6 flex justify-center gap-1.5" aria-hidden>
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="h-2 w-2 animate-pulse bg-primary"
                    style={{ animationDelay: `${i * 150}ms` }}
                  />
                ))}
              </div>
              <p className="mt-4 text-sm text-muted-foreground">Scanning your site…</p>
              <p className="mt-1 text-xs text-muted-foreground/70">
                This usually takes a minute or two. Feel free to move on — it'll keep running.
              </p>
            </>
          ) : (
            <>
              <p data-numeric className="mt-4 font-mono text-4xl font-bold">
                {health}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">Your starting SEO health score</p>
            </>
          )}
          <button onClick={() => router.push('/home')} className="mt-6 text-sm text-primary">
            {step === 'done' ? 'Continue →' : 'Skip for now →'}
          </button>
        </Card>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-sm p-8">
        <p className="font-display text-lg font-black tracking-tight">Venturelyx</p>
        <p className="mt-1 text-sm text-muted-foreground">Tell us about your business</p>

        <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm text-muted-foreground">
            Business name
            <input required value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
          </label>
          <label className="flex flex-col gap-1 text-sm text-muted-foreground">
            Website (optional)
            <input
              type="url"
              placeholder="https://example.com"
              value={websiteUrl}
              onChange={(e) => setWebsiteUrl(e.target.value)}
              className={inputCls}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-muted-foreground">
            Industry (optional)
            <input value={vertical} onChange={(e) => setVertical(e.target.value)} className={inputCls} />
          </label>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" disabled={busy} className="mt-2">
            {busy ? 'Creating…' : 'Continue'}
          </Button>
        </form>
      </Card>
    </main>
  );
}
