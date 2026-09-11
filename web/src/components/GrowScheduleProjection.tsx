'use client';

import { CalendarCheck, WarningCircle } from '@phosphor-icons/react';
import { useApi } from '@/lib/useApi';
import type {
  GrowMailboxRamp, GrowScheduleBinding, GrowScheduleDay, GrowScheduleProjectionResponse,
} from '@/lib/types';
import { Card } from '@/components/ui/Card';
import { Bar } from '@/components/ui/Bar';
import { Skeleton } from '@/components/ui/Skeleton';
import { toneSoft } from '@/components/ui/tone';

const BINDING_LABEL: Record<GrowScheduleBinding, string> = {
  mailbox_capacity: 'Mailbox capacity',
  domain_caps: 'Domain caps',
  daily_target: 'Daily target',
};

const BINDING_CLASS: Record<GrowScheduleBinding, string> = {
  mailbox_capacity: 'bg-primary',
  domain_caps: 'bg-warning',
  daily_target: 'bg-muted-foreground',
};

const BLOCKED_LABEL: Record<NonNullable<GrowScheduleProjectionResponse['projection']['blocked_reason']>, string> = {
  no_mailbox_capacity: 'no mailbox has any sending capacity',
  no_domain_capacity: 'every remaining recipient domain is capped at zero',
};

function groupRuns(days: GrowScheduleDay[]): Array<{ binding: GrowScheduleBinding; count: number; from: string; to: string }> {
  const runs: Array<{ binding: GrowScheduleBinding; count: number; from: string; to: string }> = [];
  for (const day of days) {
    const last = runs[runs.length - 1];
    if (last && last.binding === day.binding) {
      last.count += 1;
      last.to = day.date;
    } else {
      runs.push({ binding: day.binding, count: 1, from: day.date, to: day.date });
    }
  }
  return runs;
}

