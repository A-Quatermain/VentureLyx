# Venturelyx — Roadmap

## Rules that must not be relitigated

Each of these was learned the expensive way.

1. **`SET LOCAL x = $1` is a syntax error.** SET takes no bind parameters.
   Use `set_config(name, value, true)`.
2. **The GUC is `app.user_id`, never `app.current_user`** — reserved keyword,
   the statement will not parse.
3. **Every view needs `WITH (security_invoker = true)`** or it runs as its
   owner and bypasses RLS entirely, returning every tenant's rows.
4. **`POSTGRES_PASSWORD` is set once at init and never rotated** — it is baked
   into the data directory.
5. **Applied migrations are immutable.** Write a new one.
6. **Normalise URLs for identity, request them as linked.** Stripping a
   trailing slash before fetching turned a healthy site into 16 phantom
   broken pages.
7. **Commit immediately after a fix.** Two fixes were silently reverted in one
   day by copying files over already-patched ones.
8. **Secrets never enter a chat, a ticket, or a terminal transcript.**
9. **Everything runs on acxnet07 (192.168.1.158).** Not acxnet02, not .156.

---

## Current state

| Layer | Status |
|---|---|
| PostgreSQL 17 · Redis · MinIO | healthy |
| 44 tables, 43 RLS policies, verified | live |
| Nightly verified backups, 03:15 UTC | working |
| ScaleSEO crawler (Python worker) | crawling live sites |
| API — Fastify, auth + 2FA, RBAC, tenant context | live |
| Caddy + Cloudflare Tunnel | `api.venturelyx.com` public |

Four businesses, nine sites. WIP sites (`in_health_score = false`) are crawled
but excluded from the brand's headline score.

---

## Next: Command Center (`web/`)

Next.js, "Daylight Ledger" design system — tokens are defined as CSS variables
in `mockups/venturelyx-command.html`, which is a complete navigable prototype
of every screen.

1. Sign-in → 2FA → org switcher
2. Home: Next Move card, revenue by channel, signals, module rail
3. ScaleSEO: health gauge, grouped issues, page table — real crawl data
4. Module shells: Build · Source · Operate · Grow · AI Team
5. Deploy; `app.venturelyx.com` stops returning 502

**Org switcher behaviour:** land in the last-used business, but the switcher
lists all businesses *with* their health scores — the portfolio view is one tap
away rather than a separate destination. Single-business clients never see the
complexity; multi-business owners get what they need.

API routes live in `api/src/routes/`. `GET /v1/auth/me` returns the user's
organizations. Tenancy is enforced by Postgres RLS, not by application code —
queries carry no `org_id` filter and must not add one.

---

## Backlog

- Off-box backups (dumps currently share a disk with the database)
- Rank tracking: tables exist, no data source yet
- Google Search Console / GA4 import (awaits OAuth in the credential vault)
- Auto-fix flow: `seo_issues.auto_fixable` is set but nothing acts on it
- **AI Lead Generation** under Grow — outbound prospecting, distinct from
  today's inbound capture. Needs a compliance layer first (consent, suppression
  lists, opt-out: CAN-SPAM, TCPA, GDPR)
- Agency layer — cross-client view for Venturelyx staff
- Stripe billing and self-serve signup
- AI Team runtime: one agent loop, one tool registry, six configured personas
- `seed_sites.py` still holds the old six-org list and would recreate the org
  splits if re-run
- `migrate.sh` should skip-and-warn on a checksum mismatch rather than aborting
  the whole run; its duration column reports nonsense values
