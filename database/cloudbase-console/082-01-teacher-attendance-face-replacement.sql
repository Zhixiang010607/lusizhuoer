-- Migration 082: auditable HQ-only replacement of the attendance face profile.
-- This changes no attendance record, daily report, verification order, balance,
-- BLE authorization or customer-face data. Only service_role may update the
-- dedicated teacher attendance profile through the teacherCreate cloud function.

BEGIN;

DO $$
BEGIN
  IF TO_REGCLASS('public.teacher_attendance_face_profiles') IS NULL THEN
    RAISE EXCEPTION 'migration 082 requires public.teacher_attendance_face_profiles';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'migration 082 requires the CloudBase service_role';
  END IF;
END;
$$;

ALTER TABLE public.teacher_attendance_face_profiles
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  ADD COLUMN IF NOT EXISTS replacement_count INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.teacher_attendance_face_profiles'::regclass
       AND conname = 'teacher_attendance_face_replacement_count_check'
  ) THEN
    ALTER TABLE public.teacher_attendance_face_profiles
      ADD CONSTRAINT teacher_attendance_face_replacement_count_check
      CHECK (replacement_count >= 0);
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS public.teacher_attendance_face_replacements (
  id BIGSERIAL PRIMARY KEY,
  teacher_id BIGINT NOT NULL
    REFERENCES public.teachers(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  staff_account_id BIGINT NOT NULL
    REFERENCES public.staff_accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  replaced_by_account_id BIGINT NOT NULL
    REFERENCES public.staff_accounts(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  client_request_id VARCHAR(96) NOT NULL UNIQUE,
  previous_face_person_id VARCHAR(96) NOT NULL,
  new_face_person_id VARCHAR(96) NOT NULL UNIQUE,
  previous_profile_photo_file_id TEXT NOT NULL,
  new_profile_photo_file_id TEXT NOT NULL,
  quality_score NUMERIC(6,2),
  liveness_score NUMERIC(6,2),
  face_request_id VARCHAR(128) NOT NULL DEFAULT '',
  replaced_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  CONSTRAINT teacher_attendance_face_replacement_request_check
    CHECK (CHAR_LENGTH(BTRIM(client_request_id)) BETWEEN 8 AND 96),
  CONSTRAINT teacher_attendance_face_replacement_person_check
    CHECK (previous_face_person_id <> new_face_person_id),
  CONSTRAINT teacher_attendance_face_replacement_photo_check
    CHECK (previous_profile_photo_file_id LIKE 'pg://%' AND new_profile_photo_file_id LIKE 'pg://%')
);

CREATE INDEX IF NOT EXISTS idx_teacher_attendance_face_replacements_teacher_time
  ON public.teacher_attendance_face_replacements (teacher_id, replaced_at DESC, id DESC);

CREATE OR REPLACE FUNCTION public.guard_teacher_attendance_face_profile_update_v82()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;
  IF NEW.teacher_id IS DISTINCT FROM OLD.teacher_id
     OR NEW.staff_account_id IS DISTINCT FROM OLD.staff_account_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'teacher attendance face profile ownership is immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.face_person_id IS NOT DISTINCT FROM OLD.face_person_id
     OR NEW.face_id IS NOT DISTINCT FROM OLD.face_id
     OR NEW.profile_photo_file_id IS NOT DISTINCT FROM OLD.profile_photo_file_id THEN
    RAISE EXCEPTION 'attendance face replacement must replace person, face and private photo together'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.replacement_count IS DISTINCT FROM OLD.replacement_count + 1 THEN
    RAISE EXCEPTION 'attendance face replacement count must advance exactly once'
      USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := CLOCK_TIMESTAMP();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_teacher_attendance_face_profile_update_v82
  ON public.teacher_attendance_face_profiles;
CREATE TRIGGER trg_teacher_attendance_face_profile_update_v82
BEFORE UPDATE ON public.teacher_attendance_face_profiles
FOR EACH ROW EXECUTE FUNCTION public.guard_teacher_attendance_face_profile_update_v82();

REVOKE ALL ON TABLE public.teacher_attendance_face_profiles FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.teacher_attendance_face_replacements FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.teacher_attendance_face_replacements_id_seq FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_teacher_attendance_face_profile_update_v82() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON TABLE public.teacher_attendance_face_profiles FROM service_role;
REVOKE ALL ON TABLE public.teacher_attendance_face_replacements FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.teacher_attendance_face_profiles TO service_role;
GRANT SELECT, INSERT ON TABLE public.teacher_attendance_face_replacements TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.teacher_attendance_face_replacements_id_seq TO service_role;

COMMENT ON TABLE public.teacher_attendance_face_replacements IS
  'Migration 082: immutable audit of HQ onsite replacements of attendance-only teacher face profiles.';
COMMENT ON COLUMN public.teacher_attendance_face_profiles.replacement_count IS
  'Migration 082: number of successful atomic HQ attendance-face replacements.';

COMMIT;
