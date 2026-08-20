'use client';

import Link from 'next/link';
import { useApi } from '@/lib/useApi';
import type { SeoSite } from '@/lib/types';
import { Card } from '@/components/ui/Card';

export default function ScaleSeoSitesPage() {
  const { data: sites, isLoading, error } = useApi<SeoSite[]>('/seo/sites');

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
      <p className="font-display text-lg font-black tracking-tight">ScaleSEO</p>
      {(sites ?? []).map((site) => (
        <Link key={site.id} href={`/scaleseo/${site.id}`}>
          <Card className="p-4 transition-colors hover:border-primary">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">{site.name}</p>
                <p className="text-xs text-muted-foreground">{site.url}</p>
              </div>
              <div className="text-right">
                <p className="font-mono text-lg font-medium" data-numeric>
                  {site.health ?? '—'}
                </p>
                {(site.critical_issues ?? 0) > 0 && (
                  <p className="text-xs text-destructive">{site.critical_issues} critical</p>
                )}
              </div>
            </div>
          </Card>
        </Link>
      ))}
      {sites?.length === 0 && <p className="text-sm text-muted-foreground">No sites yet.</p>}
    </div>
  );
}
