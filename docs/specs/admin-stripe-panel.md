# Venturelyx — Admin "Billing / Stripe" Panel

Platform-admin-only page that answers, at a glance: are we in test or live
mode, are all three Stripe secrets actually set and consistent with each
other, is the webhook reaching us and verifying, and does every tier's
Price lookup key actually match what `billingEntitlements.ts` unlocks. The
specific trap this exists to catch: **a lookup-key mismatch lets checkout
succeed while the module never unlocks** — silent on the customer's receipt,
invisible anywhere else in the app.

ADDITIVE. Org-scoped rules don't apply here — this is the platform's own
Stripe account, not a per-tenant setting. Don't touch `/opt/outreach`.

## Confirmed names (read before changing anything here)

- Platform-staff gate: `requireStaffOrNotFound(req, reply)` from
  `api/src/lib/staffGuard.ts`, checking `req.session.is_platform_staff`
  directly — the same gate every other `admin.ts` route uses. There is no
  separate "super-admin" role in this codebase; `is_platform_staff` already
  means platform employee, never a tenant/org admin, so reusing it as-is
  satisfies "super-admin only" with nothing new to add.
- `organizations`, `billing_customers`, `billing_subscriptions`,
  `stripe_events` — all from `db/migrations/021_stripe_billing.sql`.
  `stripe_events` has no `org_id` (platform-global idempotency ledger);
  `billing_subscriptions` has `org_id, status, price_lookup_keys, updated_at`
  and is upserted per org, not append-only.
- `api/src/lib/billingEntitlements.ts`: `LOOKUP_KEY_MODULES`,
  `modulesForLookupKeys()`, `BILLABLE_MODULES`.
- `api/src/lib/stripe.ts`: `IS_STRIPE_LIVE_MODE`, the shared `stripe` client.
- `api/src/scripts/stripeCatalog.ts`: `CATALOG` (4 products: platform,
  growth_partner, launch_growth, founding) — already exported.

## Two gaps found while confirming the above (handled by scoping down, not inventing data)

1. **No append-only entitlement grant/revoke log exists.** `syncEntitlements`
   only `console.error`s on refusal; nothing writes a history row on
   success. Rather than add one (out of scope for a read-only panel), the
   "Entitlement log" section is **derived** from `billing_subscriptions`
   joined to `organizations`, ordered by `updated_at DESC` — current state
   as of the last webhook-driven update per org, not a true change history.
   Labeled as such in the UI ("as of last webhook update"), not presented as
   an event log.
2. **No record of failed signature-verify attempts.** `routes/billing.ts`'s
   webhook handler only inserts into `stripe_events` *after*
   `constructEvent()` succeeds — a bad signature returns 400 before any
   write. So "last signature-verify pass/fail" can only ever show the last
   *pass*; a persistent failure (e.g. wrong `whsec_` after a key rotation)
   shows up as "no new events," not as a visible failure. Noted plainly in
   the UI rather than implied as a real pass/fail indicator.

## Backend — `api/src/routes/adminBilling.ts` (new file, registered in `server.ts` under `/v1` like every other route file)

`GET /admin/billing/status` — read-only, single call, everything below:

- **Mode**: `IS_STRIPE_LIVE_MODE` → `'live' | 'test'`.
- **Keys** (masked — prefix + last 4 chars only, exactly what the brief
  asked for, never the full value):
  - secret key: configured?, mode (`sk_live_`/`sk_test_`), masked value.
  - publishable key: same, from `STRIPE_PUBLISHABLE_KEY`.
  - webhook secret: configured? only (no safe way to show live/test from a
    `whsec_` prefix alone — both modes share it).
  - `modeMismatch`: true when secret and publishable key prefixes disagree.
