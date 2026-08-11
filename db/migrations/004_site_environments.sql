-- =============================================================================
-- 004_site_environments.sql
--
-- Two structural corrections plus the WIP-site model.
--
--   1. A business can own several sites. The seed script wrongly created a
--      separate org per site slug, splitting two real businesses in half:
--        - GeoDyn Parking      (geodynparking.com + geodyn.us admin portal)
--        - the education business (CampusPath + TestGuard + PathU.ai)
--      This merges each back into one org.
--
--   2. Each brand has a live site AND a work-in-progress rebuild. A WIP site
--      should be crawled (so you can watch its health climb as you finish it)
--      but must NOT drag down the brand's headline score. Two new columns
--      express that: `environment` and `in_health_score`.
--
-- Idempotent where it can be: guarded with IF NOT EXISTS / ON CONFLICT so a
-- re-run is safe, though migrate.sh applies each file once regardless.
-- =============================================================================

-- ── 1. new columns ──────────────────────────────────────────────────────────
ALTER TABLE seo_sites
  ADD COLUMN IF NOT EXISTS environment text NOT NULL DEFAULT 'production'
    CHECK (environment IN ('production','staging','development')),
  ADD COLUMN IF NOT EXISTS in_health_score boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN seo_sites.environment IS
  'production = the live site; development = WIP rebuild; staging = preview mirror';
COMMENT ON COLUMN seo_sites.in_health_score IS
  'false keeps a site visible and crawlable but out of the brand headline score';

-- ── 2. merge GeoDyn: geodyn.us is the admin portal, same business ───────────
DO $$
DECLARE
  target_org uuid;
  orphan_org uuid;
BEGIN
  SELECT id INTO target_org FROM organizations WHERE slug = 'geodyn';
  SELECT id INTO orphan_org FROM organizations WHERE slug = 'geodyn-us';

  IF target_org IS NOT NULL AND orphan_org IS NOT NULL THEN
    -- Move any rows that reference the orphan org to the surviving org. Only
    -- seo_sites is populated today, but move the whole graph defensively so a
    -- later-seeded row cannot strand.
    -- Demote first: a partial unique index allows only one primary site per
    -- org, so reparenting a second primary would collide.
    UPDATE seo_sites SET is_primary = false WHERE org_id = orphan_org;
    -- Demote first: a partial unique index allows only one primary site per
    -- org, so reparenting a second primary would collide.
    UPDATE seo_sites SET is_primary = false WHERE org_id = orphan_org;
    -- Demote first: a partial unique index permits only one primary site per
    -- org, so reparenting a second primary collides before we can demote it.
    UPDATE seo_sites SET is_primary = false WHERE org_id = orphan_org;
    UPDATE seo_sites            SET org_id = target_org WHERE org_id = orphan_org;
    UPDATE seo_crawls           SET org_id = target_org WHERE org_id = orphan_org;
    UPDATE seo_pages            SET org_id = target_org WHERE org_id = orphan_org;
    UPDATE seo_links            SET org_id = target_org WHERE org_id = orphan_org;
    UPDATE seo_issues           SET org_id = target_org WHERE org_id = orphan_org;
    UPDATE seo_scores           SET org_id = target_org WHERE org_id = orphan_org;
    UPDATE signals              SET org_id = target_org WHERE org_id = orphan_org;
    UPDATE growth_opportunities SET org_id = target_org WHERE org_id = orphan_org;

    -- geodyn.us is a real portal, so it stays production, just not primary.
    UPDATE seo_sites
       SET is_primary = false, environment = 'production',
           notes = 'Admin portal for GeoDyn Parking. Same business as geodynparking.com.'
     WHERE org_id = target_org AND key = 'geodyn-us';

    DELETE FROM organizations WHERE id = orphan_org;
  END IF;
END $$;

-- ── 3. merge the education business: CampusPath + TestGuard + PathU ─────────
DO $$
DECLARE
  target_org uuid;
  orphan_org uuid;
BEGIN
  SELECT id INTO target_org FROM organizations WHERE slug = 'campuspath';
  SELECT id INTO orphan_org FROM organizations WHERE slug = 'testguard';

  IF target_org IS NOT NULL AND orphan_org IS NOT NULL THEN
    -- Demote first: a partial unique index allows only one primary site per
    -- org, so reparenting a second primary would collide.
    UPDATE seo_sites SET is_primary = false WHERE org_id = orphan_org;
    -- Demote first: a partial unique index allows only one primary site per
    -- org, so reparenting a second primary would collide.
    UPDATE seo_sites SET is_primary = false WHERE org_id = orphan_org;
    -- Demote first: a partial unique index permits only one primary site per
    -- org, so reparenting a second primary collides before we can demote it.
    UPDATE seo_sites SET is_primary = false WHERE org_id = orphan_org;
    UPDATE seo_sites            SET org_id = target_org WHERE org_id = orphan_org;
    UPDATE seo_crawls           SET org_id = target_org WHERE org_id = orphan_org;
    UPDATE seo_pages            SET org_id = target_org WHERE org_id = orphan_org;
    UPDATE seo_links            SET org_id = target_org WHERE org_id = orphan_org;
    UPDATE seo_issues           SET org_id = target_org WHERE org_id = orphan_org;
    UPDATE seo_scores           SET org_id = target_org WHERE org_id = orphan_org;
    UPDATE signals              SET org_id = target_org WHERE org_id = orphan_org;
    UPDATE growth_opportunities SET org_id = target_org WHERE org_id = orphan_org;

    UPDATE seo_sites SET is_primary = false WHERE org_id = target_org AND key = 'testguard';

    DELETE FROM organizations WHERE id = orphan_org;
  END IF;

  -- The education org sells three products; name it for the company.
  UPDATE organizations SET name = 'CampusPath Education'
   WHERE slug = 'campuspath' AND name = 'CampusPath';
