-- ─────────────────────────────────────────────────────────────────────────────
-- 006_amazon_spapi_foundation.sql
-- Amazon SP-API Foundation: connection record, marketplace reference data,
-- and audit log.
--
-- Phase 1A only. OAuth flows, report job/document, and Brand Analytics
-- tables are deferred to later phases.
-- ─────────────────────────────────────────────────────────────────────────────


-- ── 1. amazon_marketplaces ────────────────────────────────────────────────────
-- Reference table for Amazon marketplace IDs, endpoints, and regions.
-- Readable by any authenticated user (public reference data — no workspace scope).
-- All writes are performed directly in migrations or by service-role.

CREATE TABLE IF NOT EXISTS public.amazon_marketplaces (
  id           text PRIMARY KEY,   -- Amazon marketplace ID e.g. A21TJRUUN4KGV
  country_code text NOT NULL,
  name         text NOT NULL,
  api_endpoint text NOT NULL,
  lwa_region   text NOT NULL,      -- LWA token endpoint region
  currency     text NOT NULL
);

-- Seed reference rows (upsert — safe to re-run)
INSERT INTO public.amazon_marketplaces (id, country_code, name, api_endpoint, lwa_region, currency)
VALUES
  ('A21TJRUUN4KGV',  'IN', 'Amazon India',  'https://sellingpartnerapi-eu.amazon.com', 'eu-west-1', 'INR'),
  ('ATVPDKIKX0DER',  'US', 'Amazon US',     'https://sellingpartnerapi-na.amazon.com', 'us-east-1', 'USD'),
  ('A1F83G8C2ARO7P', 'GB', 'Amazon UK',     'https://sellingpartnerapi-eu.amazon.com', 'eu-west-1', 'GBP')
ON CONFLICT (id) DO UPDATE SET
  country_code = EXCLUDED.country_code,
  name         = EXCLUDED.name,
  api_endpoint = EXCLUDED.api_endpoint,
  lwa_region   = EXCLUDED.lwa_region,
  currency     = EXCLUDED.currency;

ALTER TABLE public.amazon_marketplaces ENABLE ROW LEVEL SECURITY;

-- Any authenticated user can read marketplace reference data
CREATE POLICY "amazon_marketplaces_authenticated_read"
  ON public.amazon_marketplaces
  FOR SELECT
  TO authenticated
  USING (true);

-- No INSERT/UPDATE/DELETE for authenticated role — writes via service-role only


-- ── 2. amazon_connections ─────────────────────────────────────────────────────
-- One row per workspace. Stores the SP-API connection state.
--
-- SECURITY NOTE: refresh_token_encrypted and access_token_encrypted hold
-- AES-256-GCM ciphertext (iv:ct:tag).  They must NEVER be returned to the
-- frontend.  The status API route explicitly excludes them.

CREATE TABLE IF NOT EXISTS public.amazon_connections (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,

  -- SP-API identity (populated after OAuth completes)
  selling_partner_id       text,
  marketplace_id           text,
  marketplace_name         text,

  -- Encrypted tokens — server-side only, AES-256-GCM via src/lib/amazon/crypto.ts
  refresh_token_encrypted  text,
  access_token_encrypted   text,
  access_token_expires_at  timestamptz,

  -- Connection lifecycle
  status                   text        NOT NULL DEFAULT 'not_connected'
                           CHECK (status IN ('not_connected', 'active', 'expired', 'revoked', 'error')),
  connected_by_user_id     uuid        REFERENCES auth.users(id),
  connected_at             timestamptz,
  last_sync_at             timestamptz,
  error_message            text,
  updated_at               timestamptz NOT NULL DEFAULT now(),

  -- SP-API capability flags (determined post-connection)
  brand_analytics_eligible boolean     NOT NULL DEFAULT false,
  brand_registry_enrolled  boolean     NOT NULL DEFAULT false
);

-- Enforce one connection record per workspace
CREATE UNIQUE INDEX IF NOT EXISTS amazon_connections_workspace_id_idx
  ON public.amazon_connections (workspace_id);

ALTER TABLE public.amazon_connections ENABLE ROW LEVEL SECURITY;

-- Workspace members can read connection metadata (safe fields enforced at API layer)
CREATE POLICY "amazon_connections_workspace_read"
  ON public.amazon_connections
  FOR SELECT
  TO authenticated
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

-- No INSERT/UPDATE/DELETE for authenticated role — all writes via service-role admin client


-- ── 3. amazon_audit_logs ─────────────────────────────────────────────────────
-- Immutable append-only log for SP-API events: OAuth connect/disconnect,
-- token refreshes, sync runs, errors.
-- Writes: service-role only.

CREATE TABLE IF NOT EXISTS public.amazon_audit_logs (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid        NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  user_id      uuid        REFERENCES auth.users(id),
  event_type   text        NOT NULL,  -- e.g. 'oauth_connect', 'token_refresh', 'sync_complete', 'oauth_revoke'
  details      jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Efficient workspace + time lookups
CREATE INDEX IF NOT EXISTS amazon_audit_logs_workspace_created_idx
  ON public.amazon_audit_logs (workspace_id, created_at DESC);

ALTER TABLE public.amazon_audit_logs ENABLE ROW LEVEL SECURITY;

-- Workspace members can read their own audit log
CREATE POLICY "amazon_audit_logs_workspace_read"
  ON public.amazon_audit_logs
  FOR SELECT
  TO authenticated
  USING (workspace_id IN (SELECT public.user_workspace_ids()));

-- No INSERT/UPDATE/DELETE for authenticated role — writes via service-role only
