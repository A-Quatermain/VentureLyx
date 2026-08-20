-- =============================================================================
-- 006_fix_apply_tenant_rls.sql
--
-- app.apply_tenant_rls() (001_platform_core.sql) blindly applies the generic
-- tenant_isolation policy to every table with an org_id column. sessions and
-- job_queue are deliberately given stricter, differently-named policies
-- instead (session_self, queue_access) — 001's own comment on session_self
-- explains why: tenant_isolation would let any org member see every other
-- member's sessions. Policies on the same table OR together, so re-running
-- apply_tenant_rls() (005_ai_usage.sql just did, to pick up ai_usage) put
-- tenant_isolation back next to session_self/queue_access and silently
-- widened access back to the exact thing 001 overrode it to prevent.
--
-- Fix at the source: skip a table if it already carries a policy that
-- is not tenant_isolation. Any future migration that calls this procedure
-- again (to cover a newly added table) can no longer reintroduce this.
-- =============================================================================

BEGIN;

CREATE OR REPLACE PROCEDURE app.apply_tenant_rls()
LANGUAGE plpgsql AS $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.relname AS tbl
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id' AND a.attnum > 0
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND NOT EXISTS (
        SELECT 1 FROM pg_policies p
         WHERE p.schemaname = 'public' AND p.tablename = c.relname
           AND p.policyname <> 'tenant_isolation'
      )
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tbl);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t.tbl);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t.tbl);
    EXECUTE format($p$
      CREATE POLICY tenant_isolation ON public.%I
        USING (org_id = app.current_org() OR app.is_staff())
        WITH CHECK (org_id = app.current_org() OR app.is_staff())
    $p$, t.tbl);
    RAISE NOTICE 'RLS applied: %', t.tbl;
  END LOOP;
END $$;

-- Undo the regression 005_ai_usage.sql's CALL just introduced.
DROP POLICY IF EXISTS tenant_isolation ON sessions;
DROP POLICY IF EXISTS tenant_isolation ON job_queue;

COMMIT;
