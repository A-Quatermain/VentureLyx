# Venturelyx — Grow Recoverable-Bounce Bucket, Resend, Fallback Channel

Gives an owner somewhere to see and act on bounces that aren't proof of a
dead address — today they're correctly left unsuppressed but invisible,
buried in the same "Bounced" filter as permanently-dead ones.

ADDITIVE. Hard-bounce auto-remove, suppression, per-mailbox cap
enforcement, the fair-share allocator, and the campaign circuit breaker are
all unchanged — this only adds a bucket, a resend path, and a fallback-send
path, each wired to call the existing enforcement, never to duplicate or
bypass it. Don't touch `/opt/outreach`.

## Correction to this spec's own framing (confirmed against real code)

The brief states the classifier already types bounces as "hard /
dead_domain / soft / block / auth / unknown" — six categories. That's not
what exists. `lib/growBounceClassify.ts`'s `BounceType` is **four** values:
`hard | soft | block | unknown` (`db/migrations/029_grow_bounce_detail.sql`'s
`app.grow_bounce_type` enum, same four). There is no `dead_domain` or `auth`
*type*. What the brief calls "auth" is a **category** string
(`'Auth failure'`) under `type = 'block'` (SPF/DKIM/DMARC rejection, code
5.7.26 or an spf/dkim/dmarc keyword match) — `classifyBounce()` already
returns `{ code, type, category, explanation, action }`, and `category` is
exactly this finer label, recomputed on every read rather than stored (so a
later fix to the mapping table improves old bounces too — see that file's
own header).

This doesn't change the actual intent or the numbers: "dead domain" is just
what `type = 'hard'` already means (`5.1.1`/`5.1.2`/`5.2.1`/malformed —
every `EXPLICIT_CODES` hard entry *is* "this address doesn't exist"), and
"auth" is already inside `block`. The real 30-day schools@ split the user
quoted — 8 hard, 5 block, 2 unknown — maps onto the real model with zero
remainder:

- **Permanent** = `bounce_type = 'hard'` only.
- **Recoverable** = `bounce_type IN ('block', 'soft', 'unknown')`.

`soft` is included because the async DSN-poller path (`growWorker.ts`'s
`handleClassifiedMessage`) sets `status = 'bounced'` for a classified-soft
DSN exactly like block/unknown — it does NOT auto-remove or suppress,
exactly matching "recoverable." (The synchronous SMTP-rejection path only
reaches `status = 'bounced'` on an immediate 5xx; a 4xx there retries via
backoff and becomes `'failed'` if attempts run out, never `'bounced'` — so
a `soft`-typed row in the Bounced view, when one exists, always came from a
real bounce-mailbox DSN, not a live rejection.)

## Confirmed names

