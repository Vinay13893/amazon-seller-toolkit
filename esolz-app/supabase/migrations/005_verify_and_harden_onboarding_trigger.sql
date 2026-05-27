-- ============================================================
-- Migration 005: Verify and Harden Onboarding Trigger
-- Sociomonkey — Amazon Intelligence Platform
--
-- Safe: no DROP TABLE, no DELETE, no destructive operations.
-- Idempotent: safe to re-run on a database that already has some
-- of these objects; ON CONFLICT / DROP IF EXISTS everywhere.
--
-- What this migration does:
--   1. Seeds subscription_plans (the most critical missing piece).
--      fn_handle_new_profile() silently skips workspace_subscriptions
--      if the Free plan row does not exist yet.
--   2. Hardens fn_handle_new_user() and fn_handle_new_profile()
--      with ON CONFLICT guards and a RAISE WARNING when Free plan
--      is still missing at trigger time.
--   3. Recreates both triggers idempotently (DROP IF EXISTS + CREATE).
--   4. Backfills existing users who are missing any onboarding rows:
--      (a) profiles with no workspace
--      (b) workspaces with no subscription
--      (c) workspaces with no workspace_member for the owner
--      (d) workspaces with no usage_counter for the current month
-- ============================================================


-- ============================================================
-- SECTION 1: Seed subscription_plans
-- ON CONFLICT (name) DO NOTHING makes this safe to re-run.
-- Prices in INR. Limits match project brief.
-- Update prices before launch — these are placeholders.
-- ============================================================

INSERT INTO public.subscription_plans
  (name, price_monthly, asin_limit, keyword_limit, pincode_check_limit,
   competitor_limit, report_limit, features)
VALUES
  ('Free',
   0, 5, 10, 100, 3, 3,
   '{"bsr_tracking":true,"keyword_tracking":true,"pincode_check":true,
     "buybox_monitor":false,"alerts":false,"reports":false}'),

  ('Starter',
   999, 15, 25, 300, 5, 5,
   '{"bsr_tracking":true,"keyword_tracking":true,"pincode_check":true,
     "buybox_monitor":true,"alerts":false,"reports":false}'),

  ('Growth',
   1499, 30, 50, 600, 10, 10,
   '{"bsr_tracking":true,"keyword_tracking":true,"pincode_check":true,
     "buybox_monitor":true,"alerts":true,"reports":false}'),

  ('Pro',
   2499, 60, 100, 1200, 20, 20,
   '{"bsr_tracking":true,"keyword_tracking":true,"pincode_check":true,
     "buybox_monitor":true,"alerts":true,"reports":true}'),

  ('Agency',
   7999, 999, 999, 9999, 999, 999,
   '{"bsr_tracking":true,"keyword_tracking":true,"pincode_check":true,
     "buybox_monitor":true,"alerts":true,"reports":true,"multi_workspace":true}')

ON CONFLICT (name) DO NOTHING;


-- ============================================================
-- SECTION 2: Harden fn_handle_new_user
-- (auth.users INSERT → creates profile row)
--
-- Changes vs original:
--   - ON CONFLICT (id) DO NOTHING already present — kept.
--   - RAISE WARNING added so failures surface in Supabase logs.
-- ============================================================

CREATE OR REPLACE FUNCTION public.fn_handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, email, company_name)
  VALUES (
    NEW.id,
    NEW.raw_user_meta_data ->> 'full_name',
    NEW.email,
    NEW.raw_user_meta_data ->> 'company_name'
  )
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_handle_new_user failed for user %: %', NEW.id, SQLERRM;
  RETURN NEW;  -- Always return NEW so auth.users INSERT is never blocked
END;
$$;


-- ============================================================
-- SECTION 3: Harden fn_handle_new_profile
-- (profiles INSERT → creates workspace + member + subscription + usage_counter)
--
-- Changes vs original:
--   - ON CONFLICT (workspace_id, user_id) DO NOTHING on workspace_members
--   - ON CONFLICT (workspace_id) DO NOTHING on workspace_subscriptions
--   - ON CONFLICT (workspace_id, period_start) DO NOTHING on usage_counters
--   - RAISE WARNING when Free plan not found (instead of silent skip)
--   - Exception block to prevent profile INSERT from failing
-- ============================================================

