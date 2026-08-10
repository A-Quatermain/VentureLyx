-- =============================================================================
-- Venturelyx :: tenant isolation test
--
-- Run this against a scratch database after EVERY migration. If any test
-- fails, tenancy is broken and nothing else matters.
--
--   psql -U postgres -d venturelyx_test -f 001_platform_core.sql
--   psql -U postgres -d venturelyx_test -f 002_business_graph.sql
--   psql -U postgres -d venturelyx_test -f test/isolation_test.sql   (as superuser)
--   PGPASSWORD=... psql -U venturelyx_app -d venturelyx_test -f test/isolation_assert.sql
-- =============================================================================

-- ---- seed (superuser; RLS does not apply to superusers) ----
INSERT INTO organizations (id,slug,name) VALUES
 ('11111111-1111-1111-1111-111111111111','acme','Acme Pools'),
 ('22222222-2222-2222-2222-222222222222','rival','Rival Pools')
ON CONFLICT DO NOTHING;

INSERT INTO parties (org_id,display_name,is_customer) VALUES
 ('11111111-1111-1111-1111-111111111111','ACME CUSTOMER',true),
 ('22222222-2222-2222-2222-222222222222','RIVAL CUSTOMER',true);

INSERT INTO users (id,email,full_name) VALUES
 ('aaaaaaaa-0000-0000-0000-000000000001','a@acme.test','Acme Owner')
ON CONFLICT DO NOTHING;

INSERT INTO memberships (org_id,user_id,role) VALUES
 ('11111111-1111-1111-1111-111111111111','aaaaaaaa-0000-0000-0000-000000000001','owner')
ON CONFLICT DO NOTHING;

-- =============================================================================
-- Assertions below run AS venturelyx_app, not as superuser.
-- =============================================================================
\echo ''
\echo '=== T1  unscoped SELECT leaks nothing (the "forgot the WHERE" case) ==='
\echo '     EXPECT: only ACME CUSTOMER'
BEGIN;
SET LOCAL app.current_org = '11111111-1111-1111-1111-111111111111';
SET LOCAL app.user_id     = 'aaaaaaaa-0000-0000-0000-000000000001';
SET LOCAL app.is_staff    = 'off';
SELECT display_name FROM parties;

\echo ''
\echo '=== T2  cross-tenant INSERT is rejected ==='
\echo '     EXPECT: ERROR new row violates row-level security policy'
SAVEPOINT s1;
INSERT INTO parties (org_id,display_name)
VALUES ('22222222-2222-2222-2222-222222222222','INJECTED');
ROLLBACK TO s1;

\echo ''
\echo '=== T3  no org context returns zero rows, never all rows ==='
\echo '     EXPECT: 0'
SET LOCAL app.current_org = '';
SELECT count(*) AS rows_visible FROM parties;

\echo ''
\echo '=== T4  staff mode sees across tenants (agency view) ==='
\echo '     EXPECT: both rows'
SET LOCAL app.is_staff = 'on';
SELECT display_name FROM parties ORDER BY display_name;

\echo ''
\echo '=== T5  app role cannot tamper with the audit log ==='
\echo '     EXPECT: ERROR permission denied for table audit_log'
SAVEPOINT s2;
DELETE FROM audit_log;
ROLLBACK TO s2;

COMMIT;

\echo ''
\echo '=== T6  every org_id table has RLS enabled ==='
\echo '     EXPECT: zero rows'
SELECT c.relname AS UNPROTECTED_TABLE
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id'
WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relrowsecurity;

\echo ''
\echo '=== T7  no table carries duplicate overlapping policies ==='
\echo '     EXPECT: zero rows (permissive policies OR together)'
SELECT tablename, count(*) FROM pg_policies
WHERE schemaname='public' GROUP BY tablename HAVING count(*) > 1;
