'use client';

import { useEffect, useState } from 'react';
import { mutate } from 'swr';
import { apiFetch, ApiError } from '@/lib/api';
import type { SeoEnvironment, SeoSite, SeoSiteCreateResponse, SeoSiteInput } from '@/lib/types';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerFooter } from '@/components/ui/Drawer';
import { Button } from '@/components/ui/Button';

const ENVIRONMENTS: SeoEnvironment[] = ['production', 'staging', 'development'];

interface FormState {
  url: string;
  name: string;
  environment: SeoEnvironment;
  is_primary: boolean;
  render: boolean;
  in_health_score: boolean;
}

function toFormState(site: SeoSite | undefined, defaultPrimary: boolean): FormState {
  if (site) {
    return {
      url: site.url,
      name: site.name,
      environment: site.environment,
      is_primary: site.is_primary,
      render: site.render,
      in_health_score: site.in_health_score,
    };
  }
  return { url: '', name: '', environment: 'production', is_primary: defaultPrimary, render: false, in_health_score: true };
}

const inputCls =
  'min-h-[42px] w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';
const labelCls = 'flex flex-col gap-1 text-sm text-muted-foreground';

export function SiteDrawer({
  open,
  onOpenChange,
  site,
  defaultPrimary = false,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Omit for "add site"; pass the existing record for "edit". */
  site?: SeoSite;
  /** Pre-check "Primary site" for the very first site an org adds. */
  defaultPrimary?: boolean;
  onSaved: (siteId: string, justCreated: boolean) => void;
}) {
  const [form, setForm] = useState<FormState>(() => toFormState(site, defaultPrimary));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isEdit = !!site;

  useEffect(() => {
    if (open) setForm(toFormState(site, defaultPrimary));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, site]);

  async function onSave() {
    if (!form.name.trim()) {
      setError('Name is required.');
      return;
    }
    if (!form.url.trim()) {
      setError('Website URL is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload: SeoSiteInput = {
        url: form.url.trim(),
        name: form.name.trim(),
        environment: form.environment,
        is_primary: form.is_primary,
        render: form.render,
        in_health_score: form.in_health_score,
      };
      if (isEdit) {
        await apiFetch(`/seo/sites/${site.id}`, { method: 'PATCH', body: JSON.stringify(payload) });
        await mutate('/seo/sites');
        onSaved(site.id, false);
      } else {
        const res = await apiFetch<SeoSiteCreateResponse>('/seo/sites', {
          method: 'POST',
          body: JSON.stringify(payload),
        });
        await mutate('/seo/sites');
        onSaved(res.id, true);
      }
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save this site.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{isEdit ? 'Edit site' : 'Add site'}</DrawerTitle>
        </DrawerHeader>

        <div className="flex flex-1 flex-col gap-5">
          <label className={labelCls}>
            Website URL<span className="text-primary">*</span>
            <input
              autoFocus={!isEdit}
              type="url"
              placeholder="https://example.com"
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              className={inputCls}
            />
          </label>

          <label className={labelCls}>
            Name<span className="text-primary">*</span>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Main site, Staging rebuild"
              className={inputCls}
            />
          </label>

          <label className={labelCls}>
            Environment
            <select
              value={form.environment}
              onChange={(e) => setForm({ ...form, environment: e.target.value as SeoEnvironment })}
              className={inputCls}
            >
              {ENVIRONMENTS.map((e) => (
                <option key={e} value={e}>
                  {e[0]!.toUpperCase() + e.slice(1)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-start gap-2.5 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 shrink-0"
              checked={form.is_primary}
              onChange={(e) => setForm({ ...form, is_primary: e.target.checked })}
            />
            <span>
              <span className="font-medium text-foreground">Primary site</span>
              <p className="mt-0.5 text-xs text-muted-foreground">
                The one shown wherever a single number stands in for the whole business — Command Center's
                SEO score, the org switcher. Only one site can be primary; checking this unchecks it
                elsewhere.
              </p>
            </span>
          </label>

          <label className="flex items-start gap-2.5 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 shrink-0"
              checked={form.render}
              onChange={(e) => setForm({ ...form, render: e.target.checked })}
            />
            <span>
              <span className="font-medium text-foreground">Rendering</span>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Turn this on if the site is built with React, Vue, or another JavaScript framework — without
                it, a JS-rendered site crawls as a single empty page instead of its real content.
              </p>
            </span>
          </label>

          <label className="flex items-start gap-2.5 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 shrink-0"
              checked={form.in_health_score}
              onChange={(e) => setForm({ ...form, in_health_score: e.target.checked })}
            />
            <span>
              <span className="font-medium text-foreground">Count toward brand health score</span>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Turn this off for a work-in-progress rebuild or a staging copy, so an unfinished site doesn't
                drag down the overall score everyone else sees.
              </p>
            </span>
          </label>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DrawerFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={onSave} disabled={busy}>
            {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Add site'}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
