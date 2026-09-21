'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api';
import type { CreateOrgResponse, SeoHealthDetail } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { BusinessProfileForm, type BusinessProfileValues } from '@/components/BusinessProfileForm';
import { ServiceAreaForm, BLANK_SERVICE_AREA, realCities, type ServiceAreaValues } from '@/components/ServiceAreaForm';
import { VideoHero } from '@/components/VideoHero';

type Step = 'form' | 'crawling' | 'done';

const BLANK_PROFILE: BusinessProfileValues = { name: '', website_url: '', vertical: '', service_area: '' };

// Where they work is optional at this step (matches "Skip for now" further
// down) — filled in here if they have it handy, in Settings otherwise.
function hasServiceAreaInput(v: ServiceAreaValues): boolean {
  return v.mode === 'cities' ? realCities(v.cities).length > 0 : v.address_line1.trim() !== '' && v.radiusMiles.trim() !== '';
}

// Same split treatment as sign-in — video panel left (sign-in uses a still
// photo instead), wizard content right.
function OnboardingLayout({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <main className="grid min-h-screen grid-cols-1 lg:grid-cols-2">
      <div className="relative hidden overflow-hidden lg:flex lg:flex-col lg:justify-between lg:p-12">
        <VideoHero
          poster="/video/hero-trades-poster.jpg"
          mp4="/video/hero-trades.mp4"
          webm="/video/hero-trades.webm"
          className="absolute inset-0"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-primary/80 via-primary/40 to-[#001030]/85" />

        <p className="relative font-display text-lg font-bold tracking-tight text-white">Venturelyx</p>

        <h1 className="relative max-w-lg font-display text-4xl font-bold leading-tight tracking-tight text-white xl:text-5xl">
          We build businesses, not websites.
        </h1>
      </div>

      <div className="flex items-center justify-center bg-background p-6">
        <div className={`w-full text-center ${wide ? 'max-w-lg' : 'max-w-sm'}`}>{children}</div>
      </div>
    </main>
  );
}

export default function OnboardingPage() {
  const router = useRouter();
  const [profile, setProfile] = useState<BusinessProfileValues>(BLANK_PROFILE);
  const [serviceArea, setServiceArea] = useState<ServiceAreaValues>(BLANK_SERVICE_AREA);
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

      // Best-effort — the owner can always set this in Settings later, and a
      // failure here shouldn't block onboarding from completing.
      if (hasServiceAreaInput(serviceArea)) {
        try {
          const body =
            serviceArea.mode === 'cities'
              ? {
                  mode: 'cities' as const,
                  cities: realCities(serviceArea.cities).map((c) => ({
                    name: c.name, region: c.region.trim() || null, isPrimary: c.isPrimary,
                  })),
                }
              : {
                  mode: 'radius' as const,
                  address_line1: serviceArea.address_line1,
                  address_line2: serviceArea.address_line2 || null,
                  city: serviceArea.city,
                  region: serviceArea.region || null,
                  postal_code: serviceArea.postal_code || null,
                  radiusMiles: Number(serviceArea.radiusMiles),
                };
          await apiFetch('/service-area', { method: 'PUT', body: JSON.stringify(body) });
        } catch {
          // Swallowed on purpose — see comment above.
        }
      }

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
      <OnboardingLayout>
        <p className="font-display text-lg font-bold tracking-tight lg:hidden">Venturelyx</p>
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
            <p data-numeric className="mt-4 font-mono text-4xl font-semibold tabular-nums">
              {health}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">Your starting SEO health score</p>
          </>
        )}
        <button onClick={() => router.push('/home')} className="mt-6 text-sm font-medium text-primary hover:underline">
          {step === 'done' ? 'Continue →' : 'Skip for now →'}
        </button>
      </OnboardingLayout>
    );
  }

  return (
    <OnboardingLayout wide>
      <div className="text-left">
        <p className="font-display text-lg font-bold tracking-tight lg:hidden">Venturelyx</p>
        <h2 className="mt-1 font-display text-2xl font-bold tracking-tight">Tell us about your business</h2>

        <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
          <BusinessProfileForm values={profile} onChange={setProfile} />

          <div className="border-t border-border pt-4">
            <p className="mb-3 text-sm font-medium">Where do you work? (optional)</p>
            <ServiceAreaForm values={serviceArea} onChange={setServiceArea} />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" disabled={busy} className="mt-2 w-full">
            {busy ? 'Creating…' : 'Continue'}
          </Button>
        </form>
      </div>
    </OnboardingLayout>
  );
}
