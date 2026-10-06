'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { mutate } from 'swr';
import { apiFetch, ApiError } from '@/lib/api';
import type { CreateOrgResponse } from '@/lib/types';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerFooter } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';
import { BusinessProfileForm, type BusinessProfileValues } from '@/components/BusinessProfileForm';

const BLANK: BusinessProfileValues = { name: '', website_url: '', vertical: '', service_area: '' };

// Same four fields and the same POST /orgs a new signup's onboarding uses
// (api/src/routes/auth.ts: "a user may own more than one — this is a
// first-class path"). That route already switches the current session into
// the new org server-side and queues its first crawl if a website was
// given, so creating here and landing on /home is enough to put the person
// on the new business's own (freshly 0-of-7) setup checklist — no separate
// "switch" step needed.
export function AddBusinessDrawer({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [profile, setProfile] = useState<BusinessProfileValues>(BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setProfile(BLANK);
    setError(null);
  }

  async function onCreate() {
    if (!profile.name.trim()) {
      setError('Business name is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await apiFetch<CreateOrgResponse>('/orgs', {
        method: 'POST',
        body: JSON.stringify({
          name: profile.name.trim(),
          website_url: profile.website_url.trim() || null,
          vertical: profile.vertical.trim() || null,
          service_area: profile.service_area.trim() || null,
        }),
      });
      // Revalidate every SWR-cached org-scoped query before navigating —
      // same reasoning as OrgSwitcher's own switchTo, so /home's first
      // render already reflects the new org rather than a stale one.
      await mutate(() => true);
      onOpenChange(false);
      router.push('/home');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create this business.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>Add a business</DrawerTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Same questions as signup. You&apos;ll land on its setup checklist next.
          </p>
        </DrawerHeader>

        <div className="flex flex-1 flex-col gap-4">
          <BusinessProfileForm values={profile} onChange={setProfile} />
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DrawerFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onCreate} disabled={busy}>
            {busy ? 'Creating…' : 'Create business'}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
