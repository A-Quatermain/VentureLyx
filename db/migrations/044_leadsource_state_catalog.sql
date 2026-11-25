-- Venturelyx :: 044_leadsource_state_catalog
--
-- Replaces the static STATE_CATALOG array (leadSourceStateCatalog.ts)
-- with a real table, populated from the v2 design report's research.
-- Not a tenant table — there's no org_id, it's the same reference data
-- for everyone, same reason leadsource_raw_records has no RLS (nothing
-- to scope by). No app.apply_tenant_rls() call; default grants are fine
-- (read-only in practice — nothing in the API ever writes to this table).
--
-- `confirmed` is the honest-signal column the design asked for: true
-- ONLY for facts independently verified by direct inspection (byte
-- offsets fetched and parsed by hand), not merely read off an official
-- page. As of this migration, that's Florida alone — everything else
-- here came from reading the state's own site/docs (cited in
-- source_note) but was never independently tested the way FL's daily
-- file was in Phase 1.

BEGIN;

CREATE TABLE leadsource_state_catalog (
  state             char(2) PRIMARY KEY,
  name              text NOT NULL,
  access            text NOT NULL CHECK (access IN ('available', 'planned')),
  access_type       text,     -- 'free_daily' | 'free_open_data' | 'paid_subscription' | 'none_found'
  cadence           text,     -- null = unconfirmed/unclear
  format            text,     -- null = unconfirmed/unclear
  has_county_field  boolean,  -- null = unconfirmed
  cost_notes        text,
  terms_url         text,
  confirmed         boolean NOT NULL DEFAULT false,
  source_note       text NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

INSERT INTO leadsource_state_catalog
  (state, name, access, access_type, cadence, format, has_county_field, cost_notes, terms_url, confirmed, source_note)
VALUES
  ('FL', 'Florida', 'available', 'free_daily', 'daily (weekdays)', 'fixed-width, 1440 bytes/record (CRLF in the quarterly snapshot, LF in the daily file)',
   false, '$0', 'https://dos.fl.gov/sunbiz/other-services/data-downloads/', true,
   'Independently verified: SFTP download, byte-offset field layout confirmed by hand (Phase 1), quarterly snapshot format confirmed by hand (Phase 4).'),

  ('CT', 'Connecticut', 'planned', 'free_open_data', 'monthly (filing history replaced 1st of month)', 'CSV/JSON/XML/RDF via Socrata API',
   NULL, '$0', 'https://portal.ct.gov/SOTS/Business-Services/Bulk-Data-and-Images', false,
   'Read from the Secretary of the State''s own bulk-data page and data.ct.gov catalog listing (v2 design report research) — not independently fetched/parsed.'),

  ('OR', 'Oregon', 'planned', 'free_open_data', 'weekly', 'Socrata API, no auth required',
   NULL, '$0', 'https://sos.oregon.gov/business/public-Information-data', false,
   'Read from the Secretary of State''s public-data page and the Oregon open-data portal listing — not independently fetched/parsed.'),

  ('NY', 'New York', 'planned', 'free_open_data', NULL, 'CSV/JSON/XML/RDF via data.ny.gov (several linked datasets)',
   NULL, '$0', 'https://data.ny.gov/', false,
   'Read from the data.ny.gov catalog listing for Dept. of State business filings — refresh cadence not stated anywhere I found; not independently fetched/parsed.'),

  ('GA', 'Georgia', 'planned', 'paid_subscription', NULL, NULL,
   NULL, '$100 setup + $500/mo FTP subscription, or $1,000 one-time full-DB purchase (per the GTA bulk-data page)',
   'https://georgia.gov/bulk-corporations-data', false,
   'Read from the Georgia Technology Authority''s bulk-corporations-data page — file format and cadence not stated there; not independently fetched/parsed.'),

  ('KY', 'Kentucky', 'planned', 'paid_subscription', 'monthly (full DB + officers); daily for UCC only', 'tab-delimited',
   NULL, '~$2,000/mo cited by a third-party guide — NOT confirmed on sos.ky.gov itself', 'https://sos.ky.gov/bus/Pages/Bulk-Data-Service.aspx', false,
   'Read from the Secretary of State''s Bulk Data Service page; the price figure is third-party and unverified — flagged as such deliberately.'),

  ('NC', 'North Carolina', 'planned', 'paid_subscription', 'weekly', 'CSV, documented layout (2012-dated doc, may be stale)',
   NULL, '$750 one-time setup + $2,000/fiscal year', 'https://www.sosnc.gov/online_services/data_subscriptions', false,
   'Read from the NC Secretary of State''s Data Subscription Services pages and fee schedule — not independently fetched/parsed.'),

  ('SC', 'South Carolina', 'planned', 'paid_subscription', NULL, NULL,
   NULL, '$12,000/year for corporations bulk data, per an older state legislative report (FY2015-16 to FY2018-19) — current price unconfirmed',
   'https://scdgs.sc.gov/service/secretary-state-bulk-data-images-and-notary-registration', false,
   'Read from a SC House Legislative Oversight Committee report and the Secretary of State''s bulk-data page — pricing is dated, cadence not stated.'),

  ('TX', 'Texas', 'planned', 'paid_subscription', 'daily (30-day lookback) or weekly (8-week lookback) via SOSDirect', NULL,
   NULL, '$60/day of data (daily updates) or $20/week (weekly new-filing updates)', 'https://direct.sos.state.tx.us/help/help-corp.asp?pg=bulk', false,
   'Read from the Texas SOS''s own Help/Fees pages — not independently fetched/parsed.'),

  ('AL', 'Alabama', 'planned', 'none_found', NULL, NULL,
   NULL, NULL, 'https://www.sos.alabama.gov/business-entities/business-downloads', false,
   'No official bulk/open-data path found during research — only an unofficial third-party scraper, which was not pursued as a source.');

COMMIT;
