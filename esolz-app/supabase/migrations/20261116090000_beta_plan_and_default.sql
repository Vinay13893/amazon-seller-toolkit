-- Beta access for new workspaces. Existing subscriptions are intentionally unchanged.
INSERT INTO public.subscription_plans (
  name, price_monthly, asin_limit, keyword_limit, pincode_check_limit,
  competitor_limit, report_limit, features
)
VALUES (
  'Beta', 0, 10, 30, 100, 10, 5,
  '{
    "beta": true,
    "bsr_tracker": true,
    "keywords": true,
    "pincode_checker": true,
    "buy_box": true,
    "competitors": true,
    "alerts": true,
    "keyword_asin_limit": 10,
    "keywords_per_asin": 3,
    "buybox_asin_limit": 10,
    "refresh_interval_hours": 24
  }'::jsonb
)
ON CONFLICT (name) DO UPDATE SET
  price_monthly = EXCLUDED.price_monthly,
  asin_limit = EXCLUDED.asin_limit,
  keyword_limit = EXCLUDED.keyword_limit,
  pincode_check_limit = EXCLUDED.pincode_check_limit,
  competitor_limit = EXCLUDED.competitor_limit,
  report_limit = EXCLUDED.report_limit,
  features = EXCLUDED.features;

CREATE OR REPLACE FUNCTION public.fn_handle_new_profile()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_workspace_id UUID;
  v_plan_id UUID;
BEGIN
  INSERT INTO public.workspaces (owner_id, name, type)
  VALUES (NEW.id, COALESCE(NULLIF(TRIM(NEW.company_name), ''), 'My Workspace'), 'seller')
  RETURNING id INTO v_workspace_id;

  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (v_workspace_id, NEW.id, 'owner')
  ON CONFLICT (workspace_id, user_id) DO NOTHING;

  SELECT id INTO v_plan_id
  FROM public.subscription_plans
  WHERE name = 'Beta'
  LIMIT 1;

  IF v_plan_id IS NULL THEN
    SELECT id INTO v_plan_id FROM public.subscription_plans WHERE name = 'Free' LIMIT 1;
  END IF;

  IF v_plan_id IS NOT NULL THEN
    INSERT INTO public.workspace_subscriptions
      (workspace_id, plan_id, status, current_period_start, current_period_end)
    VALUES (v_workspace_id, v_plan_id, 'active', NOW(), NOW() + INTERVAL '365 days')
    ON CONFLICT (workspace_id) DO NOTHING;
  ELSE
    RAISE WARNING 'fn_handle_new_profile: Beta and Free plans not found for workspace %.', v_workspace_id;
  END IF;

  INSERT INTO public.usage_counters (workspace_id, period_start, period_end)
  VALUES (v_workspace_id, date_trunc('month', NOW()), date_trunc('month', NOW()) + INTERVAL '1 month')
  ON CONFLICT (workspace_id, period_start) DO NOTHING;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'fn_handle_new_profile failed for profile %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

