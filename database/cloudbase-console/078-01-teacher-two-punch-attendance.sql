-- Migration 078: two immutable attendance punches per Shanghai business day.
-- Existing migration-075 rows become CLOCK_IN records. A CLOCK_OUT is only
-- accepted after the same active teacher has a CLOCK_IN for that date.

BEGIN;

DO $$
BEGIN
  IF TO_REGCLASS('public.teacher_attendance_records') IS NULL THEN
    RAISE EXCEPTION 'migration 078 requires public.teacher_attendance_records';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'migration 078 requires the CloudBase service_role';
  END IF;
END;
$$;

ALTER TABLE public.teacher_attendance_records
  ADD COLUMN IF NOT EXISTS attendance_type VARCHAR(12);

UPDATE public.teacher_attendance_records
   SET attendance_type = 'CLOCK_IN'
 WHERE attendance_type IS NULL;

ALTER TABLE public.teacher_attendance_records
  ALTER COLUMN attendance_type SET DEFAULT 'CLOCK_IN',
  ALTER COLUMN attendance_type SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.teacher_attendance_records'::regclass
       AND conname = 'teacher_attendance_type_check'
  ) THEN
    ALTER TABLE public.teacher_attendance_records
      ADD CONSTRAINT teacher_attendance_type_check
      CHECK (attendance_type IN ('CLOCK_IN', 'CLOCK_OUT'));
  END IF;
END;
$$;

ALTER TABLE public.teacher_attendance_records
  DROP CONSTRAINT IF EXISTS uq_teacher_attendance_account_date;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.teacher_attendance_records'::regclass
       AND conname = 'uq_teacher_attendance_account_date_type'
  ) THEN
    ALTER TABLE public.teacher_attendance_records
      ADD CONSTRAINT uq_teacher_attendance_account_date_type
      UNIQUE (staff_account_id, attendance_date, attendance_type);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_teacher_attendance_records_date_type_teacher
  ON public.teacher_attendance_records (attendance_date DESC, attendance_type, teacher_id);

DROP TRIGGER IF EXISTS trg_teacher_attendance_insert_v75
  ON public.teacher_attendance_records;
DROP TRIGGER IF EXISTS trg_teacher_attendance_insert_v78
  ON public.teacher_attendance_records;

CREATE OR REPLACE FUNCTION public.enforce_teacher_attendance_insert_v78()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  shanghai_today DATE := (CLOCK_TIMESTAMP() AT TIME ZONE 'Asia/Shanghai')::DATE;
  valid_teacher BOOLEAN := FALSE;
  clock_in_at TIMESTAMPTZ;
  server_now TIMESTAMPTZ := CLOCK_TIMESTAMP();
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'teacher attendance records are immutable'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.attendance_date IS DISTINCT FROM shanghai_today THEN
    RAISE EXCEPTION 'teacher attendance may only be recorded for the current Shanghai date'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.attendance_type NOT IN ('CLOCK_IN', 'CLOCK_OUT') THEN
    RAISE EXCEPTION 'teacher attendance type must be CLOCK_IN or CLOCK_OUT'
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
  IF NEW.attendance_type = 'CLOCK_OUT' THEN
    SELECT attendance.checked_in_at
      INTO clock_in_at
      FROM public.teacher_attendance_records AS attendance
     WHERE attendance.teacher_id = NEW.teacher_id
       AND attendance.staff_account_id = NEW.staff_account_id
       AND attendance.attendance_date = NEW.attendance_date
       AND attendance.attendance_type = 'CLOCK_IN'
     LIMIT 1;
    IF clock_in_at IS NULL THEN
      RAISE EXCEPTION 'clock-out requires an existing same-day clock-in'
        USING ERRCODE = '23514';
    END IF;
    IF server_now <= clock_in_at THEN
      RAISE EXCEPTION 'clock-out must occur after clock-in'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.checked_in_at := server_now;
  NEW.created_at := server_now;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_teacher_attendance_insert_v78
BEFORE INSERT OR UPDATE OR DELETE ON public.teacher_attendance_records
FOR EACH ROW EXECUTE FUNCTION public.enforce_teacher_attendance_insert_v78();

DROP FUNCTION IF EXISTS public.enforce_teacher_attendance_insert_v75();

REVOKE ALL ON TABLE public.teacher_attendance_records FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_teacher_attendance_insert_v78() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.teacher_attendance_records FROM service_role;
GRANT SELECT, INSERT ON TABLE public.teacher_attendance_records TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.teacher_attendance_records_id_seq TO service_role;

COMMENT ON COLUMN public.teacher_attendance_records.attendance_type IS
  'Migration 078: CLOCK_IN or CLOCK_OUT; one immutable record of each type per account and Shanghai business date.';
COMMENT ON TABLE public.teacher_attendance_records IS
  'Migration 078: immutable teacher clock-in and clock-out records with server time, location and face audit metadata; attendance photos are not stored.';

COMMIT;
