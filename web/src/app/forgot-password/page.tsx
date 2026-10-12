'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { apiFetch, ApiError } from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

const inputCls =
  'min-h-[42px] rounded-lg border border-border bg-background px-3 text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Always the same screen on submit, success or not — the server's own
  // response never reveals whether the email exists, so the UI can't
  // either.
  const [sent, setSent] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await apiFetch('/auth/forgot', { method: 'POST', body: JSON.stringify({ email }) });
      setSent(true);
    } catch (err) {
      // A genuine failure (rate-limited, malformed email) still gets its
      // own message — only "does this account exist" stays hidden.
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-sm p-8">
        <p className="font-display text-lg font-bold tracking-tight">Venturelyx</p>

        {sent ? (
          <>
            <p className="mt-1 text-sm text-muted-foreground">Check your email</p>
            <p className="mt-4 text-sm text-foreground">
              If that email is registered, we sent a link to reset your password. It expires in 30 minutes.
            </p>
            <Link href="/sign-in" className="mt-6 inline-block text-sm font-medium text-primary hover:underline">
              Back to sign in
            </Link>
          </>
        ) : (
          <>
            <p className="mt-1 text-sm text-muted-foreground">Reset your password</p>
            <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-3">
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
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" disabled={busy} className="mt-2 w-full">
                {busy ? 'Sending…' : 'Send reset link'}
              </Button>
            </form>
            <Link href="/sign-in" className="mt-6 inline-block text-sm font-medium text-primary hover:underline">
              Back to sign in
            </Link>
          </>
        )}
      </Card>
    </main>
  );
}
