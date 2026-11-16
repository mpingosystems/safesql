-- Sprint 9.6-RLS — read-only checks. Run AFTER applying
-- supabase/migrations/20261115000000_fix_team_members_rls_recursion.sql.
--
-- Part 1 is one query returning one table: check_name | expected | actual | pass.
-- Every row should show pass = true. Nothing here writes data.

WITH expected_policies(tablename, policyname, cmd) AS (
  VALUES
    ('approval_policies', 'approval_policies_team_read',            'SELECT'),
    ('approval_requests', 'approval_requests_requester_insert',     'INSERT'),
    ('approval_requests', 'approval_requests_team_read',            'SELECT'),
    ('audit_events',      'audit_events_team_read',                 'SELECT'),
    ('audit_log',         'audit_log_team_read',                    'SELECT'),
    ('custom_rules',      'custom_rules_team_read',                 'SELECT'),
    ('evidence_bundles',  'evidence_bundles_team_read',             'SELECT'),
    ('saved_queries',     'team members read shared queries',       'SELECT'),
    ('team_invitations',  'invitees read own invitation',           'SELECT'),
    ('team_invitations',  'managers create invitations',            'INSERT'),
    ('team_members',      'managers delete members',                'DELETE'),
    ('team_members',      'managers manage members',                'UPDATE'),
    ('team_members',      'team members read members',              'SELECT'),
    ('teams',             'team managers update team',              'UPDATE'),
    ('teams',             'team members read team',                 'SELECT'),
    ('validations',       'Team members can view team validations', 'SELECT')
),
live AS (
  SELECT p.*, e.cmd AS expected_cmd
    FROM expected_policies e
    LEFT JOIN pg_policies p
      ON p.schemaname = 'public' AND p.tablename = e.tablename AND p.policyname = e.policyname
),
helpers(proname, args) AS (
  VALUES ('my_team_ids', ''), ('my_team_ids', 'roles text[]'), ('my_joined_team_ids', '')
),
fn AS (
  SELECT h.proname, h.args, p.oid, p.prosecdef, p.provolatile, p.proconfig,
         r.rolbypassrls AS owner_bypassrls
    FROM helpers h
    LEFT JOIN pg_namespace n ON n.nspname = 'private'
    LEFT JOIN pg_proc p
      ON p.pronamespace = n.oid AND p.proname = h.proname
     AND pg_get_function_identity_arguments(p.oid) = h.args
    LEFT JOIN pg_roles r ON r.oid = p.proowner
)
SELECT 'A. policies in public that read team_members directly' AS check_name,
       '0' AS expected,
       (SELECT count(*) FROM pg_policies
         WHERE schemaname = 'public'
           AND (coalesce(qual, '')       ~* 'from\s+(public\.)?team_members'
             OR coalesce(with_check, '') ~* 'from\s+(public\.)?team_members'))::text AS actual,
       (SELECT count(*) FROM pg_policies
         WHERE schemaname = 'public'
           AND (coalesce(qual, '')       ~* 'from\s+(public\.)?team_members'
             OR coalesce(with_check, '') ~* 'from\s+(public\.)?team_members')) = 0 AS pass
UNION ALL
SELECT 'B. rebuilt policies present (of 16)', '16',
       (SELECT count(*) FROM live WHERE policyname IS NOT NULL)::text,
       (SELECT count(*) FROM live WHERE policyname IS NOT NULL) = 16
UNION ALL
SELECT 'C. rebuilt policies missing (names)', '(none)',
       coalesce((SELECT string_agg(e.tablename || '.' || e.policyname, ', ')
                   FROM expected_policies e
                   LEFT JOIN pg_policies p
                     ON p.schemaname = 'public' AND p.tablename = e.tablename
                    AND p.policyname = e.policyname
                  WHERE p.policyname IS NULL), '(none)'),
       NOT EXISTS (SELECT 1 FROM expected_policies e
                    LEFT JOIN pg_policies p
                      ON p.schemaname = 'public' AND p.tablename = e.tablename
                     AND p.policyname = e.policyname
                   WHERE p.policyname IS NULL)
UNION ALL
SELECT 'D. rebuilt policies with roles = {authenticated}', '16',
       (SELECT count(*) FROM live WHERE roles = ARRAY['authenticated']::name[])::text,
       (SELECT count(*) FROM live WHERE roles = ARRAY['authenticated']::name[]) = 16
UNION ALL
SELECT 'E. rebuilt policies PERMISSIVE with expected command', '16',
       (SELECT count(*) FROM live WHERE permissive = 'PERMISSIVE' AND cmd = expected_cmd)::text,
       (SELECT count(*) FROM live WHERE permissive = 'PERMISSIVE' AND cmd = expected_cmd) = 16
UNION ALL
SELECT 'F. rebuilt policies calling a private.* helper', '16',
       (SELECT count(*) FROM live
         WHERE coalesce(qual, '') || coalesce(with_check, '') ~ 'private\.my_(joined_)?team_ids')::text,
       (SELECT count(*) FROM live
         WHERE coalesce(qual, '') || coalesce(with_check, '') ~ 'private\.my_(joined_)?team_ids') = 16
