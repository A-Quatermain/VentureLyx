'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { apiFetch, ApiError } from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

const inputCls =
  'min-h-[42px] rounded-lg border border-border bg-background px-3 text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';

interface SignupResponse {
  ok: boolean;
  orgId: string;
  requiresApproval: boolean;
}

export default function GetStartedPage() {
  const [businessName, setBusinessName] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingApproval, setPendingApproval] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 12) {
      setError('Use at least 12 characters.');
      return;
    }
    setBusy(true);
    try {
      const result = await apiFetch<SignupResponse>('/growth-scan/self-service', {
        method: 'POST',
        body: JSON.stringify({
          business_name: businessName, website_url: websiteUrl || undefined,
          full_name: fullName, email, password,
        }),
      });

      if (result.requiresApproval) {
        setPendingApproval(true);
        setBusy(false);
        return;
      }

      // Platform ($129/mo) is self-service — go straight to Stripe
      // Checkout. The webhook that fires on successful payment is what
      // actually flips this org out of 'prospect' and unlocks the app.
      const { url } = await apiFetch<{ url: string }>('/billing/checkout', {
        method: 'POST', body: JSON.stringify({ lookupKeys: ['platform_monthly'] }),
      });
      window.location.href = url;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-sm p-8">
        <p className="font-display text-lg font-bold tracking-tight">Get started with Platform</p>
        <p className="mt-1 text-sm text-muted-foreground">$129/mo. Self-service — no sales call needed.</p>

        {pendingApproval ? (
          <p className="mt-6 text-sm text-muted-foreground">
            Your account is created — we&rsquo;re just reviewing new signups right now and will email you the moment
            you&rsquo;re approved for payment.
          </p>
        ) : (
        <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm text-muted-foreground">
            Business name
            <input required value={businessName} onChange={(e) => setBusinessName(e.target.value)} className={inputCls} />
          </label>
          <label className="flex flex-col gap-1 text-sm text-muted-foreground">
            Website (optional)
            <input type="url" value={websiteUrl} onChange={(e) => setWebsiteUrl(e.target.value)} placeholder="https://yourbusiness.com" className={inputCls} />
          </label>
          <label className="flex flex-col gap-1 text-sm text-muted-foreground">
            Your name
            <input required autoComplete="name" value={fullName} onChange={(e) => setFullName(e.target.value)} className={inputCls} />
          </label>
          <label className="flex flex-col gap-1 text-sm text-muted-foreground">
            Email
            <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} />
          </label>
          <label className="flex flex-col gap-1 text-sm text-muted-foreground">
            Password
            <input type="password" required minLength={12} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputCls} />
            <span className="text-xs text-muted-foreground/70">At least 12 characters.</span>
          </label>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" disabled={busy} className="mt-2">
            {busy ? 'Setting up…' : 'Continue to payment'}
          </Button>
        </form>
        )}

        <p className="mt-4 text-center text-sm text-muted-foreground">
          Need Growth Partner or Launch &amp; Growth instead?{' '}
          <Link href="/growth-scan" className="text-primary">Get a free Growth Scan</Link>
        </p>
      </Card>
    </main>
  );
}
