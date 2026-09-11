-- ═══════════════════════════════════════════════════════════════════════════
-- Sprint 9 (compliance tier) — 4/4: make the Business tier reachable
-- Requires 20260911000000 (audit_append).
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Finding: teams.plan is set to 'team' at creation and never updated; the
-- Stripe webhook patches users.plan only. So the 20-seat cap
-- (seat_limit_for_plan('business')), the export gate and every
-- team.plan-based check have never seen 'business'. A paying Business
-- customer gets Team behaviour.
--
-- Fix, at the database layer so it holds for every write path: when the
-- team OWNER's users.plan changes, mirror it onto the teams they own and
-- record a plan_changed event on each team's chain.
--
-- Mapping (users.plan → teams.plan):
--   'team' | 'business'          → same
--   anything else (free / pro)   → unchanged (existing behaviour: a lapsed
--                                  owner's team keeps its last plan; members'
--                                  own users.plan is handled by accept/member)
-- users.plan's CHECK is (free, pro, team, business) — 'enterprise' is set by
-- hand and is out of scope here.

-- 6a. Constrain the column that already exists.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'teams_plan_check') THEN
    ALTER TABLE public.teams
      ADD CONSTRAINT teams_plan_check CHECK (plan IN ('team', 'business', 'enterprise'));
  END IF;
END $$;

-- 6b. Sync trigger: users.plan → owned teams.plan (+ chain event).
CREATE OR REPLACE FUNCTION public.users_sync_owned_team_plan() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE t RECORD;
BEGIN
  IF NEW.plan IS NOT DISTINCT FROM OLD.plan THEN
    RETURN NEW;
  END IF;
  IF NEW.plan NOT IN ('team', 'business') THEN
    RETURN NEW;   -- downgrade to free/pro: leave the team's plan as is
  END IF;

  FOR t IN
    SELECT id, plan FROM public.teams
     WHERE created_by = NEW.clerk_user_id AND plan IS DISTINCT FROM NEW.plan
  LOOP
    UPDATE public.teams SET plan = NEW.plan, updated_at = now() WHERE id = t.id;
    PERFORM public.audit_append(
      t.id, 'plan_changed', 'system:stripe', NULL, NEW.clerk_user_id,
      jsonb_build_object('from', t.plan, 'to', NEW.plan, 'owner', NEW.clerk_user_id,
                         'stripe_subscription_id', NEW.stripe_subscription_id));
  END LOOP;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_sync_owned_team_plan ON public.users;
CREATE TRIGGER users_sync_owned_team_plan
  AFTER UPDATE OF plan ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.users_sync_owned_team_plan();

-- 6c. Backfill: teams whose owner already pays for Business (or Team) but
--     whose teams.plan never caught up. Recorded on the chain as a backfill.
DO $$
DECLARE t RECORD;
BEGIN
  FOR t IN
    SELECT tm.id AS team_id, tm.plan AS old_plan, u.plan AS new_plan, u.clerk_user_id, u.stripe_subscription_id
      FROM public.teams tm
      JOIN public.users u ON u.clerk_user_id = tm.created_by
     WHERE u.plan IN ('team', 'business') AND tm.plan IS DISTINCT FROM u.plan
  LOOP
    UPDATE public.teams SET plan = t.new_plan, updated_at = now() WHERE id = t.team_id;
    PERFORM public.audit_append(
      t.team_id, 'plan_changed', 'system:migration', NULL, t.clerk_user_id,
      jsonb_build_object('from', t.old_plan, 'to', t.new_plan, 'owner', t.clerk_user_id,
                         'stripe_subscription_id', t.stripe_subscription_id,
                         'reason', 'sprint9 backfill: teams.plan had never been synced from users.plan'));
  END LOOP;
END $$;

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   SELECT tm.id, tm.plan AS team_plan, u.plan AS owner_plan
--     FROM public.teams tm JOIN public.users u ON u.clerk_user_id = tm.created_by;
--     → no row where owner_plan IN ('team','business') AND team_plan <> owner_plan
--   SELECT team_id, seq, event_type, payload FROM public.audit_events WHERE event_type = 'plan_changed';
--   SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.users'::regclass AND tgname = 'users_sync_owned_team_plan';
--
-- ── FULL POST-APPLY CHECK (all four files) ──────────────────────────────────
--   SELECT tablename, policyname, cmd FROM pg_policies
--    WHERE tablename IN ('audit_events','evidence_bundles','team_signing_keys',
--                        'approval_policies','approval_requests','custom_rules','audit_log')
--    ORDER BY tablename, policyname;
--   Expect: team_signing_keys has NO policies; approval_requests has exactly
--   team_read (SELECT) + requester_insert (INSERT); no policy on any of these
--   tables contains 'app.clerk_user_id'.
