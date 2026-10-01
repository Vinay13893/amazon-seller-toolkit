-- Page 3 / Keywords product separation.
--
-- Keyword rank tracking is ASIN-level. Seller listings remain SKU-level, so
-- an own keyword must not bind to one arbitrary amazon_listing_items row when
-- several SKUs share the same ASIN. Competitors continue to bind to a genuine
-- tracked_asins row; research keywords have neither product reference.

ALTER TABLE public.tracked_keywords
  ADD COLUMN IF NOT EXISTS own_asin text;

CREATE UNIQUE INDEX IF NOT EXISTS tracked_asins_workspace_id_id_uidx
  ON public.tracked_asins (workspace_id, id);

DROP INDEX IF EXISTS public.tracked_keywords_asin_keyword_marketplace_uidx;
DROP INDEX IF EXISTS public.tracked_keywords_unassigned_keyword_marketplace_uidx;

-- Reclassify every legacy own-catalog overlap without changing its keyword ID.
-- EXISTS deliberately avoids selecting a listing ID, so one or many seller
-- SKUs for the ASIN produce the same ASIN-level keyword target.
UPDATE public.tracked_keywords tk
SET
  own_asin = upper(btrim(ta.asin)),
  tracked_asin_id = NULL
FROM public.tracked_asins ta
WHERE tk.tracked_asin_id = ta.id
  AND tk.workspace_id = ta.workspace_id
  AND tk.own_asin IS NULL
  AND EXISTS (
    SELECT 1
    FROM public.amazon_listing_items li
    WHERE li.workspace_id = tk.workspace_id
      AND upper(btrim(li.asin)) = upper(btrim(ta.asin))
      AND li.marketplace_id = CASE upper(btrim(tk.marketplace))
        WHEN 'IN' THEN 'A21TJRUUN4KGV'
        WHEN 'US' THEN 'ATVPDKIKX0DER'
        WHEN 'UK' THEN 'A1F83G8C2ARO7P'
        WHEN 'GB' THEN 'A1F83G8C2ARO7P'
        WHEN 'DE' THEN 'A1PA6795UKMFR9'
        ELSE NULL
      END
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
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
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tracked_keywords_not_both_product_refs_chk'
      AND conrelid = 'public.tracked_keywords'::regclass
  ) THEN
    ALTER TABLE public.tracked_keywords
      ADD CONSTRAINT tracked_keywords_not_both_product_refs_chk
      CHECK (NOT (own_asin IS NOT NULL AND tracked_asin_id IS NOT NULL));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tracked_keywords_own_asin_format_chk'
      AND conrelid = 'public.tracked_keywords'::regclass
  ) THEN
    ALTER TABLE public.tracked_keywords
      ADD CONSTRAINT tracked_keywords_own_asin_format_chk
      CHECK (own_asin IS NULL OR own_asin ~ '^[A-Z0-9]{10}$');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS tracked_keywords_own_asin_idx
  ON public.tracked_keywords (workspace_id, own_asin, marketplace)
  WHERE own_asin IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS tracked_keywords_own_asin_keyword_marketplace_uidx
  ON public.tracked_keywords (
    workspace_id,
    own_asin,
    lower(btrim(keyword)),
    upper(btrim(marketplace))
  )
  WHERE own_asin IS NOT NULL;

CREATE UNIQUE INDEX tracked_keywords_asin_keyword_marketplace_uidx
  ON public.tracked_keywords (
    workspace_id,
    tracked_asin_id,
    lower(btrim(keyword)),
    upper(btrim(marketplace))
  )
  WHERE tracked_asin_id IS NOT NULL;

CREATE UNIQUE INDEX tracked_keywords_unassigned_keyword_marketplace_uidx
  ON public.tracked_keywords (
    workspace_id,
    lower(btrim(keyword)),
    upper(btrim(marketplace))
  )
  WHERE tracked_asin_id IS NULL
    AND own_asin IS NULL;

NOTIFY pgrst, 'reload schema';
