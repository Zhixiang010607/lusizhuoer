-- 090: photo-only attendance. No historical rows/photos or enrollment are deleted.
BEGIN;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid =
      'public.teacher_attendance_records'::regclass
      AND conname = 'teacher_attendance_photo_check_v89' AND convalidated) THEN
    RAISE EXCEPTION '090 requires verified migration 089';
  END IF;
END $$;
ALTER TABLE public.teacher_attendance_records
  ADD COLUMN IF NOT EXISTS attendance_method VARCHAR(8) NOT NULL DEFAULT 'FACE',
  ALTER COLUMN face_score DROP NOT NULL,
  ALTER COLUMN face_request_id DROP NOT NULL;
ALTER TABLE public.teacher_attendance_records
  ADD CONSTRAINT teacher_attendance_method_check_v90 CHECK (
    (attendance_method = 'FACE' AND face_score IS NOT NULL AND face_request_id IS NOT NULL)
    OR (attendance_method = 'PHOTO' AND face_score IS NULL AND face_request_id IS NULL
        AND quality_score IS NULL AND liveness_score IS NULL
        AND photo_object_ref IS NOT NULL AND photo_taken_at IS NOT NULL));

-- Keep the existing trigger identity and all ownership/order/immutability guards.
CREATE OR REPLACE FUNCTION public.enforce_teacher_attendance_insert_v78()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_temp AS $$
DECLARE
  server_now TIMESTAMPTZ := CLOCK_TIMESTAMP();
  clock_in_at TIMESTAMPTZ;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'teacher attendance records are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.attendance_date IS DISTINCT FROM (server_now AT TIME ZONE 'Asia/Shanghai')::date
     OR NEW.attendance_type NOT IN ('CLOCK_IN', 'CLOCK_OUT') THEN
    RAISE EXCEPTION 'attendance requires current Shanghai date and valid punch type' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.staff_accounts a JOIN public.teachers t
      ON t.staff_account_id = a.id AND t.id = NEW.teacher_id
      WHERE a.id = NEW.staff_account_id AND a.role_code = 'teacher'
        AND a.account_status = 'ACTIVE' AND t.teacher_status = 'ACTIVE') THEN
    RAISE EXCEPTION 'attendance is restricted to active teachers' USING ERRCODE = '23514';
  END IF;
  IF NEW.attendance_method = 'FACE' AND NOT EXISTS (
      SELECT 1 FROM public.teacher_attendance_face_profiles
      WHERE teacher_id = NEW.teacher_id AND staff_account_id = NEW.staff_account_id) THEN
    RAISE EXCEPTION 'legacy face attendance requires an enrolled profile' USING ERRCODE = '23514';
  END IF;
  IF NEW.attendance_type = 'CLOCK_OUT' THEN
    SELECT checked_in_at INTO clock_in_at FROM public.teacher_attendance_records
      WHERE teacher_id = NEW.teacher_id AND staff_account_id = NEW.staff_account_id
        AND attendance_date = NEW.attendance_date AND attendance_type = 'CLOCK_IN';
    IF clock_in_at IS NULL OR server_now <= clock_in_at THEN
      RAISE EXCEPTION 'clock-out requires an earlier same-day clock-in' USING ERRCODE = '23514';
    END IF;
  END IF;
  NEW.checked_in_at := server_now;
  NEW.created_at := server_now;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.enforce_teacher_attendance_insert_v78() FROM PUBLIC, anon, authenticated;
COMMENT ON COLUMN public.teacher_attendance_records.attendance_method IS
  '090: FACE preserves historical audit; PHOTO has no face/liveness scores. Private photo and two-punch guards remain.';
COMMIT;
