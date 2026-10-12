-- Training PDFs: explicit HQ-confirmed physical deletion, with minimal
-- request tombstones to prevent a stale upload queue republishing deleted PDFs.
BEGIN;
CREATE TABLE IF NOT EXISTS public.training_material_deleted_requests (
  client_request_id VARCHAR(64) PRIMARY KEY,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.training_material_deleted_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.training_material_deleted_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.training_material_deleted_requests TO service_role;
GRANT DELETE ON TABLE public.training_materials TO service_role;

CREATE OR REPLACE FUNCTION public.guard_deleted_training_upload()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.client_request_id, 987));
  IF EXISTS (SELECT 1 FROM public.training_material_deleted_requests WHERE client_request_id = NEW.client_request_id) THEN
    RAISE EXCEPTION 'training upload request was deleted' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_deleted_training_upload() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS guard_deleted_training_upload ON public.training_materials;
CREATE TRIGGER guard_deleted_training_upload BEFORE INSERT ON public.training_materials
  FOR EACH ROW EXECUTE FUNCTION public.guard_deleted_training_upload();

CREATE OR REPLACE FUNCTION public.finalize_training_material_deletion(p_id BIGINT, p_reference TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE request_key VARCHAR(64);
BEGIN
  SELECT client_request_id INTO request_key FROM public.training_materials WHERE id = p_id;
  IF request_key IS NULL THEN RETURN TRUE; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(request_key, 987));
  WITH removed AS (
    DELETE FROM public.training_materials
     WHERE id = p_id AND file_reference = p_reference AND material_status = 'ARCHIVED'
     RETURNING client_request_id
  ) INSERT INTO public.training_material_deleted_requests (client_request_id)
    SELECT client_request_id FROM removed ON CONFLICT DO NOTHING;
  RETURN NOT EXISTS (SELECT 1 FROM public.training_materials WHERE id = p_id);
END;
$$;
REVOKE ALL ON FUNCTION public.finalize_training_material_deletion(BIGINT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_training_material_deletion(BIGINT, TEXT) TO service_role;
-- Only the exact finalizer deletes rows. Do not expose general table deletion.
REVOKE DELETE ON TABLE public.training_materials FROM service_role;
COMMIT;
