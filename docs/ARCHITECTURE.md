# Venturelyx — Architecture

**Status:** Draft v0.1 — for review before any application code is written.
**Host:** acxnet07 (192.168.1.158), Ubuntu 26.04, Docker + Compose.

---

## 1. What this is

Venturelyx is a **multi-tenant hosted platform**, not an appliance.

CampusPath and TestGuard are appliances because schools require data locality and
are sold one box per district. That model does not transfer here. Venturelyx's
value is the *shared* layer — crawl corpus, rank history, competitor data,
vertical templates, cross-account benchmarks. Isolating tenants into separate
boxes destroys the only thing that makes this a product rather than an agency,
and creates an unmaintainable patching burden for a solo operator.

**The appliance seam stays open** (a franchise group may one day want a
self-hosted "Pool Company OS"). Cost of keeping it open is three rules that are
good practice regardless:

1. Strict 12-factor config. No hardcoded hostnames, paths, or ports. Ever.
2. No state on the local filesystem. All persistence is Postgres or object store.
3. One `docker compose up` brings the entire stack from cold.

---

## 2. Stack

| Layer | Choice | Rationale |
|---|---|---|
| API | **TypeScript + Fastify** | Typed routes + schema validation enforce the API contract rather than documenting it. TS is the guardrail that catches an AI agent inventing a field. |
| Frontends | **Next.js** (`app`, `web`, `scan`) | Three deployments, one component library. |
| Database | **PostgreSQL 17** | Row-level security is the tenancy control (§4). |
| Cache/sessions | **Redis** | Sessions, rate limiting, ephemeral cache only. Nothing whose loss is unrecoverable. |
| Crawl workers | **Python** (httpx, selectolax, Playwright) | Already proven in production on acxnet02. Node has no equivalent worth switching for. |
| Object store | **MinIO** | S3-compatible. Reports, screenshots, crawl artifacts, uploads. Migrating off the box later is a config change. |
| Ingress | **Caddy** behind **cloudflared** | No inbound ports. Matches the existing homelab pattern. |

**Node is chosen because it is what is already operated.** Every production
service in this estate — CampusPath, GeoDyn, TestGuard, JARVIS — is Node. When
something breaks at 11pm with a paying client on it, familiarity with the
failure modes is worth more than theoretical elegance. FastAPI is an entirely
defensible alternative; the objection is learning its operational edges on live
client data.

**Python stays for crawling permanently.** The language boundary becomes a clean
service boundary: workers never import API code. They communicate only through
the database.

---

## 3. Service topology

```
                    Cloudflare (DNS + Tunnel)
                              │
                        cloudflared
                              │
                            Caddy
                              │
        ┌──────────┬──────────┼──────────┐
        ▼          ▼          ▼          ▼
      web        app        api        scan
   (Next.js)  (Next.js)  (Fastify)  (Next.js)
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
          Postgres          Redis           MinIO
              ▲
              │  (job_queue: SKIP LOCKED)
              │
        ┌─────┴─────┬─────────────┐
        ▼           ▼             ▼
   crawl-worker  render-worker  scheduler
    (Python)     (Playwright)   (Node)
```

**Hostnames**

| Host | Serves |
|---|---|
| `venturelyx.com` | Marketing site |
| `app.venturelyx.com` | Command Center (client + staff) |
| `api.venturelyx.com` | Fastify API |
| `scan.venturelyx.com` | Public Growth Scan (lead wedge) |
| `status.venturelyx.com` | Later |

Only Caddy is reachable from cloudflared. Postgres, Redis, MinIO and all workers
sit on an internal Docker network with no published ports.

---

## 4. Tenancy — enforced by the database, not by discipline

**Decision: PostgreSQL Row-Level Security, `FORCE`d, on every tenant table.**

The application connects as `venturelyx_app`, a **non-superuser, non-owner** role.
Each request opens a transaction and sets:

```sql
SET LOCAL app.current_org  = '<uuid>';
SET LOCAL app.current_user = '<uuid>';
SET LOCAL app.is_staff     = 'off';
```

Every tenant table carries `org_id uuid NOT NULL` and a policy of the form
`USING (org_id = app.current_org() OR app.is_staff())`.

**Why this and not application-level filtering:** if a query — written by you at
2am or by an AI agent — omits `WHERE org_id = ?`, RLS returns zero rows instead of
another client's leads. Cross-tenant data leakage is the failure mode that ends a
B2B company, and "I will remember to filter" is not a control. This is the single
highest-leverage decision in the build.

`SET LOCAL` is transaction-scoped, so a pooled connection cannot leak tenant
context into the next request. This is mandatory, not stylistic.

**Staff mode.** Venturelyx operates *across* clients and needs an agency view:
all accounts, health scores, at-risk clients, overdue deliverables. `app.is_staff`
enables cross-tenant reads for users holding a platform-staff role. Every staff-mode
request is written to `audit_log` unconditionally.

---

## 5. Job queue in Postgres, not Redis

`SELECT ... FOR UPDATE SKIP LOCKED` against a `job_queue` table.

- Language-agnostic — Python workers and the Node scheduler share one queue with no bridge.
- Survives a Redis restart. Crawl schedules are not disposable.
- Inspectable with SQL when a crawl mysteriously has not run.

