import { useEffect, type MouseEvent } from 'react';
import { useLenis } from 'lenis/react';
import {
  ArrowRight,
  BarChart3,
  FileText,
  GitCompare,
  PackageCheck,
  ReceiptText,
  ShieldCheck,
  Store,
  Wallet,
} from 'lucide-react';
import { buttonClass } from '@/components/ui/button';
import { ThemeToggle } from '@/components/ThemeToggle';
import { SmoothScroll } from '@/components/SmoothScroll';

/* The sticky header's height — anchor scrolling lands just below it. */
const HEADER_OFFSET = -72;

const NAV = [
  { id: 'features', label: 'Features' },
  { id: 'how', label: 'How it works' },
  { id: 'roles', label: 'Who it is for' },
];

const FEATURES = [
  { icon: FileText, title: 'Tenders', body: 'Draft, publish and run sealed tenders with deadlines, criteria and a clean audit trail.' },
  { icon: GitCompare, title: 'Evaluation', body: 'Side-by-side quotation comparison with weighted scoring and a recommendation you can defend.' },
  { icon: PackageCheck, title: 'Goods receipt', body: 'Capture GRNs against purchase orders — quantities, shortages and exceptions, line by line.' },
  { icon: ReceiptText, title: 'Invoicing', body: 'Three-way match of invoice, order and receipt before a rupee is ever approved.' },
  { icon: Wallet, title: 'Payments', body: 'A payable register and payment history that reconciles to the last paise.' },
  { icon: BarChart3, title: 'Reports', body: 'Role dashboards and exportable reports that turn the paper trail into decisions.' },
];

const STEPS = [
  { word: 'Plan', body: 'Scope the requirement, set the criteria and open the tender to the right vendors.' },
  { word: 'Personalize', body: 'Weight what matters to you, score every bid and shape the award to your rules.' },
  { word: 'Pursue', body: 'Drive it through orders, receipts, invoices and payment without losing the thread.' },
];

const ROLES = [
  { icon: ShieldCheck, title: 'Buyer organisations', body: 'Officers and approvers run sourcing end to end with permissions that match the org chart.' },
  { icon: Store, title: 'Vendors', body: 'Discover tenders, submit quotations, dispatch goods and raise invoices in one place.' },
  { icon: BarChart3, title: 'Platform admins', body: 'Approve organisations, vet vendors and watch the whole platform from a single console.' },
];

