'use client';

import { use } from 'react';
import Link from 'next/link';
import { useApi } from '@/lib/useApi';
import type { SeoHealthDetail, SeoRanking } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Ring } from '@/components/ui/Ring';
import { Bar } from '@/components/ui/Bar';
import { Sparkline } from '@/components/ui/Sparkline';
import { SeverityBadge } from '@/components/ui/Badge';
import { StatStrip } from '@/components/ui/StatStrip';
import { CrawlButton } from '@/components/CrawlButton';

export default function ScaleSeoHealthPage({
  params,
}: {
  params: Promise<{ siteId: string }>;
}) {
  const { siteId } = use(params);
  const { data, isLoading, error } = useApi<SeoHealthDetail>(`/seo/health/${siteId}`);
  const { data: rankings } = useApi<SeoRanking[]>('/seo/rankings');

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
        {score.health !== null ? (
          <div className="flex flex-wrap items-center gap-5">
            <Ring score={score.health} />
            <div className="min-w-[180px] flex-1 space-y-2">
              <Bar label="Technical" valueText={score.technical ?? '—'} percent={score.technical ?? 0} />
              <Bar label="Content" valueText={score.content ?? '—'} percent={score.content ?? 0} />
              <Bar label="Speed" valueText={score.performance ?? '—'} percent={score.performance ?? 0} />
              <Bar label="Local presence" valueText={score.local_seo ?? '—'} percent={score.local_seo ?? 0} tone="sun" />
            </div>
          </div>
        ) : (
          <p className="text-sm text-ink-2">No score yet — waiting on the first crawl.</p>
        )}
        {score.computed_at && (
          <p className="mt-3 text-xs text-ink-3">
            Checked {new Date(score.computed_at).toLocaleString()}
          </p>
        )}
      </Card>

      <StatStrip
        stats={[
          { label: 'Pages checked', value: String(score.pages_crawled ?? score.pages ?? 0) },
          { label: 'Broken links', value: String(score.broken_links ?? 0) },
          { label: 'Things to fix', value: String(issues.length) },
        ]}
      />

      <Card>
        <p className="text-xs font-medium text-ink-3">HEALTH TREND</p>
        <div className="mt-2">
          <Sparkline points={trend} />
        </div>
      </Card>

      <Card className="overflow-x-auto p-0">
        <p className="p-4 pb-2 text-xs font-medium text-ink-3">LOCAL RANKINGS</p>
        {!rankings || rankings.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-ink-2">
            No ranking data yet — this needs a rank-tracking source connected.
          </p>
        ) : (
          <table className="w-full min-w-[520px] text-left text-sm">
            <thead>
              <tr className="border-b border-line-2 text-xs text-ink-3">
                <th className="px-4 py-2 font-medium">Area</th>
                <th className="px-4 py-2 font-medium">Phrase</th>
                <th className="px-4 py-2 font-medium">Position</th>
                <th className="px-4 py-2 font-medium">Trend</th>
              </tr>
            </thead>
            <tbody>
              {rankings.map((r) => (
                <tr key={`${r.phrase}-${r.location_name}`} className="border-b border-line-2 last:border-0">
                  <td className="px-4 py-2 text-ink">{r.location_name}</td>
                  <td className="px-4 py-2 text-ink-2">{r.phrase}</td>
                  <td className="px-4 py-2 font-mono" data-numeric>
                    {r.position ?? '—'}
                  </td>
                  <td className="px-4 py-2 font-mono" data-numeric>
                    {r.movement == null || r.movement === 0 ? (
                      <span className="text-ink-3">—</span>
                    ) : r.movement > 0 ? (
                      <span className="text-growth">▲ {r.movement}</span>
                    ) : (
                      <span className="text-alert">▼ {Math.abs(r.movement)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
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
