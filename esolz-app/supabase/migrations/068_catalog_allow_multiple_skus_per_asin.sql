-- Seller listings are identified by workspace, SKU, and marketplace. Multiple
-- seller SKUs may legitimately share an ASIN in the same marketplace.
-- Keep amazon_listing_items_workspace_id_sku_marketplace_id_key unchanged.
CREATE INDEX IF NOT EXISTS amazon_listing_items_asin_marketplace_idx
  ON public.amazon_listing_items (workspace_id, asin, marketplace_id)
  WHERE asin IS NOT NULL;

DROP INDEX IF EXISTS public.amazon_listing_items_asin_marketplace_uidx;