function Header() {
  const lenis = useLenis();

  const go = (id: string) => (event: MouseEvent) => {
    event.preventDefault();
    const el = document.getElementById(id);
    if (!el) return;
    if (lenis) lenis.scrollTo(el, { offset: HEADER_OFFSET });
    else el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-surface/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-3 px-4 sm:px-6">
        <a href="#top" onClick={go('top')} className="flex items-center gap-2.5" aria-label="TenderX home">
          <img
            src="/logo.jpeg"
            alt="TenderX"
            className="size-8 rounded-md object-cover"
            onError={(event) => {
              event.currentTarget.style.display = 'none';
            }}
          />
          <span className="text-lg font-bold tracking-tight text-text">TenderX</span>
        </a>

        <nav aria-label="Sections" className="ml-6 hidden items-center gap-6 md:flex">
          {NAV.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              onClick={go(item.id)}
              className="text-sm font-medium text-muted transition-colors hover:text-text"
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <ThemeToggle />
          <a href="/login" className={buttonClass('ghost', 'md', 'hidden sm:inline-flex')}>
            Sign in
          </a>
          <a href="/register" className={buttonClass('primary', 'md')}>
            Get started
          </a>
        </div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section id="top" className="relative overflow-hidden">
      {/* Soft brand glows that read in both themes. */}
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="animate-float absolute -top-24 -right-16 size-80 rounded-full bg-brand-light/25 blur-3xl" />
        <div className="absolute -bottom-32 -left-20 size-96 rounded-full bg-brand/20 blur-3xl" />
      </div>

      <div className="relative mx-auto grid max-w-6xl items-center gap-12 px-4 py-20 sm:px-6 md:grid-cols-2 md:py-28">
        <div>
          <span className="animate-rise inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-muted">
            <span className="size-1.5 rounded-full bg-brand" />
            Procurement, end to end
          </span>

          <h1 className="animate-rise mt-5 text-5xl font-extrabold tracking-tight sm:text-6xl" style={{ animationDelay: '60ms' }}>
            <span className="bg-gradient-to-r from-brand-deep via-brand to-brand-light bg-clip-text text-transparent">
              TenderX
            </span>
          </h1>

          <p className="animate-rise mt-3 text-2xl font-semibold text-text sm:text-3xl" style={{ animationDelay: '120ms' }}>
            Plan. Personalize. Pursue.
          </p>

          <p className="animate-rise mt-5 max-w-md text-base text-muted" style={{ animationDelay: '180ms' }}>
            One system for the whole procurement lifecycle — from the first sealed tender to the
            final reconciled payment, with every step on the record.
          </p>

          <div className="animate-rise mt-8 flex flex-wrap items-center gap-3" style={{ animationDelay: '240ms' }}>
            <a href="/register" className={buttonClass('primary', 'lg')}>
              Get started
              <ArrowRight className="size-4" />
            </a>
            <a href="/login" className={buttonClass('outline', 'lg')}>
              Sign in
            </a>
          </div>
        </div>

        {/* Abstract product panel — no real data, pure chrome. */}
        <div className="animate-rise relative" style={{ animationDelay: '300ms' }}>
          <div className="rounded-2xl border border-border bg-surface p-5 shadow-xl">
            <div className="flex items-center gap-2 border-b border-border pb-3">
              <span className="size-2.5 rounded-full bg-danger" />
              <span className="size-2.5 rounded-full bg-warning" />
              <span className="size-2.5 rounded-full bg-success" />
              <span className="ml-2 text-xs text-muted">Comparison · Tender #4821</span>
            </div>
            <div className="mt-4 space-y-3">
              {[
                { name: 'Meridian Industries', score: 92, tone: 'bg-success' },
                { name: 'Apex Supplies', score: 81, tone: 'bg-brand' },
                { name: 'Northwind Trading', score: 68, tone: 'bg-warning' },
              ].map((row) => (
                <div key={row.name} className="flex items-center gap-3">
                  <span className="w-40 truncate text-sm text-text">{row.name}</span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-subtle">
                    <span className={`block h-full rounded-full ${row.tone}`} style={{ width: `${row.score}%` }} />
                  </span>
                  <span className="numeric w-10 text-sm text-text">{row.score}</span>
                </div>
              ))}
            </div>
            <div className="mt-5 flex items-center justify-between rounded-lg bg-brand-deep px-4 py-3">
              <span className="text-sm font-medium text-white">Recommended award</span>
              <span className="text-sm font-semibold text-brand-light">Meridian Industries</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function SectionHeading({ eyebrow, title, body }: { eyebrow: string; title: string; body: string }) {
  return (
    <div className="reveal mx-auto max-w-2xl text-center">
      <p className="text-sm font-semibold text-brand">{eyebrow}</p>
      <h2 className="mt-2 text-3xl font-bold tracking-tight text-text sm:text-4xl">{title}</h2>
      <p className="mt-3 text-base text-muted">{body}</p>
    </div>
  );
}

function Features() {
  return (
    <section id="features" className="mx-auto max-w-6xl px-4 py-20 sm:px-6 md:py-28">
      <SectionHeading
        eyebrow="Everything in one place"
        title="The whole lifecycle, nothing bolted on"
        body="Six tightly connected modules that hand off to each other cleanly — no spreadsheets in the gaps."
      />
      <div className="mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((feature, index) => (
          <div
            key={feature.title}
            className="reveal group rounded-xl border border-border bg-surface p-6 transition-all hover:-translate-y-1 hover:border-brand hover:shadow-lg"
            style={{ transitionDelay: `${index * 60}ms` }}
          >
            <span className="inline-flex size-11 items-center justify-center rounded-lg bg-brand/15 text-brand-ink transition-colors group-hover:bg-brand/25">
              <feature.icon className="size-5" />
            </span>
            <h3 className="mt-4 text-base font-semibold text-text">{feature.title}</h3>
            <p className="mt-1.5 text-sm text-muted">{feature.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section id="how" className="border-y border-border bg-subtle/50">
      <div className="mx-auto max-w-6xl px-4 py-20 sm:px-6 md:py-28">
        <SectionHeading
          eyebrow="Plan. Personalize. Pursue."
          title="Three moves, start to finish"
          body="The tagline is the workflow — each word is a stage, and TenderX carries you through all three."
        />
        <div className="mt-14 grid gap-6 md:grid-cols-3">
          {STEPS.map((step, index) => (
            <div key={step.word} className="reveal relative rounded-xl border border-border bg-surface p-7" style={{ transitionDelay: `${index * 80}ms` }}>
              <span className="numeric text-5xl font-extrabold text-brand/30">{String(index + 1).padStart(2, '0')}</span>
              <h3 className="mt-3 text-xl font-bold text-brand-ink">{step.word}</h3>
              <p className="mt-2 text-sm text-muted">{step.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Roles() {
  return (
    <section id="roles" className="mx-auto max-w-6xl px-4 py-20 sm:px-6 md:py-28">
      <SectionHeading
        eyebrow="Who it is for"
        title="One platform, every seat at the table"
        body="Buyers, vendors and the platform team each get a workspace scoped to exactly what they do."
      />
      <div className="mt-14 grid gap-5 md:grid-cols-3">
        {ROLES.map((role, index) => (
          <div key={role.title} className="reveal rounded-xl border border-border bg-surface p-7" style={{ transitionDelay: `${index * 70}ms` }}>
            <span className="inline-flex size-11 items-center justify-center rounded-lg bg-brand-deep text-white">
              <role.icon className="size-5" />
            </span>
            <h3 className="mt-4 text-lg font-semibold text-text">{role.title}</h3>
            <p className="mt-1.5 text-sm text-muted">{role.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function CtaBand() {
  return (
    <section className="mx-auto max-w-6xl px-4 pb-24 sm:px-6">
      <div className="reveal overflow-hidden rounded-2xl bg-gradient-to-br from-brand-deep via-brand-deep to-brand p-10 text-center md:p-16">
        <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
          Run your next tender on TenderX
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-base text-brand-light">
          Plan it, personalize the scoring, pursue it to payment — all on one trail.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <a href="/register" className={buttonClass('primary', 'lg', 'bg-white text-brand-deep hover:bg-brand-paper')}>
            Create an account
            <ArrowRight className="size-4" />
          </a>
          <a href="/login" className={buttonClass('outline', 'lg', 'border-white/40 bg-transparent text-white hover:bg-white/10')}>
            Sign in
          </a>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-border bg-surface">
      <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 py-8 sm:flex-row sm:px-6">
        <div className="flex items-center gap-2.5">
          <img
            src="/logo.jpeg"
            alt=""
            aria-hidden
            className="size-6 rounded object-cover"
            onError={(event) => {
              event.currentTarget.style.display = 'none';
            }}
          />
          <span className="font-semibold text-text">TenderX</span>
          <span className="text-sm text-muted">· Plan. Personalize. Pursue.</span>
        </div>
        <p className="text-xs text-muted">© {new Date().getFullYear()} TenderX. All rights reserved.</p>
      </div>
    </footer>
  );
}

function LandingInner() {
  // Scroll reveal: elements are visible by default; this only adds the entrance.
  useEffect(() => {
    const items = Array.from(document.querySelectorAll<HTMLElement>('.reveal'));
    if (!('IntersectionObserver' in window)) {
      items.forEach((el) => el.classList.add('reveal-in'));
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.classList.add('reveal-in');
            observer.unobserve(entry.target);
          }
        }
      },
      { rootMargin: '0px 0px -10% 0px', threshold: 0.1 },
    );
    items.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  return (
    <div className="min-h-screen bg-bg">
      <Header />
      <main>
        <Hero />
        <Features />
        <HowItWorks />
        <Roles />
        <CtaBand />
      </main>
      <Footer />
    </div>
  );
}

export function LandingPage() {
  return (
    <SmoothScroll>
      <LandingInner />
    </SmoothScroll>
  );
}
