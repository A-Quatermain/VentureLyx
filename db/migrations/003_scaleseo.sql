-- Venturelyx :: 003_scaleseo
-- Ported from the single-tenant crawler schema on acxnet02 (~/seo-platform/schema.sql).
-- Adds org_id + RLS, uuid parent keys, rank tracking, and business-graph joins.

BEGIN;

CREATE TABLE seo_sites (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key            text NOT NULL,
  name           text NOT NULL,
  url            text NOT NULL,
  enabled        boolean NOT NULL DEFAULT true,
  is_primary     boolean NOT NULL DEFAULT false,
  max_pages      int  NOT NULL DEFAULT 500,
  concurrency    int  NOT NULL DEFAULT 4,
  delay_ms       int  NOT NULL DEFAULT 250,
  timeout_s      int  NOT NULL DEFAULT 20,
  respect_robots boolean NOT NULL DEFAULT true,
  render         boolean NOT NULL DEFAULT false,
  user_agent     text,
  exclude_paths  text[] NOT NULL DEFAULT ARRAY['/admin','/login','/dashboard','/portal'],
  notes          text,
  crawl_schedule text NOT NULL DEFAULT 'weekly',
  last_crawl_at  timestamptz,
  next_crawl_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, key)
);
CREATE UNIQUE INDEX ON seo_sites (org_id) WHERE is_primary;
CREATE INDEX ON seo_sites (next_crawl_at) WHERE enabled;

CREATE TABLE seo_crawls (
  id            bigserial PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id       uuid NOT NULL REFERENCES seo_sites(id) ON DELETE CASCADE,
  job_id        bigint REFERENCES job_queue(id) ON DELETE SET NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  status        text NOT NULL DEFAULT 'running',
  pages_crawled int  NOT NULL DEFAULT 0,
  rendered      boolean NOT NULL DEFAULT false,
  trigger       text NOT NULL DEFAULT 'schedule',
  error         text
);
CREATE INDEX ON seo_crawls (site_id, started_at DESC);
CREATE INDEX ON seo_crawls (org_id, started_at DESC);

CREATE TABLE seo_pages (
  id               bigserial PRIMARY KEY,
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  crawl_id         bigint NOT NULL REFERENCES seo_crawls(id) ON DELETE CASCADE,
  site_id          uuid NOT NULL REFERENCES seo_sites(id) ON DELETE CASCADE,
  market_target_id uuid REFERENCES market_targets(id) ON DELETE SET NULL,
  content_id       uuid REFERENCES content_pages(id) ON DELETE SET NULL,
  url              text NOT NULL,
  status_code      int,
  redirect_to      text,
  redirect_hops    int NOT NULL DEFAULT 0,
  title            text,
  title_len        int,
  meta_description text,
  meta_desc_len    int,
  h1               text,
  h1_count         int NOT NULL DEFAULT 0,
  canonical        text,
  meta_robots      text,
  indexable        boolean,
  word_count       int NOT NULL DEFAULT 0,
  links_out_int    int NOT NULL DEFAULT 0,
  links_out_ext    int NOT NULL DEFAULT 0,
  images_total     int NOT NULL DEFAULT 0,
  images_no_alt    int NOT NULL DEFAULT 0,
  schema_types     text[],
  content_hash     text,
  response_ms      int,
  depth            int NOT NULL DEFAULT 0,
  lcp_ms           int,
  cls              numeric(6,3),
  inp_ms           int,
  perf_score       smallint,
  crawled_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON seo_pages (crawl_id);
CREATE INDEX ON seo_pages (site_id, url);
CREATE INDEX ON seo_pages (site_id, content_hash);
CREATE INDEX ON seo_pages (org_id, market_target_id) WHERE market_target_id IS NOT NULL;

CREATE TABLE seo_links (
  id          bigserial PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  crawl_id    bigint NOT NULL REFERENCES seo_crawls(id) ON DELETE CASCADE,
  site_id     uuid NOT NULL REFERENCES seo_sites(id) ON DELETE CASCADE,
  from_url    text NOT NULL,
  to_url      text NOT NULL,
  anchor      text,
  is_internal boolean NOT NULL,
  status_code int
);
CREATE INDEX ON seo_links (crawl_id);
CREATE INDEX ON seo_links (site_id, status_code) WHERE status_code >= 400;

CREATE TABLE seo_issues (
  id           bigserial PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  crawl_id     bigint NOT NULL REFERENCES seo_crawls(id) ON DELETE CASCADE,
  site_id      uuid NOT NULL REFERENCES seo_sites(id) ON DELETE CASCADE,
  signal_id    bigint REFERENCES signals(id) ON DELETE SET NULL,
  url          text,
  code         text NOT NULL,
  severity     text NOT NULL,
  detail       text,
  auto_fixable boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON seo_issues (crawl_id);
CREATE INDEX ON seo_issues (site_id, code);
CREATE INDEX ON seo_issues (org_id, severity) WHERE severity IN ('critical','high');

CREATE TABLE seo_scores (
  id              bigserial PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  crawl_id        bigint NOT NULL REFERENCES seo_crawls(id) ON DELETE CASCADE,
  site_id         uuid NOT NULL REFERENCES seo_sites(id) ON DELETE CASCADE,
  health          smallint NOT NULL,
  technical       smallint,
  content         smallint,
  local_seo       smallint,
  performance     smallint,
  reputation      smallint,
  ai_visibility   smallint,
  pages           int NOT NULL DEFAULT 0,
  broken_links    int NOT NULL DEFAULT 0,
  critical_issues int NOT NULL DEFAULT 0,
  high_issues     int NOT NULL DEFAULT 0,
  computed_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON seo_scores (site_id, computed_at DESC);

CREATE TABLE seo_keywords (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id           uuid NOT NULL REFERENCES seo_sites(id) ON DELETE CASCADE,
  market_target_id  uuid REFERENCES market_targets(id) ON DELETE SET NULL,
  location_id       uuid REFERENCES locations(id) ON DELETE SET NULL,
  phrase            text NOT NULL,
  search_volume     int,
  difficulty        smallint,
  intent            text,
  is_tracked        boolean NOT NULL DEFAULT true,
  is_branded        boolean NOT NULL DEFAULT false,
  est_value_monthly numeric(12,2),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, site_id, phrase, location_id)
);
CREATE INDEX ON seo_keywords (org_id, is_tracked) WHERE is_tracked;

CREATE TABLE seo_rankings (
  id            bigserial PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  keyword_id    uuid NOT NULL REFERENCES seo_keywords(id) ON DELETE CASCADE,
  engine        text NOT NULL DEFAULT 'google',
  position      numeric(5,1),
  previous      numeric(5,1),
  url           text,
  serp_features text[],
  checked_on    date NOT NULL DEFAULT current_date,
  UNIQUE (keyword_id, engine, checked_on)
);
CREATE INDEX ON seo_rankings (org_id, checked_on DESC);
CREATE INDEX ON seo_rankings (keyword_id, checked_on DESC);

CREATE TABLE seo_competitors (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id    uuid NOT NULL REFERENCES seo_sites(id) ON DELETE CASCADE,
  name       text NOT NULL,
  domain     text NOT NULL,
  is_tracked boolean NOT NULL DEFAULT true,
  discovered boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, site_id, domain)
);

CREATE TABLE seo_competitor_rankings (
  id            bigserial PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  competitor_id uuid NOT NULL REFERENCES seo_competitors(id) ON DELETE CASCADE,
  keyword_id    uuid NOT NULL REFERENCES seo_keywords(id) ON DELETE CASCADE,
  position      numeric(5,1),
  url           text,
  checked_on    date NOT NULL DEFAULT current_date,
  UNIQUE (competitor_id, keyword_id, checked_on)
);

CREATE TABLE seo_gsc_daily (
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id     uuid NOT NULL REFERENCES seo_sites(id) ON DELETE CASCADE,
  date        date NOT NULL,
  query       text NOT NULL DEFAULT '',
  page        text NOT NULL DEFAULT '',
  clicks      int NOT NULL DEFAULT 0,
  impressions int NOT NULL DEFAULT 0,
  ctr         numeric(6,4),
  position    numeric(6,2),
  PRIMARY KEY (site_id, date, query, page)
);
CREATE INDEX ON seo_gsc_daily (org_id, date DESC);

CREATE TABLE seo_ga4_daily (
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id      uuid NOT NULL REFERENCES seo_sites(id) ON DELETE CASCADE,
  date         date NOT NULL,
  landing_page text NOT NULL DEFAULT '',
  channel      text NOT NULL DEFAULT '',
  sessions     int NOT NULL DEFAULT 0,
  engaged      int NOT NULL DEFAULT 0,
  conversions  int NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, date, landing_page, channel)
);
CREATE INDEX ON seo_ga4_daily (org_id, date DESC);

