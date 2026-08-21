'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api';
import { ensureOrgSelected } from '@/lib/orgSelect';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

export default function MfaPage() {
  const router = useRouter();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await apiFetch('/auth/mfa', { method: 'POST', body: JSON.stringify({ code }) });
      const me = await ensureOrgSelected();
      router.push(me.organizations?.length ? '/home' : '/onboarding');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-sm p-8">
        <p className="font-display text-lg font-bold tracking-tight">Two-factor code</p>
        <p className="mt-1 text-sm text-muted-foreground">Codes change every 30 seconds.</p>

        <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-sm text-muted-foreground">
            Code
            <input
              type="text"
              inputMode="numeric"
              required
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="min-h-[42px] rounded-lg border border-border bg-background px-3 font-mono text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              data-numeric
            />
          </label>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" disabled={busy} className="mt-2">
            {busy ? 'Verifying…' : 'Verify'}
          </Button>
        </form>
      </Card>
    </main>
  );
}