Redis handles sessions, rate limiting, and caching — things where data loss is survivable.

---

## 6. The business graph

**Modules are feature surfaces over one shared domain model. They do not own data.**

If ScaleSEO holds its own contacts table and Operate holds another, then
"SEO generated $18,340 last month" is not computable, and that sentence is the
entire product thesis.

| Entity | Serves |
|---|---|
| `parties` | One table for every person/company — lead, customer, vendor, supplier, contractor. Role *flags*, not separate tables. A sourced supplier can later become a customer; the record follows them. |
| `catalog_items` | What the business sells. Feeds quote lines (Operate), the opportunity matrix (ScaleSEO), page generation (Build), RFQ lines (Source). |
| `locations` | Service areas. Powers dispatch *and* local rank grids *and* city page generation. |
| `market_targets` | `catalog_item × location`. Simultaneously the SEO opportunity engine, the dispatch model, and the vertical templates. One concept, three modules — the sign the model is right. |
| `timeline_events` | Append-only, per party. Form fills, calls, texts, reviews, job completions, payments, and every AI action. This is what makes Command Center and the AI agents informed rather than guessing. |
| `attribution_touches` | Source/medium/campaign/landing page/keyword, retained through to the paid invoice. |

`catalog_items` and `locations` are `gen/services.json` and `gen/cities.json` from
the nppools generator, promoted to first-class entities.

**Attribution is in the spine from migration 002.** Retrofitting it later makes all
historical data worthless, and historical data is what makes the ROI claim credible.

---

## 7. Intelligence layer

One engine, not per-module logic.

```
signals  →  growth_opportunities  →  actions  →  approval  →  execution
```

Modules emit **signals** (page dropped out of index, lead untouched 5 days, review
unanswered, invoice aged past 30, competitor took position 3). Signals are scored
into **growth_opportunities** carrying an estimated dollar value. Opportunities
produce **actions** the owner approves.

This powers "Growth opportunities" on Command Center, "Next best move" on the
Growth Score, and it is the work queue the AI Team draws from.

---

## 8. AI Team is a runtime, not six features

Six separately-built assistants produce six chatbots that each know a sliver of the
business and can do nothing. The AI Receptionist needs scheduling + catalog + CRM.
The AI SEO Specialist needs crawl data + catalog + content. Same tools, different
permissions.

**One agent runtime, one tool registry, six configured personas.** A persona is a
system prompt + a scoped toolset + an approval policy, stored as rows. Adding "AI
Collections Assistant" later is a config change, not a project.

Every AI action writes to `timeline_events` and `audit_log`, and every action with
external side effects requires explicit approval until a per-persona autonomy level
is raised deliberately.

---

## 9. Naming collisions resolved

Two words were overloaded. Locked now to prevent an expensive rename later:

| Concept | Name | Not |
|---|---|---|
| Background task queue | `job_queue` | ~~jobs~~ |
| Field service work order | `work_orders` | ~~jobs~~ |
| Sales pipeline record | `deals` | ~~opportunities~~ |
| Intelligence-layer finding | `growth_opportunities` | ~~opportunities~~ |

---

## 10. Build order

| # | Block | Contents |
|---|---|---|
| 0 | Foundation | These docs + schema + design language |
| 1 | Platform core | Tenancy, auth + 2FA, RBAC, queue, credential vault, audit, backups |
| 2 | Business graph | Full schema live, thin admin UI |
| 3 | Operate v1 | Parties, timeline, deals, attribution |
| 4 | ScaleSEO | Port the acxnet02 crawler in, multi-tenant it |
| 5 | Command Center v1 | Real numbers from two modules |
| 6 | Growth Scan | `scan.venturelyx.com` public wedge |
| 7+ | Deepen Operate → Grow → Build/Source workflow → AI Team → billing |

Marketing site lands after the product exists, so it sells something real.
First accounts are N&P Pools and Atlético — live sites, real data, reference
customers before a line of marketing copy is written.

---

## 11. Sizing

Current: 2 vCPU / 7.2 GB / 29 GB. **Target: 4 vCPU / 16 GB static / 100 GB.**

The Hyper-V host is an i7-10610U — 4 physical cores, 8 threads *total for the
machine*. Allocating more than 4 vCPU causes scheduler thrash and reduces
throughput. Dynamic Memory must be **off**: ballooning causes Postgres to badly
mis-size `shared_buffers`. Checkpoints must be **off**: differencing disks over a
running Postgres are a corruption risk. Backups happen inside the guest.

`vm.overcommit_memory` is deliberately left at `0`. The usual Postgres advice of
`2` breaks Chromium and V8, which reserve large virtual address space without
touching it. Postgres OOM protection is applied per-container instead.

Ceiling for this architecture is low thousands of SMB tenants on one box. The
bottleneck arrives as crawl throughput long before API load; the fix is adding
worker containers. Postgres goes vertical, then a read replica for dashboards.
Kubernetes is a revenue problem that does not exist yet.

---

## 12. Open decisions

- **Design language** — pending. Palette, type scale, density, component behavior.
- **ScaleSEO port scope** — pending the acxnet02 inventory. How much of the existing
  crawler survives verbatim vs. needs rewriting for multi-tenancy.
- **Billing** — Stripe, deferred to Block 7. Schema placeholder only.
