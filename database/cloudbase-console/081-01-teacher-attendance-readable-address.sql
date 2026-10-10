-- Migration 081: retain an immutable human-readable reverse-geocoded location
-- beside every teacher attendance coordinate. The coordinates and map remain
-- authoritative; address text is informational and may be NULL when an
-- external geocoder is unavailable.

BEGIN;

DO $$
BEGIN
  IF TO_REGCLASS('public.teacher_attendance_records') IS NULL THEN
    RAISE EXCEPTION 'migration 081 requires public.teacher_attendance_records';
  END IF;
END;
$$;

ALTER TABLE public.teacher_attendance_records
  ADD COLUMN IF NOT EXISTS place_name VARCHAR(160),
  ADD COLUMN IF NOT EXISTS formatted_address VARCHAR(500),
  ADD COLUMN IF NOT EXISTS address_provider VARCHAR(24);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.teacher_attendance_records'::regclass
       AND conname = 'teacher_attendance_place_name_check'
  ) THEN
    ALTER TABLE public.teacher_attendance_records
      ADD CONSTRAINT teacher_attendance_place_name_check
      CHECK (place_name IS NULL OR CHAR_LENGTH(BTRIM(place_name)) BETWEEN 1 AND 160);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.teacher_attendance_records'::regclass
       AND conname = 'teacher_attendance_formatted_address_check'
  ) THEN
    ALTER TABLE public.teacher_attendance_records
      ADD CONSTRAINT teacher_attendance_formatted_address_check
      CHECK (formatted_address IS NULL OR CHAR_LENGTH(BTRIM(formatted_address)) BETWEEN 1 AND 500);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.teacher_attendance_records'::regclass
       AND conname = 'teacher_attendance_address_provider_check'
  ) THEN
    ALTER TABLE public.teacher_attendance_records
      ADD CONSTRAINT teacher_attendance_address_provider_check
      CHECK (address_provider IS NULL OR address_provider IN ('TENCENT', 'HERE'));
  END IF;
END;
$$;

REVOKE ALL ON TABLE public.teacher_attendance_records FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.teacher_attendance_records FROM service_role;
GRANT SELECT, INSERT ON TABLE public.teacher_attendance_records TO service_role;

COMMENT ON COLUMN public.teacher_attendance_records.place_name IS
  'Migration 081: nearest reverse-geocoded POI, building, shop or road label; informational only.';
COMMENT ON COLUMN public.teacher_attendance_records.formatted_address IS
  'Migration 081: reverse-geocoded readable address; coordinates remain authoritative.';
COMMENT ON COLUMN public.teacher_attendance_records.address_provider IS
  'Migration 081: server-side reverse-geocoder that produced the readable address.';

COMMIT;
