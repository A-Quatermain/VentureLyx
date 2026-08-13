'use client';

import { use } from 'react';
import Link from 'next/link';
import { useApi } from '@/lib/useApi';
import type { SeoPage } from '@/lib/types';
import { Card } from '@/components/ui/Card';

export default function ScaleSeoPagesPage({
  params,
}: {
  params: Promise<{ siteId: string }>;
}) {
  const { siteId } = use(params);
  const { data: pages, isLoading, error } = useApi<SeoPage[]>(`/seo/pages/${siteId}`);

  if (isLoading) return <div className="p-4 text-sm text-ink-2">Loading…</div>;
  if (error) {
    return (
      <div className="p-4">
        <Card>
          <p className="text-sm text-alert">
            {error instanceof Error ? error.message : 'Could not load pages.'}
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <p className="font-display text-lg font-bold text-deepwater">Pages</p>
        <Link href={`/scaleseo/${siteId}`} className="text-sm text-pool">
          ← Back to health
        </Link>
      </div>

      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-line-2 text-xs text-ink-3">
              <th className="px-4 py-2 font-medium">URL</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Title</th>
              <th className="px-4 py-2 font-medium">Words</th>
              <th className="px-4 py-2 font-medium">Alt-text gaps</th>
              <th className="px-4 py-2 font-medium">Response</th>
              <th className="px-4 py-2 font-medium">Indexable</th>
            </tr>
          </thead>
          <tbody>
            {(pages ?? []).map((p) => (
              <tr key={p.url} className="border-b border-line-2 last:border-0">
                <td className="max-w-xs truncate px-4 py-2 text-ink">{p.url}</td>
                <td className="px-4 py-2 font-mono" data-numeric>
                  <span className={p.status_code >= 400 ? 'text-alert' : 'text-ink-2'}>
                    {p.status_code}
                  </span>
                </td>
                <td className="max-w-xs truncate px-4 py-2 text-ink-2">{p.title ?? '—'}</td>
                <td className="px-4 py-2 font-mono text-ink-2" data-numeric>
                  {p.word_count ?? '—'}
                </td>
                <td className="px-4 py-2 font-mono text-ink-2" data-numeric>
                  {p.images_no_alt ?? 0}/{p.images_total ?? 0}
                </td>
                <td className="px-4 py-2 font-mono text-ink-2" data-numeric>
                  {p.response_ms ?? '—'}ms
                </td>
                <td className="px-4 py-2">
                  {p.indexable ? (
                    <span className="text-growth">Yes</span>
                  ) : (
                    <span className="text-alert">No</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {pages?.length === 0 && <p className="p-4 text-sm text-ink-2">No pages crawled yet.</p>}
      </Card>
    </div>
  );
}
