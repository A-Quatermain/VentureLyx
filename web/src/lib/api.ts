// Browser-side API client. Talks directly to api.venturelyx.com — CORS on
// the API is already configured for this origin, credentials included, no
// proxy layer. Never call Postgres from here; there is no DATABASE_URL in
// this app on purpose.
const API_BASE = process.env.NEXT_PUBLIC_API_BASE;
if (!API_BASE) {
  throw new Error('NEXT_PUBLIC_API_BASE is not set');
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? 'Request failed', body.code);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
