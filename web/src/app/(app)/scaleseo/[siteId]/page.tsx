'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { mutate } from 'swr';
import { ChartBar, UsersThree, FilePlus, ClockCounterClockwise, MapPin } from '@phosphor-icons/react';
import { useApi, useRole, atLeast } from '@/lib/useApi';
import { apiFetch, ApiError } from '@/lib/api';
import type {
  SeoHealthDetail, SeoRanking, SeoKeyword, SeoCompetitor, SeoCrawlHistoryEntry, ContentPage, SummaryResponse,
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
type PageKind = 'service_page' | 'location_page' | 'blog_post' | 'landing_page';

export default function ScaleSeoHealthPage({
  params,
}: {
  params: Promise<{ siteId: string }>;
}) {
  const { siteId } = use(params);
  const [tab, setTab] = useState<Tab>('Scanner');
  // Seeded by a Priority Action's "Fix this for me" — jumps to the AI Page
  // Builder with a topic already filled in, rather than a fake instant fix.
  const [builderKind, setBuilderKind] = useState<PageKind>('service_page');
  const [builderTopic, setBuilderTopic] = useState('');

  function onFixIssue(code: string) {
    setBuilderKind('service_page');
    setBuilderTopic(`Fix SEO issue: ${code.replace(/_/g, ' ')}`);
    setTab('AI Page Builder');
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="font-display text-2xl font-bold tracking-tight">ScaleSEO</h1>
        <div className="flex items-center gap-3">
          <Link href={`/scaleseo/${siteId}/pages`} className="text-sm font-medium text-primary hover:underline">
            View pages →
          </Link>
          <CrawlButton siteId={siteId} />
        </div>
      </div>

      <div className="flex w-fit gap-1 rounded-full border border-border bg-surface p-1 shadow-sm">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === t ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'Scanner' && <ScannerTab siteId={siteId} onFixIssue={onFixIssue} />}
      {tab === 'Keywords' && <KeywordsTab siteId={siteId} />}
      {tab === 'Competitors' && <CompetitorsTab siteId={siteId} />}
      {tab === 'AI Page Builder' && (
        <AIPageBuilderTab kind={builderKind} setKind={setBuilderKind} topic={builderTopic} setTopic={setBuilderTopic} />
      )}
      {tab === 'History' && <HistoryTab siteId={siteId} />}
    </div>
  );
}

const SUBSCORE_LABELS = {
  technical: 'Technical',
  content: 'Content',
  local_seo: 'Local SEO',
  reviews: 'Reviews',
  performance: 'Performance',
} as const;

