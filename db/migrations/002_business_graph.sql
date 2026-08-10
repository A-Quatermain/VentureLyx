-- =============================================================================
-- Venturelyx :: 002_business_graph
--
-- The shared domain model. Modules (Build, Source, Operate, ScaleSEO, Grow,
-- AI Team) are feature surfaces over THESE tables. No module gets its own
-- contacts, its own services, or its own locations.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- PARTIES — every person or company, one table, role flags not role tables.
-- A supplier sourced in Source can later become a customer in Operate and the
-- record follows them. Separate tables make that a data migration.
-- -----------------------------------------------------------------------------
CREATE TYPE app.party_kind AS ENUM ('person','company');

CREATE TABLE parties (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind           app.party_kind NOT NULL DEFAULT 'person',
  display_name   text NOT NULL,
  first_name     text,
  last_name      text,
  company_name   text,

  -- role flags
  is_lead        boolean NOT NULL DEFAULT false,
  is_customer    boolean NOT NULL DEFAULT false,
  is_vendor      boolean NOT NULL DEFAULT false,
  is_supplier    boolean NOT NULL DEFAULT false,
  is_contractor  boolean NOT NULL DEFAULT false,

  lifecycle      text NOT NULL DEFAULT 'new',   -- new|working|qualified|customer|lost|dormant
  owner_user_id  uuid REFERENCES users(id) ON DELETE SET NULL,

  -- denormalised attribution (full history in attribution_touches)
  first_touch_id uuid,
  last_touch_id  uuid,

  address_line1  text,
  address_line2  text,
  city           text,
  region         text,
  postal_code    text,
  country        char(2) NOT NULL DEFAULT 'US',
  latitude       numeric(9,6),
  longitude      numeric(9,6),

  location_id    uuid,                          -- FK added after locations
  tags           text[] NOT NULL DEFAULT '{}',
  custom         jsonb  NOT NULL DEFAULT '{}'::jsonb,
  notes          text,

  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);
CREATE INDEX ON parties (org_id, lifecycle) WHERE deleted_at IS NULL;
CREATE INDEX ON parties (org_id, is_customer) WHERE is_customer AND deleted_at IS NULL;
CREATE INDEX ON parties (org_id, is_supplier) WHERE is_supplier AND deleted_at IS NULL;
CREATE INDEX ON parties (org_id, last_activity_at DESC);
CREATE INDEX parties_name_trgm ON parties USING gin (display_name gin_trgm_ops);

-- Contact points. Multiple emails/phones per party, one primary each.
CREATE TYPE app.contact_channel AS ENUM ('email','phone','sms','whatsapp','url');

CREATE TABLE party_contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  party_id    uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  channel     app.contact_channel NOT NULL,
  value       text NOT NULL,
  label       text,                              -- 'work','mobile','billing'
  is_primary  boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  opted_out_at timestamptz,                      -- consent tracking, TCPA/CAN-SPAM
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, party_id, channel, value)
);
CREATE INDEX ON party_contacts (org_id, channel, value);
CREATE UNIQUE INDEX ON party_contacts (party_id, channel) WHERE is_primary;

-- -----------------------------------------------------------------------------
-- LOCATIONS — service areas. Powers dispatch, local rank grids, city pages.
-- This is gen/cities.json promoted to a first-class entity.
-- -----------------------------------------------------------------------------
CREATE TABLE locations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name          text NOT NULL,                   -- 'Coral Springs'
  slug          text NOT NULL,                   -- 'coral-springs'
  region        text,                            -- 'FL'
  country       char(2) NOT NULL DEFAULT 'US',
  postal_codes  text[] NOT NULL DEFAULT '{}',
  latitude      numeric(9,6),
  longitude     numeric(9,6),
  radius_miles  numeric(6,2),
  population    int,
  is_primary    boolean NOT NULL DEFAULT false,  -- HQ / main service city
  is_active     boolean NOT NULL DEFAULT true,
  priority      smallint NOT NULL DEFAULT 100,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);

