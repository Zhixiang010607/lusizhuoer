-- Migration 088: immutable, compressed teacher attendance photo evidence.
-- Historical punches keep NULL photo columns; no fabricated backfill.
BEGIN;
DO $$
BEGIN
  IF TO_REGCLASS('public.teacher_attendance_records') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_trigger
                     WHERE tgrelid = 'public.teacher_attendance_records'::regclass
                       AND tgname = 'trg_teacher_attendance_insert_v78' AND NOT tgisinternal) THEN
    RAISE EXCEPTION '088 requires the immutable two-punch migration 078';
  END IF;
END;
$$;
ALTER TABLE public.teacher_attendance_records
  ADD COLUMN IF NOT EXISTS photo_object_ref TEXT,
  ADD COLUMN IF NOT EXISTS photo_bytes INTEGER,
  ADD COLUMN IF NOT EXISTS photo_sha256 VARCHAR(64),
  ADD COLUMN IF NOT EXISTS photo_width INTEGER,
  ADD COLUMN IF NOT EXISTS photo_height INTEGER,
  ADD COLUMN IF NOT EXISTS photo_taken_at TIMESTAMPTZ;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.teacher_attendance_records'::regclass
                   AND conname = 'teacher_attendance_photo_check_v88') THEN
    ALTER TABLE public.teacher_attendance_records
      ADD CONSTRAINT teacher_attendance_photo_check_v88 CHECK (
        (photo_object_ref IS NULL AND photo_bytes IS NULL AND photo_sha256 IS NULL
         AND photo_width IS NULL AND photo_height IS NULL AND photo_taken_at IS NULL)
        OR
        (photo_object_ref IS NOT NULL AND photo_bytes IS NOT NULL AND photo_sha256 IS NOT NULL
         AND photo_width IS NOT NULL AND photo_height IS NOT NULL AND photo_taken_at IS NOT NULL
         AND photo_object_ref ~ '^pg://[^/]+/attendance/[a-f0-9]{48}[.]jpg$'
         AND photo_bytes BETWEEN 4 AND 524288 AND photo_sha256 ~ '^[a-f0-9]{64}$'
         AND photo_width BETWEEN 160 AND 1280 AND photo_height BETWEEN 160 AND 1280
         AND photo_taken_at = checked_in_at));
  END IF;
END;
$$;
CREATE OR REPLACE FUNCTION public.enforce_teacher_attendance_photo_v88()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER
SET search_path = public, pg_temp AS $$
DECLARE
  server_now TIMESTAMPTZ := CLOCK_TIMESTAMP();
  clock_in_at TIMESTAMPTZ;
BEGIN
  IF NEW.photo_object_ref IS NULL OR NEW.photo_taken_at IS NULL THEN
    RAISE EXCEPTION 'new attendance requires verified private photo evidence'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.photo_taken_at > server_now OR NEW.photo_taken_at < server_now - INTERVAL '2 minutes'
     OR (NEW.photo_taken_at AT TIME ZONE 'Asia/Shanghai')::date <> NEW.attendance_date THEN
    RAISE EXCEPTION 'attendance photo must use recent server time on the same Shanghai date'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.attendance_type = 'CLOCK_OUT' THEN
    SELECT checked_in_at INTO clock_in_at FROM public.teacher_attendance_records
     WHERE staff_account_id = NEW.staff_account_id AND teacher_id = NEW.teacher_id
       AND attendance_date = NEW.attendance_date AND attendance_type = 'CLOCK_IN';
    IF clock_in_at IS NULL OR NEW.photo_taken_at <= clock_in_at THEN
      RAISE EXCEPTION 'clock-out photo must be after same-day clock-in'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  -- This trigger sorts after v78: keep its active-teacher/order/immutability
  -- checks, but use the very same DB-issued instant baked into the image.
  NEW.checked_in_at := NEW.photo_taken_at;
  NEW.created_at := NEW.photo_taken_at;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_z_teacher_attendance_photo_v88 ON public.teacher_attendance_records;
CREATE TRIGGER trg_z_teacher_attendance_photo_v88
BEFORE INSERT ON public.teacher_attendance_records
FOR EACH ROW EXECUTE FUNCTION public.enforce_teacher_attendance_photo_v88();
REVOKE ALL ON TABLE public.teacher_attendance_records FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_teacher_attendance_photo_v88() FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.teacher_attendance_records TO service_role;
COMMENT ON TABLE public.teacher_attendance_records IS
  '088: immutable two-punch attendance; new punches retain compressed private timestamped face evidence; legacy photos remain absent.';
COMMIT;
