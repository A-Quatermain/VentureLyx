'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { mutate } from 'swr';
import { ChartBar, UsersThree, FilePlus, ClockCounterClockwise } from '@phosphor-icons/react';
import { useApi, useRole, atLeast } from '@/lib/useApi';
import { apiFetch, ApiError } from '@/lib/api';
import type {
  SeoHealthDetail, SeoRanking, SeoKeyword, SeoCompetitor, SeoCrawlHistoryEntry, ContentPage,
} from '@/lib/types';
import { formatMoney } from '@/lib/format';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Ring } from '@/components/ui/Ring';
import { Bar } from '@/components/ui/Bar';
import { Sparkline } from '@/components/ui/Sparkline';
import { SeverityBadge } from '@/components/ui/Badge';
import { StatStrip } from '@/components/ui/StatStrip';
import { CrawlButton } from '@/components/CrawlButton';
import { AIStreamPanel } from '@/components/AIStreamPanel';

const TABS = ['Scanner', 'Keywords', 'Competitors', 'AI Page Builder', 'History'] as const;
type Tab = (typeof TABS)[number];

export default function ScaleSeoHealthPage({
  params,
}: {
  params: Promise<{ siteId: string }>;
}) {
  const { siteId } = use(params);
  const [tab, setTab] = useState<Tab>('Scanner');

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="font-display text-lg font-black tracking-tight">ScaleSEO</p>
        <div className="flex items-center gap-3">
          <Link href={`/scaleseo/${siteId}/pages`} className="text-sm text-primary">
            View pages →
          </Link>
          <CrawlButton siteId={siteId} />
        </div>
      </div>

      <div className="flex overflow-x-auto border border-border">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`whitespace-nowrap border-r border-border px-4 py-2.5 text-sm font-medium transition-colors last:border-r-0 ${
              tab === t ? 'bg-foreground text-background' : 'hover:bg-muted'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Scanner' && <ScannerTab siteId={siteId} />}
      {tab === 'Keywords' && <KeywordsTab siteId={siteId} />}
      {tab === 'Competitors' && <CompetitorsTab siteId={siteId} />}
      {tab === 'AI Page Builder' && <AIPageBuilderTab />}
      {tab === 'History' && <HistoryTab siteId={siteId} />}
    </div>
  );
}

function ScannerTab({ siteId }: { siteId: string }) {
  const { data, isLoading, error } = useApi<SeoHealthDetail>(`/seo/health/${siteId}`);
  const { data: rankings } = useApi<SeoRanking[]>('/seo/rankings');

  if (isLoading) return <div className="p-4 text-sm text-muted-foreground">Loading…</div>;
  if (error || !data) {
    return (
      <Card className="p-4">
        <p className="text-sm text-destructive">
          {error instanceof Error ? error.message : 'Could not load this site.'}
        </p>
      </Card>
    );
  }

  const { score, issues, trend } = data;

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        {score && score.health !== null ? (
          <div className="flex flex-wrap items-center gap-5">
            <Ring score={score.health} />
            <div className="min-w-[180px] flex-1 space-y-2">
              <Bar label="Technical" valueText={score.technical ?? '—'} percent={score.technical ?? 0} />
              <Bar label="Content" valueText={score.content ?? '—'} percent={score.content ?? 0} />
              <Bar label="Speed" valueText={score.performance ?? '—'} percent={score.performance ?? 0} />
              <Bar label="Local presence" valueText={score.local_seo ?? '—'} percent={score.local_seo ?? 0} tone="primary" />
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No score yet — waiting on the first crawl.</p>
        )}
        {score?.computed_at && (
          <p className="mt-3 text-xs text-muted-foreground">
            Checked {new Date(score.computed_at).toLocaleString()}
          </p>
        )}
      </Card>

      <StatStrip
        stats={[
          { label: 'Pages checked', value: String(score?.pages_crawled ?? score?.pages ?? 0) },
          { label: 'Broken links', value: String(score?.broken_links ?? 0) },
          { label: 'Things to fix', value: String(issues.length) },
        ]}
      />

      <Card className="p-4">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">Health trend</p>
        <div className="mt-2">
          <Sparkline points={trend} />
        </div>
      </Card>

      <Card className="overflow-x-auto p-0">
        <p className="p-4 pb-2 font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">Local rankings</p>
        {!rankings || rankings.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted-foreground">
            No ranking data yet — this needs a rank-tracking source connected.
          </p>
        ) : (
          <table className="w-full min-w-[520px] text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">Area</th>
                <th className="px-4 py-2 font-medium">Phrase</th>
                <th className="px-4 py-2 font-medium">Position</th>
                <th className="px-4 py-2 font-medium">Trend</th>
              </tr>
            </thead>
            <tbody>
              {rankings.map((r) => (
                <tr key={`${r.phrase}-${r.location_name}`} className="border-b border-border last:border-0">
                  <td className="px-4 py-2">{r.location_name}</td>
                  <td className="px-4 py-2 text-muted-foreground">{r.phrase}</td>
                  <td className="px-4 py-2 font-mono" data-numeric>
                    {r.position ?? '—'}
                  </td>
                  <td className="px-4 py-2 font-mono" data-numeric>
                    {r.movement == null || r.movement === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : r.movement > 0 ? (
                      <span className="text-success">▲ {r.movement}</span>
                    ) : (
                      <span className="text-destructive">▼ {Math.abs(r.movement)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card className="p-0">
        <p className="p-4 pb-0 font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">Issues</p>
        {issues.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No open issues.</p>
        ) : (
          <ul className="divide-y divide-border">
            {issues.map((issue) => (
              <li key={issue.code} className="flex items-start gap-3 p-4">
                <SeverityBadge severity={issue.severity} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    {issue.code}
                    <span className="text-muted-foreground"> — {issue.pages} pages</span>
                  </p>
                  {issue.example_detail && (
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">{issue.example_detail}</p>
                  )}
                  {issue.auto_fixable && (
                    <span className="mt-1 inline-block border border-primary px-2 py-0.5 text-xs text-primary">
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

function KeywordsTab({ siteId }: { siteId: string }) {
  const { data, isLoading, error } = useApi<SeoKeyword[]>(`/seo/keywords/${siteId}`);

  return (
    <Card className="overflow-x-auto p-0">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <ChartBar size={16} className="text-muted-foreground" />
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">Tracked keywords</p>
      </div>
      {isLoading ? (
        <p className="p-4 text-sm text-muted-foreground">Loading…</p>
      ) : error ? (
        <p className="p-4 text-sm text-destructive">Could not load keywords.</p>
      ) : !data || data.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">
          No keywords tracked yet — this needs keyword research connected for this site.
        </p>
      ) : (
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th className="px-4 py-2 font-medium">Phrase</th>
              <th className="px-4 py-2 font-medium">Intent</th>
              <th className="px-4 py-2 font-medium">Volume</th>
              <th className="px-4 py-2 font-medium">Difficulty</th>
              <th className="px-4 py-2 font-medium">Position</th>
              <th className="px-4 py-2 font-medium">Value/mo</th>
            </tr>
          </thead>
          <tbody>
            {data.map((k) => (
              <tr key={k.id} className="border-b border-border last:border-0">
                <td className="px-4 py-2">
                  {k.phrase}
                  {k.is_branded && <span className="ml-1.5 text-xs text-muted-foreground">(branded)</span>}
                </td>
                <td className="px-4 py-2 text-muted-foreground">{k.intent ?? '—'}</td>
                <td className="px-4 py-2 font-mono text-muted-foreground" data-numeric>
                  {k.search_volume ?? '—'}
                </td>
                <td className="px-4 py-2 font-mono text-muted-foreground" data-numeric>
                  {k.difficulty ?? '—'}
                </td>
                <td className="px-4 py-2 font-mono" data-numeric>
                  {k.position ?? '—'}
                </td>
                <td className="px-4 py-2 font-mono" data-numeric>
                  {k.est_value_monthly ? formatMoney(k.est_value_monthly) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function CompetitorsTab({ siteId }: { siteId: string }) {
  const { data, isLoading, error } = useApi<SeoCompetitor[]>(`/seo/competitors/${siteId}`);

  return (
    <Card className="overflow-x-auto p-0">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <UsersThree size={16} className="text-muted-foreground" />
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">Competitors</p>
      </div>
      {isLoading ? (
        <p className="p-4 text-sm text-muted-foreground">Loading…</p>
      ) : error ? (
        <p className="p-4 text-sm text-destructive">Could not load competitors.</p>
      ) : !data || data.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">
          No competitors tracked yet — this needs competitor tracking connected for this site.
        </p>
      ) : (
        <table className="w-full min-w-[520px] text-left text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Domain</th>
              <th className="px-4 py-2 font-medium">Avg. position</th>
              <th className="px-4 py-2 font-medium">Keywords tracked</th>
            </tr>
          </thead>
          <tbody>
            {data.map((c) => (
              <tr key={c.id} className="border-b border-border last:border-0">
                <td className="px-4 py-2">
                  {c.name}
                  {c.discovered && <span className="ml-1.5 text-xs text-muted-foreground">(auto-discovered)</span>}
                </td>
                <td className="px-4 py-2 text-muted-foreground">{c.domain}</td>
                <td className="px-4 py-2 font-mono" data-numeric>
                  {c.avg_position ?? '—'}
                </td>
                <td className="px-4 py-2 font-mono text-muted-foreground" data-numeric>
                  {c.tracked_keywords}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

const PAGE_KINDS = ['service_page', 'location_page', 'blog_post', 'landing_page'] as const;
const CONTENT_PAGES_KEY = '/seo/content-pages';

function AIPageBuilderTab() {
  const role = useRole();
  const canEdit = atLeast(role, 'staff');
  const { data: pages, isLoading } = useApi<ContentPage[]>(CONTENT_PAGES_KEY);

  const [kind, setKind] = useState<(typeof PAGE_KINDS)[number]>('service_page');
  const [topic, setTopic] = useState('');
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function onSave() {
    if (!draft.trim()) return;
    setSaving(true);
    setSaveError(null);
    try {
      await apiFetch(CONTENT_PAGES_KEY, {
        method: 'POST',
        body: JSON.stringify({ kind, body: draft, generated_by: 'ai' }),
      });
      await mutate(CONTENT_PAGES_KEY);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : 'Could not save this draft.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm text-muted-foreground">
            Page type
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as (typeof PAGE_KINDS)[number])}
              className="min-h-[38px] rounded-none border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-primary"
            >
              {PAGE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {k.replace('_', ' ')}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-1 flex-col gap-1 text-sm text-muted-foreground">
            Topic / target keyword
            <input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="e.g. emergency pool leak repair"
              className="min-h-[38px] w-full rounded-none border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-primary"
            />
          </label>
        </div>
      </Card>

      {topic.trim() && (
        <AIStreamPanel
          key={`${kind}-${topic}`}
          path="/ai/page-generation/stream"
          body={{ kind, topic }}
          title="AI Page Builder"
          triggerLabel="Draft this page"
          onTextChange={setDraft}
        />
      )}

      {canEdit && draft.trim() && (
        <div className="flex items-center gap-3">
          <Button onClick={onSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save as draft'}
          </Button>
          {saved && <span className="text-sm text-success">Saved.</span>}
          {saveError && <span className="text-sm text-destructive">{saveError}</span>}
        </div>
      )}

      <Card className="overflow-x-auto p-0">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <FilePlus size={16} className="text-muted-foreground" />
          <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">Drafted pages</p>
        </div>
        {isLoading ? (
          <p className="p-4 text-sm text-muted-foreground">Loading…</p>
        ) : !pages || pages.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No pages drafted yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {pages.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{p.title || `Untitled ${p.kind.replace('_', ' ')}`}</p>
                  <p className="text-xs text-muted-foreground">
                    {p.kind.replace('_', ' ')} · {new Date(p.created_at).toLocaleDateString()}
                  </p>
                </div>
                <span className="shrink-0 border border-border px-1.5 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
                  {p.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function HistoryTab({ siteId }: { siteId: string }) {
  const { data, isLoading, error } = useApi<SeoCrawlHistoryEntry[]>(`/seo/crawl-history/${siteId}`);

  return (
    <Card className="overflow-x-auto p-0">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <ClockCounterClockwise size={16} className="text-muted-foreground" />
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground">Crawl history</p>
      </div>
      {isLoading ? (
        <p className="p-4 text-sm text-muted-foreground">Loading…</p>
      ) : error ? (
        <p className="p-4 text-sm text-destructive">Could not load crawl history.</p>
      ) : !data || data.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">No crawls yet.</p>
      ) : (
        <table className="w-full min-w-[600px] text-left text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th className="px-4 py-2 font-medium">Started</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Trigger</th>
              <th className="px-4 py-2 font-medium">Pages</th>
              <th className="px-4 py-2 font-medium">Health</th>
            </tr>
          </thead>
          <tbody>
            {data.map((c) => (
              <tr key={c.id} className="border-b border-border last:border-0">
                <td className="px-4 py-2">{new Date(c.started_at).toLocaleString()}</td>
                <td className="px-4 py-2">
                  <span
                    className={`border px-1.5 py-0.5 font-mono text-[10px] uppercase ${
                      c.status === 'ok'
                        ? 'border-success text-success'
                        : c.status === 'running'
                          ? 'border-primary text-primary'
                          : 'border-destructive text-destructive'
                    }`}
                  >
                    {c.status}
                  </span>
                </td>
                <td className="px-4 py-2 text-muted-foreground">{c.trigger}</td>
                <td className="px-4 py-2 font-mono text-muted-foreground" data-numeric>
                  {c.pages_crawled}
                </td>
                <td className="px-4 py-2 font-mono" data-numeric>
                  {c.health ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
