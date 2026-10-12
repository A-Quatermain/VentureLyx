import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  ArrowRight, Kanban, MagnifyingGlass, Compass, Package, TrendUp, Robot, Star,
  Globe, MagicWand, ChartBar, ShieldCheck, Prohibit, HandTap, ImageSquare,
} from '@phosphor-icons/react/ssr';
import { getServerSession } from '@/lib/session';
import { ThemeToggle } from '@/components/ThemeToggle';
import { VideoHero } from '@/components/VideoHero';
import { ImageCarousel } from '@/components/ImageCarousel';
import { MODULES, type ModuleInfo } from '@/lib/modules';
import { TIERS } from '@/lib/pricing';

// This page is a Server Component, so it imports Phosphor's /ssr icon set —
// lib/modules.ts stores an icon *name* rather than a component for exactly
// this reason (a client component would need the other import). Local to
// this file: nothing else needs this mapping.
const MODULE_ICONS: Record<ModuleInfo['icon'], typeof Kanban> = {
  Compass, Package, Kanban, MagnifyingGlass, TrendUp, Robot, Star,
};

// This page's output depends on the request's session cookie (redirects an
// authenticated visitor away entirely), so it was never actually a static
// page — but without this, Next.js still tries to prerender it once at
// build time to check. That build-time call has no real request/cookie and
// no INTERNAL_API_BASE (that's a docker-compose runtime env var; the build
// stage has no docker network), so it always failed there for the wrong
// reason. Forcing dynamic skips the build-time attempt entirely.
export const dynamic = 'force-dynamic';

const HOW_IT_WORKS = [
  {
    step: '1',
    icon: Globe,
    title: 'Connect your website',
    copy: 'Point ScaleSEO at your live site. No code, no tag manager, no waiting on a developer.',
  },
  {
    step: '2',
    icon: MagnifyingGlass,
    title: 'We scan it',
    copy: 'A real crawl finds the pages you’re missing for every service, in every city you serve.',
  },
  {
    step: '3',
    icon: MagicWand,
    title: 'Fix issues with AI drafts you approve',
    copy: 'AI drafts the page, the fix, or the reply. Nothing goes live until you say so.',
  },
  {
    step: '4',
    icon: ChartBar,
    title: 'Track by where it came from',
    copy: 'Leads, jobs, and revenue, attributed back to the channel and page that produced them.',
  },
];

// Real, verified numbers only (queried 2026-09-22 against the running
// database) — see the commit message for the exact queries. Nothing here
// is illustrative or rounded for effect.
const CASE_STUDY = {
  name: 'N&P Pools',
  vertical: 'South Florida pool service',
  before: 1,
  after: 15,
  crawlDates: 'September 1 and September 10',
  healthBefore: 74,
  healthAfter: 90,
  opportunityPages: 36,
  ownerQuote: null as string | null, // placeholder — see the boxed callout below
  ownerName: 'Noel',
};

// Module sections get a real screenshot each, rendered through the same
// ImageCarousel (components/ImageCarousel.tsx) whether there's one capture
// or several — a single-image array just renders statically (no dots, no
// auto-advance; see that component). Grow (3) and ScaleSEO (2) are the only
// ones with more than one; the placeholder box below only still applies to
// a module with no screenshotImages at all, which is none of them today.
const MODULE_SECTIONS: Array<{
  key: string;
  eyebrow: string;
  title: string;
  copy: string;
  screenshotCaption: string;
  screenshotImages?: string[];
}> = [
  {
    key: 'operate',
    eyebrow: 'Operate — live',
    title: 'Every lead in one pipeline',
    copy: 'Track leads from first contact to paid invoice. See your catalog, your open jobs, and exactly who owes you money — all in one place.',
    screenshotCaption: 'Operate — pipeline view',
    screenshotImages: ['/brand/Operate.png'],
  },
  {
    key: 'scaleseo',
    eyebrow: 'ScaleSEO — live',
    title: 'Find out why customers can’t find you',
    copy: 'A real crawl of your site, a health score out of 100, and a page-by-page account of what’s broken — the same engine behind the N&P Pools result above.',
    screenshotCaption: 'ScaleSEO — site health dashboard',
    screenshotImages: ['/brand/ScaleSEO.png', '/brand/ScaleSEO 1.png'],
  },
  {
    key: 'grow',
    eyebrow: 'Grow — beta',
    title: 'Email campaigns that respect your list',
    copy: 'Import your contacts, write a sequence, and send real campaigns with mailbox warmup and one-click unsubscribe built in. SMS, funnels, and paid ads are coming.',
    screenshotCaption: 'Grow — campaign sequence editor',
    screenshotImages: ['/brand/Grow 1.png', '/brand/Grow 2.png', '/brand/Grow 3.png'],
  },
  {
    key: 'ai-team',
    eyebrow: 'AI Team — beta',
    title: 'AI drafts. You approve.',
    copy: 'Growth Strategist recommends what to do next. Content Writer drafts service and location pages. Reputation Assistant drafts review replies. Nothing publishes or sends until you approve it. A phone attendant is coming.',
    screenshotCaption: 'AI Team — assistant roster',
    screenshotImages: ['/brand/AI Team 1.png'],
  },
  {
    key: 'reviews',
    eyebrow: 'Reviews — live',
    title: 'Every review, one inbox',
    copy: 'Collect reviews from Google, Facebook, and Yelp, or add them manually. See your rating trend and reply with an AI-drafted response you approve before it goes live.',
    screenshotCaption: 'Reviews — inbox and rating trend',
    screenshotImages: ['/brand/Reviews.png'],
  },
];