ALTER TABLE parties
  ADD CONSTRAINT parties_location_fk
  FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- CATALOG — what the business sells. Feeds quote lines, the SEO opportunity
-- matrix, page generation, and RFQ lines. gen/services.json promoted.
-- -----------------------------------------------------------------------------
CREATE TYPE app.catalog_kind AS ENUM ('service','product','package','fee');

CREATE TABLE catalog_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind           app.catalog_kind NOT NULL DEFAULT 'service',
  name           text NOT NULL,                  -- 'Pool Heater Repair'
  slug           text NOT NULL,                  -- 'pool-heater-repair'
  description    text,
  sku            text,
  parent_id      uuid REFERENCES catalog_items(id) ON DELETE SET NULL,
  unit           text NOT NULL DEFAULT 'each',
  unit_price     numeric(12,2),
  cost           numeric(12,2),
  taxable        boolean NOT NULL DEFAULT true,
  duration_min   int,                            -- scheduling
  is_active      boolean NOT NULL DEFAULT true,
  seo_keywords   text[] NOT NULL DEFAULT '{}',   -- seed terms for the matrix
  priority       smallint NOT NULL DEFAULT 100,
  custom         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);

-- -----------------------------------------------------------------------------
-- MARKET TARGETS — catalog_item × location.
-- Simultaneously: the SEO opportunity matrix, the dispatch model, and the
-- vertical templates. One concept serving three modules.
-- -----------------------------------------------------------------------------
CREATE TABLE market_targets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  catalog_item_id   uuid NOT NULL REFERENCES catalog_items(id) ON DELETE CASCADE,
  location_id       uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  primary_keyword   text,                        -- 'pool heater repair parkland fl'
  target_url        text,                        -- '/pool-heater-repair-parkland-fl'
  content_id        uuid,                        -- FK added after content_pages
  is_served         boolean NOT NULL DEFAULT true,   -- do they actually work here
  status            text NOT NULL DEFAULT 'identified',
                    -- identified|planned|building|published|ranking
  search_volume     int,
  difficulty        smallint,
  est_value_monthly numeric(12,2),
  current_position  numeric(5,1),
  best_position     numeric(5,1),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, catalog_item_id, location_id)
);
CREATE INDEX ON market_targets (org_id, status);
CREATE INDEX ON market_targets (org_id, est_value_monthly DESC NULLS LAST);

