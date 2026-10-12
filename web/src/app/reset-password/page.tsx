'use client';

import { Suspense, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { apiFetch, ApiError } from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

const inputCls =
  'min-h-[42px] rounded-lg border border-border bg-background px-3 text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';

function ResetPasswordForm() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 12) {
      setError('Use at least 12 characters.');
      return;
    }
    setBusy(true);
    try {
      await apiFetch('/auth/reset', { method: 'POST', body: JSON.stringify({ token, password }) });
      setDone(true);
      setTimeout(() => router.push('/sign-in'), 2000);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <>
        <p className="mt-1 text-sm text-destructive">This reset link is missing its token.</p>
        <Link href="/forgot-password" className="mt-6 inline-block text-sm font-medium text-primary hover:underline">
          Request a new link
        </Link>
      </>
    );
  }

  if (done) {
    return <p className="mt-4 text-sm text-foreground">Password updated. Taking you to sign in…</p>;
  }

  return (
    <>
      <p className="mt-1 text-sm text-muted-foreground">Set a new password</p>
      <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm text-muted-foreground">
          New password
          <input
            type="password"
            required
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputCls}
          />
        </label>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={busy} className="mt-2 w-full">
          {busy ? 'Updating…' : 'Update password'}
        </Button>
      </form>
    </>
  );
}

export default function ResetPasswordPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-sm p-8">
        <p className="font-display text-lg font-bold tracking-tight">Venturelyx</p>
        <Suspense fallback={<p className="mt-4 text-sm text-muted-foreground">Loading…</p>}>
          <ResetPasswordForm />
        </Suspense>
      </Card>
    </main>
  );
}
