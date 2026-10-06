'use client';

import { use, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { mutate } from 'swr';
import {
  ChartBar, UsersThree, FilePlus, ClockCounterClockwise, MapPin, Target, Plug,
  PencilSimple, Trash, Plus, CaretDown, Storefront, Megaphone, Star, Wrench, ArrowSquareOut,
} from '@phosphor-icons/react';
import { useApi, useRole, atLeast } from '@/lib/useApi';
import { apiFetch, ApiError } from '@/lib/api';
import { API_BASE } from '@/lib/config';
import type {
  SeoHealthDetail, SeoRanking, SeoCompetitor, SeoCrawlHistoryEntry, ContentPage, SummaryResponse,
  CoverageGap, GscQueriesResponse, SeoSite, SeoIssueGroup,
} from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Ring } from '@/components/ui/Ring';
import { Bar } from '@/components/ui/Bar';
import { Sparkline } from '@/components/ui/Sparkline';
import { SeverityBadge } from '@/components/ui/Badge';
import { StatStrip } from '@/components/ui/StatStrip';
import { CrawlButton } from '@/components/CrawlButton';
import { AIStreamPanel } from '@/components/AIStreamPanel';
import { SitePicker } from '@/components/SitePicker';
import { SiteDrawer } from '@/components/SiteDrawer';
import { ISSUE_GUIDANCE, FALLBACK_GUIDANCE, WHO_LABEL, type WhoCanDo } from '@/lib/seoGuidance';

const TABS = ['Get Found', 'Scanner', 'Keywords', 'Coverage', 'Competitors', 'AI Page Builder', 'History'] as const;
type Tab = (typeof TABS)[number];
type PageKind = 'service_page' | 'location_page' | 'blog_post' | 'landing_page';

const SITES_KEY = '/seo/sites';