-- -----------------------------------------------------------------------------
-- ATTRIBUTION — carried from first touch through to the paid invoice.
-- This is why "SEO generated $18,340" is computable. It must exist from day one;
-- retrofitting makes all historical data worthless.
-- -----------------------------------------------------------------------------
CREATE TABLE attribution_touches (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  party_id       uuid REFERENCES parties(id) ON DELETE CASCADE,
  anon_id        text,                           -- cookie before identification
  source         text,                           -- 'google','direct','facebook'
  medium         text,                           -- 'organic','cpc','referral'
  campaign       text,
  content        text,
  term           text,                           -- keyword when available
  landing_url    text,
  referrer_url   text,
  gclid          text,
  channel        text,                           -- rolled up: 'seo','paid','social'
  market_target_id uuid REFERENCES market_targets(id) ON DELETE SET NULL,
  device         text,
  ip             inet,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON attribution_touches (org_id, party_id, occurred_at);
CREATE INDEX ON attribution_touches (org_id, anon_id) WHERE party_id IS NULL;
CREATE INDEX ON attribution_touches (org_id, channel, occurred_at DESC);

ALTER TABLE parties
  ADD CONSTRAINT parties_first_touch_fk FOREIGN KEY (first_touch_id)
    REFERENCES attribution_touches(id) ON DELETE SET NULL,
  ADD CONSTRAINT parties_last_touch_fk  FOREIGN KEY (last_touch_id)
    REFERENCES attribution_touches(id) ON DELETE SET NULL;

-- -----------------------------------------------------------------------------
-- TIMELINE — append-only event log per party. Form fills, calls, texts, emails,
-- reviews, job completions, payments, and every AI action land here.
-- This is what makes Command Center and the AI personas informed.
-- -----------------------------------------------------------------------------
CREATE TABLE timeline_events (
  id            bigserial PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  party_id      uuid REFERENCES parties(id) ON DELETE CASCADE,
  event_type    text NOT NULL,                   -- 'form.submitted','call.inbound'
  module        text,                            -- 'operate','scaleseo','ai_team'
  title         text NOT NULL,
  body          text,
  actor_type    text NOT NULL DEFAULT 'system',  -- user|system|ai_persona|customer
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_label   text,
  entity_type   text,                            -- 'deal','invoice','work_order'
  entity_id     uuid,
  direction     text,                            -- inbound|outbound
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON timeline_events (org_id, party_id, occurred_at DESC);
CREATE INDEX ON timeline_events (org_id, event_type, occurred_at DESC);
CREATE INDEX ON timeline_events (org_id, occurred_at DESC);

-- -----------------------------------------------------------------------------
-- DEALS — sales pipeline. Named `deals` so `opportunities` stays reserved for
-- the intelligence layer (growth_opportunities).
-- -----------------------------------------------------------------------------
CREATE TABLE pipelines (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       text NOT NULL,
  stages     jsonb NOT NULL,   -- [{key,label,probability,is_won,is_lost}]
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE deals (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  pipeline_id     uuid REFERENCES pipelines(id) ON DELETE SET NULL,
  party_id        uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  title           text NOT NULL,
  stage           text NOT NULL DEFAULT 'new',
  status          text NOT NULL DEFAULT 'open',  -- open|won|lost
  value           numeric(12,2),
  probability     smallint,
  owner_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  source_touch_id uuid REFERENCES attribution_touches(id) ON DELETE SET NULL,
  expected_close  date,
  closed_at       timestamptz,
  lost_reason     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON deals (org_id, status, stage);
CREATE INDEX ON deals (org_id, party_id);

-- -----------------------------------------------------------------------------
-- WORK — field service. `work_orders`, never `jobs` (that is the task queue).
-- -----------------------------------------------------------------------------
CREATE TABLE work_orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  party_id        uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  deal_id         uuid REFERENCES deals(id) ON DELETE SET NULL,
  number          text,
  title           text NOT NULL,
  description     text,
  status          text NOT NULL DEFAULT 'scheduled',
                  -- scheduled|dispatched|in_progress|complete|cancelled
  location_id     uuid REFERENCES locations(id) ON DELETE SET NULL,
  address_line1   text,
  city            text,
  region          text,
  postal_code     text,
  scheduled_start timestamptz,
  scheduled_end   timestamptz,
  started_at      timestamptz,
  completed_at    timestamptz,
  assigned_to     uuid REFERENCES users(id) ON DELETE SET NULL,
  signature_file  uuid REFERENCES files(id) ON DELETE SET NULL,
  recurrence      jsonb,                         -- weekly pool service etc.
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);
CREATE INDEX ON work_orders (org_id, status, scheduled_start);
CREATE INDEX ON work_orders (org_id, assigned_to, scheduled_start);

CREATE TABLE work_order_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  work_order_id   uuid NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
  catalog_item_id uuid REFERENCES catalog_items(id) ON DELETE SET NULL,
  description     text NOT NULL,
  quantity        numeric(12,3) NOT NULL DEFAULT 1,
  unit_price      numeric(12,2) NOT NULL DEFAULT 0,
  position        smallint NOT NULL DEFAULT 0
);

-- -----------------------------------------------------------------------------
-- MONEY — quotes, invoices, payments, expenses.
-- Amounts are numeric(12,2); cents-as-integers is the alternative but numeric
-- keeps accounting-integration mapping honest.
-- -----------------------------------------------------------------------------
CREATE TABLE quotes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  party_id     uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  deal_id      uuid REFERENCES deals(id) ON DELETE SET NULL,
  number       text,
  status       text NOT NULL DEFAULT 'draft',  -- draft|sent|accepted|declined|expired
  subtotal     numeric(12,2) NOT NULL DEFAULT 0,
  tax          numeric(12,2) NOT NULL DEFAULT 0,
  total        numeric(12,2) NOT NULL DEFAULT 0,
  valid_until  date,
  sent_at      timestamptz,
  accepted_at  timestamptz,
  terms        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);

CREATE TABLE quote_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  quote_id        uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  catalog_item_id uuid REFERENCES catalog_items(id) ON DELETE SET NULL,
  description     text NOT NULL,
  quantity        numeric(12,3) NOT NULL DEFAULT 1,
  unit_price      numeric(12,2) NOT NULL DEFAULT 0,
  taxable         boolean NOT NULL DEFAULT true,
  position        smallint NOT NULL DEFAULT 0
);

