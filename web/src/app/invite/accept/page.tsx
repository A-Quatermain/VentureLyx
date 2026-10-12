'use client';

import { Suspense, useState, type FormEvent } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

const inputCls =
  'min-h-[42px] rounded-lg border border-border bg-background px-3 text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';

function AcceptInviteForm() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await apiFetch<{ orgId: string }>('/auth/invites/accept', {
        method: 'POST',
        body: JSON.stringify({ token, full_name: fullName || undefined, password: password || undefined }),
      });
      router.push('/home');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return <p className="mt-4 text-sm text-destructive">This invite link is missing its token.</p>;
  }

  return (
    <>
      <p className="mt-1 text-sm text-muted-foreground">
        If you already have a Venturelyx account with this email, just accept below. New here? Set a name and
        password first.
      </p>
      <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm text-muted-foreground">
          Full name (new accounts only)
          <input
            type="text"
            autoComplete="name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className={inputCls}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-muted-foreground">
          Password (new accounts only)
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputCls}
          />
        </label>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button type="submit" disabled={busy} className="mt-2 w-full">
          {busy ? 'Accepting…' : 'Accept invite'}
        </Button>
      </form>
    </>
  );
}

export default function AcceptInvitePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-sm p-8">
        <p className="font-display text-lg font-bold tracking-tight">Venturelyx</p>
        <Suspense fallback={<p className="mt-4 text-sm text-muted-foreground">Loading…</p>}>
          <AcceptInviteForm />
        </Suspense>
      </Card>
    </main>
  );
}
