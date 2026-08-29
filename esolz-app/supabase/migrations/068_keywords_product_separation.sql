-- 068_keywords_product_separation.sql
-- Page 3 / Keywords product separation.
--
-- My Product keyword tracking binds directly to amazon_listing_items.
-- Competitor keyword tracking continues to bind to genuine external
-- tracked_asins. Historical keyword_rank_snapshots remain attached through
-- tracked_keyword_id, so keyword history is preserved without rewriting
-- snapshot rows.

ALTER TABLE public.tracked_keywords
  ADD COLUMN IF NOT EXISTS amazon_listing_item_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS amazon_listing_items_workspace_id_id_uidx
  ON public.amazon_listing_items (workspace_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS tracked_asins_workspace_id_id_uidx
  ON public.tracked_asins (workspace_id, id);

DROP INDEX IF EXISTS public.tracked_keywords_unassigned_keyword_marketplace_uidx;

UPDATE public.tracked_keywords tk
SET
  amazon_listing_item_id = li.id,
  tracked_asin_id = NULL
FROM public.tracked_asins ta
JOIN public.amazon_listing_items li
  ON li.workspace_id = ta.workspace_id
  AND li.asin = ta.asin
  AND li.marketplace_id = CASE upper(ta.marketplace)
    WHEN 'IN' THEN 'A21TJRUUN4KGV'
    WHEN 'US' THEN 'ATVPDKIKX0DER'
    WHEN 'UK' THEN 'A1F83G8C2ARO7P'
    WHEN 'GB' THEN 'A1F83G8C2ARO7P'
    WHEN 'DE' THEN 'A1PA6795UKMFR9'
    ELSE NULL
  END
WHERE tk.tracked_asin_id = ta.id
  AND tk.workspace_id = ta.workspace_id
  AND tk.amazon_listing_item_id IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'tracked_keywords_listing_fk'
      AND conrelid = 'public.tracked_keywords'::regclass
  ) THEN
    ALTER TABLE public.tracked_keywords
      ADD CONSTRAINT tracked_keywords_listing_fk
      FOREIGN KEY (workspace_id, amazon_listing_item_id)
      REFERENCES public.amazon_listing_items (workspace_id, id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'tracked_keywords_tracked_asin_workspace_fk'
      AND conrelid = 'public.tracked_keywords'::regclass
  ) THEN
    ALTER TABLE public.tracked_keywords
      ADD CONSTRAINT tracked_keywords_tracked_asin_workspace_fk
      FOREIGN KEY (workspace_id, tracked_asin_id)
      REFERENCES public.tracked_asins (workspace_id, id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'tracked_keywords_not_both_product_refs_chk'
      AND conrelid = 'public.tracked_keywords'::regclass
  ) THEN
    ALTER TABLE public.tracked_keywords
      ADD CONSTRAINT tracked_keywords_not_both_product_refs_chk
      CHECK (
        NOT (
          amazon_listing_item_id IS NOT NULL
          AND tracked_asin_id IS NOT NULL
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS tracked_keywords_listing_idx
  ON public.tracked_keywords (amazon_listing_item_id)
  WHERE amazon_listing_item_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS tracked_keywords_listing_keyword_marketplace_uidx
  ON public.tracked_keywords (workspace_id, amazon_listing_item_id, keyword, marketplace)
  WHERE amazon_listing_item_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS tracked_keywords_asin_keyword_marketplace_uidx
  ON public.tracked_keywords (workspace_id, tracked_asin_id, keyword, marketplace)
  WHERE tracked_asin_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS tracked_keywords_unassigned_keyword_marketplace_uidx
  ON public.tracked_keywords (workspace_id, keyword, marketplace)
  WHERE tracked_asin_id IS NULL
    AND amazon_listing_item_id IS NULL;

NOTIFY pgrst, 'reload schema';
