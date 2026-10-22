'use client';

import Link from 'next/link';
import { Users, Receipt, Briefcase, ArrowRight } from '@phosphor-icons/react';
import { PageHeader } from '@/components/Primitives';
import { Card } from '@/components/ui/Card';

const CARDS = [
  {
    key: 'customers',
    icon: Users,
    title: 'Customers',
    description: 'Name, email, phone, company, address — upserts by email, else name, so re-running the same file is safe.',
    href: '/operate/customers/import',
  },
  {
    key: 'invoices',
    icon: Receipt,
    title: 'Invoices',
    description: 'Current-year invoices — status, payments, and overdue tracking are worked out from the amounts you give.',
    href: '/operate/invoices/import',
  },
  {
    key: 'jobs',
    icon: Briefcase,
    title: 'Open jobs',
    description: 'Scheduled and in-progress work — links to the customer, creating them if they’re not imported yet.',
    href: '/operate/jobs/import',
  },
];

export default function ImportDataHubPage() {
  return (
    <div className="p-4">
      <PageHeader
        eyebrow="Operate"
        title="Import your data"
        subtitle="Bring your existing business in from a spreadsheet — start day one with real numbers, not an empty dashboard. Import customers first so invoices and jobs can link to them, though each one works on its own."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {CARDS.map((c) => (
          <Link key={c.key} href={c.href}>
            <Card className="flex h-full flex-col p-5 transition hover:border-primary/40 hover:shadow-sm">
              <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                <c.icon size={19} weight="duotone" className="text-primary" />
              </div>
              <p className="text-sm font-semibold">{c.title}</p>
              <p className="mt-1 flex-1 text-sm text-muted-foreground">{c.description}</p>
              <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-primary">
                Start import <ArrowRight size={12} weight="bold" />
              </span>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
