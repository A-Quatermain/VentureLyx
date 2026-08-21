'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api';
import type { CreateOrgResponse, SeoHealthDetail } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { BusinessProfileForm, type BusinessProfileValues } from '@/components/BusinessProfileForm';

type Step = 'form' | 'crawling' | 'done';

const BLANK_PROFILE: BusinessProfileValues = { name: '', website_url: '', vertical: '', service_area: '' };

export default function OnboardingPage() {
  const router = useRouter();
  const [profile, setProfile] = useState<BusinessProfileValues>(BLANK_PROFILE);
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
          name: profile.name,
          website_url: profile.website_url.trim() || null,
          vertical: profile.vertical.trim() || null,
          service_area: profile.service_area.trim() || null,
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
          <p className="font-display text-lg font-bold tracking-tight">Venturelyx</p>
          {step === 'crawling' ? (
            <>
              <div className="mt-6 flex justify-center gap-1.5" aria-hidden>
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="h-2 w-2 animate-pulse rounded-full bg-primary"
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
      <Card className="w-full max-w-lg p-8">
        <p className="font-display text-lg font-bold tracking-tight">Venturelyx</p>
        <p className="mt-1 text-sm text-muted-foreground">Tell us about your business</p>

        <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
          <BusinessProfileForm values={profile} onChange={setProfile} />

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" disabled={busy} className="mt-2">
            {busy ? 'Creating…' : 'Continue'}
          </Button>
        </form>
      </Card>
    </main>
  );
}
