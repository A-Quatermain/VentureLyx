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

  if (isLoading) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
  if (error) {
    return (
      <div className="p-4">
        <Card className="p-4">
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : 'Could not load pages.'}
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <p className="font-display text-lg font-black tracking-tight">Pages</p>
        <Link href={`/scaleseo/${siteId}`} className="text-sm text-primary">
          ← Back to health
        </Link>
      </div>

      <Card className="overflow-x-auto p-0">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
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
              <tr key={p.url} className="border-b border-border last:border-0">
                <td className="max-w-xs truncate px-4 py-2">{p.url}</td>
                <td className="px-4 py-2 font-mono" data-numeric>
                  <span className={p.status_code >= 400 ? 'text-destructive' : 'text-muted-foreground'}>
                    {p.status_code}
                  </span>
                </td>
                <td className="max-w-xs truncate px-4 py-2 text-muted-foreground">{p.title ?? '—'}</td>
                <td className="px-4 py-2 font-mono text-muted-foreground" data-numeric>
                  {p.word_count ?? '—'}
                </td>
                <td className="px-4 py-2 font-mono text-muted-foreground" data-numeric>
                  {p.images_no_alt ?? 0}/{p.images_total ?? 0}
                </td>
                <td className="px-4 py-2 font-mono text-muted-foreground" data-numeric>
                  {p.response_ms ?? '—'}ms
                </td>
                <td className="px-4 py-2">
                  {p.indexable ? (
                    <span className="text-success">Yes</span>
                  ) : (
                    <span className="text-destructive">No</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {pages?.length === 0 && <p className="p-4 text-sm text-muted-foreground">No pages crawled yet.</p>}
      </Card>
    </div>
  );
}
