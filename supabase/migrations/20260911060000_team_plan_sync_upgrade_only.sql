-- ═══════════════════════════════════════════════════════════════════════════
-- Sprint 9 (compliance tier) — 7/7: team plan sync mirrors UPGRADES only
-- Requires 20260911030000_compliance_team_plan_sync.sql.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 4/4 mirrored users.plan onto owned teams whenever the new value was 'team'
-- or 'business' — which also mirrored a business → team downgrade. Decision
-- (Sprint 9 item 6): only UPGRADES sync automatically; a downgrade leaves
-- teams.plan as it was, to be handled deliberately (support / future
-- ownership tooling) rather than silently shrinking a team's seat cap.
--
-- Rank: team = 1, business = 2, enterprise = 3. Mirror when rank(new) >
-- rank(current team plan). Event actor stays 'system:stripe'.

CREATE OR REPLACE FUNCTION public.team_plan_rank(p TEXT) RETURNS INTEGER
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p WHEN 'team' THEN 1 WHEN 'business' THEN 2 WHEN 'enterprise' THEN 3 ELSE 0 END;
$$;

CREATE OR REPLACE FUNCTION public.users_sync_owned_team_plan() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE t RECORD;
BEGIN
  IF NEW.plan IS NOT DISTINCT FROM OLD.plan THEN
    RETURN NEW;
  END IF;
  IF public.team_plan_rank(NEW.plan) = 0 THEN
    RETURN NEW;   -- free / pro: never mirrored
  END IF;

  FOR t IN
    SELECT id, plan FROM public.teams
     WHERE created_by = NEW.clerk_user_id
       AND public.team_plan_rank(NEW.plan) > public.team_plan_rank(plan)   -- upgrades only
  LOOP
    UPDATE public.teams SET plan = NEW.plan, updated_at = now() WHERE id = t.id;
    PERFORM public.audit_append(
      t.id, 'plan_changed', 'system:stripe', NULL, NEW.clerk_user_id,
      jsonb_build_object('from', t.plan, 'to', NEW.plan, 'owner', NEW.clerk_user_id,
                         'stripe_subscription_id', NEW.stripe_subscription_id, 'direction', 'upgrade'));
  END LOOP;
  RETURN NEW;
END;
$$;

-- Trigger binding unchanged (CREATE OR REPLACE keeps it); re-declared for a standalone run.
DROP TRIGGER IF EXISTS users_sync_owned_team_plan ON public.users;
CREATE TRIGGER users_sync_owned_team_plan
  AFTER UPDATE OF plan ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.users_sync_owned_team_plan();

-- ── VERIFY ──────────────────────────────────────────────────────────────────
--   SELECT public.team_plan_rank('team'), public.team_plan_rank('business'), public.team_plan_rank('free');  -- 1, 2, 0
--   SELECT prosrc LIKE '%upgrades only%' FROM pg_proc WHERE proname = 'users_sync_owned_team_plan';          -- true
