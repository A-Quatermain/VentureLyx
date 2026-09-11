'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { mutate } from 'swr';
import {
  Megaphone, UsersThree, PaperPlaneTilt, Tray, WarningCircle, Flag,
  EnvelopeSimple, Globe, Play, Pause, CheckCircle, Archive, Trash, ArrowRight, UploadSimple,
} from '@phosphor-icons/react';
import { useApi, useRole, atLeast } from '@/lib/useApi';
import { apiFetch, ApiError } from '@/lib/api';
import type { GrowCampaign, GrowContactListItem, GrowStats } from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Bar } from '@/components/ui/Bar';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { PageHeader, Stagger, StaggerItem } from '@/components/Primitives';
import { NewCampaignDrawer } from '@/components/NewCampaignDrawer';
import { toneSoft, type Tone } from '@/components/ui/tone';

const CAMPAIGNS_KEY = '/grow/campaigns';

const CAMPAIGN_STATUS_TONE: Record<GrowCampaign['status'], Tone> = {
  draft: 'muted',
  running: 'success',
  paused: 'warning',
  stopped: 'destructive',
  done: 'primary',
  archived: 'muted',
};

const CAMPAIGN_STATUS_ICON: Record<GrowCampaign['status'], typeof Play> = {
  draft: Megaphone,
  running: Play,
  paused: Pause,
  stopped: Pause,
  done: CheckCircle,
  archived: Archive,
};

/** Shared by the dashboard list and the campaign detail page: confirms,
 *  calls the delete endpoint, and reports whether it actually deleted or
 *  archived instead (a campaign with any sent mail on record can't be
 *  deleted — see api/src/routes/grow.ts). */
async function confirmAndDeleteCampaign(
  campaign: GrowCampaign,
  onDone: (result: { archived: boolean }) => void,
  onError: (message: string) => void,
) {
  if (!window.confirm(`Delete "${campaign.name}"? This can't be undone.`)) return;
  try {
    const res = await apiFetch<{ archived: boolean; campaign: GrowCampaign | null }>(
      `/grow/campaigns/${campaign.id}`, { method: 'DELETE' },
    );
    await mutate(CAMPAIGNS_KEY);
    onDone(res);
  } catch (err) {
    onError(err instanceof ApiError ? err.message : `Could not delete "${campaign.name}".`);
  }
}

function Metric({
  label,
  value,
  sub,
  icon: Icon,
  tone = 'primary',
}: {
  label: string;
  value: string;
  sub?: string;
  icon: typeof Megaphone;
  tone?: Tone;
}) {
  return (
    <StaggerItem>
      <Card className="p-5">
        <div className="mb-3 flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</span>
          <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${toneSoft[tone]}`}>
            <Icon size={16} weight="duotone" />
          </div>
        </div>
        <div className="font-mono text-3xl font-semibold tabular-nums tracking-tight">{value}</div>
        {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
      </Card>
    </StaggerItem>
  );
}

function GrowSkeleton() {
  return (
    <div className="p-4">
      <Skeleton className="mb-8 h-10 w-64 rounded-lg bg-muted" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-xl bg-muted" />
        ))}
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4">
        <Skeleton className="h-48 rounded-xl bg-muted" />
        <Skeleton className="h-48 rounded-xl bg-muted" />
      </div>
    </div>
  );
}

function ChecklistStep({
  done,
  n,
  title,
  detail,
  action,
}: {
  done: boolean;
  n: number;
  title: string;
  detail: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3">
        <span
          className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
            done ? 'bg-success/10 text-success' : 'bg-primary/10 text-primary'
          }`}
        >
          {done ? <CheckCircle size={16} weight="fill" /> : n}
        </span>
        <div>
          <p className="text-sm font-semibold">{title}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">{detail}</p>
        </div>
      </div>
      {action && <div className="shrink-0 pl-10 sm:pl-0">{action}</div>}
    </div>
  );
}

