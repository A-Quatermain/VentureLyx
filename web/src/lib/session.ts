// The only place that reads the incoming request's session cookie and
// forwards it to the API from a Next.js server process. A server component
// is not the browser — it has no cookie jar of its own — so this is
// deliberate, not an accident: read the request's Cookie header once here,
// never re-implemented per page.
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

export function getServerSession(): Promise<MeResponse> {
  return serverFetch<MeResponse>('/auth/me');
}
