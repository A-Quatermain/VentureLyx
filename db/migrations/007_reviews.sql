-- =============================================================================
-- 007_reviews.sql
--
-- Real schema for Reviews & Reputation. No automated review source is
-- connected yet (no Google Business Profile / Yelp / Facebook integration) —
-- `source` defaults to 'manual' because right now a review only enters the
-- system the way an owner would type one in, same as every other table in
-- this app that models a real-world entity before its automation exists
-- (parties before CSV import, seo_sites before a crawl). The column exists
-- so a future sync job can write 'google'/'yelp'/'facebook' rows into the
-- exact same table without a migration.
-- =============================================================================

BEGIN;

CREATE TABLE reviews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  party_id        uuid REFERENCES parties(id) ON DELETE SET NULL,
  source          text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual','google','facebook','yelp')),
  source_review_id text,
  author_name     text NOT NULL,
  rating          smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body            text,
  reviewed_at     timestamptz NOT NULL DEFAULT now(),
  response_body   text,
  response_status text NOT NULL DEFAULT 'none'
    CHECK (response_status IN ('none','drafted','published')),
  responded_at    timestamptz,
  responded_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON reviews (org_id, reviewed_at DESC);
-- One row per external review if a future sync writes source_review_id.
CREATE UNIQUE INDEX ON reviews (org_id, source, source_review_id) WHERE source_review_id IS NOT NULL;

CALL app.apply_tenant_rls();

CREATE TRIGGER reviews_touch BEFORE UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

COMMIT;
