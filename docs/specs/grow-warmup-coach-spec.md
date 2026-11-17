# Venturelyx — Grow Scheduler Fixes + Warmup Health Gate

This file didn't exist before this change — section 3 was referenced ahead
of being written. Sections 1 and 2 are two confirmed-live bugs in the
existing allocator and domain-cap enforcement (`api/src/lib/growScheduler.ts`),
found investigating a real stalled mailbox on a live org. Section 3 is the
new warmup health gate, built from the inline spec given alongside the fix
request (reproduced here as the actual spec of record, since no prior
document existed).

ADDITIVE. The circuit breaker (campaign-level, bounce/complaint over a
rolling window), hard-bounce auto-remove, suppression, and per-mailbox/
per-domain enforcement at claim time are all unchanged. Don't touch
`/opt/outreach`.

## 1. Mailbox starvation — `allocateMailboxCapacity()` round-robins the pool now, not sequentially

**The bug**: `allocateMailboxCapacity()` walked mailboxes in a fixed order
(sorted by `mailbox.id`, a UUID — no business meaning) and filled each one
to its OWN full remaining capacity, splitting fairly across competing
campaigns, before moving to the next mailbox. Whenever total daily demand
was under the pool's total capacity (the common case, not the exception),
the first few mailboxes in that order absorbed all of it and every later
mailbox got nothing — however much capacity it had free.

Confirmed live: five 50/day mailboxes, two campaigns, ~167 total attempts
on 11/13. Outreach/info/alan (1st–3rd in UUID order) got 51/52/50; schools
(4th) got a partial 19; team (5th, last in that sort) got **0** — not
because anything was wrong with team@ specifically, but because it
happened to sort last.

**The fix**: a double round-robin, one slot at a time — which mailbox gets
the next slot, and which campaign that slot goes to — both rotating, both
dropping out once exhausted (capacity for a mailbox, demand for a
campaign) without resetting the other's position. Verified against the
11/13 numbers: the same 167 total now lands 34/34/33/33/33 across all
five mailboxes (`api/src/lib/growScheduler.ts`'s own doc comment on
`allocateMailboxCapacity()` has the full before/after). Still bounded by
each mailbox's real `remaining` capacity and each campaign's real demand —
nothing here changes the hard ceiling, only how fairly it's divided before
`commitCampaignPlan()`'s existing per-contact picking and `claimDue()`'s
send-time backstop (both untouched).

## 2. Domain cap — the `'*'` fallback is now a real per-recipient-domain daily ceiling

**The bug**: the only `grow_domain_policies` row on a real org was
`domain = '*', daily_cap = 125`. Both the scheduler's `domainCapacity()`
and the `/grow/stats` dashboard query joined `grow_messages.recipient_domain`
against `grow_domain_policies.domain` by literal string equality — which
can never match the literal string `'*'` against a real domain like
`gmail.com`. So the fallback row's own "sent today" always read `0`, no
matter how much traffic actually fell through to it (confirmed: 167 real
sends that day, dashboard showed `0/125`). Enforcement was just as broken
underneath the display bug: the fallback branch didn't even attempt to
subtract a sent-today count — it compared each domain's usage only within
one planning tick's in-memory counter, which resets every tick and every
campaign, so there was no actual cumulative daily ceiling for any
fallback-governed domain (today, every domain this org sends to).

**The fix** (`growScheduler.ts`'s `domainCapacity()`, now returning
`{ explicitCaps, fallbackCap, committedToday }`): `committedToday` is a
live, dynamic per-`recipient_domain` count (`sent`/`sending`/`queued`,
today, across every campaign) — not keyed off `grow_domain_policies` rows
at all, so it works identically whether a domain has an explicit override
or falls through to `'*'`. `commitCampaignPlan()` now checks
`committedToday(domain) + thisTickUsed(domain) >= cap` before picking a
candidate — a real cumulative ceiling, not a per-tick illusion of one. The
`/grow/stats` dashboard query got the identical fix: explicit policy rows
are always shown (even at 0 used, so a configured-but-idle cap stays
visible), and the top actual recipient domains by today's volume are
shown against the fallback cap for everything else — real usage, not an
unmatchable `'*'` row.

## 3. Warmup health gate

The time-based ramp (`grow_mailbox_daily_cap()`, unchanged in shape) only
ever goes up on schedule — it has no idea whether a mailbox is actually
landing cleanly. This adds the other half.

