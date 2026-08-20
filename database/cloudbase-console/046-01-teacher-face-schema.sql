-- CloudBase migration 046, part 1 / 8. Run this file by itself.
BEGIN;
DO $$
BEGIN
  IF TO_REGCLASS('public.staff_accounts') IS NULL
     OR TO_REGCLASS('public.teachers') IS NULL
     OR TO_REGCLASS('public.stores') IS NULL
     OR TO_REGCLASS('public.products') IS NULL
     OR TO_REGCLASS('public.customers') IS NULL
     OR TO_REGCLASS('public.recharge_records') IS NULL
     OR TO_REGCLASS('public.verification_records') IS NULL THEN
    RAISE EXCEPTION 'core master-data and order tables must exist before migration 046';
  END IF;
  IF TO_REGCLASS('public.verification_photo_drafts') IS NULL
     OR TO_REGCLASS('public.verification_photos') IS NULL
     OR TO_REGCLASS('public.device_signal_outbox') IS NULL THEN
    RAISE EXCEPTION 'migrations 037, 038 and 041 must be executed before migration 046';
  END IF;
END;
$$;

LOCK TABLE public.staff_accounts IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.teachers IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.stores IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.products IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.customers IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.recharge_records IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE public.verification_records IN SHARE ROW EXCLUSIVE MODE;

-- Some older incremental installations still carry no-longer-collected
-- identity-card fields from schema.sql.  The teacher creation UI has never
-- collected those values, so do not manufacture fake credentials merely to
-- create a face-bound teacher.  Existing encrypted values are preserved.
DO $$
DECLARE
  column_row RECORD;
BEGIN
  FOR column_row IN
    SELECT column_name
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'teachers'
       AND column_name IN ('id_card_ciphertext', 'id_card_hash', 'phone')
       AND is_nullable = 'NO'
  LOOP
    EXECUTE FORMAT('ALTER TABLE public.teachers ALTER COLUMN %I DROP NOT NULL', column_row.column_name);
  END LOOP;
END;
$$;

-- The historical incremental schema did not give teacher_code a default.
-- The profile trigger below always supplies a code, but adding a deterministic
-- fallback prevents direct, approved administrative imports from failing.
CREATE SEQUENCE IF NOT EXISTS public.teacher_profile_code_seq;
DO $$
DECLARE
  has_default BOOLEAN;
BEGIN
  SELECT COALESCE(column_default IS NOT NULL AND BTRIM(column_default) <> '', FALSE)
    INTO has_default
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'teachers'
     AND column_name = 'teacher_code';
  IF NOT has_default THEN
    ALTER TABLE public.teachers
      ALTER COLUMN teacher_code SET DEFAULT
        ('TCHF' || LPAD(nextval('public.teacher_profile_code_seq')::TEXT, 12, '0'));
  END IF;
END;
$$;

ALTER TABLE public.teachers
  ADD COLUMN IF NOT EXISTS face_person_id VARCHAR(128),
  ADD COLUMN IF NOT EXISTS face_consent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS face_enrollment_status VARCHAR(24) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS face_enrolled_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS face_enrolled_by_account_id BIGINT REFERENCES public.staff_accounts(id);

ALTER TABLE public.teachers
  DROP CONSTRAINT IF EXISTS teachers_face_enrollment_status_check,
  DROP CONSTRAINT IF EXISTS teachers_face_enrollment_shape_check;
ALTER TABLE public.teachers
  ADD CONSTRAINT teachers_face_enrollment_status_check CHECK (
    face_enrollment_status IN ('PENDING', 'ENROLLED', 'LEGACY_UNVERIFIED')
  ),
  ADD CONSTRAINT teachers_face_enrollment_shape_check CHECK (
    (face_enrollment_status = 'ENROLLED'
      AND BTRIM(COALESCE(face_person_id, '')) <> ''
      AND face_consent_at IS NOT NULL
      AND face_enrolled_at IS NOT NULL)
    OR
    (face_enrollment_status IN ('PENDING', 'LEGACY_UNVERIFIED')
      AND face_person_id IS NULL
      AND face_consent_at IS NULL
      AND face_enrolled_at IS NULL
      AND face_enrolled_by_account_id IS NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_teachers_face_person_id
  ON public.teachers (face_person_id)
  WHERE face_person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_teachers_face_enrollment_active
  ON public.teachers (face_enrollment_status, teacher_status, id);

-- Existing records remain readable, but are explicitly marked so that an
-- administrator can enroll a face before selecting or reactivating them.
UPDATE public.teachers
   SET face_enrollment_status = CASE
         WHEN BTRIM(COALESCE(face_person_id, '')) <> ''
              AND face_consent_at IS NOT NULL
              AND face_enrolled_at IS NOT NULL THEN 'ENROLLED'
         ELSE 'LEGACY_UNVERIFIED'
       END,
       face_person_id = CASE
         WHEN BTRIM(COALESCE(face_person_id, '')) <> ''
              AND face_consent_at IS NOT NULL
              AND face_enrolled_at IS NOT NULL THEN face_person_id
         ELSE NULL
       END,
       face_consent_at = CASE
         WHEN BTRIM(COALESCE(face_person_id, '')) <> ''
              AND face_consent_at IS NOT NULL
              AND face_enrolled_at IS NOT NULL THEN face_consent_at
         ELSE NULL
       END,
       face_enrolled_at = CASE
         WHEN BTRIM(COALESCE(face_person_id, '')) <> ''
              AND face_consent_at IS NOT NULL
              AND face_enrolled_at IS NOT NULL THEN face_enrolled_at
         ELSE NULL
       END,
       face_enrolled_by_account_id = CASE
         WHEN BTRIM(COALESCE(face_person_id, '')) <> ''
              AND face_consent_at IS NOT NULL
              AND face_enrolled_at IS NOT NULL THEN face_enrolled_by_account_id
         ELSE NULL
       END
 WHERE face_enrollment_status = 'PENDING';

COMMIT;
