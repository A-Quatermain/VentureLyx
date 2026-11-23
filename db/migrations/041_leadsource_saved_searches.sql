-- Venturelyx :: 041_leadsource_saved_searches
--
-- Phase 2.5 of LeadSource v2 (docs/specs — see the v2 design report this
-- follows). Self-serve, ad-hoc search over everything already ingested
-- into leadsource_raw_records (040_leadsource.sql) — a different thing
-- from leadsource_settings, which only ever governs the daily PUSH
-- fan-out. A saved search is a PULL: run it whenever, against the whole
-- history, with arbitrary filters including a free-text name search.
--
-- Scoped to FL only in this phase (states text[] exists for the shape
-- v2's multi-state catalog will eventually need, but nothing outside FL
-- is ingested yet — a non-FL value here just matches nothing today).

BEGIN;

CREATE TABLE leadsource_saved_searches (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                 uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                   text NOT NULL,
  states                 text[] NOT NULL DEFAULT ARRAY['FL']::text[],
  counties               text[] NOT NULL DEFAULT '{}',
  zips                   text[] NOT NULL DEFAULT '{}',
  filing_types           text[] NOT NULL DEFAULT '{}',
  file_date_window_days  int NOT NULL DEFAULT 30,
  name_keywords          text[] NOT NULL DEFAULT '{}',
  include_dba            boolean NOT NULL DEFAULT false,
  created_by             uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leadsource_saved_searches_org_idx ON leadsource_saved_searches (org_id);

CALL app.apply_tenant_rls();

COMMIT;
