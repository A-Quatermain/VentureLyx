import Link from 'next/link';
import type { SeoSummary } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Ring } from '@/components/ui/Ring';
import { Bar } from '@/components/ui/Bar';

export function ScaleSeoHealthCard({ seo }: { seo: SeoSummary | null }) {
  if (!seo || seo.health === null) {
    return (
      <Card>
        <p className="text-xs font-medium text-ink-3">SCALESEO</p>
        <p className="mt-2 text-sm text-ink-2">
          No score yet — ScaleSEO hasn&apos;t crawled a primary site for this business yet.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-ink-3">SCALESEO</p>
        <Link href="/scaleseo" className="text-xs text-pool">
          View site →
        </Link>
      </div>
      <div className="mt-2 flex items-center gap-4">
        <Ring score={seo.health} size={80} strokeWidth={7} />
        <div className="flex-1 space-y-2">
          <Bar label="Technical" valueText={seo.technical ?? '—'} percent={seo.technical ?? 0} />
          <Bar label="Content" valueText={seo.content ?? '—'} percent={seo.content ?? 0} />
          <Bar label="Speed" valueText={seo.performance ?? '—'} percent={seo.performance ?? 0} />
        </div>
      </div>
    </Card>
  );
}