const TRUST_POINTS = [
  { icon: ShieldCheck, title: 'You own your data', copy: 'Export or delete it whenever you want. It’s yours, not ours to hold onto.' },
  { icon: Prohibit, title: 'Cancel anytime', copy: 'No contract, no retention call. Cancel from Settings whenever you want.' },
  { icon: HandTap, title: 'AI never acts without you', copy: 'Every AI-drafted page, reply, or email is a draft. Nothing publishes or sends until you approve it.' },
];

const FAQ = [
  {
    q: 'Do I need a website already?',
    a: 'Yes, today — ScaleSEO and Grow both work against a site you already have. Build, a from-scratch website builder, is coming soon.',
  },
  {
    q: 'Will AI publish or send anything without me?',
    a: 'No. Every AI-drafted page, review reply, or email sits as a draft until you personally approve it — see the Trust section above.',
  },
  {
    q: 'What does ScaleSEO actually check?',
    a: 'It crawls your live site, scores its health, and flags exactly which pages and issues are costing you visibility — the same crawl behind the N&P Pools example on this page.',
  },
  {
    q: 'Is Grow’s email sending compliant?',
    a: 'Every campaign includes a real one-click unsubscribe link that’s honored immediately, and sending is paced with a mailbox warmup ramp rather than blasting a new domain’s full volume on day one.',
  },
  {
    q: 'What does it cost?',
    a: 'Platform starts at $129/mo, self-service. Growth Partner and Launch & Growth are white-glove engagements — start with a free Growth Scan and we’ll recommend the right fit. See Pricing below for the full breakdown.',
  },
];