// A new org has no campaigns and (usually) no contacts — this is the normal
// first thing an owner sees, not an edge case, so it gets its own screen
// rather than a dashboard full of zeroes with one muted "No campaigns yet."
// line buried in it.
function GetStartedPanel({
  hasContacts,
  contactCount,
  canEdit,
  onNewCampaign,
}: {
  hasContacts: boolean;
  contactCount: number;
  canEdit: boolean;
  onNewCampaign: () => void;
}) {
  return (
    <Card className="overflow-hidden">
      <div className="flex flex-col items-center gap-3 border-b border-border px-6 py-10 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10">
          <Megaphone size={28} weight="duotone" className="text-primary" />
        </div>
        <h2 className="font-display text-xl font-bold tracking-tight">Let&apos;s get your first campaign running</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          Grow sends a scheduled email sequence to an imported contact list, respecting mailbox warmup and
          per-domain send limits automatically. Three steps to your first send.
        </p>
      </div>
      <div className="divide-y divide-border">
        <ChecklistStep
          done={hasContacts}
          n={1}
          title="Import your contact list"
          detail={
            hasContacts
              ? `${contactCount}+ contact${contactCount === 1 ? '' : 's'} imported and ready to enroll.`
              : 'Upload a CSV or Excel file — map its columns once, preview what will import, and it’s saved as a reusable mapping for next time.'
          }
          action={
            !hasContacts && canEdit && (
              <Link href="/grow/contacts/import">
                <Button>
                  <UploadSimple size={14} weight="bold" className="mr-1.5 inline" /> Import contacts
                </Button>
              </Link>
            )
          }
        />
        <ChecklistStep
          done={false}
          n={2}
          title="Create a campaign"
          detail="Name it, set a daily send target, a sending window, and a timezone."
          action={
            canEdit && (
              <Button onClick={onNewCampaign}>
                <Megaphone size={14} weight="bold" className="mr-1.5 inline" /> New campaign
              </Button>
            )
          }
        />
        <ChecklistStep
          done={false}
          n={3}
          title="Write your sequence & start"
          detail="Add sequence steps on the campaign page, then flip it from draft to running whenever it's ready."
        />
      </div>
    </Card>
  );
}

