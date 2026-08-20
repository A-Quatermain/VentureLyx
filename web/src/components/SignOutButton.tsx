'use client';

import { SignOut } from '@phosphor-icons/react';
import { apiFetch } from '@/lib/api';

export function SignOutButton() {
  async function onClick() {
    // Always leave the page even if the API call fails — a stuck sign-out
    // button with no visible error is worse than navigating ahead of a
    // slow/failed server-side session revoke.
    //
    // A hard navigation (not router.push/refresh) is deliberate: Next's
    // client router cache only invalidates the *current* route on refresh()
    // — a stale cached RSC payload for /home could still be served on a
    // subsequent client-side nav (e.g. browser back) even after the cookie
    // is cleared, which would look exactly like "sign out doesn't work."
    // A full reload leaves no client-side state (router cache, SWR cache,
    // component state) anywhere to go stale.
    try {
      await apiFetch('/auth/logout', { method: 'POST' });
    } finally {
      window.location.href = '/sign-in';
    }
  }

  return (
    <button
      onClick={onClick}
      aria-label="Sign out"
      className="grid h-9 w-9 place-items-center border border-border text-muted-foreground transition-colors hover:bg-destructive hover:text-destructive-foreground"
    >
      <SignOut size={16} weight="bold" />
    </button>
  );
}