CREATE TABLE invoices (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  party_id      uuid NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
  quote_id      uuid REFERENCES quotes(id) ON DELETE SET NULL,
  work_order_id uuid REFERENCES work_orders(id) ON DELETE SET NULL,
  deal_id       uuid REFERENCES deals(id) ON DELETE SET NULL,
  number        text,
  status        text NOT NULL DEFAULT 'draft',  -- draft|sent|partial|paid|void|overdue
  subtotal      numeric(12,2) NOT NULL DEFAULT 0,
  tax           numeric(12,2) NOT NULL DEFAULT 0,
  total         numeric(12,2) NOT NULL DEFAULT 0,
  amount_paid   numeric(12,2) NOT NULL DEFAULT 0,
  issued_on     date,
  due_on        date,
  paid_at       timestamptz,
  external_ref  text,                            -- QuickBooks / Xero id
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, number)
);
CREATE INDEX ON invoices (org_id, status, due_on);

CREATE TABLE invoice_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invoice_id      uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  catalog_item_id uuid REFERENCES catalog_items(id) ON DELETE SET NULL,
  description     text NOT NULL,
  quantity        numeric(12,3) NOT NULL DEFAULT 1,
  unit_price      numeric(12,2) NOT NULL DEFAULT 0,
  taxable         boolean NOT NULL DEFAULT true,
  position        smallint NOT NULL DEFAULT 0
);

CREATE TABLE payments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  invoice_id    uuid REFERENCES invoices(id) ON DELETE SET NULL,
  party_id      uuid REFERENCES parties(id) ON DELETE SET NULL,
  amount        numeric(12,2) NOT NULL,
  method        text,                            -- card|ach|cash|check
  processor     text,                            -- stripe|square|manual
  processor_ref text,
  status        text NOT NULL DEFAULT 'succeeded',
  received_at   timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON payments (org_id, received_at DESC);

