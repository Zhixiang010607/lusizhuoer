-- Migration 075: teacher attendance face profiles and immutable daily clock-ins.
-- A profile is enrolled by HQ during teacher creation. Clock-in photos are
-- verified in memory and are never stored; only audit metadata and location
-- are persisted after a successful 1:1 match.

BEGIN;

DO $$
BEGIN
  IF TO_REGCLASS('public.staff_accounts') IS NULL OR TO_REGCLASS('public.teachers') IS NULL THEN
    RAISE EXCEPTION 'migration 075 requires public.staff_accounts and public.teachers';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'migration 075 requires the CloudBase service_role';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.teacher_attendance_face_profiles (
  id BIGSERIAL PRIMARY KEY,
  teacher_id BIGINT NOT NULL UNIQUE
    REFERENCES public.teachers(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  staff_account_id BIGINT NOT NULL UNIQUE
    REFERENCES public.staff_accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  face_person_id VARCHAR(96) NOT NULL UNIQUE,
  face_id VARCHAR(128) NOT NULL,
  profile_photo_file_id TEXT NOT NULL,
  enrolled_by_account_id BIGINT NOT NULL
    REFERENCES public.staff_accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  consent_at TIMESTAMPTZ NOT NULL,
  quality_score NUMERIC(6,2),
  liveness_score NUMERIC(6,2),
  face_request_id VARCHAR(128) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  CONSTRAINT teacher_attendance_face_person_check CHECK (CHAR_LENGTH(BTRIM(face_person_id)) BETWEEN 8 AND 96),
  CONSTRAINT teacher_attendance_face_id_check CHECK (CHAR_LENGTH(BTRIM(face_id)) BETWEEN 1 AND 128),
  CONSTRAINT teacher_attendance_face_photo_check CHECK (profile_photo_file_id LIKE 'pg://%')
);

CREATE TABLE IF NOT EXISTS public.teacher_attendance_records (
  id BIGSERIAL PRIMARY KEY,
  teacher_id BIGINT NOT NULL
    REFERENCES public.teachers(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  staff_account_id BIGINT NOT NULL
    REFERENCES public.staff_accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  attendance_date DATE NOT NULL,
  checked_in_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  latitude NUMERIC(10,7) NOT NULL,
  longitude NUMERIC(10,7) NOT NULL,
  accuracy_m NUMERIC(10,2) NOT NULL,
  face_score NUMERIC(6,2) NOT NULL,
  face_request_id VARCHAR(128) NOT NULL,
  quality_score NUMERIC(6,2),
  liveness_score NUMERIC(6,2),
  client_request_id VARCHAR(96) NOT NULL,
  device_platform VARCHAR(24) NOT NULL DEFAULT 'UNKNOWN',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  CONSTRAINT uq_teacher_attendance_account_date UNIQUE (staff_account_id, attendance_date),
  CONSTRAINT uq_teacher_attendance_account_request UNIQUE (staff_account_id, client_request_id),
  CONSTRAINT teacher_attendance_latitude_check CHECK (latitude BETWEEN -90 AND 90),
  CONSTRAINT teacher_attendance_longitude_check CHECK (longitude BETWEEN -180 AND 180),
  CONSTRAINT teacher_attendance_accuracy_check CHECK (accuracy_m > 0 AND accuracy_m <= 500),
  CONSTRAINT teacher_attendance_face_score_check CHECK (face_score BETWEEN 0 AND 100),
  CONSTRAINT teacher_attendance_request_check CHECK (CHAR_LENGTH(BTRIM(client_request_id)) BETWEEN 8 AND 96),
  CONSTRAINT teacher_attendance_platform_check CHECK (device_platform IN ('IOS', 'ANDROID', 'IPAD', 'OTHER', 'UNKNOWN'))
);

CREATE INDEX IF NOT EXISTS idx_teacher_attendance_records_date_teacher
  ON public.teacher_attendance_records (attendance_date DESC, teacher_id);

CREATE OR REPLACE FUNCTION public.enforce_teacher_attendance_insert_v75()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  shanghai_today DATE := (CLOCK_TIMESTAMP() AT TIME ZONE 'Asia/Shanghai')::DATE;
  valid_teacher BOOLEAN := FALSE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'teacher attendance records are immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.attendance_date IS DISTINCT FROM shanghai_today THEN
    RAISE EXCEPTION 'teacher attendance may only be recorded for the current Shanghai date'
      USING ERRCODE = '23514';
  END IF;
  SELECT EXISTS (
    SELECT 1
      FROM public.staff_accounts AS account
      JOIN public.teachers AS teacher
        ON teacher.staff_account_id = account.id
       AND teacher.id = NEW.teacher_id
      JOIN public.teacher_attendance_face_profiles AS profile
        ON profile.teacher_id = teacher.id
       AND profile.staff_account_id = account.id
     WHERE account.id = NEW.staff_account_id
       AND account.role_code = 'teacher'
       AND account.account_status = 'ACTIVE'
       AND teacher.teacher_status = 'ACTIVE'
  ) INTO valid_teacher;
  IF NOT valid_teacher THEN
    RAISE EXCEPTION 'attendance is restricted to active teachers with an enrolled profile'
      USING ERRCODE = '23514';
  END IF;
  NEW.checked_in_at := CLOCK_TIMESTAMP();
  NEW.created_at := NEW.checked_in_at;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_teacher_attendance_insert_v75
  ON public.teacher_attendance_records;
CREATE TRIGGER trg_teacher_attendance_insert_v75
BEFORE INSERT OR UPDATE OR DELETE ON public.teacher_attendance_records
FOR EACH ROW EXECUTE FUNCTION public.enforce_teacher_attendance_insert_v75();

REVOKE ALL ON TABLE public.teacher_attendance_face_profiles FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.teacher_attendance_records FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.teacher_attendance_face_profiles_id_seq FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.teacher_attendance_records_id_seq FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_teacher_attendance_insert_v75() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON TABLE public.teacher_attendance_face_profiles FROM service_role;
REVOKE ALL ON TABLE public.teacher_attendance_records FROM service_role;
GRANT SELECT, INSERT, DELETE ON TABLE public.teacher_attendance_face_profiles TO service_role;
GRANT SELECT, INSERT ON TABLE public.teacher_attendance_records TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.teacher_attendance_face_profiles_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.teacher_attendance_records_id_seq TO service_role;

COMMENT ON TABLE public.teacher_attendance_face_profiles IS
  'Migration 075: HQ-enrolled attendance-only teacher face profiles; not an account or business authorization gate.';
COMMENT ON TABLE public.teacher_attendance_records IS
  'Migration 075: immutable once-daily teacher clock-ins with server time, location and face audit metadata; clock-in photos are not stored.';

COMMIT;