- **Webhook health**:
  - Expected public URL: `https://api.venturelyx.com/v1/billing/webhook` —
    a literal constant (verified against `infra/caddy/Caddyfile`'s static
    host mapping and confirmed live against the running container: the
    route is registered under `/v1`, so `/billing/webhook` without it 404s).
    Not read from any env var — none exists for this today, same pattern
    `routes/billing.ts` already uses for `APP_BASE_URL`'s literal fallback.
  - Last event: most recent `stripe_events` row (type + `processed_at`), or
    "no events received yet."
- **Catalog check**: for each of `CATALOG`'s 4 products, each price's
  lookup key, live-looked-up via `stripe.prices.list` (current mode) —
  Stripe price id + amount if found, flagged missing if not. Recurring
  (subscription) lookup keys are additionally checked against
  `LOOKUP_KEY_MODULES` — missing from that map is the exact "checkout
  succeeds, module never unlocks" trap, shown loud (red row). One-time setup
  fees (`launch_growth_setup`, `founding_setup`) are deliberately absent
  from `LOOKUP_KEY_MODULES` (billingEntitlements.ts's own documented
  reasoning) and are only checked for existing in Stripe, not for a module
  mapping.
- **Recent entitlements**: last 20 `billing_subscriptions` rows joined to
  `organizations`, with `modulesForLookupKeys()` applied to show the
  resulting module set per org — see gap #1 above for the caveat.

`POST /admin/billing/sync-catalog` — body `{ confirm: true }` required.
Spawns the already-compiled `dist/scripts/stripeCatalog.js` as a child
process (passing `--allow-live` only when `IS_STRIPE_LIVE_MODE`) rather than
importing the script module directly — the script's `main()` runs at
top-level import time, so importing it into a long-lived API process would
re-run catalog sync (including deactivating the old v1 catalog) on every
API boot. Spawning is also exactly what a human operator running
`npm run stripe:catalog` does, so there is one source of truth for catalog
logic, never a second copy. Captures stdout/stderr, returns it verbatim,
audit-logged via the same `auditAdmin()` helper `admin.ts` uses.

No separate "self-check" endpoint — it would just recompute the same
`/admin/billing/status` payload a second way. The "Run self-check" button in
the UI re-fetches `/admin/billing/status` and renders a green/red summary
banner computed client-side from that one response.

## Frontend — `web/src/app/admin/billing/page.tsx` (new), nav link added to `web/src/app/admin/layout.tsx`

Matches the existing admin design system exactly — no new primitives:
`PageHeader` (eyebrow "Staff only"), `Card`, the `toneSoft`/`Tone` chip
colors from `components/ui/tone.ts` (success/warning/destructive/muted) for
every ok/missing/mismatch indicator, `font-mono tabular-nums` for IDs and
amounts like the existing stat tiles.

1. Mode banner — large, unmistakable, `success` tone text "LIVE" over a
   warning-tinted banner if live (money is real), `muted` "TEST" otherwise.
2. Keys status — three rows, masked value + chip per key, a loud banner if
   `modeMismatch`.
3. Webhook health — expected URL (copyable), last event row or empty state.
4. Catalog check — table of all tiers/prices; red row + explanation text on
   any mismatch or missing lookup key.
5. "Sync catalog" button — confirm dialog first (`AskUserQuestion`-style
   native `confirm()` is fine here, consistent with other destructive-ish
   admin actions in this app), then calls the sync endpoint and shows its
   raw output.
6. Recent entitlements table — org, modules (chips), status, "as of" time.
7. "Run self-check" — re-fetches status, shows one pass/fail banner.

## Definition of done

- Platform staff sees mode/keys/webhook/catalog/entitlements at a glance;
  tenant org admins get the same invisible-404 treatment as every other
  `/admin/*` route and API path.
- No full `sk_live_`/`pk_live_`/`whsec_` value ever reaches the browser —
  prefix + last 4 only.
- Sync catalog is idempotent (delegates to the existing idempotent script)
  and confirm-gated; Run self-check is read-only.
- Matches the admin console's existing visual language, light and dark,
  down to phone width.
