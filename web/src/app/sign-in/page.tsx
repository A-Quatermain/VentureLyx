'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { apiFetch, ApiError } from '@/lib/api';
import { ensureOrgSelected } from '@/lib/orgSelect';
import type { LoginResponse } from '@/lib/types';
import { Card } from '@/components/ui/Card';
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

      await ensureOrgSelected();
      router.push('/home');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-sm p-8">
        <p className="font-display text-lg font-black tracking-tight">Venturelyx</p>
        <p className="mt-1 text-sm text-muted-foreground">Sign in to Command Center</p>

        <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm text-muted-foreground">
            Email
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="min-h-[42px] rounded-none border border-border bg-background px-3 text-foreground outline-none focus:border-primary"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-muted-foreground">
            Password
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="min-h-[42px] rounded-none border border-border bg-background px-3 text-foreground outline-none focus:border-primary"
            />
          </label>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" disabled={busy} className="mt-2">
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>

        <p className="mt-4 text-center text-sm text-muted-foreground">
          New to Venturelyx?{' '}
          <Link href="/register" className="text-primary">
            Create an account
          </Link>
        </p>
      </Card>
    </main>
  );
}
