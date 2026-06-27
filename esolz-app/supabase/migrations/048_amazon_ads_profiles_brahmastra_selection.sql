-- Profile-level Brahmastra sync selection. An Amazon Ads OAuth connection can
-- carry many advertiser profiles (one per seller/vendor account under the
-- same login); report sync must never default to "every profile" since most
-- of them are unrelated businesses. This adds an explicit opt-in flag per
-- profile, an optional single "primary" designation, and a manual label for
-- profiles where Amazon's account name isn't useful.
-- Read-only with respect to Amazon — these columns are only ever written by
-- our own app in response to a user action in Settings.

ALTER TABLE public.amazon_ads_profiles
  ADD COLUMN IF NOT EXISTS brahmastra_sync_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_primary boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS display_name text;

ALTER TABLE public.amazon_ads_profiles
  DROP CONSTRAINT IF EXISTS amazon_ads_profiles_primary_requires_enabled;
ALTER TABLE public.amazon_ads_profiles
  ADD CONSTRAINT amazon_ads_profiles_primary_requires_enabled
  CHECK (NOT is_primary OR brahmastra_sync_enabled);

-- At most one primary profile per workspace.
CREATE UNIQUE INDEX IF NOT EXISTS amazon_ads_profiles_primary_unique_idx
  ON public.amazon_ads_profiles (workspace_id)
  WHERE is_primary;

NOTIFY pgrst, 'reload schema';
