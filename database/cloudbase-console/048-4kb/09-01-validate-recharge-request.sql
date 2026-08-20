-- 048 fallback, 09-01/15. Internal validation shared by the compact recharge wrapper.
BEGIN;
CREATE OR REPLACE FUNCTION public.validate_teacher_experience_quota_recharge(
  p_unit_count INTEGER,
  p_note TEXT,
  p_idempotency_key VARCHAR
)
RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE normalized_note TEXT := BTRIM(COALESCE(p_note, ''));
BEGIN
  IF p_unit_count IS NULL OR p_unit_count < 1 OR p_unit_count > 1000000 THEN
    RAISE EXCEPTION 'recharge unit count must be an integer from 1 to 1000000' USING ERRCODE = '22023';
  END IF;
  IF CHAR_LENGTH(normalized_note) > 500 THEN
    RAISE EXCEPTION 'recharge note is too long' USING ERRCODE = '22001';
  END IF;
  IF BTRIM(COALESCE(p_idempotency_key, '')) !~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$' THEN
    RAISE EXCEPTION 'valid idempotency key is required' USING ERRCODE = '22023';
  END IF;
  RETURN normalized_note;
END;
$$;
COMMIT;
