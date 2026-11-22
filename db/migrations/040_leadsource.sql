-- Venturelyx :: 040_leadsource
--
-- Phase 2 of LeadSource (docs/specs — see the Phase 1 research this
-- follows). Per-org opt-in module surfacing Florida Sunbiz public
-- corporate/fictitious-name filings as leads.
--
-- leadsource_raw_records: shared, NOT tenant-scoped — one row per public
-- record, across every org, keyed (source, source_id). This is exactly
-- the kind of table RLS can't protect (no org_id to scope by), so
-- "worker-write-only, app read-only" is enforced the only way that
-- actually works for a non-tenant table: Postgres GRANTs, not RLS.
-- venturelyx_app (every API request, every other worker) gets SELECT
-- only — the REVOKE below undoes the blanket `ALTER DEFAULT PRIVILEGES
-- ... GRANT ALL ON TABLES` from 001_platform_core.sql, same pattern
-- already used for audit_log. A new role, venturelyx_leadsource_worker,
-- is the only thing that can INSERT/UPDATE it — the ingest job connects
-- with that role's own DSN (LEADSOURCE_WORKER_DB_DSN), never the shared
-- app role.
--
-- leadsource_leads: per-tenant copy. Dedup is UNIQUE(org_id, source,
-- source_id) as a constraint, not application logic that could be
-- gotten wrong twice — the daily fan-out INSERTs ... ON CONFLICT DO
-- NOTHING. email/phone are NOT columns here on purpose: this source
-- never has them, and enrichment (a later, separate step) is where
-- they'd eventually be filled from something else.
--
-- leadsource_settings: one row per org, owner-editable. counties/
-- filing_types are text[] (config, not an enum — matches pipelines.stages'
-- own "config, not a hardcoded list" precedent in this schema).
--
-- leadsource_lead_detail: the view the leads list/export actually reads.
-- WITH (security_invoker = true) is not optional — 001_platform_core.sql's
-- own comment on this exact pattern explains why: without it, a view
-- executes as its OWNER (superuser) and bypasses RLS entirely, handing
-- every org's rows to any caller. This view is also what keeps
-- leadsource_raw_records's wide `raw` jsonb blob (which includes officer
-- home addresses) from ever being selected directly by the app role in
-- normal use — the view only ever projects the specific fields the leads
-- UI and CSV export are allowed to show.

BEGIN;

CREATE TABLE leadsource_raw_records (
  source        text NOT NULL,
  source_id     text NOT NULL,
  raw           jsonb NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source, source_id)
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'venturelyx_leadsource_worker') THEN
    CREATE ROLE venturelyx_leadsource_worker LOGIN PASSWORD 'CHANGE_ME_AT_DEPLOY' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO venturelyx_leadsource_worker;
GRANT SELECT, INSERT, UPDATE ON leadsource_raw_records TO venturelyx_leadsource_worker;
-- Undoes 001_platform_core.sql's blanket ALTER DEFAULT PRIVILEGES grant —
-- the app role (every API request) only ever reads this table.
REVOKE INSERT, UPDATE, DELETE ON leadsource_raw_records FROM venturelyx_app;

CREATE TABLE leadsource_leads (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  source         text NOT NULL,
  source_id      text NOT NULL,
  enrichment_status text NOT NULL DEFAULT 'new'
                 CHECK (enrichment_status IN ('new', 'enriching', 'enriched', 'skipped')),
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, source, source_id)
);
CREATE INDEX leadsource_leads_org_idx ON leadsource_leads (org_id, last_seen_at DESC);

CREATE TABLE leadsource_settings (
  org_id              uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  counties            text[] NOT NULL DEFAULT ARRAY['BROWARD', 'PALM BEACH']::text[],
  filing_types        text[] NOT NULL DEFAULT ARRAY['DOMP', 'FLAL', 'FORP', 'FORL']::text[],
  file_date_window_days int NOT NULL DEFAULT 7,
  include_dba         boolean NOT NULL DEFAULT false,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid REFERENCES users(id) ON DELETE SET NULL
);

CALL app.apply_tenant_rls();

-- security_invoker=true: this view must run with the CALLER's RLS, not
-- the view owner's bypass — see this file's own header.
CREATE VIEW leadsource_lead_detail WITH (security_invoker = true) AS
  SELECT
    l.id, l.org_id, l.source, l.source_id, l.enrichment_status,
    l.first_seen_at, l.last_seen_at,
    r.raw->>'corp_name'      AS business_name,
    r.raw->>'filing_type'    AS business_type,
    r.raw->>'addr1'          AS principal_address,
    r.raw->>'city'           AS principal_city,
    r.raw->>'state'          AS principal_state,
    r.raw->>'zip'            AS principal_zip,
    r.raw->>'file_date'      AS file_date,
    r.raw->>'ra_name'        AS registered_agent_name,
    r.raw->>'ra_type'        AS registered_agent_type,
    -- No officer fields projected here, ever — officer home addresses
    -- (and names) stay inside leadsource_raw_records.raw, reachable only
    -- by the worker role and platform staff, never through this view.
    NULL::text AS phone,
    NULL::text AS email
  FROM leadsource_leads l
  JOIN leadsource_raw_records r ON r.source = l.source AND r.source_id = l.source_id;

COMMIT;
