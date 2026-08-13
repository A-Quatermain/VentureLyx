// Browser-side API client. Talks directly to api.venturelyx.com — CORS on
// the API is already configured for this origin, credentials included, no
// proxy layer. Never call Postgres from here; there is no DATABASE_URL in
// this app on purpose.
import { API_BASE } from './config';

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    // Only set Content-Type when there's actually a body — Fastify's JSON
    // parser rejects an empty body sent with Content-Type: application/json
    // (FST_ERR_CTP_EMPTY_JSON_BODY), which silently broke every bodyless
    // POST (logout, crawl-trigger) with no visible error to the user.
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? 'Request failed', body.code);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
