-- Venturelyx :: 009_grow
--
-- Schema for the Grow module (email outreach). Ported from the standalone
-- CampusPath engine at /opt/outreach/migrations/{001_init,002_step_variants}.sql
-- — same tables, same throttling/warmup logic, same partial indexes — adapted
-- to run as a module inside this multi-tenant app instead of its own isolated
-- single-tenant database. The standalone engine is untouched by this; nothing
-- here imports its data or code, and no data is migrated by this file.
--
-- Four things changed from the standalone version:
--
-- 1. tenant_id -> org_id throughout, referencing this app's organizations
--    instead of a Grow-local tenants table (which is dropped — Venturelyx's
--    organizations already play that role).
--
-- 2. Every table name is prefixed grow_. None of them carried a module
--    prefix standalone (campaigns, messages, events, contacts, ...) because
--    there was nothing else in that database to collide with. Here there
--    is — ScaleSEO's own tables set the precedent (seo_sites, seo_crawls,
--    seo_pages, ...) for exactly this reason.
--
-- 3. Mailbox credentials move into `integrations` (encryptSecret/
--    credential_enc/iv/tag, same as the Google Search Console connection in
--    api/src/routes/integrations.ts) instead of mailboxes.secret_ref, which
--    was a pointer to a name in a .env file — meaningless outside the
--    standalone engine's own process. grow_mailboxes.integration_id is a
--    plain FK; the row itself (provider = 'grow_mailbox', external_id =
--    the mailbox address, credential_enc/iv/tag = the SMTP/IMAP password)
--    is written by application code, not this migration.
--
-- 4. Contacts stay Grow-owned (grow_contacts) rather than becoming rows in
--    the shared `parties` table. parties/party_contacts already model
--    "someone who engaged with this business" and Operate's GET /parties
--    reads is_lead=true directly with no other filter — a 2,000+ row cold
--    prospecting import is not that, and dumping it into parties would
--    flood Operate's lead list with people who never asked to be there.
--    grow_contacts.party_id is a nullable FK, left unused — promoting a
--    contact to a real party (e.g. on a genuine reply) is explicitly out
--    of scope for this migration. And unlike the standalone schema, the
--    import-derived fields (tier, contact_rank, is_chain, domain_rank, the
--    Florida scholarship-program flags, ...) are typed columns here, not
--    jsonb — the scheduler groups and orders on several of these, and a
--    jsonb `attrs` also let the standalone importer write "True"/"False"
--    as literal strings for the scholarship flags instead of real
--    booleans, a bug real columns make impossible to repeat.
--
-- Also added, beyond a literal port, because every table in this app has
-- them: created_at/updated_at (+ the standard touch trigger) on every
-- table whose rows change after insert. grow_domain_policies didn't even
-- have created_at standalone; it does now.
--
-- One more addition beyond the requested table list: grow_sending_domains.
-- It isn't in the brief, but grow_mailboxes.domain_id references it in the
-- standalone schema (SPF/DKIM/DMARC verification per sending domain) and
-- there's no other table that could hold that — dropping it would leave
-- domain_id with nothing to point at. Flagging this explicitly since it
-- wasn't asked for by name.

BEGIN;

-- -----------------------------------------------------------------------------
-- Campaigns and sequences
-- -----------------------------------------------------------------------------

CREATE TABLE grow_campaigns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name          text NOT NULL,
  status        text NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','running','paused','stopped','done')),
  timezone      text NOT NULL DEFAULT 'America/New_York',
  window_start  time NOT NULL DEFAULT '08:30',
  window_end    time NOT NULL DEFAULT '15:30',
  weekdays_only boolean NOT NULL DEFAULT true,
  daily_target  int NOT NULL DEFAULT 100,
  pause_reason  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE grow_sequence_steps (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id     uuid NOT NULL REFERENCES grow_campaigns(id) ON DELETE CASCADE,
  step_no         int NOT NULL,
  delay_days      int NOT NULL DEFAULT 0,     -- days after the previous step
  applies_to_rank int,                        -- NULL = any contact rank
  subject_tmpl    text NOT NULL,
  body_tmpl       text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- One variant per rank, plus at most one catch-all (applies_to_rank IS NULL)
-- per step. Two partial indexes because NULL never equals NULL in a unique
-- constraint, so a single index would let duplicate catch-alls through.
-- (This is the end state 002_step_variants.sql arrived at standalone, after
-- relaxing an original bare UNIQUE(campaign_id, step_no); there's no bare
-- constraint to relax here since this table starts from that end state.)
CREATE UNIQUE INDEX grow_sequence_steps_ranked_uq
    ON grow_sequence_steps (campaign_id, step_no, applies_to_rank)
    WHERE applies_to_rank IS NOT NULL;
CREATE UNIQUE INDEX grow_sequence_steps_catchall_uq
    ON grow_sequence_steps (campaign_id, step_no)
    WHERE applies_to_rank IS NULL;

-- -----------------------------------------------------------------------------
-- Sending infrastructure (org brings its own mailboxes)
-- -----------------------------------------------------------------------------

CREATE TABLE grow_sending_domains (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  domain      text NOT NULL,
  provider    text NOT NULL CHECK (provider IN ('spacemail','google','microsoft','other')),
  spf_ok      boolean NOT NULL DEFAULT false,
  dkim_ok     boolean NOT NULL DEFAULT false,
  dmarc_ok    boolean NOT NULL DEFAULT false,
  verified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, domain)
);

