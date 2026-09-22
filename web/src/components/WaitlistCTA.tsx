'use client';

import { useState, type FormEvent } from 'react';
import { ArrowRight } from '@phosphor-icons/react';
import { apiFetch, ApiError } from '@/lib/api';

/**
 * "Join the waitlist" CTA used everywhere on the landing page a real
 * subscribe/pay action would go once Stripe exists (lib/pricing.ts) —
 * posts to POST /v1/waitlist instead. Starts as a plain button; clicking
 * it expands to an inline email form rather than navigating anywhere, so
 * it can live inline in the pricing section instead of routing to a
 * separate page for a single field.
 */
export function WaitlistCTA({
  interest,
  sourcePage,
  label = 'Join the waitlist',
  className = '',
}: {
  interest?: string;
  sourcePage: string;
  label?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'submitting' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setStatus('submitting');
    setError(null);
    try {
      await apiFetch('/waitlist', {
        method: 'POST',
        body: JSON.stringify({ email, interest, source_page: sourcePage }),
      });
      setStatus('done');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
      setStatus('error');
    }
  }

  if (status === 'done') {
    return (
      <p className="text-sm font-medium text-success">
        You&rsquo;re on the list — we&rsquo;ll reach out as soon as it&rsquo;s ready.
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={className || 'inline-flex min-h-[42px] items-center gap-1.5 rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary-hover hover:shadow-md'}
      >
        {label} <ArrowRight size={16} weight="bold" />
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2 sm:flex-row">
      <input
        type="email"
        required
        autoFocus
        placeholder="you@yourbusiness.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="min-h-[42px] rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
      />
      <button
        type="submit"
        disabled={status === 'submitting'}
        className="inline-flex min-h-[42px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary-hover hover:shadow-md disabled:opacity-50"
      >
        {status === 'submitting' ? 'Joining…' : 'Join'}
      </button>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </form>
  );
}
