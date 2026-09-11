'use client';

import { useState } from 'react';
import { mutate } from 'swr';
import { Clock, WarningCircle } from '@phosphor-icons/react';
import { apiFetch, ApiError } from '@/lib/api';
import type { GrowCampaign } from '@/lib/types';
import {
  isValidTimezone, outsideBusinessHours, timeInTimezoneToUtcLabel, windowMinutes,
} from '@/lib/growTimezone';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';

const CAMPAIGNS_KEY = '/grow/campaigns';

const inputCls =
  'min-h-[42px] w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary focus:ring-2 focus:ring-primary/20';
const labelCls = 'flex flex-col gap-1 text-sm text-muted-foreground';

interface Draft {
  timezone: string;
  window_start: string;
  window_end: string;
  weekdays_only: boolean;
  daily_target: number;
}

export function GrowSendWindowCard({ campaign, canEdit }: { campaign: GrowCampaign; canEdit: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Draft>({
    timezone: campaign.timezone,
    window_start: campaign.window_start.slice(0, 5),
    window_end: campaign.window_end.slice(0, 5),
    weekdays_only: campaign.weekdays_only,
    daily_target: campaign.daily_target,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function startEditing() {
    setDraft({
      timezone: campaign.timezone,
      window_start: campaign.window_start.slice(0, 5),
      window_end: campaign.window_end.slice(0, 5),
      weekdays_only: campaign.weekdays_only,
      daily_target: campaign.daily_target,
    });
    setError(null);
    setEditing(true);
  }

  async function onSave() {
    if (!isValidTimezone(draft.timezone)) {
      setError(`"${draft.timezone}" isn't a recognized timezone — use an IANA name like America/New_York`);
      return;
    }
    if (windowMinutes(draft.window_start, draft.window_end) <= 0) {
      setError('Window end must be after window start');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/grow/campaigns/${campaign.id}`, { method: 'PATCH', body: JSON.stringify(draft) });
      await mutate(CAMPAIGNS_KEY);
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the send window.');
    } finally {
      setSaving(false);
    }
  }

  const view = editing ? draft : {
    timezone: campaign.timezone,
    window_start: campaign.window_start.slice(0, 5),
    window_end: campaign.window_end.slice(0, 5),
    weekdays_only: campaign.weekdays_only,
    daily_target: campaign.daily_target,
  };

  const minutes = windowMinutes(view.window_start, view.window_end);
  const tooShort = minutes > 0 && minutes < 120;
  const offHours = outsideBusinessHours(view.window_start, view.window_end);
  const utcStart = timeInTimezoneToUtcLabel(view.window_start, view.timezone);
  const utcEnd = timeInTimezoneToUtcLabel(view.window_end, view.timezone);

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Clock size={16} className="text-muted-foreground" />
          <p className="text-sm font-semibold">Send window</p>
        </div>
        {canEdit && !editing && (
          <Button variant="ghost" className="!min-h-0 px-2.5 py-1 text-xs" onClick={startEditing}>Edit</Button>
        )}
      </div>

      {editing ? (
        <div className="mt-3 flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={labelCls}>
              Window start
              <input
                type="time"
                value={draft.window_start}
                onChange={(e) => setDraft({ ...draft, window_start: e.target.value })}
                className={inputCls}
              />
            </label>
            <label className={labelCls}>
              Window end
              <input
                type="time"
                value={draft.window_end}
                onChange={(e) => setDraft({ ...draft, window_end: e.target.value })}
                className={inputCls}
              />
            </label>
            <label className={labelCls}>
              Timezone
              <input
                value={draft.timezone}
                onChange={(e) => setDraft({ ...draft, timezone: e.target.value })}
                placeholder="America/New_York"
                className={inputCls}
              />
              <span className="text-xs text-muted-foreground/70">An IANA name — the campaign's own wall-clock time, not the server's.</span>
            </label>
            <label className={labelCls}>
              Daily target
              <input
                type="number"
                min={1}
                value={draft.daily_target}
                onChange={(e) => setDraft({ ...draft, daily_target: Number(e.target.value) })}
                className={inputCls}
              />
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={draft.weekdays_only}
              onChange={(e) => setDraft({ ...draft, weekdays_only: e.target.checked })}
              className="h-4 w-4 rounded border-border"
            />
            Weekdays only
          </label>

          {(tooShort || offHours) && (
            <div className="flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
              <WarningCircle size={14} weight="fill" className="mt-0.5 shrink-0" />
              <div>
                {tooShort && <p>This window is under two hours — sends will be tightly bunched.</p>}
                {offHours && <p>This window falls outside normal business hours (08:00–18:00) in {draft.timezone}.</p>}
              </div>
            </div>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex items-center gap-2">
            <Button onClick={onSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
            <Button variant="ghost" onClick={() => setEditing(false)} disabled={saving}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          <p className="text-sm">
            <span className="font-mono tabular-nums" data-numeric>{view.window_start}</span>
            {'–'}
            <span className="font-mono tabular-nums" data-numeric>{view.window_end}</span>{' '}
            <span className="text-muted-foreground">{view.timezone}</span>
          </p>
          {utcStart && utcEnd && (
            <p className="text-xs text-muted-foreground">
              Server runs UTC — that's{' '}
              <span className="font-mono tabular-nums" data-numeric>{utcStart}</span>
              {'–'}
              <span className="font-mono tabular-nums" data-numeric>{utcEnd}</span> UTC today.
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {view.weekdays_only ? 'Weekdays only' : 'Every day'} · target{' '}
            <span className="font-mono tabular-nums" data-numeric>{view.daily_target}</span>/day
          </p>
          {(tooShort || offHours) && (
            <div className="mt-1 flex items-start gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
              <WarningCircle size={14} weight="fill" className="mt-0.5 shrink-0" />
              <div>
                {tooShort && <p>This window is under two hours — sends will be tightly bunched.</p>}
                {offHours && <p>This window falls outside normal business hours (08:00–18:00) in {view.timezone}.</p>}
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
