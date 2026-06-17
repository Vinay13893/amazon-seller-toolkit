-- Chunked backfill helper for grouped Brand Analytics Top Search Terms rows.

CREATE OR REPLACE FUNCTION public.backfill_brand_analytics_search_terms_grouped_rows(
  p_report_document_id text,
  p_min_rank integer,
  p_max_rank integer
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inserted_count integer := 0;
BEGIN
  WITH grouped AS (
    SELECT
      workspace_id,
      max(marketplace_id) AS marketplace_id,
      max(report_id) AS report_id,
      report_document_id,
      CASE
        WHEN min(data_start_time) IS NOT NULL OR max(data_end_time) IS NOT NULL
          THEN concat_ws(' to ', min(data_start_time)::date::text, max(data_end_time)::date::text)
        ELSE NULL
      END AS report_period,
      min(data_start_time) AS data_start_time,
      max(data_end_time) AS data_end_time,
      search_term,
      coalesce(search_frequency_rank, 0)::integer AS search_frequency_rank,
      coalesce(department_name, '') AS department_name,
      max(clicked_asin) FILTER (WHERE click_share_rank = 1) AS product_1_asin,
      max(clicked_item_name) FILTER (WHERE click_share_rank = 1) AS product_1_title,
      max(click_share) FILTER (WHERE click_share_rank = 1) AS product_1_click_share,
      max(conversion_share) FILTER (WHERE click_share_rank = 1) AS product_1_conversion_share,
      max(clicked_asin) FILTER (WHERE click_share_rank = 2) AS product_2_asin,
      max(clicked_item_name) FILTER (WHERE click_share_rank = 2) AS product_2_title,
      max(click_share) FILTER (WHERE click_share_rank = 2) AS product_2_click_share,
      max(conversion_share) FILTER (WHERE click_share_rank = 2) AS product_2_conversion_share,
      max(clicked_asin) FILTER (WHERE click_share_rank = 3) AS product_3_asin,
      max(clicked_item_name) FILTER (WHERE click_share_rank = 3) AS product_3_title,
      max(click_share) FILTER (WHERE click_share_rank = 3) AS product_3_click_share,
      max(conversion_share) FILTER (WHERE click_share_rank = 3) AS product_3_conversion_share
    FROM public.brand_analytics_search_terms_rows
    WHERE report_document_id = p_report_document_id
      AND search_term IS NOT NULL
      AND search_term <> ''
      AND coalesce(search_frequency_rank, 0)::integer BETWEEN p_min_rank AND p_max_rank
    GROUP BY
      workspace_id,
      report_document_id,
      search_term,
      coalesce(search_frequency_rank, 0),
      coalesce(department_name, '')
  ),
  upserted AS (
    INSERT INTO public.brand_analytics_search_terms_grouped_rows (
      workspace_id,
      amazon_connection_id,
      marketplace_id,
      report_id,
      report_document_id,
      report_period,
      data_start_time,
      data_end_time,
      search_term,
      search_frequency_rank,
      department_name,
      product_1_asin,
      product_1_title,
      product_1_click_share,
      product_1_conversion_share,
      product_2_asin,
      product_2_title,
      product_2_click_share,
      product_2_conversion_share,
      product_3_asin,
      product_3_title,
      product_3_click_share,
      product_3_conversion_share,
      opportunity_tag,
      suggested_action
    )
    SELECT
      workspace_id,
      NULL::uuid,
      marketplace_id,
      report_id,
      report_document_id,
      report_period,
      data_start_time,
      data_end_time,
      search_term,
      search_frequency_rank,
      department_name,
      product_1_asin,
      product_1_title,
      product_1_click_share,
      product_1_conversion_share,
      product_2_asin,
      product_2_title,
      product_2_click_share,
      product_2_conversion_share,
      product_3_asin,
      product_3_title,
      product_3_click_share,
      product_3_conversion_share,
      CASE
        WHEN search_frequency_rank <= 1000 AND coalesce(product_1_conversion_share, 0) < 2
          THEN 'Conversion gap'
        WHEN search_frequency_rank <= 5000 AND coalesce(product_1_click_share, 0) < 5
          THEN 'Click share opportunity'
        WHEN coalesce(product_1_click_share, 0) >= 10 AND coalesce(product_1_conversion_share, 0) >= 8
          THEN 'Winning term'
        ELSE 'Monitor'
      END AS opportunity_tag,
      CASE
        WHEN search_frequency_rank <= 1000 AND coalesce(product_1_conversion_share, 0) < 2
          THEN 'Improve image/title/price/reviews'
        WHEN search_frequency_rank <= 5000 AND coalesce(product_1_click_share, 0) < 5
          THEN 'Add to exact-match campaign'
        WHEN coalesce(product_1_click_share, 0) >= 10 AND coalesce(product_1_conversion_share, 0) >= 8
          THEN 'Protect winning term'
        ELSE 'Monitor next report'
      END AS suggested_action
    FROM grouped
    ON CONFLICT (
      workspace_id,
      report_document_id,
      search_term,
      search_frequency_rank,
      department_name
    ) DO UPDATE SET
      marketplace_id = EXCLUDED.marketplace_id,
      report_id = EXCLUDED.report_id,
      report_period = EXCLUDED.report_period,
      data_start_time = EXCLUDED.data_start_time,
      data_end_time = EXCLUDED.data_end_time,
      product_1_asin = EXCLUDED.product_1_asin,
      product_1_title = EXCLUDED.product_1_title,
      product_1_click_share = EXCLUDED.product_1_click_share,
      product_1_conversion_share = EXCLUDED.product_1_conversion_share,
      product_2_asin = EXCLUDED.product_2_asin,
      product_2_title = EXCLUDED.product_2_title,
      product_2_click_share = EXCLUDED.product_2_click_share,
      product_2_conversion_share = EXCLUDED.product_2_conversion_share,
      product_3_asin = EXCLUDED.product_3_asin,
      product_3_title = EXCLUDED.product_3_title,
      product_3_click_share = EXCLUDED.product_3_click_share,
      product_3_conversion_share = EXCLUDED.product_3_conversion_share,
      opportunity_tag = EXCLUDED.opportunity_tag,
      suggested_action = EXCLUDED.suggested_action,
      updated_at = now()
    RETURNING 1
  )
  SELECT count(*) INTO inserted_count FROM upserted;

  RETURN inserted_count;
END;
$$;

NOTIFY pgrst, 'reload schema';