CREATE TABLE expenses (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  party_id     uuid REFERENCES parties(id) ON DELETE SET NULL,  -- vendor
  category     text,
  description  text,
  amount       numeric(12,2) NOT NULL,
  incurred_on  date NOT NULL DEFAULT current_date,
  receipt_file uuid REFERENCES files(id) ON DELETE SET NULL,
  external_ref text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- CONTENT — pages, posts, generated drafts. Shared by Build, ScaleSEO, Grow.
-- -----------------------------------------------------------------------------
CREATE TABLE content_pages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  market_target_id uuid REFERENCES market_targets(id) ON DELETE SET NULL,
  kind             text NOT NULL DEFAULT 'service_page',  -- service_page|blog|landing
  url              text,
  slug             text,
  title            text,
  meta_description text,
  h1               text,
  body             text,
  schema_jsonld    jsonb,
  status           text NOT NULL DEFAULT 'draft',
                   -- draft|ai_generated|awaiting_approval|approved|published
  generated_by     text,                          -- 'ai:seo_specialist'
  approved_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at      timestamptz,
  published_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON content_pages (org_id, status);

ALTER TABLE market_targets
  ADD CONSTRAINT market_targets_content_fk
  FOREIGN KEY (content_id) REFERENCES content_pages(id) ON DELETE SET NULL;

CREATE TABLE documents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  party_id    uuid REFERENCES parties(id) ON DELETE SET NULL,
  file_id     uuid REFERENCES files(id) ON DELETE SET NULL,
  kind        text,                              -- 'contract','blueprint','rfq'
  title       text NOT NULL,
  status      text NOT NULL DEFAULT 'active',
  visible_to_client boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- INTELLIGENCE LAYER — one engine, not per-module logic.
-- signals -> growth_opportunities -> actions -> approval -> execution
-- -----------------------------------------------------------------------------
CREATE TABLE signals (
  id           bigserial PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  module       text NOT NULL,
  signal_type  text NOT NULL,   -- 'page.deindexed','lead.stale','review.unanswered'
  severity     smallint NOT NULL DEFAULT 3,   -- 1 critical .. 5 info
  entity_type  text,
  entity_id    uuid,
  summary      text NOT NULL,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  detected_at  timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  dedupe_key   text
);
CREATE INDEX ON signals (org_id, severity, detected_at DESC) WHERE resolved_at IS NULL;
CREATE UNIQUE INDEX ON signals (org_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND resolved_at IS NULL;

CREATE TABLE growth_opportunities (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  module          text NOT NULL,
  kind            text NOT NULL,   -- 'seo.new_page','ops.follow_up','rep.review_push'
  title           text NOT NULL,
  rationale       text,
  est_value_monthly numeric(12,2),
  effort          text,            -- low|medium|high
  confidence      smallint,        -- 0-100
  score           numeric(8,2),    -- ranking score for Command Center
  entity_type     text,
  entity_id       uuid,
  status          text NOT NULL DEFAULT 'open',
                  -- open|accepted|in_progress|done|dismissed
  dismissed_reason text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON growth_opportunities (org_id, status, score DESC NULLS LAST);

CREATE TABLE actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  opportunity_id  uuid REFERENCES growth_opportunities(id) ON DELETE CASCADE,
  action_type     text NOT NULL,   -- 'content.generate','email.send','meta.fix'
  params          jsonb NOT NULL DEFAULT '{}'::jsonb,
  requires_approval boolean NOT NULL DEFAULT true,
  status          text NOT NULL DEFAULT 'proposed',
                  -- proposed|approved|rejected|executing|done|failed
  proposed_by     text,            -- 'ai:seo_specialist' | 'system'
  approved_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at     timestamptz,
  job_id          bigint REFERENCES job_queue(id) ON DELETE SET NULL,
  result          jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON actions (org_id, status);

COMMIT;

-- =============================================================================
-- Apply RLS to everything added above, then updated_at triggers.
-- =============================================================================
BEGIN;
CALL app.apply_tenant_rls();

-- apply_tenant_rls() is idempotent and re-adds tenant_isolation to any table
-- with org_id, including ones with bespoke policies. Re-assert those here.
DROP POLICY IF EXISTS tenant_isolation ON sessions;
DROP POLICY IF EXISTS tenant_isolation ON job_queue;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'parties','locations','catalog_items','market_targets','deals',
    'work_orders','quotes','invoices','content_pages',
    'growth_opportunities','actions'
  ] LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_touch BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()', t, t);
  END LOOP;
END $$;
COMMIT;

-- =============================================================================
-- Verification — run after migrating. Any table listed here is UNPROTECTED.
-- =============================================================================
-- SELECT c.relname AS unprotected_table
-- FROM pg_class c
-- JOIN pg_namespace n ON n.oid = c.relnamespace
-- JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id'
-- WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity;
