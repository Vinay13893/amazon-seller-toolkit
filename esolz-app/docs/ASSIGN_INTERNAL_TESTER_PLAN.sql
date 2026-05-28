-- ─────────────────────────────────────────────────────────────────────────────
-- ASSIGN_INTERNAL_TESTER_PLAN.sql
-- Manually assign a workspace to the "Internal Tester" plan
--
-- HOW TO USE
-- 1. Create the test user in Supabase Dashboard:
--      Authentication → Users → "Add user" (email + password)
-- 2. Confirm their email:
--      Authentication → Users → click user → "Send confirmation email"
--      OR toggle "Confirm email" = on in the user row
-- 3. Make sure migration 008 has been applied so the plan row exists.
-- 4. Replace '[your-test-email@example.com]' below with the test user's email.
-- 5. Run this entire script in Supabase SQL Editor (project: okxfwcfxxrtmijmjvztdq)
-- 6. Log in as that user → go to /dashboard/billing
--      The banner should show "Internal Tester — Internal testing access enabled"
--
-- SAFE TO RE-RUN: uses upsert (ON CONFLICT DO UPDATE)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Step 0: verify the plan row exists (from migration 008) ──────────────────
SELECT id, name, asin_limit, keyword_limit, features
FROM   public.subscription_plans
WHERE  name = 'Internal Tester';
-- Expected: 1 row.  If 0 rows → apply migration 008 first.

-- ── Step 1: resolve IDs ───────────────────────────────────────────────────────
DO $$
DECLARE
  v_email        TEXT := 'test2026@sociomonkey.com';
  v_user_id      UUID;
  v_workspace_id UUID;
  v_plan_id      UUID;
BEGIN
  -- 1a. Find user in auth.users
  SELECT id INTO v_user_id
  FROM   auth.users
  WHERE  email = v_email
  LIMIT  1;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'User with email % not found in auth.users. '
      'Create them in Authentication → Users first.', v_email;
  END IF;

  -- 1b. Find their workspace via workspace_members
  SELECT workspace_id INTO v_workspace_id
  FROM   public.workspace_members
  WHERE  user_id = v_user_id
  ORDER  BY created_at
  LIMIT  1;

  IF v_workspace_id IS NULL THEN
    RAISE EXCEPTION 'No workspace found for user %. '
      'Have them log in once so the onboarding trigger creates a workspace.', v_email;
  END IF;

  -- 1c. Find Internal Tester plan
  SELECT id INTO v_plan_id
  FROM   public.subscription_plans
  WHERE  name = 'Internal Tester'
  LIMIT  1;

  IF v_plan_id IS NULL THEN
    RAISE EXCEPTION 'Plan "Internal Tester" not found. '
      'Apply migration 008_internal_tester_plan.sql first.';
  END IF;

  -- 2. Upsert workspace_subscriptions
  INSERT INTO public.workspace_subscriptions (
    workspace_id,
    plan_id,
    status,
    current_period_start,
    current_period_end
  )
  VALUES (
    v_workspace_id,
    v_plan_id,
    'active',
    NOW(),
    NOW() + INTERVAL '3650 days'   -- ~10 years; well beyond any real billing period
  )
  ON CONFLICT (workspace_id) DO UPDATE SET
    plan_id              = EXCLUDED.plan_id,
    status               = EXCLUDED.status,
    current_period_start = EXCLUDED.current_period_start,
    current_period_end   = EXCLUDED.current_period_end,
    updated_at           = NOW();

  -- 3. Reset usage counters for the current period so limits read as 0/999999
  --    Upserts the current-period row if it exists, otherwise inserts fresh.
  INSERT INTO public.usage_counters (
    workspace_id,
    period_start,
    period_end,
    asin_count,
    keyword_count,
    pincode_checks_used,
    reports_generated,
    competitor_count
  )
  VALUES (
    v_workspace_id,
    date_trunc('month', NOW()),
    date_trunc('month', NOW()) + INTERVAL '1 month',
    0, 0, 0, 0, 0
  )
  ON CONFLICT (workspace_id, period_start) DO UPDATE SET
    asin_count          = 0,
    keyword_count       = 0,
    pincode_checks_used = 0,
    reports_generated   = 0,
    competitor_count    = 0,
    updated_at          = NOW();

  RAISE NOTICE 'Done. workspace_id=% assigned to Internal Tester plan (plan_id=%)',
    v_workspace_id, v_plan_id;
END;
$$;

-- ── Step 2: verify ────────────────────────────────────────────────────────────
SELECT
  ws.workspace_id,
  sp.name         AS plan_name,
  ws.status,
  ws.current_period_start,
  ws.current_period_end
FROM   public.workspace_subscriptions ws
JOIN   public.subscription_plans      sp ON sp.id = ws.plan_id
WHERE  sp.name = 'Internal Tester';
-- Expected: 1 row, status = 'active', period_end ~10 years out
