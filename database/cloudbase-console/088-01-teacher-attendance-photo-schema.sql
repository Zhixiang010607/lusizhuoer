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
COMMIT;
