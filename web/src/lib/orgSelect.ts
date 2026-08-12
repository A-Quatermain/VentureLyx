// Runs right after a successful sign-in (post-MFA if MFA is enabled). The
// API only auto-selects an org on login when the user belongs to exactly
// one (see auth.ts: `soleOrg`); multi-business owners land with no org
// selected. Until the API persists a true "last used" org, default to the
// first one (already name-sorted by /auth/me) so there's always something
// to land in — this is a real POST /auth/org, not a client-side guess, so
// req.db()'s RLS context is genuinely set server-side.
import { apiFetch } from './api';
import type { MeResponse } from './types';

export async function ensureOrgSelected(): Promise<void> {
  const me = await apiFetch<MeResponse>('/auth/me');
  if (me.currentOrgId || !me.organizations?.length) return;

  await apiFetch('/auth/org', {
    method: 'POST',
    body: JSON.stringify({ orgId: me.organizations[0]!.id }),
  });
}