export default function GrowPage() {
  const router = useRouter();
  const role = useRole();
  const canEdit = atLeast(role, 'staff');
  const canDelete = atLeast(role, 'manager');
  const [creating, setCreating] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteNotice, setDeleteNotice] = useState<string | null>(null);

  const { data: campaigns, isLoading: campaignsLoading, error: campaignsError } =
    useApi<GrowCampaign[]>(CAMPAIGNS_KEY);
  const { data: stats, isLoading: statsLoading, error: statsError } = useApi<GrowStats>('/grow/stats');
  const { data: contacts, isLoading: contactsLoading } = useApi<GrowContactListItem[]>('/grow/contacts');

  if (campaignsLoading || statsLoading || contactsLoading) return <GrowSkeleton />;
  if (campaignsError || statsError || !stats) {
    return (
      <div className="p-4">
        <Card className="p-4">
          <p className="text-sm text-destructive">Could not load Grow.</p>
        </Card>
      </div>
    );
  }

  const hasCampaigns = !!campaigns && campaigns.length > 0;

  if (!hasCampaigns) {
    return (
      <div>
        <PageHeader eyebrow="Grow" title="Email Outreach" />
        <GetStartedPanel
          hasContacts={!!contacts && contacts.length > 0}
          contactCount={contacts?.length ?? 0}
          canEdit={canEdit}
          onNewCampaign={() => setCreating(true)}
        />
        <NewCampaignDrawer
          open={creating}
          onOpenChange={setCreating}
          onCreated={(id) => router.push(`/grow/campaigns/${id}`)}
        />
      </div>
    );
  }

  const runningCampaigns = campaigns.filter((c) => c.status === 'running');
  // Pacing target is the sum of daily_target across currently running
  // campaigns — paused/draft/stopped/done campaigns aren't contributing to
  // today's send volume, so they shouldn't inflate the "vs target" figure.
  const runningTarget = runningCampaigns.reduce((sum, c) => sum + c.daily_target, 0);

  const bouncePercent = stats.bounce_threshold > 0 ? (stats.bounce_rate / stats.bounce_threshold) * 100 : 0;
  const complaintPercent = stats.complaint_threshold > 0 ? (stats.complaint_rate / stats.complaint_threshold) * 100 : 0;
  const bounceOver = stats.bounce_rate >= stats.bounce_threshold;
  const complaintOver = stats.complaint_rate >= stats.complaint_threshold;

  return (
    <div>
      <PageHeader
        eyebrow="Grow"
        title="Email Outreach"
        subtitle="Cold outreach campaigns, contacts, and send capacity — every number here is live, nothing is projected."
        actions={
          <div className="flex items-center gap-4">
            <Link href="/grow/contacts" className="text-sm font-medium text-primary hover:underline">
              Contacts →
            </Link>
            <Link href="/grow/queue" className="text-sm font-medium text-primary hover:underline">
              Queue →
            </Link>
            <Link href="/grow/sending" className="text-sm font-medium text-primary hover:underline">
              Sending setup →
            </Link>
            {canEdit && <Button onClick={() => setCreating(true)}>New campaign</Button>}
          </div>
        }
      />

      <Stagger className="grid grid-cols-2 gap-4 lg:grid-cols-3">
        <Metric
          label="Campaigns running"
          value={String(runningCampaigns.length)}
          sub={`${campaigns.length} total`}
          icon={Megaphone}
        />
        <Metric
          label="Contacts enrolled"
          value={String(stats.contacts_enrolled)}
          sub="currently active"
          icon={UsersThree}
        />
        <Metric
          label="Sent today"
          value={runningTarget > 0 ? `${stats.sent_today} / ${runningTarget}` : String(stats.sent_today)}
          sub={runningTarget > 0 ? 'against running campaigns’ daily target' : 'no campaign running'}
          icon={PaperPlaneTilt}
        />
        <Metric label="Queue depth" value={String(stats.queue_depth)} sub="messages scheduled" icon={Tray} />
        <Metric
          label="Bounce rate"
          value={`${(stats.bounce_rate * 100).toFixed(2)}%`}
          sub={`pauses above ${(stats.bounce_threshold * 100).toFixed(1)}%`}
          icon={WarningCircle}
          tone={bounceOver ? 'destructive' : 'success'}
        />
        <Metric
          label="Complaint rate"
          value={`${(stats.complaint_rate * 100).toFixed(3)}%`}
          sub={`pauses above ${(stats.complaint_threshold * 100).toFixed(2)}%`}
          icon={Flag}
          tone={complaintOver ? 'destructive' : 'success'}
        />
      </Stagger>

      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card className="p-4">
          <Bar
            label="Bounce rate vs. pause threshold"
            valueText={`${(stats.bounce_rate * 100).toFixed(2)}%`}
            percent={bouncePercent}
            tone={bounceOver ? 'destructive' : 'success'}
            sub={`Campaigns pause automatically above ${(stats.bounce_threshold * 100).toFixed(1)}%`}
          />
        </Card>
        <Card className="p-4">
          <Bar
            label="Complaint rate vs. pause threshold"
            valueText={`${(stats.complaint_rate * 100).toFixed(3)}%`}
            percent={complaintPercent}
            tone={complaintOver ? 'destructive' : 'success'}
            sub={`Campaigns pause automatically above ${(stats.complaint_threshold * 100).toFixed(2)}%`}
          />
        </Card>
      </div>

      <Card className="mt-4 p-0">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Megaphone size={16} className="text-muted-foreground" />
          <p className="text-sm font-semibold">Campaigns</p>
        </div>
        {deleteError && <p className="border-b border-border px-4 py-2 text-sm text-destructive">{deleteError}</p>}
        {deleteNotice && <p className="border-b border-border bg-warning/5 px-4 py-2 text-sm text-warning">{deleteNotice}</p>}
        <ul className="divide-y divide-border">
          {campaigns.map((c) => {
            const StatusIcon = CAMPAIGN_STATUS_ICON[c.status];
            return (
              <li key={c.id} className="relative">
                <Link
                  href={`/grow/campaigns/${c.id}`}
                  className={`flex items-center justify-between gap-3 p-4 transition-colors hover:bg-muted/50 ${canDelete ? 'pr-12' : ''}`}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${toneSoft[CAMPAIGN_STATUS_TONE[c.status]]}`}>
                      <StatusIcon size={16} weight="fill" />
                    </div>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{c.name}</p>
                      <p className="text-xs text-muted-foreground">
                        <span className="font-mono tabular-nums" data-numeric>{c.daily_target}</span>/day ·{' '}
                        {c.timezone} · {c.window_start}–{c.window_end}
                        {c.weekdays_only && ' · weekdays only'}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    {c.past_end_date && c.status !== 'archived' && c.status !== 'done' && (
                      <span
                        title={`End date (${c.end_date}) has passed`}
                        className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground"
                      >
                        Ended
                      </span>
                    )}
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-medium uppercase tracking-wide ${toneSoft[CAMPAIGN_STATUS_TONE[c.status]]}`}
                    >
                      {c.status}
                    </span>
                    <ArrowRight size={14} className="text-muted-foreground" />
                  </div>
                </Link>
                {canDelete && (
                  <button
                    type="button"
                    aria-label={`Delete ${c.name}`}
                    onClick={() => {
                      setDeleteError(null);
                      setDeleteNotice(null);
                      confirmAndDeleteCampaign(
                        c,
                        (res) => {
                          if (res.archived) {
                            setDeleteNotice(
                              `"${c.name}" has already sent mail, so it was archived instead of deleted — its send log is kept for the record.`,
                            );
                          }
                        },
                        setDeleteError,
                      );
                    }}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-destructive"
                  >
                    <Trash size={14} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </Card>

      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card className="overflow-x-auto p-0">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <EnvelopeSimple size={16} className="text-muted-foreground" />
            <p className="text-sm font-semibold">Mailbox capacity</p>
          </div>
          {stats.mailbox_capacity.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              No active mailboxes yet —{' '}
              <Link href="/grow/sending" className="text-primary hover:underline">
                add one in Sending setup
              </Link>{' '}
              before starting a campaign.
            </p>
          ) : (
            <table className="w-full min-w-[480px] text-left text-sm">
              <thead>
                <tr className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Mailbox</th>
                  <th className="px-4 py-2 font-medium">Used today</th>
                  <th className="px-4 py-2 text-right font-medium">Remaining</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {stats.mailbox_capacity.map((m) => {
                  const used = m.cap > 0 ? Math.min(100, (m.sent_today / m.cap) * 100) : 0;
                  return (
                    <tr key={m.id}>
                      <td className="px-4 py-3">
                        <p className="truncate font-medium">{m.address}</p>
                        <p className="text-xs text-muted-foreground">{m.status}</p>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                            <div
                              className={`h-full rounded-full ${used >= 100 ? 'bg-destructive' : 'bg-primary'}`}
                              style={{ width: `${used}%` }}
                            />
                          </div>
                          <span className="font-mono text-xs tabular-nums text-muted-foreground" data-numeric>
                            {m.sent_today}/{m.cap}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums" data-numeric>{m.remaining}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>

        <Card className="overflow-x-auto p-0">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <Globe size={16} className="text-muted-foreground" />
            <p className="text-sm font-semibold">Domain capacity</p>
          </div>
          {stats.domain_capacity.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No domain policies configured.</p>
          ) : (
            <table className="w-full min-w-[440px] text-left text-sm">
              <thead>
                <tr className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Domain</th>
                  <th className="px-4 py-2 font-medium">Used today</th>
                  <th className="px-4 py-2 text-right font-medium">Remaining</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {stats.domain_capacity.map((d) => {
                  const used = d.daily_cap > 0 ? Math.min(100, (d.sent_today / d.daily_cap) * 100) : 0;
                  return (
                    <tr key={d.domain}>
                      <td className="px-4 py-3">
                        {d.domain === '*' ? <span className="text-muted-foreground">* (default)</span> : d.domain}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
                            <div
                              className={`h-full rounded-full ${used >= 100 ? 'bg-destructive' : 'bg-accent'}`}
                              style={{ width: `${used}%` }}
                            />
                          </div>
                          <span className="font-mono text-xs tabular-nums text-muted-foreground" data-numeric>
                            {d.sent_today}/{d.daily_cap}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums" data-numeric>{d.remaining}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <NewCampaignDrawer
        open={creating}
        onOpenChange={setCreating}
        onCreated={(id) => router.push(`/grow/campaigns/${id}`)}
      />
    </div>
  );
}
