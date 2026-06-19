-- Structured inventory additions for the Internal Emount Amazon sync.
-- No raw inventory payloads, order rows, or customer data are stored.

ALTER TABLE public.amazon_inventory_summaries
  ADD COLUMN IF NOT EXISTS unfulfillable_quantity integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'amazon_api',
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DROP TRIGGER IF EXISTS trg_amazon_inventory_summaries_updated_at
  ON public.amazon_inventory_summaries;
CREATE TRIGGER trg_amazon_inventory_summaries_updated_at
  BEFORE UPDATE ON public.amazon_inventory_summaries
  FOR EACH ROW EXECUTE FUNCTION public.fn_set_updated_at();

NOTIFY pgrst, 'reload schema';