- `grow_messages`: `status` (`'bounced'` is the bucket's source), `bounce_type`,
  `bounce_code`, `bounce_reason_raw`, `bounced_at`, `attempts`, `mailbox_id`,
  `campaign_id`, `contact_id`, `recipient_domain`, `subject`, `step_no`.
- `grow_contacts`: `email`, `contact_name`, `entity_name` (the organization).
- `grow_suppressions` (org_id, email) UNIQUE — the org-wide block every send
  path already checks; untouched, still wins everywhere.
- `grow_enrollments.state` — `'bounced'` is already set by both capture
  paths for a non-hard bounce (unsuppressed, unremoved — this spec keeps
  that exactly as-is).
- `lib/growScheduler.ts`: `circuitBreaker(q, campaign)`, `BOUNCE_PAUSE_RATE`,
  `COMPLAINT_PAUSE_RATE`, `MIN_SAMPLE`, `claimDue()` (the per-mailbox daily-cap
  enforcement every queued message already goes through — see "Resend
  mechanics" below for why this is the thing that makes "no bypass path"
  almost free).
- `lib/growSendingDomain.ts`: `verifyDomain(domain, provider, dmarcSettings?)`
  → `{ spf, dkim, dmarc, subdomainWarning }`, each a live DNS check — the
  resend auth-guard calls this directly, not the cached `spf_ok`/`dkim_ok`/
  `dmarc_ok` columns, so a domain that broke *after* its last manual Verify
  click still blocks a resend.
- `lib/growMailboxTest.ts`: `sendRenderedTestEmail(mailbox, password, to,
  subject, text)` — the one-off SMTP primitive the fallback-send batch loop
  reuses (same mechanism the existing "send test email" buttons use).
- `lib/ai.ts` / `routes/grow.ts`: the `'sequence_writing'` AI feature
  (`resolveAIContext`, `streamAI`/accumulate, `logAiUsage`, `CAP_MESSAGE`) —
  this IS the already-built Outreach Writer; the fallback-send draft reuses
  this feature key rather than registering a new one.
- `lib/auth.ts`: `audit(q, {...})` — every resend and fallback send logs
  through this, same as every other mutating Grow route.

## Schema — migration `035_grow_recoverable_bounce.sql` (Part B)

```sql
-- Dedupe + the 2-per-contact-per-campaign cap. One row per ACTUAL resend
-- (a refused attempt never gets a row here — see "audit" below for where
-- a refusal is recorded instead). UNIQUE(original_message_id) is the
-- dedupe rule itself: a second resend of the same bounce is a constraint
-- violation, not application logic that could be gotten wrong.
CREATE TABLE grow_message_resends (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  original_message_id uuid NOT NULL REFERENCES grow_messages(id) ON DELETE CASCADE,
  resend_message_id    uuid NOT NULL REFERENCES grow_messages(id) ON DELETE CASCADE,
  contact_id           uuid NOT NULL REFERENCES grow_contacts(id) ON DELETE CASCADE,
  campaign_id          uuid NOT NULL REFERENCES grow_campaigns(id) ON DELETE CASCADE,
  requested_by         uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (original_message_id)
);
CREATE INDEX ON grow_message_resends (contact_id, campaign_id);

CALL app.apply_tenant_rls();
```

This migration also created `grow_fallback_sends`/`grow_fallback_send_recipients`
for a first-cut, human-triggered Part C — both dropped in migration `036`
(see below) once Part C was revised to draft automatically. Confirmed zero
rows in either before dropping.

## Schema — migration `036_grow_alternate_channel.sql` (Part C, revised)

```sql
DROP TABLE grow_fallback_send_recipients;
DROP TABLE grow_fallback_sends;

-- One row per org. trigger_bounce_types' CHECK is the hard guarantee that
-- 'unknown' can never be configured as a trigger, at the database level,
-- not just an unticked default in the UI.
CREATE TABLE grow_alternate_channel_settings (
  org_id               uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  enabled              boolean NOT NULL DEFAULT false,
  sender_mailbox_id    uuid REFERENCES grow_mailboxes(id) ON DELETE SET NULL,
  sender_adhoc_address text,
  trigger_bounce_types text[] NOT NULL DEFAULT ARRAY['block']::text[]
                        CHECK (trigger_bounce_types <@ ARRAY['block', 'soft']::text[]),
  business_context     text,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid REFERENCES users(id) ON DELETE SET NULL
);

-- One row per (contact, campaign) — UNIQUE on that pair IS "one
-- alternate-channel attempt per contact per campaign," enforced as a
-- constraint. status starts 'draft' (written automatically, zero human
-- steps) and only ever moves on an explicit Send click.
CREATE TABLE grow_fallback_drafts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  original_message_id uuid NOT NULL REFERENCES grow_messages(id) ON DELETE CASCADE,
  contact_id           uuid NOT NULL REFERENCES grow_contacts(id) ON DELETE CASCADE,
  campaign_id          uuid NOT NULL REFERENCES grow_campaigns(id) ON DELETE CASCADE,
  sender_mailbox_id    uuid REFERENCES grow_mailboxes(id) ON DELETE SET NULL,
  sender_address       text NOT NULL,
  subject              text NOT NULL,
  intro_body           text NOT NULL,
  status               text NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'sent', 'failed', 'skipped_adhoc', 'discarded')),
  generated_at         timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz,
  sent_by              uuid REFERENCES users(id) ON DELETE SET NULL,
  unsubscribe_token    text NOT NULL DEFAULT encode(gen_random_bytes(18), 'hex'),
  error                text,
  UNIQUE (contact_id, campaign_id)
);

CALL app.apply_tenant_rls();
```

## Resend mechanics (Part B) — why "no bypass path" is nearly automatic

`claimDue()` (the worker's own claim query) already enforces the
per-mailbox daily cap for **any** `status = 'queued'` row on that mailbox —
it doesn't know or care whether the row came from the planner or was
inserted directly. So a resend is implemented as: insert one new
`grow_messages` row (same `mailbox_id`, `campaign_id`, `contact_id`,
`step_no`, `recipient_domain`, and the **original** `subject`/`body` —
resending what actually bounced, not a freshly re-rendered template that
may have since changed), `status = 'queued'`, `scheduled_at = now()`. From
that point on it is indistinguishable from any other queued send, so the
cap (and, once the mailbox warmup-health gate ships, that too) applies with
zero special-casing.

The circuit breaker is the one thing that check doesn't cover — it only
runs at planning time, never at claim time. The resend route calls
`circuitBreaker(q, campaign)` itself before inserting and refuses if it
returns a halt reason, so a tripped breaker blocks a resend exactly like it
blocks a new send.

Guard order per selected message (all must pass):
1. `bounce_type !== 'hard'` (Permanent is never resendable — a defensive
   re-check, the bucket list only offers Recoverable rows to begin with).
2. Contact's email not in `grow_suppressions` for this org.
3. `circuitBreaker(q, campaign)` returns `null` (not tripped).
4. `verifyDomain()` on the sending domain: `spf.ok && dkim.ok && dmarc.ok`.
5. No existing `grow_message_resends` row for this `original_message_id`
   (dedupe).
6. Fewer than 2 existing `grow_message_resends` rows for this
   `(contact_id, campaign_id)` pair (the cap — once hit, the UI's own label
   becomes "needs manual," not resendable).

A refusal is reported per-row (bulk "select many → Resend" returns one
result per id, not a single all-or-nothing outcome) and audited with its
reason; it never creates a `grow_message_resends` row.

## Alternate-channel mechanics (Part C) — revised: automatic up to the send

First cut of this spec had a human select contacts and ask for a draft.
The brief was revised to make drafting itself automatic — the moment a
recoverable bounce is classified, if the org opted in — with the send as
the one remaining, deliberately manual step. That's a real shape change,
not just wording: a draft now has to exist on its own before any human has
acted, so `grow_fallback_sends`/`grow_fallback_send_recipients`
(this file's own first version) were dropped and replaced wholesale by
`grow_fallback_drafts` (`036_grow_alternate_channel.sql`) — confirmed zero
rows in production before dropping them, so nothing was lost.

**Config** (`grow_alternate_channel_settings`, one row per org,
`GET`/`PATCH /grow/alternate-channel/settings`, Settings page): enabled
toggle, alternate sender (a `grow_mailboxes` row or a typed address),
`trigger_bounce_types` — CHECK-constrained at the **database** level to
`{'block','soft'}` only, so `'unknown'` can never be configured as a
trigger even by a direct SQL edit, not just an unticked UI default — and a
free-text business-context line the AI draft writes on behalf of.

**Automatic, the instant `growWorker.ts` classifies a recoverable bounce**
(`lib/growFallbackDraft.ts`'s `maybeAutoDraftFallback()`, called from both
capture points — the synchronous SMTP-rejection path and the async
DSN-poller path, right where each already decides a bounce is `block` or
`soft`): if the org has this enabled and chose that bounce type as a
trigger, and this `(contact_id, campaign_id)` pair has no draft yet, it
calls the `sequence_writing` feature (the same already-built Outreach
Writer, same `resolveAIContext`/`streamAI`/`logAiUsage`/spend-cap pattern
every other AI draft in Grow uses) for one short introductory passage, and
writes a `grow_fallback_drafts` row, `status = 'draft'`, sender pre-filled
from settings. Zero human steps so far. Wrapped in its own try/catch —
an AI failure here must never break bounce processing itself; the bounce
stays correctly classified and visible in the Recoverable bucket either
way, just without a ready draft. `UNIQUE(contact_id, campaign_id)` is "ONE
alternate-channel attempt per contact per campaign" as a real constraint,
not application logic that could double-fire.

**Manual, required** (`GET /grow/fallback-drafts` lists every `status =
'draft'` row; `POST /grow/fallback-drafts/send` is the one human click):
review, edit subject/intro freely, select up to 200 (the UI defaults the
"select some" shortcut to 50), click Send. Per draft:
- Defensive re-check that the original bounce was never `hard` (can't
  actually happen — only `block`/`soft` ever reach
  `maybeAutoDraftFallback` — but checked anyway, the same discipline every
  other guard chain in this spec uses).
- Org-wide suppression re-checked at send time, not just draft time.
- **Configured-mailbox sender** → real SMTP, one `sendRenderedTestEmail()`
  call (same primitive the existing test-send buttons use), draft marked
  `sent`/`failed`.
- **Ad-hoc sender** → nothing is sent by Venturelyx — Grow has no mechanism
  anywhere for collecting one-time credentials for an arbitrary address,
  and building one would be a new secret-handling surface the brief never
  asked for. The composed, human-edited text is shown to copy and send
  yourself; the draft is marked `skipped_adhoc`, never silently dropped.
- Unsubscribe: `grow_fallback_drafts.unsubscribe_token` (same
  `encode(gen_random_bytes(18),'hex')` convention as `grow_messages`),
  footer built the same way every other send's is. `lib/growUnsubscribe.ts`
  now checks this table as a second source after `grow_messages`, reusing
  the one existing `/u/:token` handler rather than standing up a second.

**Honest framing, enforced in copy, not just logic:** both the Settings
card and the draft-review screen state, verbatim, that this reaches a
known contact through a warmer channel, is not a way around a block, and
is never a retry-until-it-lands tool.

## Definition of done

- Bounced view splits Permanent vs Recoverable; hard-bounce behavior,
  auto-remove, suppression, cap enforcement, fair-share allocation, and the
  circuit breaker's own trip conditions are byte-for-byte unchanged.
- `unknown`-type bounces are visible and flagged for human review, distinct
  from "address is probably fine" — and can never be configured as an
  alternate-channel trigger, enforced by a DB CHECK, not just a UI default.
- Resend refuses on red domain auth, consumes normal cap/breaker budget
  (and will consume the warmup health gate once that ships), dedupes via a
  DB constraint, and stops being offered after 2 attempts per
  contact-per-campaign.
- A recoverable `block`/`soft` bounce on an opted-in org produces a ready
  AI draft, sender pre-selected, with zero manual steps — and the draft
  sends only on an explicit human click, never automatically.
- One alternate-channel attempt per contact per campaign, enforced by a DB
  constraint; a second recoverable bounce for the same pair never drafts
  again — the contact needs manual attention instead.
- Every draft generated, and every send or skip, is audited
  (`grow.alternate_channel_settings.update`, `grow.fallback_drafts.send`).
- Matches the existing Grow/Settings design, light and dark, down to phone
  width — no new primitives, only `Card`/`Button`/`toneSoft` already in use
  elsewhere in this app.
