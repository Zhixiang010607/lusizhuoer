-- CloudBase migration 051, part 4 / 10. Run this file by itself.
BEGIN;
CREATE OR REPLACE FUNCTION public.assert_teacher_face_operation_input(
  p_type VARCHAR, p_request VARCHAR, p_phone VARCHAR, p_name VARCHAR,
  p_sha VARCHAR, p_bytes INTEGER, p_group VARCHAR, p_bucket VARCHAR, p_actor BIGINT,
  p_owner VARCHAR, p_ttl INTEGER
)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF p_type NOT IN ('PROVISION','UPSERT')
     OR p_request !~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$'
     OR p_phone !~ '^1[3-9][0-9]{9}$'
     OR BTRIM(COALESCE(p_name,''))='' OR CHAR_LENGTH(p_name)>100
     OR p_sha !~ '^[a-f0-9]{64}$' OR p_bytes NOT BETWEEN 4 AND 3145728
     OR p_group !~ '^[A-Za-z0-9_-]{1,64}$'
     OR p_bucket !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
     OR p_owner !~ '^[a-f0-9]{64}$'
     OR p_actor IS NULL OR p_actor<1
     OR p_ttl NOT BETWEEN 300 AND 1800 THEN
    RAISE EXCEPTION 'invalid teacher face operation lease' USING ERRCODE='22023';
  END IF;
END;
$$;

COMMIT;
