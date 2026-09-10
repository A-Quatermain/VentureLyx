-- seed_enrollments_campuspath.sql
--
-- Ported from /opt/outreach/seeds/seed_enrollments_campuspath.sql for the
-- Grow module. Changes from the standalone version:
--   * tenant_id -> org_id, enrollments/contacts/suppressions ->
--     grow_enrollments/grow_contacts/grow_suppressions.
--   * fes_eo is a real boolean column on grow_contacts now (009_grow.sql),
--     not (c.attrs->>'fes_eo')::boolean — the whole point of typed columns
--     here was to make that jsonb string-boolean pattern impossible to
--     repeat, so this reads c.fes_eo directly.
--   * GUC is app.current_org, matching 001_platform_core.sql /
--     006_fix_apply_tenant_rls.sql — not app.tenant_id.
--   * One variable convention throughout: pass -v values bare, reference as
--     :'name'::uuid. The standalone pair of files disagreed with each other
--     on whether -v values arrived pre-quoted; this file (and its sibling)
--     settle on the same convention so there's nothing to get backwards.
--
-- Enrolls contacts into the campaign, sets send priority, and gates rank-2
-- contacts behind their rank-1 colleague at the same school.
--
-- Run the VERIFY block at the bottom, as the app role (not superuser) —
-- RLS is what actually proves these rows are scoped to one org, and a
-- superuser session bypasses RLS entirely, so counts taken as superuser
-- would pass even if org scoping were silently broken.
--
-- Usage:
--   psql "$DATABASE_URL" -v org=<org-uuid> -v campaign=<campaign-uuid> \
--        -f seed_enrollments_campuspath.sql

BEGIN;

SET LOCAL app.current_org = :'org';

-- ---------------------------------------------------------------------------
-- Priority. Lower sends first. planTick orders by priority, then due time.
--
-- Not sorted by size. The largest independents (2,000+ students) mostly run
-- Blackbaud or FACTS already; the 101-250 band has real operational pain and
-- no budget for enterprise SIS, so it leads. Zero-enrollment schools are the
-- 177 that skipped the state survey — worth contacting, but last.
-- ---------------------------------------------------------------------------

INSERT INTO grow_enrollments
    (org_id, campaign_id, contact_id, state, current_step,
     next_eligible_at, priority, gated_on_contact_id)
SELECT
    c.org_id,
    :'campaign'::uuid,
    c.id,
    'active',
    0,
    now(),
    CASE
        WHEN COALESCE(c.enrollment, 0) = 0    THEN 20000  -- no data reported
        WHEN c.enrollment <= 50               THEN 10000  -- under the pricing floor
        WHEN c.enrollment <= 100              THEN  2000
        WHEN c.enrollment <= 250              THEN     0  -- lead with this band
        WHEN c.enrollment <= 500              THEN  1000
        WHEN c.enrollment <= 1000             THEN  3000
        ELSE                                        4000  -- likely already tooled
    END
    -- Schools on state scholarship programs carry reporting burden, which is
    -- what step 2 speaks to. Small nudge forward within their band.
    - CASE WHEN COALESCE(c.fes_eo, false) THEN 100 ELSE 0 END,

    -- Rank 2 waits for rank 1 at the same school to reach a terminal state.
    -- NULL where the school has no rank-1 contact, so those send immediately.
    CASE WHEN c.contact_rank = 2 THEN (
        SELECT r1.id FROM grow_contacts r1
         WHERE r1.org_id = c.org_id
           AND r1.entity_external_id = c.entity_external_id
           AND r1.contact_rank = 1
         LIMIT 1
    ) END

FROM grow_contacts c
WHERE c.org_id = :'org'::uuid
  -- Never enroll anyone already suppressed. This catches the 59 chain-overflow
  -- rows the importer wrote, plus any unsubscribe or bounce added since.
  AND NOT EXISTS (
        SELECT 1 FROM grow_suppressions s
         WHERE s.org_id = c.org_id AND s.email = c.email)
ON CONFLICT (campaign_id, contact_id) DO NOTHING;

COMMIT;

-- ---------------------------------------------------------------------------
-- VERIFY — run these as the app role (SET app.current_org first, no
-- superuser), before and after.
-- ---------------------------------------------------------------------------
--
-- Expected from the source data (2,023 sendable contacts):
--   total enrolled ............ 2023
--   rank 1 .................... 1398
--   rank 2 .................... 625
--   rank 2 gated .............. 606
--   rank 2 ungated ............   19   (school has no rank-1 contact)
--   priority band 0 ...........  407   (101-250 students, the first wave)
--
-- SELECT set_config('app.current_org', '<org-uuid>', false);
--
-- SELECT count(*) AS enrolled,
--        count(*) FILTER (WHERE gated_on_contact_id IS NOT NULL) AS gated
--   FROM grow_enrollments;
--
-- SELECT c.contact_rank, e.priority, count(*)
--   FROM grow_enrollments e JOIN grow_contacts c ON c.id = e.contact_id
--  GROUP BY 1, 2 ORDER BY 2, 1;
--
-- Nobody enrolled who is suppressed (must return 0):
-- SELECT count(*) FROM grow_enrollments e
--   JOIN grow_contacts c ON c.id = e.contact_id
--   JOIN grow_suppressions s ON s.email = c.email AND s.org_id = c.org_id;
--
-- No self-gating (must return 0):
-- SELECT count(*) FROM grow_enrollments WHERE gated_on_contact_id = contact_id;
