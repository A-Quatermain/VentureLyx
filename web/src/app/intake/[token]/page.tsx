'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'next/navigation';
import { apiFetch, ApiError } from '@/lib/api';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

const inputCls =
  'min-h-[42px] rounded-lg border border-border bg-background px-3 text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';
const labelCls = 'flex flex-col gap-1 text-sm text-muted-foreground';

interface IntakeStatus {
  dealId: string;
  alreadySubmitted: boolean;
}

const FIELDS: Array<{ key: string; label: string; type?: string; textarea?: boolean }> = [
  { key: 'business_name', label: 'Business legal / display name' },
  { key: 'primary_contact', label: 'Primary contact' },
  { key: 'contact_email', label: 'Contact email', type: 'email' },
  { key: 'phone', label: 'Phone' },
  { key: 'website_url', label: 'Website', type: 'url' },
  { key: 'address_line1', label: 'Address line 1' },
  { key: 'address_line2', label: 'Address line 2' },
  { key: 'city', label: 'City' },
  { key: 'region', label: 'State / region' },
  { key: 'postal_code', label: 'Postal code' },
  { key: 'service_area', label: 'Primary service area' },
  { key: 'business_category', label: 'Business category' },
  { key: 'main_services', label: 'Main services', textarea: true },
  { key: 'current_crm', label: 'Current CRM, if any' },
  { key: 'website_platform', label: 'Current website platform' },
  { key: 'gbp_status', label: 'Google Business Profile status' },
  { key: 'social_accounts', label: 'Social accounts', textarea: true },
  { key: 'primary_goals', label: 'Primary business goals', textarea: true },
  { key: 'biggest_problem', label: 'Biggest current growth problem', textarea: true },
  { key: 'preferred_onboarding_date', label: 'Preferred onboarding date', type: 'date' },
];

export default function IntakePage() {
  const { token } = useParams<{ token: string }>();
  const [status, setStatus] = useState<IntakeStatus | 'loading' | 'invalid'>('loading');
  const [values, setValues] = useState<Record<string, string>>({});
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    apiFetch<IntakeStatus>(`/intake/${token}`)
      .then((s) => { setStatus(s); setSubmitted(s.alreadySubmitted); })
      .catch(() => setStatus('invalid'));
  }, [token]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await apiFetch(`/intake/${token}`, { method: 'POST', body: JSON.stringify(values) });
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (status === 'loading') return <main className="p-10 text-center text-sm text-muted-foreground">Loading…</main>;
  if (status === 'invalid') {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background p-6">
        <p className="text-sm text-destructive">This intake link is invalid or has expired.</p>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-lg p-8">
        <p className="font-display text-lg font-bold tracking-tight">Tell us about your business</p>
        <p className="mt-1 text-sm text-muted-foreground">
          A few details so we can get your onboarding right the first time. No passwords or account credentials here —
          we&rsquo;ll collect those separately during onboarding.
        </p>

        {submitted ? (
          <p className="mt-6 text-sm font-medium text-success">Thanks — we&rsquo;ve got what we need. We&rsquo;ll be in touch shortly.</p>
        ) : (
          <form onSubmit={onSubmit} className="mt-6 grid gap-3 sm:grid-cols-2">
            {FIELDS.map((f) => (
              <label key={f.key} className={`${labelCls} ${f.textarea ? 'sm:col-span-2' : ''}`}>
                {f.label}
                {f.textarea ? (
                  <textarea
                    rows={2}
                    value={values[f.key] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                    className={inputCls}
                  />
                ) : (
                  <input
                    type={f.type ?? 'text'}
                    value={values[f.key] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                    className={inputCls}
                  />
                )}
              </label>
            ))}

            {error && <p className="sm:col-span-2 text-sm text-destructive">{error}</p>}

            <Button type="submit" disabled={busy} className="sm:col-span-2 mt-2">
              {busy ? 'Submitting…' : 'Submit'}
            </Button>
          </form>
        )}
      </Card>
    </main>
  );
}
