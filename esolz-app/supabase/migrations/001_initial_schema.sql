-- ============================================================
-- 001_initial_schema.sql
-- e-Solz Amazon Intelligence Platform — Initial Database Schema
-- Run in: Supabase Dashboard → SQL Editor → Run
-- ============================================================

-- Enable UUID extension (usually already enabled in Supabase)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- ============================================================
-- ENUM TYPES
-- ============================================================

CREATE TYPE public.workspace_type       AS ENUM ('seller', 'agency', 'brand');
CREATE TYPE public.member_role          AS ENUM ('owner', 'admin', 'member', 'viewer');
CREATE TYPE public.subscription_status  AS ENUM ('trial', 'active', 'past_due', 'cancelled');
CREATE TYPE public.asin_status          AS ENUM ('active', 'paused', 'archived');
CREATE TYPE public.alert_severity       AS ENUM ('critical', 'warning', 'opportunity', 'info');
CREATE TYPE public.alert_module         AS ENUM ('bsr', 'buybox', 'pincode', 'keywords', 'price', 'reviews', 'competitor');
CREATE TYPE public.alert_status         AS ENUM ('new', 'read', 'resolved');
CREATE TYPE public.report_status        AS ENUM ('ready', 'processing', 'failed');
CREATE TYPE public.report_file_type     AS ENUM ('pdf', 'excel', 'csv');


-- ============================================================
-- 1. PROFILES  (mirrors auth.users, populated by trigger)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.profiles (
  id           UUID        PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name    TEXT,
  email        TEXT,
  company_name TEXT,
  avatar_url   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================
-- 2. WORKSPACES
-- ============================================================
CREATE TABLE IF NOT EXISTS public.workspaces (
  id         UUID                 PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_id   UUID                 NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  name       TEXT                 NOT NULL,
  type       public.workspace_type NOT NULL DEFAULT 'seller',
  created_at TIMESTAMPTZ          NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ          NOT NULL DEFAULT NOW()
);


-- ============================================================
-- 3. WORKSPACE MEMBERS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.workspace_members (
  id           UUID              PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID              NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id      UUID              NOT NULL REFERENCES public.profiles(id)   ON DELETE CASCADE,
  role         public.member_role NOT NULL DEFAULT 'member',
  created_at   TIMESTAMPTZ       NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, user_id)
);


-- ============================================================
-- 4. SUBSCRIPTION PLANS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.subscription_plans (
  id                  UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  name                TEXT        NOT NULL UNIQUE,
  price_monthly       INTEGER     NOT NULL DEFAULT 0,  -- in INR (₹)
  asin_limit          INTEGER     NOT NULL DEFAULT 5,
  keyword_limit       INTEGER     NOT NULL DEFAULT 20,
  pincode_check_limit INTEGER     NOT NULL DEFAULT 100,
  competitor_limit    INTEGER     NOT NULL DEFAULT 5,
  report_limit        INTEGER     NOT NULL DEFAULT 3,
  features            JSONB       NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================
-- 5. WORKSPACE SUBSCRIPTIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.workspace_subscriptions (
  id                   UUID                      PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id         UUID                      NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  plan_id              UUID                      NOT NULL REFERENCES public.subscription_plans(id),
  status               public.subscription_status NOT NULL DEFAULT 'trial',
  current_period_start TIMESTAMPTZ               NOT NULL DEFAULT NOW(),
  current_period_end   TIMESTAMPTZ               NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
  created_at           TIMESTAMPTZ               NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ               NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id)   -- one subscription record per workspace; update it to change plan
);


-- ============================================================
-- 6. TRACKED ASINS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.tracked_asins (
  id            UUID               PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id  UUID               NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  asin          TEXT               NOT NULL,
  marketplace   TEXT               NOT NULL DEFAULT 'IN',
  product_title TEXT,
  brand         TEXT,
  category      TEXT,
  image_url     TEXT,
  status        public.asin_status NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ        NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ        NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, asin, marketplace)
);


