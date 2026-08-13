'use client';

import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/Button';

export function SignOutButton() {
  const router = useRouter();

  async function onClick() {
    // Always leave the page even if the API call fails — a stuck sign-out
    // button with no visible error is worse than a client-side nav ahead of
    // a slow/failed server-side session revoke.
    try {
      await apiFetch('/auth/logout', { method: 'POST' });
    } finally {
      router.push('/sign-in');
      router.refresh();
    }
  }

  return (
    <Button variant="ghost" onClick={onClick}>
      Sign out
    </Button>
  );
}
