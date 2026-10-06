-- Venturelyx :: 017_ai_answer_checks
--
-- Weekly sample of what a configured LLM says when asked a real local-search
-- query built from the org's own services and cities ("best pool service in
-- Parkland") — does it mention this business, roughly where, and which
-- competitors come up instead. One row per (org, query, provider, model,
-- week) so a trend is visible over time.
--
-- This is explicitly a SAMPLE of model responses on the day it was asked,
-- not a ranking, not a guarantee of placement, and not the same thing as
-- Google ranking position (seo_rank_current) or GSC's real search data
-- (seo_gsc_daily) — both of those are real observed data; this is one
-- model's answer to one prompt. The UI must say so every time this is
-- shown (api/src/routes/data.ts's /seo/ai-visibility, ScaleSEO's
-- "Get Found" tab) — never implied as something Venturelyx can get a
-- business "listed" in.

BEGIN;

CREATE TABLE ai_answer_checks (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  site_id         uuid NOT NULL REFERENCES seo_sites(id) ON DELETE CASCADE,
  query           text NOT NULL,
  provider        text NOT NULL,
  model           text NOT NULL,
  mentioned       boolean NOT NULL,
  position        smallint,              -- 1-based rank within the model's own
                                          -- recommended list, when it gave one; NULL
                                          -- when not mentioned or the response wasn't
                                          -- list-shaped
  competitors     text[] NOT NULL DEFAULT '{}',
  response_excerpt text,                 -- bounded, for transparency/audit — never
                                          -- the whole raw response
  checked_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ai_answer_checks_site_checked_idx ON ai_answer_checks (site_id, checked_at DESC);

-- Blanket RLS applier (001_platform_core.sql) — scans every table with an
-- org_id column and (re-)applies tenant_isolation, so this new table is
-- covered without hand-writing the policy.
CALL app.apply_tenant_rls();

COMMIT;
