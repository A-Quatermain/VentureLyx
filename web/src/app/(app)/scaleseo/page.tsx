'use client';

import Link from 'next/link';
import { useApi } from '@/lib/useApi';
import type { SeoSite } from '@/lib/types';
import { Card } from '@/components/ui/Card';

export default function ScaleSeoSitesPage() {
  const { data: sites, isLoading, error } = useApi<SeoSite[]>('/seo/sites');

  if (isLoading) return <div className="p-4 text-sm text-ink-2">Loading…</div>;
  if (error) {
    return (
      <div className="p-4">
        <Card>
          <p className="text-sm text-alert">
            {error instanceof Error ? error.message : 'Could not load sites.'}
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <p className="font-display text-lg font-bold text-deepwater">ScaleSEO</p>
      {(sites ?? []).map((site) => (
        <Link key={site.id} href={`/scaleseo/${site.id}`}>
          <Card className="hover:border-pool">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-ink">{site.name}</p>
                <p className="text-xs text-ink-3">{site.url}</p>
              </div>
              <div className="text-right">
                <p className="font-mono text-lg font-medium text-ink" data-numeric>
                  {site.health ?? '—'}
                </p>
                {(site.critical_issues ?? 0) > 0 && (
                  <p className="text-xs text-alert">{site.critical_issues} critical</p>
                )}
              </div>
            </div>
          </Card>
        </Link>
      ))}
      {sites?.length === 0 && <p className="text-sm text-ink-2">No sites yet.</p>}
    </div>
  );
}
