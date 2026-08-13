'use client';

import { use } from 'react';
import Link from 'next/link';
import { useApi } from '@/lib/useApi';
import type { SeoHealthDetail } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { HealthGauge } from '@/components/ui/HealthGauge';
import { Sparkline } from '@/components/ui/Sparkline';
import { SeverityBadge } from '@/components/ui/Badge';
import { CrawlButton } from '@/components/CrawlButton';

export default function ScaleSeoHealthPage({
  params,
}: {
  params: Promise<{ siteId: string }>;
}) {
  const { siteId } = use(params);
  const { data, isLoading, error } = useApi<SeoHealthDetail>(`/seo/health/${siteId}`);

  if (isLoading) return <div className="p-4 text-sm text-ink-2">Loading…</div>;
  if (error || !data) {
    return (
      <div className="p-4">
        <Card>
          <p className="text-sm text-alert">
            {error instanceof Error ? error.message : 'Could not load this site.'}
          </p>
        </Card>
      </div>
    );
  }

  const { score, issues, trend } = data;

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <p className="font-display text-lg font-bold text-deepwater">Site health</p>
        <div className="flex items-center gap-3">
          <Link href={`/scaleseo/${siteId}/pages`} className="text-sm text-pool">
            View pages →
          </Link>
          <CrawlButton siteId={siteId} />
        </div>
      </div>

      <Card>
        <HealthGauge score={score.health} />
        {score.computed_at && (
          <p className="mt-3 text-xs text-ink-3">
            Last checked {new Date(score.computed_at).toLocaleString()} · {score.pages_crawled ?? score.pages ?? 0} pages
          </p>
        )}
      </Card>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <SubScore label="Technical" value={score.technical} />
        <SubScore label="Content" value={score.content} />
        <SubScore label="Performance" value={score.performance} />
        <SubScore label="Local SEO" value={score.local_seo} />
      </div>

      <Card>
        <p className="text-xs font-medium text-ink-3">HEALTH TREND</p>
        <div className="mt-2">
          <Sparkline points={trend} />
        </div>
      </Card>

      <Card className="p-0">
        <p className="p-4 pb-0 text-xs font-medium text-ink-3">ISSUES</p>
        {issues.length === 0 ? (
          <p className="p-4 text-sm text-ink-2">No open issues.</p>
        ) : (
          <ul className="divide-y divide-line-2">
            {issues.map((issue) => (
              <li key={issue.code} className="flex items-start gap-3 p-4">
                <SeverityBadge severity={issue.severity} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink">
                    {issue.code}
                    <span className="text-ink-3"> — {issue.pages} pages</span>
                  </p>
                  {issue.example_detail && (
                    <p className="mt-0.5 truncate text-xs text-ink-3">{issue.example_detail}</p>
                  )}
                  {issue.auto_fixable && (
                    <span className="mt-1 inline-block rounded-full bg-pool-soft px-2 py-0.5 text-xs text-pool">
                      Auto-fixable
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function SubScore({ label, value }: { label: string; value: number | null }) {
  return (
    <Card>
      <p className="text-xs text-ink-3">{label}</p>
      <p className="mt-1 text-xl font-semibold text-ink">{value ?? '—'}</p>
    </Card>
  );
}
