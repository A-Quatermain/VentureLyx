'use client';

import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';
import { Button } from '@/components/ui/Button';

export function SignOutButton() {
  const router = useRouter();

  async function onClick() {
    await apiFetch('/auth/logout', { method: 'POST' });
    router.push('/sign-in');
    router.refresh();
  }

  return (
    <Button variant="ghost" onClick={onClick}>
      Sign out
    </Button>
  );
}