**Mechanics** (`api/src/lib/growMailboxHealth.ts`):
- Per mailbox, rolling **7-day** bounce/complaint rate — same definitions
  the circuit breaker already uses (`attempts = sent + bounced`, so a
  synchronous hard rejection still counts as an attempt), same thresholds
  (`BOUNCE_PAUSE_RATE` 3%, `COMPLAINT_PAUSE_RATE` 0.3%), same `MIN_SAMPLE`
  (50 attempts) before it's allowed to act at all.
- **Over threshold**: hold the mailbox's cap **1 step (5/day) down**,
  immediately, no delay. **Over 2x threshold**: 2 steps down. Protection
  is never deferred to the next evaluation.
- **Recovery is asymmetric**: at most **1 step back per 7 CONSECUTIVE
  healthy days**, tracked via `health_healthy_since` (reset to `NULL` the
  moment it's unhealthy again). A mailbox can't snap back to full capacity
  just because today happened to look fine — it has to hold healthy for a
  full week, every time, for every step back up to `steady_cap`.
- Evaluated hourly (`GROW_HEALTH_GATE_INTERVAL_MS`, default 1 hour) by a
  new `grow-worker` timer, one more independent loop alongside the
  existing planner/sender/poller — not a new container, not a new cron
  job. Runs per org, over every `active`/`warming` mailbox.
- **The cap function stays cheap**: `grow_mailbox_daily_cap(m, on_day)`
  (038_grow_mailbox_health_gate.sql) reads `m.health_steps_down` off the
  row it's already handed — the same free read it already does for
  `m.steady_cap`/`m.warmup_started_on`. No subquery, no join, no live
  bounce computation in the hot path (`mailboxCapacity()`/`claimDue()`
  both call this per mailbox, every planning tick and every send tick).
  All the actual bounce/complaint arithmetic lives in the hourly
  evaluator, which *writes* the result; the cap function only ever reads it.
- **Stored on the mailbox row**: `health_steps_down`, `health_reason`,
  `health_healthy_since`, `health_evaluated_at` — new columns, additive.
- **Shown on the Mailbox capacity card** (`/grow` dashboard): a "held N
  step(s)" badge plus the stored reason text, next to the existing
  used/cap bar.
- **Audited on every change** — `grow.mailbox.health_gate` in `audit_log`,
  written only when `health_steps_down` actually changes (not every
  hourly evaluation that finds nothing new), with the before/after step
  count and the reason.

## 4. Timezone question — answered, no bug found

Investigated whether the cap check and the dashboard draw "today" in
different timezones (the apparent trigger: outreach@/info@ appeared to
have sent 51/52 against a cap of 50 on 11/13). They don't — both are
consistently NY-zoned:

- `mailboxCapacity()`'s `committed_today` and `claimDue()`'s send-time
  backstop: `(... AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date`,
  `$1` = the org's own `organizations.timezone` (`America/New_York` here).
- `/grow/stats`'s dashboard query: identical `AT TIME ZONE $1` pattern,
  same `tz` value, read from the same `organizations.timezone` column
  (`routes/grow.ts`'s own comment on the route says so explicitly).

The apparent 51/52-against-50 was a diagnostic artifact in the **prior
investigation's own ad hoc query**, not a product bug: it counted every
message *scheduled* that NY-day regardless of final status, so 50 real
sends + 2 later hard bounces on info@ read as "52." Re-run with the exact
query the dashboard itself uses (`status = 'sent'` only, NY-zoned): alan
48, info 50, outreach 49, schools 19, team 0 — info@ sits exactly at its
50 cap, nothing exceeds it. No timezone inconsistency exists between any
two code paths checked.

## Definition of done

- 11/13's 167 attempts replayed through the new `allocateMailboxCapacity()`
  land ~33–34 per mailbox, all five included. ✅ (verified directly against
  the real historical numbers)
- The `'*'` fallback cap now reflects real per-domain usage, both in
  enforcement (`commitCampaignPlan()`) and on the dashboard. ✅
- Warmup health gate: immediate 1-/2-step protective reduction, 1-step
  weekly recovery, evaluated hourly, stored on the mailbox row, shown on
  the capacity card, audited on every change, and `grow_mailbox_daily_cap()`
  remains a cheap, zero-join function. ✅
- Existing circuit breaker, hard-bounce auto-remove, suppression, and
  claim-time backstops are unchanged. ✅
- `--competitors-due` added to the `asaranga` crontab (no sudo crontab
  access on this host for non-interactive use), same pattern as the
  existing AI-visibility-check line.

Deployed after the 17:00 New York send window closed, per request.