CREATE TABLE seo_local_visibility (
  id               bigserial PRIMARY KEY,
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id          uuid NOT NULL REFERENCES seo_sites(id) ON DELETE CASCADE,
  location_id      uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  avg_position     numeric(5,1),
  keywords_top3    int NOT NULL DEFAULT 0,
  keywords_top10   int NOT NULL DEFAULT 0,
  keywords_tracked int NOT NULL DEFAULT 0,
  visibility_score smallint,
  computed_on      date NOT NULL DEFAULT current_date,
  UNIQUE (site_id, location_id, computed_on)
);

COMMIT;

-- Views MUST set security_invoker or they execute as the owner (superuser)
-- and bypass RLS entirely, returning every tenant's rows to any caller.
BEGIN;

CREATE VIEW seo_latest_crawl WITH (security_invoker = true) AS
SELECT DISTINCT ON (site_id) * FROM seo_crawls
WHERE status = 'ok' ORDER BY site_id, started_at DESC;

CREATE VIEW seo_latest_score WITH (security_invoker = true) AS
SELECT DISTINCT ON (site_id) * FROM seo_scores
ORDER BY site_id, computed_at DESC;

CREATE VIEW seo_rank_current WITH (security_invoker = true) AS
SELECT k.id AS keyword_id, k.org_id, k.site_id, k.phrase, k.location_id,
       l.name AS location_name, r.position, r.previous,
       (r.previous - r.position) AS movement, r.checked_on
FROM seo_keywords k
JOIN LATERAL (
  SELECT position, previous, checked_on FROM seo_rankings
  WHERE keyword_id = k.id AND engine = 'google'
  ORDER BY checked_on DESC LIMIT 1
) r ON true
LEFT JOIN locations l ON l.id = k.location_id
WHERE k.is_tracked;

COMMIT;

BEGIN;
CALL app.apply_tenant_rls();
DROP POLICY IF EXISTS tenant_isolation ON sessions;
DROP POLICY IF EXISTS tenant_isolation ON job_queue;
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['seo_sites','seo_keywords'] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_touch BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()', t, t);
  END LOOP;
END $$;
COMMIT;