-- Database-level backstop for concurrent or alternate keyword insert paths.
CREATE OR REPLACE FUNCTION public.enforce_plan_keyword_limits()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_features JSONB;
  v_keyword_limit INTEGER;
  v_asin_limit INTEGER;
  v_per_asin INTEGER;
  v_target_count INTEGER;
  v_target_exists BOOLEAN;
  v_distinct_targets INTEGER;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(NEW.workspace_id::text));
  SELECT p.features, p.keyword_limit
    INTO v_features, v_keyword_limit
  FROM public.workspace_subscriptions s
  JOIN public.subscription_plans p ON p.id = s.plan_id
  WHERE s.workspace_id = NEW.workspace_id AND s.status IN ('active', 'trialing')
  LIMIT 1;

  IF COALESCE(v_features->>'keywords', 'false') <> 'true' THEN
    RAISE EXCEPTION 'Keyword tracking is not included in this plan.' USING ERRCODE = 'P0001';
  END IF;
  IF (SELECT COUNT(*) FROM public.tracked_keywords WHERE workspace_id = NEW.workspace_id) >= COALESCE(v_keyword_limit, 0) THEN
    RAISE EXCEPTION 'Keyword allowance reached.' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.own_asin IS NOT NULL OR NEW.tracked_asin_id IS NOT NULL THEN
    v_asin_limit := COALESCE((v_features->>'keyword_asin_limit')::INTEGER, v_keyword_limit);
    v_per_asin := COALESCE((v_features->>'keywords_per_asin')::INTEGER, v_keyword_limit);
    SELECT COUNT(*) INTO v_target_count FROM public.tracked_keywords
      WHERE workspace_id = NEW.workspace_id
        AND ((NEW.own_asin IS NOT NULL AND own_asin = NEW.own_asin)
          OR (NEW.tracked_asin_id IS NOT NULL AND tracked_asin_id = NEW.tracked_asin_id));
    IF v_target_count >= v_per_asin THEN
      RAISE EXCEPTION 'Keyword allowance for this ASIN reached.' USING ERRCODE = 'P0001';
    END IF;
    SELECT EXISTS(
      SELECT 1 FROM public.tracked_keywords
      WHERE workspace_id = NEW.workspace_id
        AND ((NEW.own_asin IS NOT NULL AND own_asin = NEW.own_asin)
          OR (NEW.tracked_asin_id IS NOT NULL AND tracked_asin_id = NEW.tracked_asin_id))
    ) INTO v_target_exists;
    SELECT COUNT(*) INTO v_distinct_targets FROM (
      SELECT COALESCE('own:' || own_asin, 'competitor:' || tracked_asin_id::text) AS target
      FROM public.tracked_keywords
      WHERE workspace_id = NEW.workspace_id AND (own_asin IS NOT NULL OR tracked_asin_id IS NOT NULL)
      GROUP BY 1
    ) targets;
    IF NOT v_target_exists AND v_distinct_targets >= v_asin_limit THEN
      RAISE EXCEPTION 'Keyword ASIN allowance reached.' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_plan_keyword_limits ON public.tracked_keywords;
CREATE TRIGGER trg_enforce_plan_keyword_limits
BEFORE INSERT ON public.tracked_keywords
FOR EACH ROW EXECUTE FUNCTION public.enforce_plan_keyword_limits();

CREATE OR REPLACE FUNCTION public.enforce_plan_buybox_limits()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_features JSONB;
  v_limit INTEGER;
BEGIN
  IF NEW.kind <> 'buybox' THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext(NEW.workspace_id::text));
  SELECT p.features INTO v_features
  FROM public.workspace_subscriptions s
  JOIN public.subscription_plans p ON p.id = s.plan_id
  WHERE s.workspace_id = NEW.workspace_id AND s.status IN ('active', 'trialing')
  LIMIT 1;
  IF COALESCE(v_features->>'buy_box', 'false') <> 'true' THEN
    RAISE EXCEPTION 'Buy Box tracking is not included in this plan.' USING ERRCODE = 'P0001';
  END IF;
  v_limit := COALESCE((v_features->>'buybox_asin_limit')::INTEGER, 0);
  IF NOT EXISTS (
    SELECT 1 FROM public.daily_tracker_targets
    WHERE workspace_id = NEW.workspace_id AND kind = 'buybox' AND source_key = NEW.source_key
  ) AND (SELECT COUNT(DISTINCT source_key) FROM public.daily_tracker_targets
         WHERE workspace_id = NEW.workspace_id AND kind = 'buybox') >= v_limit THEN
    RAISE EXCEPTION 'Buy Box ASIN allowance reached.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_plan_buybox_limits ON public.daily_tracker_targets;
CREATE TRIGGER trg_enforce_plan_buybox_limits
BEFORE INSERT ON public.daily_tracker_targets
FOR EACH ROW EXECUTE FUNCTION public.enforce_plan_buybox_limits();

-- Trigger functions and the onboarding trigger are not public RPC endpoints.
REVOKE ALL ON FUNCTION public.enforce_plan_keyword_limits() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_plan_buybox_limits() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fn_handle_new_profile() FROM PUBLIC, anon, authenticated;
