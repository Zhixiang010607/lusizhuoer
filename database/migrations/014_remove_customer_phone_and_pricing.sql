-- Remove sensitive customer contact and financial fields.
-- Run after the existing schema and migrations. All SQL text is ASCII-only.

BEGIN;

DROP VIEW IF EXISTS public.v_product_store_summary;

ALTER TABLE public.customers
  DROP COLUMN IF EXISTS phone;

DROP INDEX IF EXISTS public.idx_customer_phone;

ALTER TABLE public.products
  DROP COLUMN IF EXISTS price_cent;

ALTER TABLE public.recharge_records
  DROP COLUMN IF EXISTS amount_cent;

CREATE OR REPLACE VIEW public.v_product_store_summary AS
WITH product_store_activity AS (
  SELECT product_id, store_id FROM public.recharge_records
  UNION
  SELECT product_id, store_id FROM public.verification_records
)
SELECT
  p.id AS product_id,
  s.id AS store_id,
  s.store_code,
  s.store_name,
  s.province,
  s.city,
  s.district,
  COUNT(DISTINCT r.id) FILTER (WHERE r.record_status = 'APPROVED') AS recharge_count,
  COUNT(DISTINCT v.id) FILTER (WHERE v.record_status = 'APPROVED') AS verification_count,
  MAX(GREATEST(COALESCE(r.updated_at, r.created_at), COALESCE(v.updated_at, v.created_at))) AS latest_activity_at
FROM product_store_activity a
JOIN public.products p ON p.id = a.product_id
JOIN public.stores s ON s.id = a.store_id
LEFT JOIN public.recharge_records r ON r.product_id = a.product_id AND r.store_id = a.store_id
LEFT JOIN public.verification_records v ON v.product_id = a.product_id AND v.store_id = a.store_id
GROUP BY p.id, s.id, s.store_code, s.store_name, s.province, s.city, s.district;

COMMIT;