-- ============================================================
-- 7. ASIN SNAPSHOTS  (BSR / price history per scrape)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.asin_snapshots (
  id                 UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id       UUID        NOT NULL REFERENCES public.workspaces(id)    ON DELETE CASCADE,
  tracked_asin_id    UUID        NOT NULL REFERENCES public.tracked_asins(id) ON DELETE CASCADE,
  bsr                INTEGER,
  price              NUMERIC(10,2),
  rating             NUMERIC(3,2),
  review_count       INTEGER,
  buy_box_owner      TEXT,
  buy_box_status     TEXT,
  availability_score INTEGER,
  checked_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================
-- 8. TRACKED KEYWORDS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.tracked_keywords (
  id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id     UUID        NOT NULL REFERENCES public.workspaces(id)    ON DELETE CASCADE,
  tracked_asin_id  UUID        REFERENCES public.tracked_asins(id)          ON DELETE SET NULL,
  keyword          TEXT        NOT NULL,
  marketplace      TEXT        NOT NULL DEFAULT 'IN',
  search_volume    INTEGER,
  cpc_estimate     NUMERIC(8,2),
  difficulty       INTEGER,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, keyword, marketplace)
);


-- ============================================================
-- 9. KEYWORD RANK SNAPSHOTS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.keyword_rank_snapshots (
  id                 UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id       UUID        NOT NULL REFERENCES public.workspaces(id)        ON DELETE CASCADE,
  tracked_keyword_id UUID        NOT NULL REFERENCES public.tracked_keywords(id)  ON DELETE CASCADE,
  organic_rank       INTEGER,
  sponsored_rank     INTEGER,
  page_status        TEXT,
  checked_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================
-- 10. PINCODE CHECKS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.pincode_checks (
  id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id     UUID        NOT NULL REFERENCES public.workspaces(id)    ON DELETE CASCADE,
  tracked_asin_id  UUID        REFERENCES public.tracked_asins(id)          ON DELETE SET NULL,
  pincode          TEXT        NOT NULL,
  city             TEXT,
  available        BOOLEAN,
  delivery_promise TEXT,
  price            NUMERIC(10,2),
  buy_box_seller   TEXT,
  fulfillment_type TEXT,
  checked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================
-- 11. BUYBOX SNAPSHOTS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.buybox_snapshots (
  id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id     UUID        NOT NULL REFERENCES public.workspaces(id)    ON DELETE CASCADE,
  tracked_asin_id  UUID        NOT NULL REFERENCES public.tracked_asins(id) ON DELETE CASCADE,
  buy_box_owner    TEXT,
  buy_box_status   TEXT,
  buy_box_price    NUMERIC(10,2),
  your_price       NUMERIC(10,2),
  price_gap        NUMERIC(10,2),
  fulfillment_type TEXT,
  checked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================
-- 12. COMPETITOR ASINS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.competitor_asins (
  id               UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id     UUID        NOT NULL REFERENCES public.workspaces(id)  ON DELETE CASCADE,
  tracked_asin_id  UUID        REFERENCES public.tracked_asins(id)        ON DELETE SET NULL,
  competitor_asin  TEXT        NOT NULL,
  product_title    TEXT,
  brand            TEXT,
  marketplace      TEXT        NOT NULL DEFAULT 'IN',
  category         TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, competitor_asin, marketplace)
);


-- ============================================================
-- 13. ALERTS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.alerts (
  id                 UUID                   PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id       UUID                   NOT NULL REFERENCES public.workspaces(id)   ON DELETE CASCADE,
  tracked_asin_id    UUID                   REFERENCES public.tracked_asins(id)         ON DELETE SET NULL,
  title              TEXT                   NOT NULL,
  description        TEXT,
  severity           public.alert_severity  NOT NULL DEFAULT 'info',
  module             public.alert_module    NOT NULL,
  status             public.alert_status    NOT NULL DEFAULT 'new',
  recommended_action TEXT,
  created_at         TIMESTAMPTZ            NOT NULL DEFAULT NOW(),
  resolved_at        TIMESTAMPTZ
);


-- ============================================================
-- 14. REPORTS
-- ============================================================
CREATE TABLE IF NOT EXISTS public.reports (
  id           UUID                     PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id UUID                     NOT NULL REFERENCES public.workspaces(id)  ON DELETE CASCADE,
  report_name  TEXT                     NOT NULL,
  report_type  TEXT                     NOT NULL,
  status       public.report_status     NOT NULL DEFAULT 'processing',
  file_type    public.report_file_type  NOT NULL DEFAULT 'pdf',
  file_url     TEXT,
  created_by   UUID                     REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ              NOT NULL DEFAULT NOW()
);


-- ============================================================
-- 15. USAGE COUNTERS  (reset monthly per billing cycle)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.usage_counters (
  id                  UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  workspace_id        UUID        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  period_start        TIMESTAMPTZ NOT NULL,
  period_end          TIMESTAMPTZ NOT NULL,
  asin_count          INTEGER     NOT NULL DEFAULT 0,
  keyword_count       INTEGER     NOT NULL DEFAULT 0,
  pincode_checks_used INTEGER     NOT NULL DEFAULT 0,
  reports_generated   INTEGER     NOT NULL DEFAULT 0,
  competitor_count    INTEGER     NOT NULL DEFAULT 0,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, period_start)
);


-- ============================================================
-- INDEXES
-- ============================================================

-- workspace membership (hot path for RLS)
CREATE INDEX idx_wm_workspace  ON public.workspace_members(workspace_id);
CREATE INDEX idx_wm_user       ON public.workspace_members(user_id);

-- tracked_asins
CREATE INDEX idx_tasins_workspace ON public.tracked_asins(workspace_id);
CREATE INDEX idx_tasins_asin      ON public.tracked_asins(asin);
CREATE INDEX idx_tasins_status    ON public.tracked_asins(workspace_id, status);

-- asin_snapshots
CREATE INDEX idx_asnap_workspace   ON public.asin_snapshots(workspace_id);
CREATE INDEX idx_asnap_asin        ON public.asin_snapshots(tracked_asin_id);
CREATE INDEX idx_asnap_checked_at  ON public.asin_snapshots(checked_at DESC);

-- tracked_keywords
CREATE INDEX idx_tkw_workspace ON public.tracked_keywords(workspace_id);
CREATE INDEX idx_tkw_keyword   ON public.tracked_keywords(keyword);
CREATE INDEX idx_tkw_asin      ON public.tracked_keywords(tracked_asin_id);

-- keyword_rank_snapshots
CREATE INDEX idx_krs_workspace  ON public.keyword_rank_snapshots(workspace_id);
CREATE INDEX idx_krs_keyword    ON public.keyword_rank_snapshots(tracked_keyword_id);
CREATE INDEX idx_krs_checked_at ON public.keyword_rank_snapshots(checked_at DESC);

-- pincode_checks
CREATE INDEX idx_pc_workspace  ON public.pincode_checks(workspace_id);
CREATE INDEX idx_pc_asin       ON public.pincode_checks(tracked_asin_id);
CREATE INDEX idx_pc_pincode    ON public.pincode_checks(pincode);
CREATE INDEX idx_pc_checked_at ON public.pincode_checks(checked_at DESC);

-- buybox_snapshots
CREATE INDEX idx_bb_workspace  ON public.buybox_snapshots(workspace_id);
CREATE INDEX idx_bb_asin       ON public.buybox_snapshots(tracked_asin_id);
CREATE INDEX idx_bb_checked_at ON public.buybox_snapshots(checked_at DESC);

-- competitor_asins
CREATE INDEX idx_ca_workspace ON public.competitor_asins(workspace_id);
CREATE INDEX idx_ca_asin      ON public.competitor_asins(tracked_asin_id);

-- alerts
CREATE INDEX idx_alerts_workspace  ON public.alerts(workspace_id);
CREATE INDEX idx_alerts_status     ON public.alerts(workspace_id, status);
CREATE INDEX idx_alerts_created_at ON public.alerts(created_at DESC);

-- reports
CREATE INDEX idx_reports_workspace  ON public.reports(workspace_id);
CREATE INDEX idx_reports_created_at ON public.reports(created_at DESC);

-- usage_counters
CREATE INDEX idx_uc_workspace ON public.usage_counters(workspace_id);


-- ============================================================
-- HELPER FUNCTION  (used by RLS policies)
-- ============================================================

-- Returns all workspace_ids the current user belongs to.
-- SECURITY DEFINER so it bypasses RLS while reading workspace_members.
CREATE OR REPLACE FUNCTION public.user_workspace_ids()
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT workspace_id
  FROM   public.workspace_members
  WHERE  user_id = auth.uid();
$$;


-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE public.profiles                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspaces              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_members       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscription_plans      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workspace_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tracked_asins           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asin_snapshots          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tracked_keywords        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.keyword_rank_snapshots  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pincode_checks          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.buybox_snapshots        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.competitor_asins        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.alerts                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reports                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usage_counters          ENABLE ROW LEVEL SECURITY;

-- ── profiles ──────────────────────────────────────────────────────────────
CREATE POLICY "profiles: own row only"
  ON public.profiles FOR ALL
  USING (id = auth.uid())
  WITH CHECK (id = auth.uid());

-- ── workspaces ────────────────────────────────────────────────────────────
CREATE POLICY "workspaces: members can select"
  ON public.workspaces FOR SELECT
  USING (id IN (SELECT public.user_workspace_ids()));

CREATE POLICY "workspaces: owner can insert"
  ON public.workspaces FOR INSERT
  WITH CHECK (owner_id = auth.uid());

CREATE POLICY "workspaces: owner can update"
  ON public.workspaces FOR UPDATE
  USING (owner_id = auth.uid());

CREATE POLICY "workspaces: owner can delete"
  ON public.workspaces FOR DELETE
  USING (owner_id = auth.uid());

-- ── workspace_members ─────────────────────────────────────────────────────
CREATE POLICY "workspace_members: select if member"
  ON public.workspace_members FOR SELECT
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

CREATE POLICY "workspace_members: workspace owner can insert"
  ON public.workspace_members FOR INSERT
  WITH CHECK (
    workspace_id IN (SELECT id FROM public.workspaces WHERE owner_id = auth.uid())
  );

CREATE POLICY "workspace_members: workspace owner can delete"
  ON public.workspace_members FOR DELETE
  USING (
    workspace_id IN (SELECT id FROM public.workspaces WHERE owner_id = auth.uid())
  );

-- ── subscription_plans ────────────────────────────────────────────────────
-- Public read: everyone can see the plan catalogue
CREATE POLICY "subscription_plans: public read"
  ON public.subscription_plans FOR SELECT
  USING (true);

-- ── workspace_subscriptions ───────────────────────────────────────────────
CREATE POLICY "workspace_subscriptions: member select"
  ON public.workspace_subscriptions FOR SELECT
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

-- ── tracked_asins ─────────────────────────────────────────────────────────
CREATE POLICY "tracked_asins: member select"
  ON public.tracked_asins FOR SELECT
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

CREATE POLICY "tracked_asins: member insert"
  ON public.tracked_asins FOR INSERT
  WITH CHECK (workspace_id IN (SELECT public.user_workspace_ids()));

CREATE POLICY "tracked_asins: member update"
  ON public.tracked_asins FOR UPDATE
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

CREATE POLICY "tracked_asins: member delete"
  ON public.tracked_asins FOR DELETE
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

-- ── asin_snapshots ────────────────────────────────────────────────────────
CREATE POLICY "asin_snapshots: member select"
  ON public.asin_snapshots FOR SELECT
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

CREATE POLICY "asin_snapshots: member insert"
  ON public.asin_snapshots FOR INSERT
  WITH CHECK (workspace_id IN (SELECT public.user_workspace_ids()));

-- ── tracked_keywords ──────────────────────────────────────────────────────
CREATE POLICY "tracked_keywords: member select"
  ON public.tracked_keywords FOR SELECT
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

CREATE POLICY "tracked_keywords: member insert"
  ON public.tracked_keywords FOR INSERT
  WITH CHECK (workspace_id IN (SELECT public.user_workspace_ids()));

CREATE POLICY "tracked_keywords: member update"
  ON public.tracked_keywords FOR UPDATE
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

CREATE POLICY "tracked_keywords: member delete"
  ON public.tracked_keywords FOR DELETE
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

-- ── keyword_rank_snapshots ────────────────────────────────────────────────
CREATE POLICY "keyword_rank_snapshots: member select"
  ON public.keyword_rank_snapshots FOR SELECT
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

CREATE POLICY "keyword_rank_snapshots: member insert"
  ON public.keyword_rank_snapshots FOR INSERT
  WITH CHECK (workspace_id IN (SELECT public.user_workspace_ids()));

-- ── pincode_checks ────────────────────────────────────────────────────────
CREATE POLICY "pincode_checks: member select"
  ON public.pincode_checks FOR SELECT
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

CREATE POLICY "pincode_checks: member insert"
  ON public.pincode_checks FOR INSERT
  WITH CHECK (workspace_id IN (SELECT public.user_workspace_ids()));

-- ── buybox_snapshots ──────────────────────────────────────────────────────
CREATE POLICY "buybox_snapshots: member select"
  ON public.buybox_snapshots FOR SELECT
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

CREATE POLICY "buybox_snapshots: member insert"
  ON public.buybox_snapshots FOR INSERT
  WITH CHECK (workspace_id IN (SELECT public.user_workspace_ids()));

-- ── competitor_asins ──────────────────────────────────────────────────────
CREATE POLICY "competitor_asins: member select"
  ON public.competitor_asins FOR SELECT
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

CREATE POLICY "competitor_asins: member insert"
  ON public.competitor_asins FOR INSERT
  WITH CHECK (workspace_id IN (SELECT public.user_workspace_ids()));

CREATE POLICY "competitor_asins: member update"
  ON public.competitor_asins FOR UPDATE
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

CREATE POLICY "competitor_asins: member delete"
  ON public.competitor_asins FOR DELETE
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

-- ── alerts ────────────────────────────────────────────────────────────────
CREATE POLICY "alerts: member select"
  ON public.alerts FOR SELECT
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

CREATE POLICY "alerts: member insert"
  ON public.alerts FOR INSERT
  WITH CHECK (workspace_id IN (SELECT public.user_workspace_ids()));

CREATE POLICY "alerts: member update"
  ON public.alerts FOR UPDATE
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

-- ── reports ───────────────────────────────────────────────────────────────
CREATE POLICY "reports: member select"
  ON public.reports FOR SELECT
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

CREATE POLICY "reports: member insert"
  ON public.reports FOR INSERT
  WITH CHECK (workspace_id IN (SELECT public.user_workspace_ids()));

-- ── usage_counters ────────────────────────────────────────────────────────
CREATE POLICY "usage_counters: member select"
  ON public.usage_counters FOR SELECT
  USING (workspace_id IN (SELECT public.user_workspace_ids()));


-- ============================================================
-- AUTO-UPDATE updated_at TRIGGER
-- ============================================================

CREATE OR REPLACE FUNCTION public.fn_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

CREATE TRIGGER trg_workspaces_updated_at
  BEFORE UPDATE ON public.workspaces
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

CREATE TRIGGER trg_tracked_asins_updated_at
  BEFORE UPDATE ON public.tracked_asins
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

CREATE TRIGGER trg_workspace_subscriptions_updated_at
  BEFORE UPDATE ON public.workspace_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

CREATE TRIGGER trg_usage_counters_updated_at
  BEFORE UPDATE ON public.usage_counters
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();


-- ============================================================
-- TRIGGER: create profile row after auth.users signup
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
END;
$$;

CREATE OR REPLACE TRIGGER trg_on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.fn_handle_new_user();


-- ============================================================
-- TRIGGER: create default workspace + Free plan after profile created
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
  VALUES (v_workspace_id, NEW.id, 'owner');

  -- 3. Assign Free plan
  SELECT id INTO v_free_plan_id
  FROM   public.subscription_plans
  WHERE  name = 'Free'
  LIMIT  1;

  IF v_free_plan_id IS NOT NULL THEN
    INSERT INTO public.workspace_subscriptions
      (workspace_id, plan_id, status, current_period_start, current_period_end)
    VALUES
      (v_workspace_id, v_free_plan_id, 'active', NOW(), NOW() + INTERVAL '365 days');
  END IF;

  -- 4. Init usage counter for current month
  INSERT INTO public.usage_counters (workspace_id, period_start, period_end)
  VALUES (
    v_workspace_id,
    date_trunc('month', NOW()),
    date_trunc('month', NOW()) + INTERVAL '1 month'
  );

  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER trg_on_profile_created
  AFTER INSERT ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.fn_handle_new_profile();


-- ============================================================
-- SEED: SUBSCRIPTION PLANS
-- (prices in INR ₹ — insert before any users sign up)
-- ============================================================

INSERT INTO public.subscription_plans
  (name, price_monthly, asin_limit, keyword_limit, pincode_check_limit, competitor_limit, report_limit, features)
VALUES
  (
    'Free', 0,
    5, 20, 100, 3, 3,
    '{
      "bsr_tracker": true,
      "pincode_checker": false,
      "buy_box": false,
      "keywords": false,
      "competitors": false,
      "alerts": true,
      "reports": false,
      "refresh_interval_hours": 24,
      "api_access": false,
      "white_label": false,
      "multi_workspace": false
    }'
  ),
  (
    'Starter', 999,
    20, 100, 500, 10, 10,
    '{
      "bsr_tracker": true,
      "pincode_checker": true,
      "buy_box": false,
      "keywords": true,
      "competitors": false,
      "alerts": true,
      "reports": true,
      "refresh_interval_hours": 12,
      "api_access": false,
      "white_label": false,
      "multi_workspace": false
    }'
  ),
  (
    'Growth', 2499,
    50, 300, 2000, 25, 30,
    '{
      "bsr_tracker": true,
      "pincode_checker": true,
      "buy_box": true,
      "keywords": true,
      "competitors": true,
      "alerts": true,
      "reports": true,
      "refresh_interval_hours": 6,
      "api_access": false,
      "white_label": false,
      "multi_workspace": false
    }'
  ),
  (
    'Pro', 4999,
    150, 1000, 10000, 50, 100,
    '{
      "bsr_tracker": true,
      "pincode_checker": true,
      "buy_box": true,
      "keywords": true,
      "competitors": true,
      "alerts": true,
      "reports": true,
      "refresh_interval_hours": 3,
      "api_access": true,
      "white_label": false,
      "multi_workspace": false
    }'
  ),
  (
    'Agency', 9999,
    500, 5000, 50000, 200, 500,
    '{
      "bsr_tracker": true,
      "pincode_checker": true,
      "buy_box": true,
      "keywords": true,
      "competitors": true,
      "alerts": true,
      "reports": true,
      "refresh_interval_hours": 1,
      "api_access": true,
      "white_label": true,
      "multi_workspace": true
    }'
  )
ON CONFLICT (name) DO NOTHING;