export default async function LandingPage() {
  const me = await getServerSession();
  if (me.authenticated) {
    if (!me.mfaSatisfied) redirect('/mfa');
    redirect(me.organizations?.length ? '/home' : '/onboarding');
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          {/* Theme-aware pair, not one image: logo-full.png's navy wordmark
              is nearly invisible against this header's dark-mode background.
              32px mobile / 40px desktop. */}
          <img src="/brand/logo-full.png" alt="Venturelyx" className="h-8 w-auto dark:hidden sm:h-10" />
          <img src="/brand/logo-full-white.png" alt="Venturelyx" className="hidden h-8 w-auto dark:block sm:h-10" />
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <Link href="/sign-in" className="hidden text-sm text-muted-foreground hover:text-foreground sm:inline">
              Sign in
            </Link>
            <Link
              href="/register"
              className="inline-flex min-h-[42px] items-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground shadow-sm transition hover:bg-primary-hover hover:shadow-md"
            >
              Get started <ArrowRight size={14} weight="bold" />
            </Link>
          </div>
        </div>
      </header>

      {/* ---- Hero: who it's for, the problem, one CTA -------------------- */}
      <section className="relative isolate overflow-hidden">
        <VideoHero
          poster="/video/hero-trades-poster.jpg"
          mp4="/video/hero-trades.mp4"
          webm="/video/hero-trades.webm"
          className="absolute inset-0 -z-10"
        />
        {/* Dark scrim so headline/CTA text stays legible over any frame of the loop. */}
        <div className="absolute inset-0 -z-10 bg-gradient-to-b from-black/70 via-black/55 to-black/75" />

        <div className="mx-auto max-w-6xl px-6 pb-24 pt-20 sm:pt-28">
          <div className="max-w-3xl">
            {/* White variant — this sits on the video hero's dark scrim,
                same reasoning as the header's dark-mode pairing above,
                except this surface is always dark regardless of theme. */}
            <img src="/brand/logo-full-white.png" alt="Venturelyx" className="mb-6 h-12 w-auto sm:h-[72px]" />
            <p className="font-display text-sm font-semibold uppercase tracking-wide text-white/70">
              For local service businesses
            </p>
            <h1 className="mt-2 font-display text-4xl font-bold leading-tight tracking-tight text-white sm:text-5xl">
              Customers can’t find you.
              <br />
              Leads slip through. Reviews go unanswered.
            </h1>
            <p className="mt-6 max-w-xl text-base leading-relaxed text-white/80 sm:text-lg">
              Venturelyx finds the customers searching for you, keeps every lead in one
              pipeline, and drafts your review replies — so nothing falls through the
              cracks.
            </p>
            <div className="mt-8">
              <Link
                href="/register"
                className="inline-flex min-h-[42px] items-center gap-1.5 rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary-hover hover:shadow-md"
              >
                Start free <ArrowRight size={16} weight="bold" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ---- How it works ------------------------------------------------ */}
      <section id="how-it-works" className="mx-auto max-w-6xl scroll-mt-20 px-6 py-20">
        <h2 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">How it works</h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {HOW_IT_WORKS.map((s) => (
            <div key={s.step} className="rounded-xl border border-border bg-surface p-6 shadow-sm">
              <div className="flex items-center gap-3">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 font-mono text-sm font-bold text-primary">
                  {s.step}
                </span>
                <s.icon size={22} weight="duotone" className="text-primary" />
              </div>
              <h3 className="mt-4 font-display font-bold tracking-tight">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{s.copy}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---- Case study: N&P Pools — every number below is a verified,
          queried fact (see CASE_STUDY above), not an estimate. ----------- */}
      <section className="mx-auto max-w-6xl px-6 pb-20">
        <div className="rounded-2xl border border-border bg-surface p-6 shadow-sm sm:p-10">
          <p className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Real customer, real numbers
          </p>
          <h2 className="mt-2 font-display text-2xl font-bold tracking-tight sm:text-3xl">
            {CASE_STUDY.name} — {CASE_STUDY.vertical}
          </h2>

          <div className="mt-6 grid gap-6 sm:grid-cols-3">
            <div>
              <div className="font-mono text-4xl font-bold tabular-nums text-primary">
                {CASE_STUDY.before} <span className="text-2xl text-muted-foreground">&rarr;</span> {CASE_STUDY.after}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                pages search engines could see (crawls taken {CASE_STUDY.crawlDates})
              </p>
            </div>
            <div>
              <div className="font-mono text-4xl font-bold tabular-nums">
                {CASE_STUDY.healthBefore} <span className="text-2xl text-muted-foreground">&rarr;</span> {CASE_STUDY.healthAfter}
              </div>
              <p className="mt-1 text-sm text-muted-foreground">ScaleSEO health score, zero critical issues</p>
            </div>
            <div>
              <div className="font-mono text-4xl font-bold tabular-nums">{CASE_STUDY.opportunityPages}</div>
              <p className="mt-1 text-sm text-muted-foreground">
                more service-and-city pages ScaleSEO has identified as worth building next
              </p>
            </div>
          </div>

          <p className="mt-8 max-w-3xl text-sm leading-relaxed text-muted-foreground sm:text-base">
            After a platform migration, search crawlers could see exactly one page of
            {' '}{CASE_STUDY.name}&rsquo;s site — every city and service page was
            effectively invisible. ScaleSEO flagged it on the first scan. After
            rebuilding with crawlable pages, {CASE_STUDY.after} pages are now visible
            to search engines and the health score rose from {CASE_STUDY.healthBefore}
            {' '}to {CASE_STUDY.healthAfter}. ScaleSEO also mapped every service {CASE_STUDY.name}
            {' '}offers against every city they serve and currently has {CASE_STUDY.opportunityPages}
            {' '}more pages identified as worth building — each one a search their
            customers are already making.
          </p>

          {/* PLACEHOLDER — do not treat as real copy. Owner has approved use
              of the business name; the quote itself hasn't been collected yet. */}
          <div className="mt-6 rounded-xl border border-dashed border-border p-5">
            <p className="text-sm italic text-muted-foreground">
              &ldquo;[Quote pending — {CASE_STUDY.ownerName}, {CASE_STUDY.name}]&rdquo;
            </p>
          </div>
        </div>
      </section>

      {/* ---- Module sections: real screenshots, not illustrations --------
          Every module has a real screenshotImages entry now; the dashed
          ImageSquare placeholder only renders for a future module added
          without one yet. */}
      <section className="mx-auto max-w-6xl px-6 py-20">
        <h2 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">See it, don&rsquo;t just take our word for it</h2>
        <div className="mt-10 flex flex-col gap-16">
          {MODULE_SECTIONS.map((m, i) => (
            <div
              key={m.key}
              className={`grid items-center gap-8 lg:grid-cols-2 ${i % 2 === 1 ? 'lg:[&>*:first-child]:order-2' : ''}`}
            >
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-primary">{m.eyebrow}</p>
                <h3 className="mt-2 font-display text-xl font-bold tracking-tight sm:text-2xl">{m.title}</h3>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground sm:text-base">{m.copy}</p>
              </div>
              {m.screenshotImages ? (
                <ImageCarousel
                  images={m.screenshotImages}
                  alt={m.screenshotCaption}
                  className="aspect-[16/10] rounded-xl border border-border shadow-sm"
                />
              ) : (
                <div className="flex aspect-[16/10] items-center justify-center rounded-xl border border-dashed border-border bg-muted/40">
                  <div className="flex flex-col items-center gap-2 text-muted-foreground/60">
                    <ImageSquare size={32} weight="duotone" />
                    <span className="text-xs">{m.screenshotCaption}</span>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* ---- All modules at a glance (includes Build/Source, which have
          no screenshot section above since they don't exist to shoot yet) */}
      <section id="modules" className="mx-auto max-w-6xl scroll-mt-20 px-6 pb-24">
        <h2 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">Every module. One platform.</h2>
        <p className="mt-2 text-muted-foreground">Start with what's live. The rest is on the way.</p>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {MODULES.map((m) => {
            const Icon = MODULE_ICONS[m.icon];
            return (
              <div key={m.key} className="flex items-start justify-between gap-3 rounded-xl border border-border bg-surface p-5 shadow-sm">
                <div className="flex items-start gap-3">
                  <Icon size={20} weight="duotone" className={m.status === 'soon' ? 'text-muted-foreground/50' : 'text-primary'} />
                  <div>
                    <div className="font-display font-bold tracking-tight">{m.name}</div>
                    <div className="mt-1 text-sm text-muted-foreground">{m.description}</div>
                    {m.subtitle && <div className="mt-1 text-xs text-muted-foreground/80">{m.subtitle}</div>}
                  </div>
                </div>
                <span
                  className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                    m.status === 'live' ? 'bg-success/10 text-success'
                      : m.status === 'beta' ? 'bg-warning/10 text-warning'
                        : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {m.status}
                </span>
              </div>
            );
          })}
        </div>
      </section>

      {/* ---- Trust ---------------------------------------------------- */}
      <section className="border-y border-border bg-surface">
        <div className="mx-auto max-w-6xl px-6 py-16">
          <div className="grid gap-8 sm:grid-cols-3">
            {TRUST_POINTS.map((t) => (
              <div key={t.title} className="flex flex-col items-start gap-3">
                <t.icon size={28} weight="duotone" className="text-primary" />
                <h3 className="font-display font-bold tracking-tight">{t.title}</h3>
                <p className="text-sm leading-relaxed text-muted-foreground">{t.copy}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- FAQ -------------------------------------------------------- */}
      <section id="faq" className="mx-auto max-w-3xl scroll-mt-20 px-6 py-20">
        <h2 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">Frequently asked questions</h2>
        <div className="mt-8 flex flex-col gap-3">
          {FAQ.map((f) => (
            <details key={f.q} className="group rounded-xl border border-border bg-surface p-5 shadow-sm">
              <summary className="cursor-pointer list-none font-display font-semibold tracking-tight marker:content-none">
                {f.q}
              </summary>
              <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* ---- Pricing -----------------------------------------------------
          Platform is self-service (ctaHref -> /register). The other three
          are sales-assisted — nobody reaches Stripe for a $750 setup fee
          without a staff member generating that checkout from an approved
          deal (routes/growthScans.ts), so their CTA routes into the free
          Growth Scan funnel instead of a waitlist or a direct charge. */}
      <section id="pricing" className="mx-auto max-w-6xl scroll-mt-20 px-6 pb-24">
        <h2 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">Pricing</h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {TIERS.map((t) => (
            <div key={t.key} className={`rounded-xl border p-6 shadow-sm ${t.featured ? 'border-primary' : 'border-border'} bg-surface`}>
              <div className="font-display font-bold tracking-tight">{t.name}</div>
              <div className="mt-2 font-mono text-3xl font-bold tabular-nums">
                {t.price}<span className="text-sm font-normal text-muted-foreground">/{t.cadence}</span>
              </div>
              {t.setupFee && <p className="text-xs text-muted-foreground">+ {t.setupFee}</p>}
              <p className="mt-2 text-sm text-muted-foreground">{t.description}</p>
              <ul className="mt-4 flex flex-col gap-2 text-sm text-muted-foreground">
                {t.features.map((f) => <li key={f}>{f}</li>)}
              </ul>
              <div className="mt-6">
                <Link
                  href={t.ctaHref}
                  className="inline-flex min-h-[42px] w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary-hover hover:shadow-md"
                >
                  {t.ctaLabel}
                </Link>
              </div>
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t border-border py-8 text-center text-xs text-muted-foreground">
        © 2026 Venturelyx · We build businesses, not websites.
      </footer>
    </div>
  );
}
