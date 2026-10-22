'use client';

import { use, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { mutate } from 'swr';
import {
  CaretLeft, Phone, EnvelopeSimple, Globe, ChatCircle, MapPin, Tag, Note,
  PencilSimple, Trash, ClockCounterClockwise, Megaphone, Briefcase, FileText, Receipt, Sparkle,
  CalendarPlus, NotePencil,
} from '@phosphor-icons/react';
import { useApi, useRole, atLeast } from '@/lib/useApi';
import { apiFetch, ApiError } from '@/lib/api';
import type { ContactChannel, PartyDetail, PartyInvoice, TimelineEvent } from '@/lib/types';
import { formatMoney } from '@/lib/format';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Skeleton, SkeletonCard } from '@/components/ui/Skeleton';
import { CustomerDrawer } from '@/components/CustomerDrawer';
import { JobDrawer } from '@/components/JobDrawer';
import { InvoiceDrawer } from '@/components/InvoiceDrawer';
import { ActivityDrawer } from '@/components/ActivityDrawer';
import { AIStreamPanel } from '@/components/AIStreamPanel';
import { toneSoft, type Tone } from '@/components/ui/tone';
import type { Lifecycle as LifecycleT } from '@/lib/types';

// Overdue by STATUS (the backend's own 'overdue' state) OR by date — a
// 'sent'/'partial' invoice past its due date with a real balance left is
// overdue in substance even before whatever job flips the status column.
function isOverdue(inv: PartyInvoice): boolean {
  if (inv.status === 'overdue') return true;
  if (inv.status !== 'sent' && inv.status !== 'partial') return false;
  if (!inv.due_on) return false;
  return new Date(inv.due_on) < new Date() && Number(inv.total) > Number(inv.amount_paid);
}

const LIFECYCLE_TONE: Record<LifecycleT, Tone> = {
  new: 'primary',
  working: 'primary',
  qualified: 'primary',
  customer: 'success',
  lost: 'destructive',
  dormant: 'muted',
};

