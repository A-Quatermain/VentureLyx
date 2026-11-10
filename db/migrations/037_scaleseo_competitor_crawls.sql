-- Venturelyx :: 037_scaleseo_competitor_crawls
--
-- Backs crawl-based Competitor Analysis (docs/specs/scaleseo-competitors.md).
-- seo_competitors and seo_competitor_rankings (003_scaleseo.sql) are
-- untouched — manual-entry rows still land in seo_competitors exactly as
-- before, and seo_competitor_rankings is still reserved for a real
-- rank-tracking source that doesn't exist yet. This is new, separate
-- storage for a different kind of data entirely: what our OWN crawler
-- found when it visited a competitor's public pages, not a rank.
--
-- seo_competitor_crawls: one row per crawl attempt. Deliberately NOT
-- keyed through persist()'s seo_crawls/seo_pages/seo_scores/seo_issues/
-- signals pipeline — those are FK'd to seo_sites (an OWNED site with its
-- own crawl-config columns), and a competitor has neither a seo_sites row
-- nor a config to read defaults from. technical/content/local/performance
-- mirror the four sub-scores computed for owned sites (local reuses the
-- exact same computation owned sites call "ai_visibility" — see
-- workers/seo/scoring.py's compute_ai_visibility(); same signal, clearer
-- name for a comparison view that's explicitly about competitive
-- positioning). summary is the raw material a human or the AI critique
-- reads to explain the scores: page titles/H1s, schema types present,
-- a sitemap count, mobile-viewport presence, and avg response time /
-- page weight as the speed proxy — never a claim about rankings, traffic,
-- or backlinks (this is a same-page crawl, nothing else).
--
-- "Keep only the latest two crawls per competitor" is enforced by the
-- worker right after each insert (workers/seo/competitors.py), not a
-- trigger — simpler to read, and the worker is the only writer.

BEGIN;

CREATE TABLE seo_competitor_crawls (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  competitor_id uuid NOT NULL REFERENCES seo_competitors(id) ON DELETE CASCADE,
  job_id        bigint,
  status        text NOT NULL CHECK (status IN ('ok', 'error', 'robots_blocked')),
  error         text,
  pages_crawled int NOT NULL DEFAULT 0,
  technical     smallint,
  content       smallint,
  local         smallint,
  performance   smallint,
  summary       jsonb,
  crawled_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON seo_competitor_crawls (competitor_id, crawled_at DESC);

CALL app.apply_tenant_rls();

COMMIT;
