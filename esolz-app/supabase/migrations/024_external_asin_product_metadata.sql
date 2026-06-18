-- Extend the existing workspace-scoped competitor ASIN table so Keywords can
-- store structured metadata for competitor and external products.
-- No raw HTML or page payloads are stored.

ALTER TABLE public.competitor_asins
  ADD COLUMN IF NOT EXISTS image_url TEXT,
  ADD COLUMN IF NOT EXISTS product_url TEXT,
  ADD COLUMN IF NOT EXISTS source_type TEXT NOT NULL DEFAULT 'competitor',
  ADD COLUMN IF NOT EXISTS metadata_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS last_enriched_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS error_code TEXT,
  ADD COLUMN IF NOT EXISTS error_message TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE public.competitor_asins
  DROP CONSTRAINT IF EXISTS competitor_asins_source_type_check,
  ADD CONSTRAINT competitor_asins_source_type_check
    CHECK (source_type IN ('competitor', 'external')),
  DROP CONSTRAINT IF EXISTS competitor_asins_metadata_status_check,
  ADD CONSTRAINT competitor_asins_metadata_status_check
    CHECK (metadata_status IN ('pending', 'found', 'not_found', 'error'));

DROP TRIGGER IF EXISTS trg_competitor_asins_updated_at ON public.competitor_asins;
CREATE TRIGGER trg_competitor_asins_updated_at
  BEFORE UPDATE ON public.competitor_asins
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

CREATE INDEX IF NOT EXISTS idx_competitor_asins_workspace_source
  ON public.competitor_asins(workspace_id, source_type);

-- Backfill legacy manually-added rows without preserving the old fake
-- "External ASIN <value>" title.
INSERT INTO public.competitor_asins (
  workspace_id,
  tracked_asin_id,
  competitor_asin,
  product_title,
  brand,
  marketplace,
  category,
  image_url,
  product_url,
  source_type,
  metadata_status
)
SELECT
  ta.workspace_id,
  ta.id,
  ta.asin,
  CASE
    WHEN lower(coalesce(ta.product_title, '')) LIKE 'external asin %' THEN NULL
    ELSE ta.product_title
  END,
  ta.brand,
  ta.marketplace,
  ta.category,
  ta.image_url,
  CASE
    WHEN ta.marketplace = 'US' THEN 'https://www.amazon.com/dp/' || ta.asin
    ELSE 'https://www.amazon.in/dp/' || ta.asin
  END,
  'external',
  CASE
    WHEN ta.product_title IS NULL
      OR lower(ta.product_title) LIKE 'external asin %'
    THEN 'pending'
    ELSE 'found'
  END
FROM public.tracked_asins AS ta
WHERE lower(coalesce(ta.category, '')) LIKE '%external%'
   OR lower(coalesce(ta.product_title, '')) LIKE 'external asin %'
ON CONFLICT (workspace_id, competitor_asin, marketplace) DO UPDATE SET
  tracked_asin_id = EXCLUDED.tracked_asin_id,
  product_title = COALESCE(public.competitor_asins.product_title, EXCLUDED.product_title),
  brand = COALESCE(public.competitor_asins.brand, EXCLUDED.brand),
  image_url = COALESCE(public.competitor_asins.image_url, EXCLUDED.image_url),
  product_url = COALESCE(public.competitor_asins.product_url, EXCLUDED.product_url),
  updated_at = NOW();

NOTIFY pgrst, 'reload schema';