function BindingTimeline({ days }: { days: GrowScheduleDay[] }) {
  const runs = groupRuns(days);
  const total = days.length || 1;
  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
        {runs.map((run, i) => (
          <div
            key={i}
            title={`${BINDING_LABEL[run.binding]}: ${run.from} to ${run.to} (${run.count} day${run.count === 1 ? '' : 's'})`}
            className={`${BINDING_CLASS[run.binding]} ${i > 0 ? 'border-l border-surface' : ''}`}
            style={{ width: `${(run.count / total) * 100}%` }}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
        {(Object.keys(BINDING_LABEL) as GrowScheduleBinding[]).map((b) => (
          <span key={b} className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${BINDING_CLASS[b]}`} />
            {BINDING_LABEL[b]}
          </span>
        ))}
      </div>
    </div>
  );
}

function WarmupRampChart({ ramp }: { ramp: GrowMailboxRamp }) {
  if (ramp.points.length === 0) {
    return <p className="text-xs text-muted-foreground">Warmup hasn't started.</p>;
  }
  const w = 160;
  const h = 40;
  const maxCap = ramp.steady_cap;
  const xAt = (i: number) => (ramp.points.length <= 1 ? 0 : (i / (ramp.points.length - 1)) * w);
  const yAt = (cap: number) => h - (cap / maxCap) * h;

  // Step function: hold each week's cap flat until the next jump.
  const stepPoints: string[] = [];
  ramp.points.forEach((p, i) => {
    stepPoints.push(`${xAt(i)},${yAt(p.cap)}`);
    if (i < ramp.points.length - 1) stepPoints.push(`${xAt(i + 1)},${yAt(p.cap)}`);
  });

  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} className="h-10 w-full" preserveAspectRatio="none">
        <polyline
          points={stepPoints.join(' ')}
          fill="none"
          className="stroke-primary"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <p className="mt-1 text-xs text-muted-foreground">
        <span className="font-mono tabular-nums" data-numeric>{ramp.current_cap}</span>/day now → reaches steady{' '}
        <span className="font-mono tabular-nums" data-numeric>{ramp.steady_cap}</span>/day on{' '}
        {ramp.steady_cap_date}
      </p>
    </div>
  );
}

export function GrowScheduleProjection({ campaignId, pauseReason }: { campaignId: string; pauseReason: string | null }) {
  const { data, isLoading, error } = useApi<GrowScheduleProjectionResponse>(
    `/grow/campaigns/${campaignId}/schedule-projection`,
  );

  if (isLoading || !data) {
    return (
      <div className="flex flex-col gap-4">
        <Skeleton className="h-24 rounded-xl bg-muted" />
        <Skeleton className="h-32 rounded-xl bg-muted" />
      </div>
    );
  }
  if (error) {
    return (
      <Card className="p-4">
        <p className="text-sm text-destructive">Could not load the schedule projection.</p>
      </Card>
    );
  }

  const { circuit_breaker: cb, projection, mailbox_ramps: ramps } = data;
  const bouncePercent = cb.bounce_threshold > 0 ? (cb.bounce_rate / cb.bounce_threshold) * 100 : 0;
  const complaintPercent = cb.complaint_threshold > 0 ? (cb.complaint_rate / cb.complaint_threshold) * 100 : 0;
  const bounceOver = cb.bounce_rate >= cb.bounce_threshold;
  const complaintOver = cb.complaint_rate >= cb.complaint_threshold;

  return (
    <div className="flex flex-col gap-4">
      {pauseReason && (
        <Card className="flex items-start gap-3 border-destructive/40 bg-destructive/5 p-4">
          <WarningCircle size={20} weight="fill" className="mt-0.5 shrink-0 text-destructive" />
          <div>
            <p className="text-sm font-medium text-destructive">This campaign is paused</p>
            <p className="mt-1 text-sm text-muted-foreground">{pauseReason}</p>
          </div>
        </Card>
      )}

      <Card className="p-4">
        <p className="text-sm font-semibold">Circuit breaker</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {cb.sample_size_met
            ? `Based on ${cb.sent} sends.`
            : `Only ${cb.sent} sent so far — rates below ${cb.min_sample} sends aren't statistically meaningful yet.`}
        </p>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Bar
            label="Bounce rate vs. pause threshold"
            valueText={`${(cb.bounce_rate * 100).toFixed(2)}%`}
            percent={bouncePercent}
            tone={bounceOver ? 'destructive' : 'success'}
            sub={`Pauses automatically above ${(cb.bounce_threshold * 100).toFixed(1)}%`}
          />
          <Bar
            label="Complaint rate vs. pause threshold"
            valueText={`${(cb.complaint_rate * 100).toFixed(3)}%`}
            percent={complaintPercent}
            tone={complaintOver ? 'destructive' : 'success'}
            sub={`Pauses automatically above ${(cb.complaint_threshold * 100).toFixed(2)}%`}
          />
        </div>
      </Card>

      <Card className="p-4">
        <div className="flex items-center gap-2">
          <CalendarCheck size={16} className="text-muted-foreground" />
          <p className="text-sm font-semibold">Projected schedule</p>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          A projection from current enrollments, mailbox warmup, and domain caps — not a stored plan. It recalculates
          every time this page loads, and doesn't account for rank-2 contacts still gated on a rank-1 reply.
        </p>

        {projection.blocked_reason ? (
          <div className="mt-3 flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <WarningCircle size={16} weight="fill" className="mt-0.5 shrink-0" />
            <p>
              Can&apos;t project a completion date — {BLOCKED_LABEL[projection.blocked_reason]}, so{' '}
              <span className="font-mono tabular-nums" data-numeric>{projection.remaining_sends}</span> remaining
              send{projection.remaining_sends === 1 ? '' : 's'} can&apos;t go out.
            </p>
          </div>
        ) : projection.remaining_sends === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">Nothing left to send for currently active enrollments.</p>
        ) : (
          <>
            <div className="mt-3 flex flex-wrap items-baseline gap-x-6 gap-y-1">
              <div>
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Projected completion</p>
                <p className="text-lg font-semibold">
                  {projection.completion_date ?? (projection.horizon_exceeded ? 'Beyond 180 days' : '—')}
                </p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Remaining sends</p>
                <p className="font-mono text-lg font-semibold tabular-nums" data-numeric>{projection.remaining_sends}</p>
              </div>
            </div>
            {projection.horizon_exceeded && (
              <p className={`mt-2 rounded-lg px-2.5 py-1.5 text-xs ${toneSoft.warning}`}>
                Won&apos;t finish within the next 180 sending days at current capacity and caps.
              </p>
            )}
            <div className="mt-4">
              <BindingTimeline days={projection.days} />
            </div>
          </>
        )}
      </Card>

      {ramps.length > 0 && (
        <Card className="p-4">
          <p className="text-sm font-semibold">Mailbox warmup ramps</p>
          <div className="mt-3 grid gap-4 sm:grid-cols-2">
            {ramps.map((ramp) => (
              <div key={ramp.id} className="rounded-lg border border-border p-3">
                <p className="truncate text-sm font-medium">{ramp.address}</p>
                <WarmupRampChart ramp={ramp} />
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