export default function ScaleSeoHealthPage({
  params,
}: {
  params: Promise<{ siteId: string }>;
}) {
  const { siteId } = use(params);
  const router = useRouter();
  const role = useRole();
  const canEdit = atLeast(role, 'admin');
  const { data: sites } = useApi<SeoSite[]>(SITES_KEY);
  const site = sites?.find((s) => s.id === siteId);

  const [tab, setTab] = useState<Tab>('Get Found');
  const [addingSite, setAddingSite] = useState(false);
  const [editingSite, setEditingSite] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // Seeded by a Priority Action's "Fix this for me" — jumps to the AI Page
  // Builder with a topic already filled in, rather than a fake instant fix.
  const [builderKind, setBuilderKind] = useState<PageKind>('service_page');
  const [builderTopic, setBuilderTopic] = useState('');

  function onFixIssue(code: string) {
    setBuilderKind('service_page');
    setBuilderTopic(`Fix SEO issue: ${code.replace(/_/g, ' ')}`);
    setTab('AI Page Builder');
  }

  function onBuildGap(serviceName: string, locationName: string) {
    setBuilderKind('location_page');
    setBuilderTopic(`${serviceName} in ${locationName}`);
    setTab('AI Page Builder');
  }

  async function onDelete() {
    if (!site) return;
    const named = [
      site.crawl_count > 0 ? `${site.crawl_count} crawl${site.crawl_count === 1 ? '' : 's'}` : null,
      site.page_count > 0 ? `${site.page_count} crawled page${site.page_count === 1 ? '' : 's'}` : null,
      site.issue_count > 0 ? `${site.issue_count} open issue${site.issue_count === 1 ? '' : 's'}` : null,
    ].filter(Boolean);
    const what = named.length > 0 ? named.join(', ') : 'its crawl history';
    if (!confirm(`Delete "${site.name}"? This permanently removes ${what}. This can't be undone.`)) return;

    setDeleting(true);
    setDeleteError(null);
    try {
      await apiFetch(`/seo/sites/${siteId}`, { method: 'DELETE' });
      await mutate(SITES_KEY);
      const remaining = (sites ?? []).filter((s) => s.id !== siteId);
      router.push(remaining.length > 0 ? `/scaleseo/${remaining[0]!.id}` : '/scaleseo');
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : 'Could not delete this site.');
      setDeleting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        {sites ? <SitePicker sites={sites} currentSiteId={siteId} /> : <h1 className="font-display text-2xl font-bold tracking-tight">ScaleSEO</h1>}
        <div className="flex items-center gap-3">
          <Link href={`/scaleseo/${siteId}/pages`} className="text-sm font-medium text-primary hover:underline">
            View pages →
          </Link>
          <CrawlButton siteId={siteId} />
          {canEdit && (
            <>
              <Button variant="ghost" onClick={() => setAddingSite(true)} className="inline-flex items-center gap-1.5">
                <Plus size={14} weight="bold" /> Add site
              </Button>
              {site && (
                <>
                  <Button variant="ghost" onClick={() => setEditingSite(true)} className="inline-flex items-center gap-1.5">
                    <PencilSimple size={14} weight="bold" /> Edit
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={onDelete}
                    disabled={deleting}
                    className="inline-flex items-center gap-1.5 text-destructive"
                  >
                    <Trash size={14} weight="bold" /> {deleting ? 'Deleting…' : 'Delete'}
                  </Button>
                </>
              )}
            </>
          )}
        </div>
      </div>
      {deleteError && <p className="text-sm text-destructive">{deleteError}</p>}

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

      <SiteDrawer
        open={addingSite}
        onOpenChange={setAddingSite}
        defaultPrimary={(sites ?? []).length === 0}
        onSaved={(newSiteId) => router.push(`/scaleseo/${newSiteId}`)}
      />
      {site && (
        <SiteDrawer open={editingSite} onOpenChange={setEditingSite} site={site} onSaved={() => setEditingSite(false)} />
      )}

      {tab === 'Get Found' && <GetFoundTab siteId={siteId} onGoToTab={setTab} />}
      {tab === 'Scanner' && <ScannerTab siteId={siteId} onFixIssue={onFixIssue} />}
      {tab === 'Keywords' && <KeywordsTab siteId={siteId} />}
      {tab === 'Coverage' && <CoverageTab onBuildGap={onBuildGap} />}
      {tab === 'Competitors' && <CompetitorsTab siteId={siteId} />}
      {tab === 'AI Page Builder' && (
        <AIPageBuilderTab kind={builderKind} setKind={setBuilderKind} topic={builderTopic} setTopic={setBuilderTopic} />
      )}
      {tab === 'History' && <HistoryTab siteId={siteId} />}
    </div>
  );
}

const WHO_BADGE_CLASS: Record<WhoCanDo, string> = {
  diy: 'bg-muted text-muted-foreground',
  ai: 'bg-primary/10 text-primary',
  pro: 'bg-warning/10 text-warning',
};