CREATE TABLE grow_mailboxes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  domain_id      uuid NOT NULL REFERENCES grow_sending_domains(id) ON DELETE CASCADE,
  -- Credential vault row: integrations.credential_enc/iv/tag (encryptSecret,
  -- same as GSC) holds the SMTP/IMAP password. Convention: provider =
  -- 'grow_mailbox', external_id = this mailbox's address. Never a bare env
  -- var pointer — that only meant something inside the standalone engine's
  -- own process.
  integration_id uuid NOT NULL REFERENCES integrations(id) ON DELETE RESTRICT,
  address        text NOT NULL,
  from_name      text NOT NULL,
  reply_to       text,

  smtp_host      text NOT NULL,
  smtp_port      int  NOT NULL DEFAULT 465,
  imap_host      text,
  imap_port      int  DEFAULT 993,
  username       text NOT NULL,

  -- Warmup. Cap ramps with age; steady_cap is the ceiling after ramp.
  warmup_started_on date,
  steady_cap     int NOT NULL DEFAULT 25,
  status         text NOT NULL DEFAULT 'warming'
                 CHECK (status IN ('warming','active','paused','disabled')),
  last_health_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, address)
);

-- Per-recipient-domain daily caps. Most-specific match wins.
-- Consumer inboxes have a real spam button; Yahoo-family filtering is harsh.
CREATE TABLE grow_domain_policies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  domain      text NOT NULL,           -- '*' is the default rule
  daily_cap   int  NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, domain)
);

-- -----------------------------------------------------------------------------
-- Contacts and suppression
-- -----------------------------------------------------------------------------

CREATE TABLE grow_contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- Nullable FK to the shared CRM, left unused by this migration. Promoting
  -- a contact to a real `parties` row (e.g. on a genuine reply) is explicitly
  -- out of scope here — application logic for a later change, not this one.
  party_id      uuid REFERENCES parties(id) ON DELETE SET NULL,
  email         text NOT NULL,
  first_name    text,
  contact_name  text,
  role          text,
  contact_rank  int NOT NULL DEFAULT 1,

  entity_external_id text,
  entity_name   text,
  region        text,
  city          text,
  state         text,
  phone         text,

  recipient_domain text NOT NULL,
  is_free_provider boolean NOT NULL DEFAULT false,
  -- The imported entity's own headcount (a Florida school's student
  -- enrollment, standalone's tiering input) — unrelated to grow_enrollments
  -- below (a contact's position in a send sequence). Same word, two
  -- different things; inherited as-is from the standalone schema.
  enrollment    int,
  tier          text,
  -- Chain-collapse bookkeeping from the import/dedupe step (normalize.py):
  -- is_chain flags a business domain with many addresses (one org, not many
  -- prospects); domain_rank is this contact's rank within that domain by
  -- (contact_rank, enrollment). Kept as typed columns, not jsonb, for the
  -- same reason as the rest of this list — real columns the planner can
  -- group/order/index on, not per-row jsonb extraction on a hot path.
  is_chain      boolean NOT NULL DEFAULT false,
  domain_rank   int,

  -- Florida school-choice scholarship program eligibility flags (Family
  -- Empowerment Scholarship - Educational Options, Florida Tax Credit,
  -- Family Empowerment - Unique Abilities, Personalized Education Program).
  -- Specific to the CampusPath schools vertical, not a general Grow concept
  -- — a future org importing a non-schools list will just leave these null.
  -- Real boolean columns, not text in jsonb: the standalone version stored
  -- these as the literal strings "True"/"False" inside attrs, which is a
  -- bug (truthy-string comparisons, no type safety) fixed here by giving
  -- them an actual boolean type instead of carrying the bug forward.
  fes_eo        boolean,
  ftc           boolean,
  fes_ua        boolean,
  pep           boolean,
  non_profit    boolean,
  religious     boolean,

  attrs         jsonb NOT NULL DEFAULT '{}'::jsonb,

  source_profile text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, email)
);

CREATE INDEX grow_contacts_domain_idx ON grow_contacts (org_id, recipient_domain);
CREATE INDEX grow_contacts_entity_idx ON grow_contacts (org_id, entity_external_id);
CREATE INDEX grow_contacts_party_idx ON grow_contacts (party_id) WHERE party_id IS NOT NULL;

-- Global per org. Checked at send time, enforced at the platform layer so
-- an org cannot disable it.
CREATE TABLE grow_suppressions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email       text NOT NULL,
  reason      text NOT NULL CHECK (reason IN
              ('unsubscribed','hard_bounce','complaint','manual','chain_overflow')),
  -- Bare uuid, no FK, exactly as standalone: a suppression should outlive
  -- the campaign that caused it, including one that's since been deleted.
  campaign_id uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, email)
);

