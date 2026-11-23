-- Venturelyx :: 042_leadsource_enrichment
--
-- Phase 3 of LeadSource v2. One row per lead, each field carrying its own
-- source/found_at (and, for email, a verify status/timestamp) — per the
-- v2 design report's explicit requirement that every enriched field be
-- independently attributable, never a single opaque "enriched" blob.
--
-- status is the overall rollup, but it can only ever reach 'enriched' via
-- app.py's own logic gate (see workers/leadsource/enrich.py) — never a
-- column a caller can set directly to something stronger than what was
-- actually verified. In particular: an email that was FOUND but could not
-- be run through ZeroBounce (balance exhausted, API error) is persisted
-- as email_verify_status = 'found_unverified', and a lead in that state
-- can never be 'enriched' — only 'partial'. That distinction is the whole
-- point of this column existing separately from a plain boolean.

BEGIN;

CREATE TABLE leadsource_enrichment (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id                 uuid NOT NULL UNIQUE REFERENCES leadsource_leads(id) ON DELETE CASCADE,
  org_id                  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  is_virtual_or_agent_address boolean NOT NULL DEFAULT false,

  -- website_found is the real "did we locate and self-confirm a site"
  -- signal; website_url is populated ONLY when the URL itself is ours to
  -- keep. A site found via Brave Search and then self-confirmed by
  -- visiting it still can't have its URL persisted here — Brave's Search
  -- API terms (3(b)(i)) bar storing/caching Search Results, including
  -- result URLs, beyond transient use during the one operation that found
  -- them. website_source = 'search_transient' is exactly that case:
  -- found_at and found=true are recorded, website_url stays NULL. Only
  -- website_source = 'domain_guess' (a URL we guessed and fetched
  -- ourselves, nothing from a third-party search result) ever populates
  -- website_url.
  website_found            boolean NOT NULL DEFAULT false,
  website_url              text,
  website_source           text CHECK (website_source IS NULL OR website_source IN ('domain_guess', 'search_transient')),
  website_confidence       text CHECK (website_confidence IS NULL OR website_confidence IN ('confirmed', 'unconfirmed')),
  website_found_at         timestamptz,

  email                   text,
  email_source            text,    -- 'own_site'
  email_found_at          timestamptz,
  email_verify_status     text CHECK (email_verify_status IS NULL OR email_verify_status IN ('valid', 'risky', 'unknown', 'found_unverified')),
  email_verified_at       timestamptz,

  phone                   text,
  phone_source            text,    -- 'own_site'
  phone_found_at          timestamptz,

  status                  text NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending', 'no_website', 'partial', 'enriched', 'error')),
  attempt_count            int NOT NULL DEFAULT 0,
  last_attempted_at        timestamptz,
  next_recheck_at          timestamptz,
  last_error               text,

  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX leadsource_enrichment_org_idx ON leadsource_enrichment (org_id);
CREATE INDEX leadsource_enrichment_recheck_idx ON leadsource_enrichment (next_recheck_at) WHERE next_recheck_at IS NOT NULL;

CALL app.apply_tenant_rls();

COMMIT;