function WhoBadge({ who }: { who: WhoCanDo }) {
  return (
    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${WHO_BADGE_CLASS[who]}`}>
      {who === 'diy' ? 'DIY' : who === 'ai' ? 'AI-assisted' : 'Needs a pro'}
    </span>
  );
}

// "Get Found" — the strategic, ordered-by-impact checklist. Deliberately
// separate from Scanner's Priority Actions: that tab explains individual
// crawl findings, this one is the bigger local-search picture (a free
// listing, the crawl findings as one line item, the content gap, reviews,
// and — only once those are real — paid traffic).
function GetFoundTab({ siteId, onGoToTab }: { siteId: string; onGoToTab: (tab: Tab) => void }) {
  const { data: health } = useApi<SeoHealthDetail>(`/seo/health/${siteId}`);
  const { data: gaps } = useApi<CoverageGap[]>('/seo/coverage-gaps');
  const { data: summary } = useApi<SummaryResponse>('/command/summary');

  const issues = health?.issues ?? [];
  const whoCounts: Record<WhoCanDo, number> = { diy: 0, ai: 0, pro: 0 };
  for (const issue of issues) {
    const who = (ISSUE_GUIDANCE[issue.code] ?? FALLBACK_GUIDANCE).who;
    whoCounts[who] += 1;
  }
  const reviewCount = summary?.reputation.review_count ?? 0;
  const gapCount = gaps?.length ?? 0;
  // Already ranked by how many other services are missing in the same area
  // (api/src/routes/data.ts's /seo/coverage-gaps query) — highest-value
  // first is the existing sort, not a new one invented for this tab.
  const topGaps = (gaps ?? []).slice(0, 3);

  return (
    <div className="flex flex-col gap-4">
      <Card className="p-4">
        <p className="text-sm text-muted-foreground">
          Ordered by impact for a local service business — start at the top and work down.
        </p>
      </Card>

      <GetFoundStep
        n={1}
        icon={Storefront}
        title="Google Business Profile"
        who="diy"
        impact="Free, and the single biggest lever for local search."
      >
        <p>
          Claim it if you haven’t, then complete every section: photos, the service areas you cover,
          your real hours, and a clear description of what you do. This is what shows up on Google Maps
          and next to local search results — often before your website does.
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          Venturelyx doesn’t manage this today — it’s a free tool Google runs directly.
        </p>
        <a
          href="https://business.google.com/"
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
        >
          Open Google Business Profile <ArrowSquareOut size={13} weight="bold" />
        </a>
      </GetFoundStep>

      <GetFoundStep
        n={2}
        icon={Wrench}
        title="Fix what’s broken"
        who={null}
        impact={`${issues.length} finding${issues.length === 1 ? '' : 's'} from your last crawl.`}
      >
        {issues.length === 0 ? (
          <p>No open findings right now — this step is done.</p>
        ) : (
          <p>
            {whoCounts.diy > 0 && `${whoCounts.diy} you can fix yourself`}
            {whoCounts.diy > 0 && (whoCounts.ai > 0 || whoCounts.pro > 0) && ', '}
            {whoCounts.ai > 0 && `${whoCounts.ai} AI can draft for your approval`}
            {whoCounts.ai > 0 && whoCounts.pro > 0 && ', '}
            {whoCounts.pro > 0 && `${whoCounts.pro} need a developer`}
            {'. Each one in Priority Actions explains what it means and how to fix it.'}
          </p>
        )}
        <Button variant="ghost" className="mt-3" onClick={() => onGoToTab('Scanner')}>
          Open Priority Actions
        </Button>
      </GetFoundStep>

      <GetFoundStep
        n={3}
        icon={MapPin}
        title="Build the missing pages"
        who="ai"
        impact={`${gapCount} coverage gap${gapCount === 1 ? '' : 's'} — a service you offer with no page for a city you serve.`}
      >
        <p>Highest-value gaps first (the ones missing for the most services in the same area).</p>
        <Button variant="ghost" className="mt-3" onClick={() => onGoToTab('Coverage')}>
          Open Coverage
        </Button>
      </GetFoundStep>

      <GetFoundStep
        n={4}
        icon={Star}
        title="Reviews"
        who={null}
        impact={`${reviewCount} review${reviewCount === 1 ? '' : 's'} on file.`}
      >
        <p>
          Asking is on you — every happy customer you ask for a review is worth more than one you
          don’t. Replying is where Venturelyx helps: AI can draft a reply to any review for you to
          approve, good or bad.
        </p>
        <Link href="/reviews" className="mt-3 inline-block text-sm font-medium text-primary hover:underline">
          Open Reviews →
        </Link>
      </GetFoundStep>

      <GoogleAdsStep topGaps={topGaps} />
    </div>
  );
}

function GetFoundStep({
  n,
  icon: Icon,
  title,
  who,
  impact,
  children,
}: {
  n: number;
  icon: typeof Storefront;
  title: string;
  who: WhoCanDo | null;
  impact: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-start gap-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 font-mono text-sm font-semibold text-primary">
          {n}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Icon size={16} weight="duotone" className="shrink-0 text-muted-foreground" />
            <p className="text-sm font-semibold">{title}</p>
            {who && <WhoBadge who={who} />}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{impact}</p>
          <div className="mt-3 text-sm text-foreground">{children}</div>
        </div>
      </div>
    </Card>
  );
}

// Last, deliberately: paid traffic landing on a weak site (no GBP, broken
// findings, missing pages, no reviews) wastes money, so this comes after
// those steps rather than being hidden until they're done — "optionally"
// per the brief, not blocked.
function GoogleAdsStep({ topGaps }: { topGaps: CoverageGap[] }) {
  return (
    <GetFoundStep
      n={5}
      icon={Megaphone}
      title="Google Ads (optional)"
      who="pro"
      impact="Paid and ongoing — most effective once the steps above are done."
    >
      <p>
        Unlike the steps above, this costs money every month for as long as it runs, and stops bringing
        in traffic the moment it stops. A realistic starting budget for a local service business is
        roughly <span className="font-medium">$500–$1,500/month</span> — enough to learn what
        works without betting the business on it. Treat that as a starting range to discuss with whoever
        runs the campaign, not a guarantee of results.
      </p>
      {topGaps.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Sensible first campaigns, from your real coverage gaps
          </p>
          <ul className="mt-1.5 space-y-1">
            {topGaps.map((g) => (
              <li key={`${g.catalog_item_id}-${g.location_id}`} className="text-sm">
                “{g.service_name} in {g.location_name}”
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-3 rounded-lg bg-muted p-3 text-xs text-muted-foreground">
        Venturelyx doesn’t manage ad campaigns today. This is guidance to bring to whoever runs your
        ads — not a service we provide.
      </p>
    </GetFoundStep>
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
  // No score yet (brand-new site, or a crawl just queued) — poll until one
  // lands instead of leaving a static "waiting" sentence up; stops itself
  // the moment a real score arrives.
  const { data, isLoading, error } = useApi<SeoHealthDetail>(`/seo/health/${siteId}`, {
    refreshInterval: (latest) => (latest && latest.score?.health == null ? 3000 : 0),
  });
  const { data: rankings } = useApi<SeoRanking[]>('/seo/rankings');
  const { data: summary } = useApi<SummaryResponse>('/command/summary');

  // Surfaces the first real finding the moment a crawl we were watching
  // finishes — "undefined" (never observed) vs "null" (observed, still
  // running) matters here: only a transition actually seen while this tab
  // was open counts as "just finished," not simply loading an
  // already-scored site.
  const [justFinished, setJustFinished] = useState(false);
  const prevHealthRef = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    const health = data?.score?.health ?? null;
    if (prevHealthRef.current === null && health !== null) setJustFinished(true);
    prevHealthRef.current = health;
  }, [data?.score?.health]);

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
  const topIssue = issues[0];
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
      {justFinished && score?.health != null && (
        <Card className="overflow-hidden border-primary/30 bg-primary/5 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-foreground">
                Your first scan is done — health score {score.health}/100
              </p>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {topIssue
                  ? `Top finding: ${topIssue.code.replace(/_/g, ' ')} on ${topIssue.pages} page${topIssue.pages === 1 ? '' : 's'}.`
                  : 'No issues found on the first pass — nice start.'}
              </p>
            </div>
            <button
              onClick={() => setJustFinished(false)}
              className="shrink-0 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              Dismiss
            </button>
          </div>
        </Card>
      )}

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
          <div className="flex flex-col items-center py-8">
            <div className="flex gap-1.5" aria-hidden>
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="h-2 w-2 animate-pulse rounded-full bg-primary"
                  style={{ animationDelay: `${i * 150}ms` }}
                />
              ))}
            </div>
            <p className="mt-4 text-sm text-muted-foreground">Scanning your site…</p>
            <p className="mt-1 max-w-xs text-center text-xs text-muted-foreground/70">
              This usually takes a minute or two. The score and first findings will appear here as soon as
              it's done.
            </p>
          </div>
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
              <IssueRow key={issue.code} issue={issue} onFixIssue={onFixIssue} />
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

// Every finding already says what's wrong (the row itself); expanding it
// answers the actual question an owner has — what does this mean, why does
// it matter, how long will it take, and can Venturelyx do it or do they
// need to find someone. ISSUE_GUIDANCE is keyed by the crawler's own fixed
// issue vocabulary (workers/seo/scoring.py), not generated per-row.
function IssueRow({ issue, onFixIssue }: { issue: SeoIssueGroup; onFixIssue: (code: string) => void }) {
  const [open, setOpen] = useState(false);
  const guidance = ISSUE_GUIDANCE[issue.code] ?? FALLBACK_GUIDANCE;

  return (
    <li className="p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-start gap-3 text-left"
        >
          <SeverityBadge severity={issue.severity} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              {issue.code.replace(/_/g, ' ')}
              <span className="text-muted-foreground"> — {issue.pages} pages</span>
            </p>
            {issue.example_detail && (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{issue.example_detail}</p>
            )}
          </div>
          <CaretDown
            size={14}
            weight="bold"
            className={`mt-1 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </button>
        {issue.auto_fixable && (
          <Button variant="ai" className="shrink-0" onClick={() => onFixIssue(issue.code)}>
            Fix this for me
          </Button>
        )}
      </div>

      {open && (
        <div className="mt-3 ml-0 space-y-3 rounded-lg bg-muted p-4 text-sm sm:ml-9">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">What to do</p>
            <WhoBadge who={guidance.who} />
          </div>
          <p>
            <span className="font-medium text-foreground">What this means for your customers: </span>
            {guidance.customerImpact}
          </p>
          <p>
            <span className="font-medium text-foreground">Why it matters: </span>
            {guidance.whyItMatters}
          </p>
          <div>
            <p className="font-medium text-foreground">Steps:</p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-5">
              {guidance.steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          </div>
          <p className="text-xs text-muted-foreground">
            Roughly: {guidance.timeEstimate} — {WHO_LABEL[guidance.who]}
          </p>
        </div>
      )}
    </li>
  );
}

type GscSort = 'impressions' | 'position';

// Real query-level performance straight from Google Search Console — no
// fabricated ranking data. An org that hasn't connected GSC gets a connect
// prompt here, never plausible-looking numbers nobody generated.
function KeywordsTab({ siteId }: { siteId: string }) {
  const [sort, setSort] = useState<GscSort>('impressions');
  const { data, isLoading, error } = useApi<GscQueriesResponse>(`/seo/gsc-queries/${siteId}?sort=${sort}`);
  const role = useRole();
  const canConnect = atLeast(role, 'admin');

  return (
    <Card className="overflow-x-auto p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <ChartBar size={16} className="text-muted-foreground" />
          <p className="text-sm font-semibold">Keywords (Google Search Console, last 28 days)</p>
        </div>
        {data?.connected && (
          <div className="flex gap-1 text-xs">
            {(['impressions', 'position'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setSort(s)}
                className={`rounded-full px-2.5 py-1 font-medium capitalize transition-colors ${
                  sort === s ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
                }`}
              >
                Sort: {s}
              </button>
            ))}
          </div>
        )}
      </div>
      {isLoading ? (
        <p className="p-4 text-sm text-muted-foreground">Loading…</p>
      ) : error ? (
        <p className="p-4 text-sm text-destructive">Could not load keyword data.</p>
      ) : !data?.connected ? (
        <div className="flex flex-col items-center gap-3 p-8 text-center">
          <Plug size={24} className="text-muted-foreground" />
          <p className="max-w-sm text-sm text-muted-foreground">
            Connect Google Search Console to see real phrases this site already ranks for — actual
            impressions, clicks and position, not estimates.
          </p>
          {canConnect ? (
            <Button onClick={() => { window.location.href = `${API_BASE}/integrations/gsc/oauth/start`; }}>
              Connect Google Search Console
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground/70">Ask an admin to connect it in Settings.</p>
          )}
        </div>
      ) : data.rows.length === 0 ? (
        <p className="p-4 text-sm text-muted-foreground">
          Connected, but no query data has landed yet — the first sync can take up to a day.
        </p>
      ) : (
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2 font-medium">Query</th>
              <th className="px-4 py-2 font-medium">Page</th>
              <th className="px-4 py-2 text-right font-medium">Impressions</th>
              <th className="px-4 py-2 text-right font-medium">Clicks</th>
              <th className="px-4 py-2 text-right font-medium">CTR</th>
              <th className="px-4 py-2 text-right font-medium">Avg. position</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {data.rows.map((k) => (
              <tr key={`${k.query}-${k.page}`}>
                <td className="px-4 py-3">{k.query}</td>
                <td className="max-w-[280px] truncate px-4 py-3 text-muted-foreground">{k.page}</td>
                <td className="px-4 py-3 text-right font-mono tabular-nums" data-numeric>
                  {k.impressions.toLocaleString()}
                </td>
                <td className="px-4 py-3 text-right font-mono tabular-nums text-muted-foreground" data-numeric>
                  {k.clicks.toLocaleString()}
                </td>
                <td className="px-4 py-3 text-right font-mono tabular-nums text-muted-foreground" data-numeric>
                  {k.ctr != null ? `${(Number(k.ctr) * 100).toFixed(1)}%` : '—'}
                </td>
                <td className="px-4 py-3 text-right font-mono tabular-nums" data-numeric>
                  {k.position ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

// Genuine coverage gaps: catalog_items x locations, crossed into
// market_targets server-side and marked covered/uncovered by
// workers/seo/coverage.py matching real crawled pages — nothing invented,
// no estimated traffic or search volume, just the gap itself. Ranked by how
// many other services are missing in the same area, same as the signals
// coverage.py writes into the Command Center.
function CoverageTab({ onBuildGap }: { onBuildGap: (serviceName: string, locationName: string) => void }) {
  const { data, isLoading, error } = useApi<CoverageGap[]>('/seo/coverage-gaps');
  const role = useRole();
  const canBuild = atLeast(role, 'staff');

  return (
    <Card className="overflow-x-auto p-0">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Target size={16} className="text-muted-foreground" />
        <p className="text-sm font-semibold">Coverage gaps</p>
      </div>
      {isLoading ? (
        <p className="p-4 text-sm text-muted-foreground">Loading…</p>
      ) : error ? (
        <p className="p-4 text-sm text-destructive">Could not load coverage gaps.</p>
      ) : !data || data.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground">
          <p>
            No gaps found — either every service has a page for every place you serve, or your{' '}
            <Link href="/operate/catalog" className="font-medium text-primary hover:underline">
              catalog
            </Link>{' '}
            and{' '}
            <Link href="/settings#service-area" className="font-medium text-primary hover:underline">
              service area
            </Link>{' '}
            aren&apos;t set up yet.
          </p>
          <p className="mt-1">A freshly-added service or location also needs a crawl to run before its coverage is known.</p>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {data.map((g) => (
            <li key={`${g.catalog_item_id}-${g.location_id}`} className="flex items-center justify-between gap-3 p-4">
              <p className="min-w-0 text-sm">
                You offer <span className="font-medium">{g.service_name}</span> and serve{' '}
                <span className="font-medium">{g.location_name}</span>, but have no page targeting it.
                {g.uncovered_in_location > 1 && (
                  <span className="text-muted-foreground"> ({g.uncovered_in_location} services missing here.)</span>
                )}
              </p>
              {canBuild && (
                <Button variant="ai" className="shrink-0" onClick={() => onBuildGap(g.service_name, g.location_name)}>
                  Build this page
                </Button>
              )}
            </li>
          ))}
        </ul>
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
          Venturelyx doesn't have a data source for competitor rankings connected yet, so this tab
          intentionally shows nothing rather than a guess. It'll populate once one is.
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
