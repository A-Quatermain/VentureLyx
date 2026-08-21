import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  ArrowRight, Kanban, MagnifyingGlass, Gauge, Compass, Package, TrendUp, Robot,
} from '@phosphor-icons/react/ssr';
import { getServerSession } from '@/lib/session';
import { ThemeToggle } from '@/components/ThemeToggle';
import { VideoHero } from '@/components/VideoHero';

// This page's output depends on the request's session cookie (redirects an
// authenticated visitor away entirely), so it was never actually a static
// page — but without this, Next.js still tries to prerender it once at
// build time to check. That build-time call has no real request/cookie and
// no INTERNAL_API_BASE (that's a docker-compose runtime env var; the build
// stage has no docker network), so it always failed there for the wrong
// reason. Forcing dynamic skips the build-time attempt entirely.
export const dynamic = 'force-dynamic';

const FEATURES = [
  {
    icon: Kanban,
    title: 'Operate',
    copy: 'Track every lead through a pipeline, manage your catalog, and see who owes you money — all in one place.',
  },
  {
    icon: MagnifyingGlass,
    title: 'ScaleSEO',
    copy: "Scan your site, get a health score, and see exactly which pages and issues are costing you customers.",
  },
  {
    icon: Gauge,
    title: 'Command Center',
    copy: 'One score for how healthy your business is, plus the next best action — surfaced automatically, not buried in a report.',
  },
];

const MODULES = [
  { n: '01', name: 'Build', desc: 'Idea → blueprint → brand → site', icon: Compass, live: false },
  { n: '02', name: 'Source', desc: 'Suppliers, RFQs, cost compares', icon: Package, live: false },
  { n: '03', name: 'Operate', desc: 'CRM, jobs, invoices, payments', icon: Kanban, live: true },
  { n: '04', name: 'ScaleSEO', desc: "Get found. Fix what's broken.", icon: MagnifyingGlass, live: true },
  { n: '05', name: 'Grow', desc: 'Leads, email/SMS, funnels, ads', icon: TrendUp, live: false },
  { n: '06', name: 'AI Team', desc: 'Receptionist, sales, SEO agents', icon: Robot, live: false },
] as const;

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
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary">
              <span className="font-display text-lg font-bold leading-none text-primary-foreground">V</span>
            </div>
            <span className="font-display text-lg font-bold tracking-tight">Venturelyx</span>
          </div>
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
            <h1 className="font-display text-4xl font-bold leading-tight tracking-tight text-white sm:text-5xl">
              We build businesses,
              <br />
              not websites.
            </h1>
            <p className="mt-6 max-w-xl text-base leading-relaxed text-white/80 sm:text-lg">
              The operating system that takes your small business from idea to launch to
              scale — CRM, SEO, and revenue, all reporting into one Command Center, with an
              AI team behind it.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                href="/register"
                className="inline-flex min-h-[42px] items-center gap-1.5 rounded-lg bg-primary px-5 text-sm font-semibold text-primary-foreground shadow-sm transition hover:bg-primary-hover hover:shadow-md"
              >
                Start free <ArrowRight size={16} weight="bold" />
              </Link>
              <Link
                href="/sign-in"
                className="inline-flex min-h-[42px] items-center rounded-lg border border-white/30 px-5 text-sm font-medium text-white transition-colors hover:bg-white/10"
              >
                I have an account
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-20">
        <div className="grid gap-4 md:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="rounded-xl border border-border bg-surface p-6 shadow-sm transition-shadow hover:shadow-md">
              <f.icon size={24} weight="duotone" className="text-primary" />
              <h3 className="mt-4 font-display text-xl font-bold tracking-tight">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{f.copy}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="modules" className="mx-auto max-w-6xl scroll-mt-20 px-6 pb-24">
        <h2 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">Six modules. One platform.</h2>
        <p className="mt-2 text-muted-foreground">Start with what's live. The rest is on the way.</p>
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {MODULES.map((m) => (
            <div key={m.name} className="flex items-start justify-between gap-3 rounded-xl border border-border bg-surface p-5 shadow-sm">
              <div className="flex items-start gap-3">
                <m.icon size={20} weight="duotone" className={m.live ? 'text-primary' : 'text-muted-foreground/50'} />
                <div>
                  <div className="font-display font-bold tracking-tight">{m.name}</div>
                  <div className="mt-1 text-sm text-muted-foreground">{m.desc}</div>
                </div>
              </div>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                  m.live ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'
                }`}
              >
                {m.live ? 'Live' : 'Soon'}
              </span>
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
