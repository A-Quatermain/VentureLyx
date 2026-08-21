import Link from 'next/link';
import { redirect } from 'next/navigation';
import {
  ArrowRight, Kanban, MagnifyingGlass, Gauge, Compass, Package, TrendUp, Robot,
} from '@phosphor-icons/react/ssr';
import { getServerSession } from '@/lib/session';
import { ThemeToggle } from '@/components/ThemeToggle';

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
            <div className="flex h-7 w-7 items-center justify-center bg-primary">
              <span className="font-display text-lg font-black leading-none text-primary-foreground">V</span>
            </div>
            <span className="font-display text-lg font-black tracking-tighter">VENTURELYX</span>
          </div>
          <div className="flex items-center gap-3">
            <ThemeToggle />
            <Link href="/sign-in" className="hidden text-sm text-muted-foreground hover:text-foreground sm:inline">
              Sign in
            </Link>
            <Link
              href="/register"
              className="inline-flex min-h-[42px] items-center gap-1.5 bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
            >
              Get started <ArrowRight size={14} weight="bold" />
            </Link>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-6 pb-20 pt-20 sm:pt-28">
        <div className="max-w-3xl">
          <h1 className="font-display text-4xl font-black leading-none tracking-tighter sm:text-5xl">
            We build businesses,
            <br />
            not websites.
          </h1>
          <p className="mt-6 max-w-xl text-base leading-relaxed text-muted-foreground sm:text-lg">
            The operating system that takes your small business from idea to launch to
            scale — CRM, SEO, and revenue, all reporting into one Command Center, with an
            AI team behind it.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/register"
              className="inline-flex min-h-[42px] items-center gap-1.5 bg-primary px-5 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
            >
              Start free <ArrowRight size={16} weight="bold" />
            </Link>
            <Link
              href="/sign-in"
              className="inline-flex min-h-[42px] items-center border border-border px-5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              I have an account
            </Link>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-20">
        <div className="grid gap-4 md:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="border border-border bg-surface p-6 transition-transform hover:-translate-y-0.5">
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
            <div key={m.name} className="flex items-start justify-between gap-3 border border-border bg-surface p-5">
              <div className="flex items-start gap-3">
                <m.icon size={20} weight="duotone" className={m.live ? 'text-primary' : 'text-muted-foreground/50'} />
                <div>
                  <div className="font-display font-bold tracking-tight">{m.name}</div>
                  <div className="mt-1 text-sm text-muted-foreground">{m.desc}</div>
                </div>
              </div>
              <span
                className={`shrink-0 border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                  m.live ? 'border-primary text-primary' : 'border-border text-muted-foreground'
                }`}
              >
                {m.live ? 'Live' : 'Soon'}
              </span>
            </div>
          ))}
        </div>
      </section>

      <footer className="border-t border-border py-8 text-center font-mono text-xs text-muted-foreground">
        © 2026 Venturelyx · We build businesses, not websites.
      </footer>
    </div>
  );
}