const CONTACT_ICON: Record<ContactChannel, typeof Phone> = {
  phone: Phone,
  email: EnvelopeSimple,
  sms: ChatCircle,
  whatsapp: ChatCircle,
  url: Globe,
};

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export default function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const role = useRole();
  const canEdit = atLeast(role, 'staff');
  const canDelete = atLeast(role, 'manager');

  const { data, isLoading, error } = useApi<PartyDetail>(`/operate/parties/${id}`);
  const { data: timeline, isLoading: timelineLoading } = useApi<TimelineEvent[]>(`/operate/parties/${id}/timeline`);

  const [editing, setEditing] = useState(false);
  const [addingJob, setAddingJob] = useState(false);
  const [addingInvoice, setAddingInvoice] = useState(false);
  const [loggingActivity, setLoggingActivity] = useState(false);
  const [busy, setBusy] = useState(false);

  async function onDelete() {
    if (!data) return;
    if (!confirm(`Remove "${data.party.display_name}"? This can't be undone.`)) return;
    setBusy(true);
    try {
      await apiFetch(`/operate/parties/${id}`, { method: 'DELETE' });
      await mutate((key: string) => typeof key === 'string' && key.startsWith('/operate/parties'), undefined, {
        revalidate: true,
      });
      router.push('/operate/customers');
    } catch (err) {
      alert(err instanceof ApiError ? err.message : 'Could not remove this customer.');
      setBusy(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 p-4">
        <Skeleton className="h-10 w-64 rounded-lg bg-muted" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Skeleton className="h-64 rounded-xl bg-muted lg:col-span-1" />
          <Skeleton className="h-64 rounded-xl bg-muted lg:col-span-2" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-4">
        <Card className="p-4">
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : 'Could not load this customer.'}
          </p>
        </Card>
      </div>
    );
  }

  const { party, contacts, money, campaigns, jobs, quotes, invoices } = data;
  const phone = contacts.find((c) => c.channel === 'phone' && c.is_primary);
  const email = contacts.find((c) => c.channel === 'email' && c.is_primary);

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            href="/operate/customers"
            className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <CaretLeft size={14} weight="bold" /> Customers
          </Link>
          <div className="flex items-center gap-3">
            <h1 className="font-display text-2xl font-bold tracking-tight sm:text-3xl">{party.display_name}</h1>
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${toneSoft[LIFECYCLE_TONE[party.lifecycle]]}`}>
              {party.lifecycle}
            </span>
          </div>
          {party.company_name && <p className="mt-1 text-sm text-muted-foreground">{party.company_name}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {phone && (
            <a href={`tel:${phone.value}`} className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-border px-3 text-sm hover:bg-muted">
              <Phone size={14} weight="bold" /> Call
            </a>
          )}
          {email && (
            <a href={`mailto:${email.value}`} className="inline-flex min-h-[38px] items-center gap-1.5 rounded-lg border border-border px-3 text-sm hover:bg-muted">
              <EnvelopeSimple size={14} weight="bold" /> Email
            </a>
          )}
          {canEdit && (
            <Button variant="ghost" onClick={() => setLoggingActivity(true)}>
              <NotePencil size={14} weight="bold" className="mr-1.5 inline" /> Log activity
            </Button>
          )}
          {canEdit && (
            <Button variant="ghost" onClick={() => setAddingJob(true)}>
              <CalendarPlus size={14} weight="bold" className="mr-1.5 inline" /> New job
            </Button>
          )}
          {canEdit && (
            <Button variant="ghost" onClick={() => setAddingInvoice(true)}>
              <Receipt size={14} weight="bold" className="mr-1.5 inline" /> New invoice
            </Button>
          )}
          {canEdit && (
            <Button variant="ghost" onClick={() => setEditing(true)}>
              <PencilSimple size={14} weight="bold" className="mr-1.5 inline" /> Edit
            </Button>
          )}
          {canDelete && (
            <Button variant="ghost" onClick={onDelete} disabled={busy} className="text-destructive">
              <Trash size={14} weight="bold" className="mr-1.5 inline" /> Remove
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <MoneyTile label="Lifetime value" value={formatMoney(money.lifetime_value)} />
        <MoneyTile label="Open balance" value={formatMoney(money.open_balance)} />
        <MoneyTile
          label="Last payment"
          value={money.last_payment ? formatMoney(money.last_payment.amount) : '—'}
          sub={money.last_payment ? formatDate(money.last_payment.received_at) : 'None recorded'}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="flex flex-col gap-4 lg:col-span-1">
          <Card className="p-5">
            <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">Contact</p>
            {contacts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No contact points on file.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {contacts.map((c) => {
                  const Icon = CONTACT_ICON[c.channel];
                  return (
                    <div key={c.id} className="flex items-center gap-2 text-sm">
                      <Icon size={15} className="shrink-0 text-muted-foreground" />
                      <span>{c.value}</span>
                      {c.label && <span className="text-xs text-muted-foreground">({c.label})</span>}
                    </div>
                  );
                })}
              </div>
            )}
            {(party.city || party.address_line1) && (
              <div className="mt-3 flex items-start gap-2 border-t border-border pt-3 text-sm">
                <MapPin size={15} className="mt-0.5 shrink-0 text-muted-foreground" />
                <span className="text-muted-foreground">
                  {[party.address_line1, party.address_line2, party.city, party.region, party.postal_code]
                    .filter(Boolean)
                    .join(', ') || '—'}
                </span>
              </div>
            )}
          </Card>

          {party.tags.length > 0 && (
            <Card className="p-5">
              <p className="mb-3 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <Tag size={13} /> Tags
              </p>
              <div className="flex flex-wrap gap-1.5">
                {party.tags.map((t) => (
                  <span key={t} className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                    {t}
                  </span>
                ))}
              </div>
            </Card>
          )}

          {party.notes && (
            <Card className="p-5">
              <p className="mb-3 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <Note size={13} /> Notes
              </p>
              <p className="whitespace-pre-wrap text-sm text-muted-foreground">{party.notes}</p>
            </Card>
          )}

          <Card className="p-5">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Attribution</p>
            {party.first_touch_channel ? (
              <p className="text-sm text-muted-foreground">
                First found you through <span className="font-medium text-foreground">{party.first_touch_channel}</span>
                {party.first_touch_at && `, ${formatDate(party.first_touch_at)}`}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">No attribution recorded yet.</p>
            )}
          </Card>

          {campaigns.length > 0 && (
            <Card className="p-5">
              <p className="mb-3 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                <Megaphone size={13} /> Grow Campaigns
              </p>
              <div className="flex flex-col gap-3">
                {campaigns.map((c) => (
                  <div key={c.campaign_id} className="text-sm">
                    <p className="font-medium">{c.campaign_name}</p>
                    <p className="text-xs text-muted-foreground">
                      {c.emails_sent} sent · {c.replies} repl{c.replies === 1 ? 'y' : 'ies'}
                      {c.state && ` · ${c.state}`}
                    </p>
                  </div>
                ))}
              </div>
            </Card>
          )}

          <Card className="p-5">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Jobs</p>
              <button type="button" onClick={() => setAddingJob(true)} className="text-xs font-medium text-primary hover:underline">
                + New job
              </button>
            </div>
            {jobs.length === 0 && quotes.length === 0 ? (
              <p className="text-sm text-muted-foreground">No jobs yet.</p>
            ) : (
              <div className="flex flex-col gap-2.5">
                {jobs.map((j) => (
                  <div key={j.id} className="flex items-center gap-2 text-sm">
                    <Briefcase size={14} className="shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{j.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{j.status}</span>
                  </div>
                ))}
                {quotes.map((q) => (
                  <div key={q.id} className="flex items-center gap-2 text-sm">
                    <FileText size={14} className="shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">{q.number ?? 'Quote'}</span>
                    <span className="shrink-0 font-mono text-xs tabular-nums">{formatMoney(q.total)}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{q.status}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="p-5">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Invoices</p>
              <button type="button" onClick={() => setAddingInvoice(true)} className="text-xs font-medium text-primary hover:underline">
                + New invoice
              </button>
            </div>
            {invoices.length === 0 ? (
              <p className="text-sm text-muted-foreground">No invoices yet.</p>
            ) : (
              <div className="flex flex-col gap-2.5">
                {invoices.map((inv) => <InvoiceRow key={inv.id} invoice={inv} />)}
              </div>
            )}
          </Card>
        </div>

        <Card className="lg:col-span-2">
          <div className="flex items-center gap-2 border-b border-border px-5 py-4">
            <ClockCounterClockwise size={18} className="text-muted-foreground" />
            <h3 className="font-display font-bold tracking-tight">Timeline</h3>
          </div>
          {timelineLoading ? (
            <SkeletonCard />
          ) : !timeline || timeline.length === 0 ? (
            <p className="px-5 py-8 text-sm text-muted-foreground">Nothing here yet.</p>
          ) : (
            <div className="divide-y divide-border">
              {timeline.map((ev) => (
                <div key={ev.id} className="px-5 py-4">
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm font-semibold">{ev.title}</p>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{formatDateTime(ev.occurred_at)}</span>
                  </div>
                  {ev.body && <p className="mt-0.5 text-sm text-muted-foreground">{ev.body}</p>}
                  {ev.actor_label && <p className="mt-1 text-xs text-muted-foreground/70">{ev.actor_label}</p>}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <CustomerDrawer
        open={editing}
        onOpenChange={setEditing}
        party={party}
        contacts={contacts}
        onSaved={() => mutate(`/operate/parties/${id}`)}
      />
      <JobDrawer open={addingJob} onOpenChange={setAddingJob} partyId={id} />
      <InvoiceDrawer open={addingInvoice} onOpenChange={setAddingInvoice} partyId={id} />
      <ActivityDrawer open={loggingActivity} onOpenChange={setLoggingActivity} partyId={id} />
    </div>
  );
}

function InvoiceRow({ invoice }: { invoice: PartyInvoice }) {
  const [drafting, setDrafting] = useState(false);
  const overdue = isOverdue(invoice);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-sm">
        <Receipt size={14} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">{invoice.number ?? 'Invoice'}</span>
        <span className="shrink-0 font-mono text-xs tabular-nums">{formatMoney(invoice.total)}</span>
        <span className={`shrink-0 text-xs ${overdue ? 'font-medium text-destructive' : 'text-muted-foreground'}`}>
          {overdue ? 'overdue' : invoice.status}
        </span>
        {overdue && (
          <button
            type="button"
            title="Ask the Follow-up Assistant to draft a reminder"
            onClick={() => setDrafting((v) => !v)}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 transition hover:bg-primary/10 hover:text-primary"
          >
            <Sparkle size={13} weight="fill" />
          </button>
        )}
      </div>
      {drafting && (
        <div className="pl-5">
          <AIStreamPanel
            path="/ai/followup-assistant/stream"
            body={{ invoiceId: invoice.id }}
            title="AI-drafted payment reminder"
            triggerLabel="Draft this"
            autoStart
          />
          <p className="mt-2 text-xs text-muted-foreground/70">
            This never sends or charges on its own — copy it into however you already reach this customer.
          </p>
        </div>
      )}
    </div>
  );
}

function MoneyTile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p data-numeric className="mt-1 font-mono text-xl font-semibold tabular-nums">
        {value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </Card>
  );
}
