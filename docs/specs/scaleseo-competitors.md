# Venturelyx — ScaleSEO Competitor Analysis (crawl-based)

Fills the Competitors tab's existing honest empty state ("Venturelyx doesn't
have a data source for competitor rankings connected yet") with a real
comparison — not rankings (no paid rank-tracking provider is connected, and
this doesn't add one), but what our own crawler can see on a public page:
technical health, content coverage, and structured data, measured against
each tracked competitor the same way it's measured for an owned site.

ADDITIVE. `seo_competitors` and `seo_competitor_rankings` (003_scaleseo.sql)
are untouched — manual entries still land in `seo_competitors` exactly as
before, and `seo_competitor_rankings` is still reserved for a real
rank-tracking source that doesn't exist yet; this never writes to it.
Owned-site crawling, scoring, and `persist()` are unchanged — see "Step 0
findings" below for what that's based on. Don't touch `/opt/outreach`.

## Step 0 findings (read-only investigation this spec is built on)

- **Competitors tab**: real schema + a real route (`GET /seo/competitors/:siteId`,
  `api/src/routes/data.ts`) + a real table component — never a stub. Nobody
  writes to `seo_competitors`/`seo_competitor_rankings` anywhere in the
  codebase, so the tab has been empty since the schema was created.
- **Local Rankings does NOT capture competitor domains.** `seo_rankings`
  only stores our own `position`/`url` per keyword; `seo_local_visibility`
  is a pure rollup of it. Neither has a raw SERP result list. There is also
  no writer for `seo_rankings` at all today — a separate, pre-existing gap
  this spec doesn't touch.
- **The crawl engine (`workers/seo/crawler.py`'s `crawl_site`/`SiteConfig`)
  already takes an arbitrary URL** — `respect_robots`, rate limiting
  (`delay_ms`/`concurrency`), a page cap (`max_pages`), and a real
  `user_agent` string all already exist and need no engine change. What's
  locked to owned sites is the orchestration around it
  (`workers/seo/worker.py::run_crawl_job`, keyed on a `seo_sites` row) and
  persistence (`persist()`'s tables are all FK'd to `seo_sites`) — both
  bypassed entirely here in favor of a new job path and a new, slim table.
- **Honesty check on the two sibling features** (Keywords, Local Rankings):
  both already degrade to a truthful "not connected"/"nothing yet" message
  when their data source is empty — same pattern this feature follows.

## 1. Adding competitors

Manual entry only, v1 — `POST /seo/competitors/:siteId` with `{ name, domain }`.
- `domain` is normalized (scheme/path/`www.` stripped, lowercased) and
  validated against a basic hostname pattern; rejected if it equals the
  site's own hostname.
- Capped at 3 per site (`seo_competitors WHERE site_id = $1 AND is_tracked`
  count check) — the existing `UNIQUE(org_id, site_id, domain)` constraint
  still catches a literal duplicate.
- Writes `is_tracked = true, discovered = false` to the existing
  `seo_competitors` row — nothing new on that table.
- `DELETE /seo/competitors/:competitorId` removes it (cascades
  `seo_competitor_crawls` and `seo_competitor_rankings`, both already
  `ON DELETE CASCADE`).

## 2. Competitor crawl job

New job kind `seo.competitor_crawl`, payload `{ competitor_id }`
(`workers/seo/competitors.py::run_competitor_crawl_job`, dispatched from
`worker.py::run_job`). Fixed, conservative defaults — never read from a
`seo_sites` row, since a competitor has none:

| | owned-site crawl | competitor crawl |
|---|---|---|
| max_pages | per-site config (default 500) | **25** |
| concurrency | per-site config (default 4) | **1** |
| delay_ms | per-site config (default 250) | **600** |
| respect_robots | per-site config | **always on** |
| render | per-site config | **always off** |

**Robots.txt pre-flight, new here**: owned-site crawls never check the
start URL itself against robots.txt (reasonable — you own the site).
A competitor's crawl fetches `/robots.txt` and checks the **homepage path**
before fetching anything else; if blocked, the job records
`status = 'robots_blocked'` and crawls nothing at all. We don't work around
a disallow.

**Triggers**: on add (enqueued by the `POST /seo/competitors/:siteId`
route), on demand (`POST /seo/competitors/:competitorId/rescan`), and
weekly (`scripts/crawl.py --competitors-due` — every tracked competitor
whose latest `seo_competitor_crawls` row is absent or >7 days old; add it
to the same crontab entry `docs/DEPLOY-GSC.md` documents for `--all-due`).
All three go through the same `job_queue` dedupe key
(`seo.competitor_crawl:{competitor_id}`) the owned-site crawl path already
uses, so a second trigger while one is in flight is a no-op, not a pile-up.

**Two small, additive fields on `crawler.py`'s `PageResult`** (`html_bytes`,
`has_viewport_meta`) — both default-empty, read only by the competitor
summary builder below; nothing in `detect_issues`/`compute_scores`/
owned-site `persist()` reads either, so owned-site crawling and scoring
are byte-for-byte unchanged.

## 3. Persistence — a new, slim table

`seo_competitor_crawls` (037_scaleseo_competitor_crawls.sql) — one row per
crawl attempt, **not** `persist()`'s `seo_sites`-keyed pipeline:

```
id, org_id, competitor_id, job_id, status ('ok'|'error'|'robots_blocked'),
error, pages_crawled, technical, content, local, performance, summary jsonb,
crawled_at
```

`technical`/`content`/`performance` reuse `scoring.py`'s existing
`compute_scores()` unchanged. `local` is `compute_ai_visibility()`'s own
number — the exact computation owned sites already call "AI Visibility"
(LocalBusiness/FAQ schema completeness, phone consistency, direct-answer
structure) under the clearer name a competitive-positioning view calls it.

`summary` jsonb: page titles/H1s/word counts (the raw material for the
content-gap heuristic and the AI critique below), the union of schema
types found, average response time and page weight (the speed/weight
proxy), how many checked pages carry a `<meta name="viewport">` tag, and a
best-effort `/sitemap.xml` count (flagged separately if it's a sitemap
*index* rather than a page list, so nothing downstream mistakes one for
the other).

Only the latest **2** crawls per competitor are kept — a `DELETE ... WHERE
id NOT IN (... ORDER BY crawled_at DESC LIMIT 2)` run by the worker right
after every insert, not a trigger.

## 4. Comparison view

`GET /seo/competitors/:siteId/comparison` returns the client's own latest
scores + per-page data (re-derived live from `seo_pages`/`seo_scores` —
no new column on either, so owned-site `persist()` stays untouched) and,
per tracked competitor, its latest crawl plus the gap computation:

- **Sub-score gaps** (`competitor − client`, signed — negative means the
  client is ahead) for technical/content/local/performance.
- **Content gaps, both directions**: a lightweight title+H1 token-overlap
  heuristic (`topicGaps()` in `routes/data.ts`) — a competitor page with no
  token overlap against any of our own pages is a topic gap; the reverse
  (our pages with no match on their site) shows where we're ahead. This is
  a quick scannable signal, not the real analysis — the AI critique below
  reads the raw page lists directly instead of this heuristic.
- **Schema gaps, both directions**: set difference over each side's schema
  type union.
- **Other technical signals**: average response time, mobile-viewport tag
  coverage (competitor only — owned-site crawls don't capture this field
  today, so there's nothing stored to compare it against on our side; shown
  as the competitor's own number, not a claimed gap), sitemap page count.

States the UI handles per competitor: **no competitors yet** (prompt to add
one), **queued/running** (live job_queue state, not the last stored crawl's
stale status), **blocked by robots.txt**, **failed** (with the stored error
and a Retry that's the same re-scan action).

## 5. AI critique — extends the existing SEO Assistant

`POST /ai/competitor-critique/stream` (`routes/ai.ts`) — same persona,
same guardrails, same cost tier (`primary`) and spend-cap behavior as
`/ai/seo-recommendations/stream`, no new agent. Fed the client's latest
score + page titles and each **successfully scanned** competitor's score +
page titles + schema types; told explicitly never to invent rankings,
traffic, or backlink claims, since none of that was measured. Returns a
ranked action list ("they do X, you don't — here's what to do") with a
severity per item, grounded in the real data given.

## 6. Honest limits (stated in the tab itself)

> Compares on-page and technical factors from a public crawl of up to 25
> pages. It does not measure a competitor's rankings, traffic, conversions,
> or backlinks.

## 7. Gating

Follows ScaleSEO's existing module gate (`moduleWriteGate('scaleseo')` on
every write route) — platform-staff gating was never the question here
(this is a tenant-facing feature); no new entitlement, no new role check
beyond the existing `manager`/`viewer` split the rest of ScaleSEO uses.

## Definition of done

- A site can add up to 3 competitors by domain (validated, own-domain
  rejected) and remove them. ✅
- Each competitor crawl respects robots.txt (full pre-flight check, not
  just per-link), is capped at 25 pages, and runs on add, on demand, and
  weekly. ✅
- The comparison view shows score gaps, content gaps, and technical gaps
  in both directions. ✅
- The AI critique returns a ranked, specific action list from the real
  comparison data, through the existing SEO Assistant guardrails. ✅
- The tab states what it does and does not measure. ✅
- Existing owned-site crawling, scoring, and `persist()` are unchanged —
  verified: `workers/seo/worker.py::run_crawl_job`/`persist()` untouched;
  the only `crawler.py` change is two new, default-empty `PageResult`
  fields nothing else reads. ✅
- Matches ScaleSEO's design system (Card/Button/Bar/tone tokens, light and
  dark, phone-width grid) — no new colors or components introduced. ✅

## Smoke-tested (this build)

Ran a real `seo.competitor_crawl` job end-to-end against `example.com` from
a real site's org (N&P Pools), confirmed: robots.txt pre-flight fetched
and passed, crawl completed in &lt;1s, scores computed (technical 92,
content 20 — correctly low, since example.com has no meta description/H1/
schema), summary captured correctly (viewport tag detected, page weight,
sitemap absence correctly recorded as `null`, not a false zero), row
retained in `seo_competitor_crawls`, then deleted — cascade confirmed
clean. Test competitor and its crawl row were removed immediately after;
no lasting data left on any real org.
