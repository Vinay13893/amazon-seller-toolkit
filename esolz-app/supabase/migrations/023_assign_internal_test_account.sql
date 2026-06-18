-- Assign only the designated QA account's workspaces to the existing
-- Internal Tester plan. Safe to re-run and does not affect other users.
INSERT INTO public.workspace_subscriptions (
  workspace_id,
  plan_id,
  status,
  current_period_start,
  current_period_end
)
SELECT
  wm.workspace_id,
  plan.id,
  'active',
  now(),
  now() + interval '10 years'
FROM auth.users AS test_user
JOIN public.workspace_members AS wm
  ON wm.user_id = test_user.id
JOIN public.subscription_plans AS plan
  ON plan.name = 'Internal Tester'
WHERE lower(test_user.email) = 'test2026@sociomonkey.com'
ON CONFLICT (workspace_id) DO UPDATE SET
  plan_id = EXCLUDED.plan_id,
  status = EXCLUDED.status,
  current_period_start = EXCLUDED.current_period_start,
  current_period_end = EXCLUDED.current_period_end,
  updated_at = now();

NOTIFY pgrst, 'reload schema';