END $$;

-- ── 4. correct the live sites, then seed the WIP counterparts ───────────────
-- campuspath.org is the live K-12 platform; campuspath.com is the WIP marketing
-- site. The seed created only the .com row (disabled). Fix it to be the live
-- .org, then add .com as the WIP.
DO $$
DECLARE
  edu uuid;
  gp  uuid;
  ua  text := 'VenturelyxBot/1.0 (+https://venturelyx.com/bot)';
  ex  text[] := ARRAY['/admin','/login','/dashboard','/portal'];
BEGIN
  SELECT id INTO edu FROM organizations WHERE slug = 'campuspath';
  SELECT id INTO gp  FROM organizations WHERE slug = 'geodyn';

  -- CampusPath live = campuspath.org
  UPDATE seo_sites
     SET key='campuspath', name='CampusPath', url='https://campuspath.org',
         enabled=true, is_primary=true, environment='production',
         in_health_score=true, render=false,
         notes='Live K-12 operations platform.'
   WHERE org_id = edu AND key = 'campuspath';

  -- CampusPath WIP = campuspath.com (marketing site in progress)
  INSERT INTO seo_sites (org_id, key, name, url, enabled, is_primary, render,
                         max_pages, user_agent, exclude_paths, environment,
                         in_health_score, crawl_schedule, next_crawl_at, notes)
  VALUES (edu, 'campuspath-com', 'CampusPath (marketing)', 'https://campuspath.com',
          true, false, false, 300, ua, ex, 'development', false, 'weekly', now(),
          'WIP marketing site. Crawled but excluded from the brand health score.')
  ON CONFLICT (org_id, key) DO NOTHING;

  -- TestGuard: testguard.org is the WIP (pending launch), nothing live yet.
  UPDATE seo_sites
     SET environment='development', in_health_score=false, enabled=true,
         is_primary=false, name='TestGuard',
         notes='WIP, pending launch. Excluded from the brand health score.'
   WHERE org_id = edu AND key = 'testguard';

  -- PathU: pathu.ai landing/waitlist is live; the app is the WIP.
  INSERT INTO seo_sites (org_id, key, name, url, enabled, is_primary, render,
                         max_pages, user_agent, exclude_paths, environment,
                         in_health_score, crawl_schedule, next_crawl_at, notes)
  VALUES
    (edu, 'pathu', 'PathU.ai', 'https://pathu.ai', true, false, true, 200, ua, ex,
     'production', true, 'weekly', now(), 'Live landing page and waitlist.'),
    (edu, 'pathu-app', 'PathU.ai (app)', 'https://app.pathu.ai', true, false, true,
     300, ua, ex, 'development', false, 'weekly', now(),
     'WIP application. Crawled but excluded from the brand health score.')
  ON CONFLICT (org_id, key) DO NOTHING;

  -- GeoDyn WIP: geodyn.us is already the portal. If there is a WIP rebuild of
  -- the marketing site it is added here later; nothing to seed today.
  PERFORM gp;
END $$;

-- ── 5. rewrite seo_latest_score to exclude WIP sites ────────────────────────
-- CRITICAL: security_invoker MUST be re-applied. Without it the view runs as
-- its owner and returns every tenant's scores across the RLS boundary. This is
-- the exact trap from migration 003.
DROP VIEW IF EXISTS seo_latest_score;
CREATE VIEW seo_latest_score
  WITH (security_invoker = true) AS
  SELECT DISTINCT ON (sc.site_id)
         sc.id, sc.org_id, sc.crawl_id, sc.site_id, sc.health, sc.technical,
         sc.content, sc.local_seo, sc.performance, sc.reputation,
         sc.ai_visibility, sc.pages, sc.broken_links, sc.critical_issues,
         sc.high_issues, sc.computed_at
    FROM seo_scores sc
    JOIN seo_sites s ON s.id = sc.site_id
   WHERE s.in_health_score            -- WIP sites are tracked but not scored
   ORDER BY sc.site_id, sc.computed_at DESC;

COMMENT ON VIEW seo_latest_score IS
  'Latest score per site, WIP sites (in_health_score=false) excluded. security_invoker=on for RLS.';
