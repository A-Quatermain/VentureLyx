'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { apiFetch, ApiError } from '@/lib/api';
import { Card } from '@/components/ui/Card';

function VerifyEmailBody() {
  const token = useSearchParams().get('token') ?? '';
  const [state, setState] = useState<'checking' | 'ok' | 'error'>('checking');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) {
      setState('error');
      setError('This verification link is missing its token.');
      return;
    }
    apiFetch('/auth/verify-email/confirm', { method: 'POST', body: JSON.stringify({ token }) })
      .then(() => setState('ok'))
      .catch((err) => {
        setState('error');
        setError(err instanceof ApiError ? err.message : 'Something went wrong.');
      });
  }, [token]);

  if (state === 'checking') return <p className="mt-4 text-sm text-muted-foreground">Verifying…</p>;
  if (state === 'error') {
    return (
      <>
        <p className="mt-4 text-sm text-destructive">{error}</p>
        <Link href="/home" className="mt-6 inline-block text-sm font-medium text-primary hover:underline">
          Continue to Venturelyx
        </Link>
      </>
    );
  }
  return (
    <>
      <p className="mt-4 text-sm text-foreground">Your email is verified.</p>
      <Link href="/home" className="mt-6 inline-block text-sm font-medium text-primary hover:underline">
        Continue to Venturelyx
      </Link>
    </>
  );
}

export default function VerifyEmailPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-sm p-8">
        <p className="font-display text-lg font-bold tracking-tight">Venturelyx</p>
        <Suspense fallback={<p className="mt-4 text-sm text-muted-foreground">Loading…</p>}>
          <VerifyEmailBody />
        </Suspense>
      </Card>
    </main>
  );
}