function ScannerTab({ siteId, onFixIssue }: { siteId: string; onFixIssue: (code: string) => void }) {
  const { data, isLoading, error } = useApi<SeoHealthDetail>(`/seo/health/${siteId}`);
  const { data: rankings } = useApi<SeoRanking[]>('/seo/rankings');
  const { data: summary } = useApi<SummaryResponse>('/command/summary');

  if (isLoading) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
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
  const avgRating = summary?.reputation.avg_rating != null ? Number(summary.reputation.avg_rating) : null;
  const reviewCount = summary?.reputation.review_count ?? 0;
  const reviewsScore = reviewCount > 0 && avgRating != null ? Math.round((avgRating / 5) * 100) : null;

  const subscores: Array<{ key: keyof typeof SUBSCORE_LABELS; value: number | null; sub?: string }> = [
    { key: 'technical', value: score?.technical ?? null },
    { key: 'content', value: score?.content ?? null },
    { key: 'local_seo', value: score?.local_seo ?? null },
    { key: 'reviews', value: reviewsScore, sub: reviewCount > 0 ? `${avgRating}★ · ${reviewCount} reviews` : 'no reviews yet' },
    { key: 'performance', value: score?.performance ?? null },
  ];

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-6">
        {score && score.health !== null ? (
          <div className="flex flex-col items-center gap-8 lg:flex-row lg:items-center lg:justify-center">
            <div className="flex shrink-0 flex-col items-center">
              <Ring score={score.health} size={196} strokeWidth={16} label="SEO Health" />
            </div>
            <div className="grid w-full max-w-md grid-cols-1 gap-4 sm:grid-cols-2">
              {subscores.map((s) => (
                <Bar
                  key={s.key}
                  label={SUBSCORE_LABELS[s.key]}
                  valueText={s.value ?? '—'}
                  percent={s.value ?? 0}
                  sub={s.sub}
                />
              ))}
            </div>
          </div>
        ) : (
          <p className="py-8 text-center text-sm text-muted-foreground">No score yet — waiting on the first crawl.</p>
        )}
        {score?.computed_at && (
          <p className="mt-6 text-center text-xs text-muted-foreground">
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
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Health trend</p>
        <div className="mt-2">
          <Sparkline points={trend} />
        </div>
      </Card>

      <Card className="p-0">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <p className="text-sm font-semibold">Priority Actions</p>
        </div>
        {issues.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No open issues.</p>
        ) : (
          <ul className="divide-y divide-border">
            {issues.map((issue) => (
              <li key={issue.code} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <SeverityBadge severity={issue.severity} />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">
                      {issue.code.replace(/_/g, ' ')}
                      <span className="text-muted-foreground"> — {issue.pages} pages</span>
                    </p>
                    {issue.example_detail && (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">{issue.example_detail}</p>
                    )}
                  </div>
                </div>
                {issue.auto_fixable && (
                  <Button variant="ai" className="shrink-0" onClick={() => onFixIssue(issue.code)}>
                    Fix this for me
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="overflow-x-auto p-0">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <MapPin size={16} className="text-muted-foreground" />
          <p className="text-sm font-semibold">Local Rankings</p>
        </div>
        {!rankings || rankings.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            No ranking data yet — this needs a rank-tracking source connected.
          </p>
        ) : (
          <table className="w-full min-w-[520px] text-left text-sm">
            <thead>
              <tr className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2 font-medium">Area</th>
                <th className="px-4 py-2 font-medium">Phrase</th>
                <th className="px-4 py-2 text-right font-medium">Position</th>
                <th className="px-4 py-2 text-right font-medium">Trend</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rankings.map((r) => (
                <tr key={`${r.phrase}-${r.location_name}`}>
                  <td className="px-4 py-3">{r.location_name}</td>
                  <td className="px-4 py-3 text-muted-foreground">{r.phrase}</td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums" data-numeric>
                    {r.position ?? '—'}
                  </td>
                  <td className="px-4 py-3 text-right font-mono tabular-nums" data-numeric>
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

      <AIStreamPanel
        path="/ai/growth-strategist/stream"
        title="AI Recommendation"
        triggerLabel="What should I fix first?"
      />
    </div>
  );
}

function KeywordsTab({ siteId }: { siteId: string }) {
  const { data, isLoading, error } = useApi<SeoKeyword[]>(`/seo/keywords/${siteId}`);

  return (
    <Card className="overflow-x-auto p-0">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <ChartBar size={16} className="text-muted-foreground" />
        <p className="text-sm font-semibold">Tracked keywords</p>
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
            <tr className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2 font-medium">Phrase</th>
              <th className="px-4 py-2 font-medium">Intent</th>
              <th className="px-4 py-2 text-right font-medium">Volume</th>
              <th className="px-4 py-2 text-right font-medium">Difficulty</th>
              <th className="px-4 py-2 text-right font-medium">Position</th>
              <th className="px-4 py-2 text-right font-medium">Value/mo</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.map((k) => (
              <tr key={k.id}>
                <td className="px-4 py-3">
                  {k.phrase}
                  {k.is_branded && <span className="ml-1.5 text-xs text-muted-foreground">(branded)</span>}
                </td>
                <td className="px-4 py-3 text-muted-foreground">{k.intent ?? '—'}</td>
                <td className="px-4 py-3 text-right font-mono tabular-nums text-muted-foreground" data-numeric>
                  {k.search_volume ?? '—'}
                </td>
                <td className="px-4 py-3 text-right font-mono tabular-nums text-muted-foreground" data-numeric>
                  {k.difficulty ?? '—'}
                </td>
                <td className="px-4 py-3 text-right font-mono tabular-nums" data-numeric>
                  {k.position ?? '—'}
                </td>
                <td className="px-4 py-3 text-right font-mono tabular-nums" data-numeric>
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
        <p className="text-sm font-semibold">Competitors</p>
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
            <tr className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2 font-medium">Name</th>
              <th className="px-4 py-2 font-medium">Domain</th>
              <th className="px-4 py-2 text-right font-medium">Avg. position</th>
              <th className="px-4 py-2 text-right font-medium">Keywords tracked</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.map((c) => (
              <tr key={c.id}>
                <td className="px-4 py-3">
                  {c.name}
                  {c.discovered && <span className="ml-1.5 text-xs text-muted-foreground">(auto-discovered)</span>}
                </td>
                <td className="px-4 py-3 text-muted-foreground">{c.domain}</td>
                <td className="px-4 py-3 text-right font-mono tabular-nums" data-numeric>
                  {c.avg_position ?? '—'}
                </td>
                <td className="px-4 py-3 text-right font-mono tabular-nums text-muted-foreground" data-numeric>
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

const PAGE_KINDS: PageKind[] = ['service_page', 'location_page', 'blog_post', 'landing_page'];
const CONTENT_PAGES_KEY = '/seo/content-pages';

function AIPageBuilderTab({
  kind,
  setKind,
  topic,
  setTopic,
}: {
  kind: PageKind;
  setKind: (k: PageKind) => void;
  topic: string;
  setTopic: (t: string) => void;
}) {
  const role = useRole();
  const canEdit = atLeast(role, 'staff');
  const { data: pages, isLoading } = useApi<ContentPage[]>(CONTENT_PAGES_KEY);

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
              onChange={(e) => setKind(e.target.value as PageKind)}
              className="min-h-[42px] rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
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
              className="min-h-[42px] w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
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
          <p className="text-sm font-semibold">Drafted pages</p>
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
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 font-mono text-[10px] uppercase text-muted-foreground">
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
        <p className="text-sm font-semibold">Crawl history</p>
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
            <tr className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2 font-medium">Started</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Trigger</th>
              <th className="px-4 py-2 text-right font-medium">Pages</th>
              <th className="px-4 py-2 text-right font-medium">Health</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.map((c) => (
              <tr key={c.id}>
                <td className="px-4 py-3">{new Date(c.started_at).toLocaleString()}</td>
                <td className="px-4 py-3">
                  <span
                    className={`rounded-full px-2 py-0.5 font-mono text-[10px] uppercase ${
                      c.status === 'ok'
                        ? 'bg-success/10 text-success'
                        : c.status === 'running'
                          ? 'bg-primary/10 text-primary'
                          : 'bg-destructive/10 text-destructive'
                    }`}
                  >
                    {c.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-muted-foreground">{c.trigger}</td>
                <td className="px-4 py-3 text-right font-mono tabular-nums text-muted-foreground" data-numeric>
                  {c.pages_crawled}
                </td>
                <td className="px-4 py-3 text-right font-mono tabular-nums" data-numeric>
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
