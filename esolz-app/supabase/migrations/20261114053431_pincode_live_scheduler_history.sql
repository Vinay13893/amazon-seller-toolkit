-- Populate the marketplace for results produced by the existing finalize RPC.
CREATE FUNCTION public.pincode_result_marketplace() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.monitored_product_id IS NOT NULL THEN
    SELECT marketplace_id INTO NEW.marketplace_id
    FROM public.pincode_monitored_products
    WHERE id = NEW.monitored_product_id AND workspace_id = NEW.workspace_id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.pincode_result_marketplace() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER pincode_result_marketplace_before_insert
BEFORE INSERT ON public.pincode_availability_results
FOR EACH ROW EXECUTE FUNCTION public.pincode_result_marketplace();

CREATE INDEX pincode_history_workspace_date_idx
ON public.pincode_availability_results(workspace_id, checked_at DESC, id DESC);

-- Hosted default privileges must not expose trusted mutation RPCs.
DO $$ DECLARE f record;
BEGIN
  FOR f IN SELECT oid::regprocedure AS signature FROM pg_proc
    WHERE pronamespace = 'public'::regnamespace AND proname IN (
      'enroll_pincode_monitored_products', 'set_pincode_tracking_state',
      'remove_pincode_monitored_products', 'queue_pincode_manual_check',
      'claim_due_pincode_targets', 'finalize_pincode_check',
      'replace_pincode_product_targets', 'replace_workspace_default_pincodes',
      'get_pincode_target_results')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f.signature);
  END LOOP;
END $$;
GRANT SELECT ON public.workspace_default_pincodes, public.pincode_monitored_products,
  public.pincode_tracking_targets TO authenticated;
GRANT ALL ON public.workspace_default_pincodes, public.pincode_monitored_products,
  public.pincode_tracking_targets TO service_role;
NOTIFY pgrst, 'reload schema';