CREATE OR REPLACE FUNCTION public.fn_handle_new_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workspace_id UUID;
  v_free_plan_id UUID;
BEGIN
  -- 1. Create default workspace
  INSERT INTO public.workspaces (owner_id, name, type)
  VALUES (
    NEW.id,
    COALESCE(NULLIF(TRIM(NEW.company_name), ''), 'My Workspace'),
    'seller'
  )
  RETURNING id INTO v_workspace_id;

  -- 2. Add owner as workspace member
  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (v_workspace_id, NEW.id, 'owner')
  ON CONFLICT (workspace_id, user_id) DO NOTHING;

  -- 3. Assign Free plan (subscription_plans must be seeded first)
  SELECT id INTO v_free_plan_id
  FROM   public.subscription_plans
  WHERE  name = 'Free'
  LIMIT  1;

  IF v_free_plan_id IS NOT NULL THEN
    INSERT INTO public.workspace_subscriptions
      (workspace_id, plan_id, status, current_period_start, current_period_end)
    VALUES
      (v_workspace_id, v_free_plan_id, 'active', NOW(), NOW() + INTERVAL '365 days')
    ON CONFLICT (workspace_id) DO NOTHING;
  ELSE
    RAISE WARNING
      'fn_handle_new_profile: Free plan not found in subscription_plans. '
      'workspace_subscriptions row NOT created for workspace %. '
      'Run migration 005 to seed subscription_plans.',
      v_workspace_id;
  END IF;

  -- 4. Init usage counter for current month
  INSERT INTO public.usage_counters (workspace_id, period_start, period_end)
  VALUES (
    v_workspace_id,
    date_trunc('month', NOW()),
    date_trunc('month', NOW()) + INTERVAL '1 month'
  )
  ON CONFLICT (workspace_id, period_start) DO NOTHING;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_handle_new_profile failed for profile %: %', NEW.id, SQLERRM;
  RETURN NEW;  -- Always return NEW so profile INSERT is never blocked
END;
$$;


-- ============================================================
-- SECTION 4: Recreate triggers idempotently
-- DROP IF EXISTS + CREATE ensures the trigger is attached even if
-- a previous migration run left it in a broken state.
-- ============================================================

-- Trigger: auth.users INSERT → fn_handle_new_user → profiles INSERT
DROP TRIGGER IF EXISTS trg_on_auth_user_created ON auth.users;
CREATE TRIGGER trg_on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.fn_handle_new_user();

-- Trigger: profiles INSERT → fn_handle_new_profile → workspace chain
DROP TRIGGER IF EXISTS trg_on_profile_created ON public.profiles;
CREATE TRIGGER trg_on_profile_created
  AFTER INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.fn_handle_new_profile();


-- ============================================================
-- SECTION 5: Backfill existing users
-- Fixes users who signed up before subscription_plans was seeded,
-- or before the trigger was attached, or if the trigger failed.
--
-- No data is updated or deleted. Only missing rows are created.
-- All INSERTs use ON CONFLICT DO NOTHING for full idempotency.
-- RAISE NOTICE lines show in the Supabase SQL editor results.
-- ============================================================

DO $$
DECLARE
  r            RECORD;
  v_ws_id      UUID;
  v_free_id    UUID;
  backfill_ws  INT := 0;
  backfill_sub INT := 0;
  backfill_mem INT := 0;
  backfill_uc  INT := 0;