-- -----------------------------------------------------------------------------
-- Enrollments
-- -----------------------------------------------------------------------------

-- One row per contact per campaign. Holds sequence position and halt state.
CREATE TABLE grow_enrollments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id   uuid NOT NULL REFERENCES grow_campaigns(id) ON DELETE CASCADE,
  contact_id    uuid NOT NULL REFERENCES grow_contacts(id) ON DELETE CASCADE,
  state         text NOT NULL DEFAULT 'active'
                CHECK (state IN ('active','replied','bounced','unsubscribed',
                                 'completed','held','failed')),
  current_step  int NOT NULL DEFAULT 0,
  next_eligible_at timestamptz NOT NULL DEFAULT now(),
  -- Rank-2 contacts wait for rank 1 to go quiet before entering the queue.
  gated_on_contact_id uuid REFERENCES grow_contacts(id),
  priority      int NOT NULL DEFAULT 100,  -- lower sends first (tier A first)
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, contact_id)
);

CREATE INDEX grow_enrollments_due_idx
    ON grow_enrollments (org_id, campaign_id, state, next_eligible_at, priority);

-- -----------------------------------------------------------------------------
-- Send log
-- -----------------------------------------------------------------------------

CREATE TABLE grow_messages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id   uuid NOT NULL REFERENCES grow_campaigns(id) ON DELETE CASCADE,
  enrollment_id uuid NOT NULL REFERENCES grow_enrollments(id) ON DELETE CASCADE,
  contact_id    uuid NOT NULL REFERENCES grow_contacts(id) ON DELETE CASCADE,
  mailbox_id    uuid NOT NULL REFERENCES grow_mailboxes(id),
  step_no       int  NOT NULL,

  recipient_domain text NOT NULL,   -- denormalized: the throttle counts on this
  subject       text NOT NULL,
  body          text NOT NULL,

  status        text NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','sending','sent','failed',
                                  'bounced','cancelled')),
  scheduled_at  timestamptz NOT NULL,
  sent_at       timestamptz,
  smtp_message_id text,
  unsubscribe_token text NOT NULL DEFAULT encode(gen_random_bytes(18),'hex'),
  error         text,
  attempts      int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Drives the claim query.
CREATE INDEX grow_messages_due_idx ON grow_messages (status, scheduled_at)
    WHERE status = 'queued';
-- Drives both daily counters. Partial: only sent mail counts against quota.
CREATE INDEX grow_messages_mailbox_sent_idx ON grow_messages (mailbox_id, sent_at)
    WHERE status = 'sent';
CREATE INDEX grow_messages_domain_sent_idx
    ON grow_messages (org_id, recipient_domain, sent_at) WHERE status = 'sent';
CREATE UNIQUE INDEX grow_messages_unsub_idx ON grow_messages (unsubscribe_token);

CREATE TABLE grow_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  message_id  uuid REFERENCES grow_messages(id) ON DELETE SET NULL,
  contact_id  uuid REFERENCES grow_contacts(id) ON DELETE SET NULL,
  type        text NOT NULL CHECK (type IN
              ('sent','reply','bounce_hard','bounce_soft','complaint',
               'unsubscribe','auto_reply')),
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX grow_events_type_idx ON grow_events (org_id, type, occurred_at);

-- -----------------------------------------------------------------------------
-- Row level security — org_id present on every table above, so this one call
-- picks all of them up and applies the standard tenant_isolation policy
-- (FORCE ROW LEVEL SECURITY, USING/WITH CHECK org_id = app.current_org() OR
-- app.is_staff()). See db/migrations/006_fix_apply_tenant_rls.sql.
-- -----------------------------------------------------------------------------

CALL app.apply_tenant_rls();

-- updated_at maintenance on every table whose rows actually change after
-- insert. grow_messages, grow_events and grow_suppressions are append-once
-- (their own status/error/attempts fields track transitions directly, same
-- as seo_crawls) and deliberately don't get one, matching the standalone
-- schema and the rest of this app's own convention.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'grow_campaigns', 'grow_sequence_steps', 'grow_sending_domains',
    'grow_mailboxes', 'grow_domain_policies', 'grow_contacts', 'grow_enrollments'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER %I_touch BEFORE UPDATE ON %I
       FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()', t, t);
  END LOOP;
END $$;

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------

-- Warmup ramp: 5/day in week one, +5 each week, capped at steady_cap.
-- Unqualified (public schema, not app.) — this is Grow-specific business
-- logic, not a cross-module platform primitive like app.current_org() or
-- app.touch_updated_at(). No other module has defined its own function yet;
-- this is the first, and the precedent it sets is: module logic stays out
-- of the app schema.
CREATE OR REPLACE FUNCTION grow_mailbox_daily_cap(m grow_mailboxes, on_day date)
RETURNS int LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN m.status <> 'active' AND m.status <> 'warming' THEN 0
        WHEN m.warmup_started_on IS NULL THEN 0
        ELSE LEAST(
            m.steady_cap,
            5 * (1 + GREATEST(0, (on_day - m.warmup_started_on)) / 7)
        )
    END;
$$;

COMMIT;