UNION ALL
SELECT 'G. invitations email branch kept', 'true',
       (SELECT (qual LIKE '%auth.jwt() ->> ''email''%')::text FROM live
         WHERE policyname = 'invitees read own invitation'),
       coalesce((SELECT qual LIKE '%auth.jwt() ->> ''email''%' FROM live
                  WHERE policyname = 'invitees read own invitation'), false)
UNION ALL
SELECT 'H. validations uses my_joined_team_ids', 'true',
       (SELECT (qual LIKE '%private.my_joined_team_ids()%')::text FROM live
         WHERE policyname = 'Team members can view team validations'),
       coalesce((SELECT qual LIKE '%private.my_joined_team_ids()%' FROM live
                  WHERE policyname = 'Team members can view team validations'), false)
UNION ALL
SELECT 'I. validations_owner_or_team_read absent', 'false',
       EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                 AND tablename = 'validations'
                 AND policyname = 'validations_owner_or_team_read')::text,
       NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                     AND tablename = 'validations'
                     AND policyname = 'validations_owner_or_team_read')
UNION ALL
SELECT 'J. "users own validations" untouched (still present)', 'true',
       EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                 AND tablename = 'validations'
                 AND policyname = 'users own validations')::text,
       EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
                 AND tablename = 'validations'
                 AND policyname = 'users own validations')
UNION ALL
SELECT 'K. helpers present (of 3)', '3',
       (SELECT count(*) FROM fn WHERE oid IS NOT NULL)::text,
       (SELECT count(*) FROM fn WHERE oid IS NOT NULL) = 3
UNION ALL
SELECT 'L. helpers SECURITY DEFINER (prosecdef = true)', '3',
       (SELECT count(*) FROM fn WHERE prosecdef)::text,
       (SELECT count(*) FROM fn WHERE prosecdef) = 3
UNION ALL
SELECT 'M. helpers STABLE', '3',
       (SELECT count(*) FROM fn WHERE provolatile = 's')::text,
       (SELECT count(*) FROM fn WHERE provolatile = 's') = 3
UNION ALL
SELECT 'N. helpers pin search_path to empty', '3',
       (SELECT count(*) FROM fn
         WHERE proconfig::text[] && ARRAY['search_path=""', 'search_path=''''']::text[])::text,
       (SELECT count(*) FROM fn
         WHERE proconfig::text[] && ARRAY['search_path=""', 'search_path=''''']::text[]) = 3
UNION ALL
SELECT 'O. helper owner has BYPASSRLS', '3',
       (SELECT count(*) FROM fn WHERE owner_bypassrls)::text,
       (SELECT count(*) FROM fn WHERE owner_bypassrls) = 3
UNION ALL
SELECT 'P. authenticated may EXECUTE helpers', '3',
       (SELECT count(*) FROM fn WHERE oid IS NOT NULL
           AND has_function_privilege('authenticated', oid, 'EXECUTE'))::text,
       (SELECT count(*) FROM fn WHERE oid IS NOT NULL
           AND has_function_privilege('authenticated', oid, 'EXECUTE')) = 3
UNION ALL
SELECT 'Q. anon may EXECUTE helpers', '0',
       (SELECT count(*) FROM fn WHERE oid IS NOT NULL
           AND has_function_privilege('anon', oid, 'EXECUTE'))::text,
       (SELECT count(*) FROM fn WHERE oid IS NOT NULL
           AND has_function_privilege('anon', oid, 'EXECUTE')) = 0
UNION ALL
SELECT 'R. anon has USAGE on schema private', 'false',
       coalesce(has_schema_privilege('anon', 'private', 'USAGE')::text, 'no schema'),
       coalesce(NOT has_schema_privilege('anon', 'private', 'USAGE'), false)
UNION ALL
SELECT 'S. team_members FORCE RLS', 'false',
       (SELECT relforcerowsecurity::text FROM pg_class WHERE oid = 'public.team_members'::regclass),
       (SELECT NOT relforcerowsecurity FROM pg_class WHERE oid = 'public.team_members'::regclass)
ORDER BY 1;

-- ═══════════════════════════════════════════════════════════════════════════
-- Part 2 (optional) — act as a signed-in user, inside a transaction that is
-- rolled back. Replace the Clerk user ID with a real one (yours) before
-- running. It changes no data: SET LOCAL ends with the ROLLBACK.
-- Before the fix, the first SELECT failed with 42P17.
-- ═══════════════════════════════════════════════════════════════════════════
--   BEGIN;
--   SET LOCAL ROLE authenticated;
--   SELECT set_config('request.jwt.claims',
--                     json_build_object('sub', 'user_REPLACE_ME', 'role', 'authenticated')::text,
--                     true);
--   SELECT count(*) AS my_team_member_rows FROM public.team_members;
--   SELECT count(*) AS my_team_rows        FROM public.teams;
--   SELECT count(*) AS visible_validations FROM public.validations;
--   ROLLBACK;
