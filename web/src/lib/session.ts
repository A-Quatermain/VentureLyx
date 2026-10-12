// The only place that reads the incoming request's session cookie and
// forwards it to the API from a Next.js server process. A server component
// is not the browser — it has no cookie jar of its own — so this is
// deliberate, not an accident: read the request's Cookie header once here,
// never re-implemented per page.
import { cache } from 'react';
import { cookies } from 'next/headers';
import { INTERNAL_API_BASE } from './config';
import type { MeResponse } from './types';

async function serverFetch<T>(path: string): Promise<T> {
  if (!INTERNAL_API_BASE) {
    throw new Error('INTERNAL_API_BASE is not set');
  }
  const cookieHeader = (await cookies()).toString();
  const res = await fetch(`${INTERNAL_API_BASE}${path}`, {
    headers: { Cookie: cookieHeader },
    cache: 'no-store',
  });
  if (!res.ok) {
    throw new Error(`API ${path} failed with ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// React.cache() dedupes this across every layout/page that calls it within
// one request tree — (app)/layout.tsx and, since module layouts each call
// it again for their own enablement check, that would otherwise be a
// second real round-trip to /auth/me per page load. The underlying fetch
// itself still stays cache: 'no-store' (serverFetch above) — this only
// dedupes repeat calls within a single render, not across requests.
export const getServerSession = cache((): Promise<MeResponse> => {
  return serverFetch<MeResponse>('/auth/me');
});

// Public — no cookie forwarded, nothing sensitive in the response. Used
// by the marketing landing page to decide whether to show real prices or
// a "finalizing" placeholder. Defaults to false (placeholder, not real
// prices) if the API can't be reached at all, the same safe-default
// direction as the gate itself.
export const getPaymentGateEnabled = cache(async (): Promise<boolean> => {
  if (!INTERNAL_API_BASE) return false;
  try {
    const res = await fetch(`${INTERNAL_API_BASE}/platform-status`, { cache: 'no-store' });
    if (!res.ok) return false;
    const data = (await res.json()) as { paymentGateEnabled: boolean };
    return !!data.paymentGateEnabled;
  } catch {
    return false;
  }
});
