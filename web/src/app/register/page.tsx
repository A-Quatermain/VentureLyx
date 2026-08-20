'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { apiFetch, ApiError } from '@/lib/api';
import type { LoginResponse } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

const inputCls =
  'min-h-[42px] rounded-none border border-border bg-background px-3 text-foreground outline-none focus:border-primary';

export default function RegisterPage() {
  const router = useRouter();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 12) {
      setError('Use at least 12 characters.');
      return;
    }
    setBusy(true);
    try {
      await apiFetch<LoginResponse>('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, password, full_name: fullName }),
      });
      router.push('/onboarding');
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
        <p className="mt-1 text-sm text-muted-foreground">Create your account</p>

        <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm text-muted-foreground">
            Full name
            <input
              required
              autoComplete="name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              className={inputCls}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-muted-foreground">
            Email
            <input
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={inputCls}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-muted-foreground">
            Password
            <input
              type="password"
              required
              minLength={12}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputCls}
            />
            <span className="text-xs text-muted-foreground/70">At least 12 characters.</span>
          </label>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" disabled={busy} className="mt-2">
            {busy ? 'Creating account…' : 'Create account'}
          </Button>
        </form>

        <p className="mt-4 text-center text-sm text-muted-foreground">
          Already have an account?{' '}
          <Link href="/sign-in" className="text-primary">
            Sign in
          </Link>
        </p>
      </Card>
    </main>
  );
}
