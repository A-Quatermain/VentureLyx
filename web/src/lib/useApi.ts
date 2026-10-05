import useSWR, { type SWRConfiguration } from 'swr';
import { apiFetch } from './api';
import type { MeResponse } from './types';

// path: null skips the request entirely (SWR's own convention) — for a
// fetch that's only sometimes wanted, e.g. a search box with no query yet.
// `config` is for the rare caller that needs e.g. refreshInterval (polling
// a just-queued crawl until its score lands) — optional, so every existing
// call site is unaffected.
export function useApi<T>(path: string | null, config?: SWRConfiguration<T>) {
  return useSWR<T>(path, (p: string) => apiFetch<T>(p), config);
}

// Mirrors api/src/lib/auth.ts's Role/RANK/atLeast exactly — this is only for
// UI gating (hide/disable a control); the API is the real enforcement, and a
// 403 from a stale/wrong client-side read must still be handled gracefully.
export type Role = 'owner' | 'admin' | 'manager' | 'staff' | 'viewer';
const RANK: Record<Role, number> = { owner: 5, admin: 4, manager: 3, staff: 2, viewer: 1 };
export const atLeast = (role: Role | null | undefined, needed: Role) =>
  !!role && RANK[role as Role] >= RANK[needed];

export function useRole(): Role | null {
  const { data } = useApi<MeResponse>('/auth/me');
  return (data?.role as Role | null) ?? null;
}
