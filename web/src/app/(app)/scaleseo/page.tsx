'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Star, Plus, MagnifyingGlass } from '@phosphor-icons/react';
import { useApi, useRole, atLeast } from '@/lib/useApi';
import type { SeoSite } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { SiteDrawer } from '@/components/SiteDrawer';

export default function ScaleSeoSitesPage() {
  const router = useRouter();
  const role = useRole();
  const canEdit = atLeast(role, 'admin');
  const { data: sites, isLoading, error } = useApi<SeoSite[]>('/seo/sites');
  const [adding, setAdding] = useState(false);

  if (isLoading) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
  if (error) {
    return (
      <div className="p-4">
        <Card className="p-4">
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : 'Could not load sites.'}
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="font-display text-2xl font-bold tracking-tight">ScaleSEO</h1>
        {canEdit && (
          <Button onClick={() => setAdding(true)} className="inline-flex items-center gap-1.5">
            <Plus size={14} weight="bold" /> Add site
          </Button>
        )}
      </div>

      {(sites ?? []).map((site) => (
        <Link key={site.id} href={`/scaleseo/${site.id}`}>
          <Card className="p-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <p className="truncate text-sm font-medium">{site.name}</p>
                  {site.is_primary && <Star size={12} weight="fill" className="shrink-0 text-primary" />}
                  <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
                    {site.environment}
                  </span>
                  {!site.in_health_score && (
                    <span className="shrink-0 rounded-full bg-warning/10 px-2 py-0.5 text-[10px] font-semibold uppercase text-warning">
                      Not scored
                    </span>
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground">{site.url}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className="font-mono text-lg font-semibold tabular-nums" data-numeric>
                  {site.health ?? '—'}
                </p>
                {(site.critical_issues ?? 0) > 0 ? (
                  <p className="text-xs text-destructive">{site.critical_issues} critical</p>
                ) : site.health == null ? (
                  <p className="text-xs text-muted-foreground">scanning…</p>
                ) : null}
              </div>
            </div>
          </Card>
        </Link>
      ))}

      {sites?.length === 0 && (
        <Card className="flex flex-col items-center gap-3 p-8 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <MagnifyingGlass size={22} weight="duotone" className="text-primary" />
          </div>
          <p className="text-sm text-muted-foreground">
            No sites yet. Add your website and we'll scan it and find what's missing.
          </p>
          {canEdit && <Button onClick={() => setAdding(true)}>Add your first site</Button>}
        </Card>
      )}

      <SiteDrawer
        open={adding}
        onOpenChange={setAdding}
        defaultPrimary={(sites ?? []).length === 0}
        onSaved={(newSiteId) => router.push(`/scaleseo/${newSiteId}`)}
      />
    </div>
  );
}