BEGIN
  -- Get Free plan ID (now seeded above in Section 1)
  SELECT id INTO v_free_id
  FROM   public.subscription_plans
  WHERE  name = 'Free'
  LIMIT  1;

  IF v_free_id IS NULL THEN
    RAISE WARNING 'Backfill: Free plan still not found — subscription backfill skipped.';
  END IF;

  -- ── 5a. Profiles with no workspace at all ───────────────────────────────
  FOR r IN
    SELECT p.id, p.company_name
    FROM   public.profiles p
    WHERE  NOT EXISTS (
      SELECT 1 FROM public.workspaces w WHERE w.owner_id = p.id
    )
  LOOP
    INSERT INTO public.workspaces (owner_id, name, type)
    VALUES (
      r.id,
      COALESCE(NULLIF(TRIM(r.company_name), ''), 'My Workspace'),
      'seller'
    )
    RETURNING id INTO v_ws_id;

    INSERT INTO public.workspace_members (workspace_id, user_id, role)
    VALUES (v_ws_id, r.id, 'owner')
    ON CONFLICT (workspace_id, user_id) DO NOTHING;

    IF v_free_id IS NOT NULL THEN
      INSERT INTO public.workspace_subscriptions
        (workspace_id, plan_id, status, current_period_start, current_period_end)
      VALUES
        (v_ws_id, v_free_id, 'active', NOW(), NOW() + INTERVAL '365 days')
      ON CONFLICT (workspace_id) DO NOTHING;
    END IF;

    INSERT INTO public.usage_counters (workspace_id, period_start, period_end)
    VALUES (
      v_ws_id,
      date_trunc('month', NOW()),
      date_trunc('month', NOW()) + INTERVAL '1 month'
    )
    ON CONFLICT (workspace_id, period_start) DO NOTHING;

    backfill_ws := backfill_ws + 1;
    RAISE NOTICE 'Backfill 5a: created full onboarding chain for profile %', r.id;
  END LOOP;

  -- ── 5b. Workspaces missing their owner in workspace_members ─────────────
  FOR r IN
    SELECT w.id AS workspace_id, w.owner_id
    FROM   public.workspaces w
    WHERE  NOT EXISTS (
      SELECT 1 FROM public.workspace_members wm
      WHERE  wm.workspace_id = w.id
      AND    wm.user_id      = w.owner_id
    )
  LOOP
    INSERT INTO public.workspace_members (workspace_id, user_id, role)
    VALUES (r.workspace_id, r.owner_id, 'owner')
    ON CONFLICT (workspace_id, user_id) DO NOTHING;

    backfill_mem := backfill_mem + 1;
    RAISE NOTICE 'Backfill 5b: added owner member for workspace %', r.workspace_id;
  END LOOP;

  -- ── 5c. Workspaces with no subscription row ─────────────────────────────
  -- This is the most common real-world gap: trigger ran before Free plan seeded.
  IF v_free_id IS NOT NULL THEN
    FOR r IN
      SELECT w.id AS workspace_id
      FROM   public.workspaces w
      WHERE  NOT EXISTS (
        SELECT 1 FROM public.workspace_subscriptions ws
        WHERE  ws.workspace_id = w.id
      )
    LOOP
      INSERT INTO public.workspace_subscriptions
        (workspace_id, plan_id, status, current_period_start, current_period_end)
      VALUES
        (r.workspace_id, v_free_id, 'active', NOW(), NOW() + INTERVAL '365 days')
      ON CONFLICT (workspace_id) DO NOTHING;

      backfill_sub := backfill_sub + 1;
      RAISE NOTICE 'Backfill 5c: assigned Free plan to workspace %', r.workspace_id;
    END LOOP;
  END IF;

  -- ── 5d. Workspaces with no usage_counter for current month ──────────────
  FOR r IN
    SELECT w.id AS workspace_id
    FROM   public.workspaces w
    WHERE  NOT EXISTS (
      SELECT 1 FROM public.usage_counters uc
      WHERE  uc.workspace_id = w.id
      AND    uc.period_start = date_trunc('month', NOW())
    )
  LOOP
    INSERT INTO public.usage_counters (workspace_id, period_start, period_end)
    VALUES (
      r.workspace_id,
      date_trunc('month', NOW()),
      date_trunc('month', NOW()) + INTERVAL '1 month'
    )
    ON CONFLICT (workspace_id, period_start) DO NOTHING;

    backfill_uc := backfill_uc + 1;
    RAISE NOTICE 'Backfill 5d: created usage_counter for workspace %', r.workspace_id;
  END LOOP;

  -- ── Summary ─────────────────────────────────────────────────────────────
  RAISE NOTICE '=== Backfill complete: % new workspaces, % new members, % new subscriptions, % new usage_counters ===',
    backfill_ws, backfill_mem, backfill_sub, backfill_uc;

END;
$$;
