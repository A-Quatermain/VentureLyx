'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { apiFetch, ApiError } from '@/lib/api';
import { ensureOrgSelected } from '@/lib/orgSelect';
import type { LoginResponse } from '@/lib/types';
import { Button } from '@/components/ui/Button';

export default function SignInPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await apiFetch<LoginResponse>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });

      if (res.mfaRequired) {
        router.push('/mfa');
        return;
      }

      const me = await ensureOrgSelected();
      router.push(me.organizations?.length ? '/home' : '/onboarding');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen grid-cols-1 lg:grid-cols-2">
      {/*
        PLACEHOLDER PHOTO — stock still, not real Venturelyx brand
        photography. Swap web/public/images/signin-hero.jpg (same filename)
        for a real photo; see public/video/SOURCES.md. Sign-in keeps a
        still image by design — landing and onboarding use video instead.
      */}
      <div className="relative hidden overflow-hidden lg:flex lg:flex-col lg:justify-between lg:p-12">
        <img
          src="/images/signin-hero.jpg"
          alt=""
          aria-hidden
          className="absolute inset-0 h-full w-full object-cover"
        />
        {/* Hardcoded to the original indigo/violet values (design_guidelines.json's
            light --primary #4F46E5, Tailwind's violet-950 #2e1065) rather
            than from-primary/to-violet-950 — this photo's tint predates the
            brand-blue token change and must stay indigo/violet regardless of
            what --primary becomes next, not silently follow it. */}
        <div className="absolute inset-0 bg-gradient-to-b from-[#4F46E5]/80 via-[#4F46E5]/40 to-[#2e1065]/85" />

        {/* No logo on this panel by design — logo-full's navy wordmark
            doesn't read against this indigo/purple overlay. Lives on the
            light form side instead, where it's fully legible. */}

        <h1 className="relative max-w-lg font-display text-4xl font-bold leading-tight tracking-tight text-white xl:text-5xl">
          We build businesses, not websites.
        </h1>
      </div>

      <div className="flex items-center justify-center bg-background p-6">
        <div className="w-full max-w-sm">
          {/* Theme-aware pair — this panel is bg-background (light or dark
              depending on theme), unlike the hero panel's fixed dark scrim.
              56px, both breakpoints — this is now the only logo on the page,
              shown here on mobile too since the photo panel is lg:hidden. */}
          <img src="/brand/logo-full.png" alt="Venturelyx" className="h-14 w-auto dark:hidden" />
          <img src="/brand/logo-full-white.png" alt="Venturelyx" className="hidden h-14 w-auto dark:block" />
          <h2 className="mt-6 font-display text-2xl font-bold tracking-tight">Welcome back</h2>
          <p className="mt-1 text-sm text-muted-foreground">Sign in to your Command Center.</p>

          <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-4">
            <label className="flex flex-col gap-1.5 text-sm font-medium text-muted-foreground">
              Email
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="min-h-[44px] rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-sm font-medium text-muted-foreground">
              <span className="flex items-center justify-between">
                Password
                <Link href="/forgot-password" className="text-xs font-medium text-primary hover:underline">
                  Forgot password?
                </Link>
              </span>
              <input
                type="password"
                required
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="min-h-[44px] rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              />
            </label>

            {error && <p className="text-sm text-destructive">{error}</p>}

            <Button type="submit" disabled={busy} className="mt-2 w-full">
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>

          <p className="mt-6 text-center text-sm text-muted-foreground">
            New to Venturelyx?{' '}
            <Link href="/register" className="font-medium text-primary hover:underline">
              Create an account
            </Link>
          </p>
        </div>
      </div>
    </main>
  );
}
