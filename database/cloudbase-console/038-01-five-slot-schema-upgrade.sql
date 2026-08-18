-- CloudBase SQL editor migration 038, part 1 / 3.
-- Upgrade to five slots, snapshot retained photos, rebuild constraints and the write guard.
-- Run this file by itself. Continue only after COMMIT succeeds.
-- After pasting, press Ctrl+A in the editor so the entire short file is selected.
-- If the editor is already in an aborted transaction, run ROLLBACK;
-- separately before running this file. Do not prepend ROLLBACK here.
BEGIN;
-- Run after migration 037.  This expands each verification order from four
-- photo positions to five: the customer's retained enrollment photo, the
-- immutable face-verification capture, and three supplemental positions.
DO $$
BEGIN
  IF TO_REGCLASS('public.verification_photos') IS NULL
     OR TO_REGPROCEDURE(
       'public.create_verification_with_face_photo(character varying,bigint,bigint,bigint,bigint,character varying,bigint,text,text,character varying,character varying,character varying)'
     ) IS NULL THEN
    RAISE EXCEPTION 'migration 037 must be executed before migration 038';
  END IF;
END;
$$;

ALTER TABLE public.verification_photos
  DROP CONSTRAINT IF EXISTS verification_photos_photo_slot_check,
  DROP CONSTRAINT IF EXISTS verification_photos_photo_kind_check,
  DROP CONSTRAINT IF EXISTS verification_photos_check,
  DROP CONSTRAINT IF EXISTS verification_photos_original_bytes_check,
  DROP CONSTRAINT IF EXISTS verification_photos_thumbnail_bytes_check,
  DROP CONSTRAINT IF EXISTS verification_photos_image_width_check,
  DROP CONSTRAINT IF EXISTS verification_photos_image_height_check,
  DROP CONSTRAINT IF EXISTS verification_photos_sha256_check;

ALTER TABLE public.verification_photo_events
  DROP CONSTRAINT IF EXISTS verification_photo_events_photo_slot_check,
  DROP CONSTRAINT IF EXISTS verification_photo_events_event_type_check;

DROP TRIGGER IF EXISTS trg_enforce_verification_photo_write
  ON public.verification_photos;

ALTER TABLE public.verification_photos
  ALTER COLUMN original_bytes DROP NOT NULL,
  ALTER COLUMN thumbnail_bytes DROP NOT NULL,
  ALTER COLUMN image_width DROP NOT NULL,
  ALTER COLUMN image_height DROP NOT NULL,
  ALTER COLUMN sha256 DROP NOT NULL;

-- If v43 briefly created four-slot orders before this migration, shift those
-- historical positions upward without overwriting a neighbouring slot.
UPDATE public.verification_photos SET photo_slot = 4 WHERE photo_slot = 3;
UPDATE public.verification_photos SET photo_slot = 3 WHERE photo_slot = 2;
UPDATE public.verification_photos SET photo_slot = 2 WHERE photo_slot = 1;
UPDATE public.verification_photos SET photo_slot = 1 WHERE photo_slot = 0;

UPDATE public.verification_photo_events
   SET photo_slot = photo_slot + 1
 WHERE photo_slot BETWEEN 0 AND 3;

-- The retained profile object reference is snapshotted from the customer row.
-- Application code never grants the browser direct access to this reference.
WITH inserted_profiles AS (
  INSERT INTO public.verification_photos
    (verification_id, photo_slot, photo_kind, original_object_ref,
     thumbnail_object_ref, original_bytes, thumbnail_bytes,
     image_width, image_height, sha256, uploaded_by_account_id,
     source_evidence_token)
  SELECT v.id, 0, 'PROFILE', c.profile_photo_file_id,
         c.profile_photo_file_id, NULL, NULL, NULL, NULL, NULL,
         v.submitted_by_account_id, NULL
    FROM public.verification_records AS v
    JOIN public.customers AS c ON c.id = v.customer_id
   WHERE BTRIM(COALESCE(c.profile_photo_file_id, '')) <> ''
     AND NOT EXISTS (
       SELECT 1 FROM public.verification_photos AS p
        WHERE p.verification_id = v.id AND p.photo_slot = 0
     )
  RETURNING verification_id, uploaded_by_account_id
)
INSERT INTO public.verification_photo_events
  (verification_id, photo_slot, event_type, actor_account_id)
SELECT verification_id, 0, 'PROFILE_BOUND', uploaded_by_account_id
  FROM inserted_profiles;

ALTER TABLE public.verification_photos
  ADD CONSTRAINT verification_photos_slot_v38_check
    CHECK (photo_slot BETWEEN 0 AND 4),
  ADD CONSTRAINT verification_photos_kind_v38_check
    CHECK (photo_kind IN ('PROFILE', 'FACE', 'EXTRA')),
  ADD CONSTRAINT verification_photos_slot_kind_v38_check
    CHECK (
      (photo_slot = 0 AND photo_kind = 'PROFILE' AND source_evidence_token IS NULL)
      OR (photo_slot = 1 AND photo_kind = 'FACE' AND source_evidence_token IS NOT NULL)
      OR (photo_slot BETWEEN 2 AND 4 AND photo_kind = 'EXTRA' AND source_evidence_token IS NULL)
    ),
  ADD CONSTRAINT verification_photos_metadata_v38_check
    CHECK (
      (photo_kind = 'PROFILE'
       AND original_bytes IS NULL AND thumbnail_bytes IS NULL
       AND image_width IS NULL AND image_height IS NULL AND sha256 IS NULL)
      OR
      (photo_kind IN ('FACE', 'EXTRA')
       AND original_bytes BETWEEN 1 AND 3145728
       AND thumbnail_bytes BETWEEN 1 AND 393216
       AND image_width BETWEEN 1 AND 10000
       AND image_height BETWEEN 1 AND 10000
       AND sha256 ~ '^[0-9a-f]{64}$')
    );

ALTER TABLE public.verification_photo_events
  ADD CONSTRAINT verification_photo_events_slot_v38_check
    CHECK (photo_slot BETWEEN 0 AND 4),
  ADD CONSTRAINT verification_photo_events_type_v38_check
    CHECK (event_type IN ('PROFILE_BOUND', 'FACE_BOUND', 'UPLOAD', 'REPLACE', 'VIEW_ORIGINAL'));

CREATE OR REPLACE FUNCTION public.enforce_verification_photo_write()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  order_submitter BIGINT;
  order_submitted_at TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'verification photo evidence cannot be deleted'
      USING ERRCODE = '42501';
  END IF;

  SELECT v.submitted_by_account_id, v.submitted_at
    INTO order_submitter, order_submitted_at
    FROM public.verification_records AS v
   WHERE v.id = NEW.verification_id
   FOR UPDATE;

  IF order_submitter IS NULL THEN
    RAISE EXCEPTION 'verification order does not exist' USING ERRCODE = 'P0002';
  END IF;
  IF NEW.uploaded_by_account_id <> order_submitter THEN
    RAISE EXCEPTION 'only the verification submitter may upload photo evidence'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.photo_slot IN (0, 1) THEN
    IF TG_OP = 'UPDATE' THEN
      RAISE EXCEPTION 'retained profile and face-verification photos are immutable'
        USING ERRCODE = '42501';
    END IF;
  ELSE
    IF CLOCK_TIMESTAMP() >= order_submitted_at + INTERVAL '24 hours' THEN
      RAISE EXCEPTION 'the verification photo upload window has expired'
        USING ERRCODE = '22023';
    END IF;
    IF TG_OP = 'UPDATE' AND (
      NEW.verification_id <> OLD.verification_id
      OR NEW.photo_slot <> OLD.photo_slot
      OR NEW.uploaded_by_account_id <> OLD.uploaded_by_account_id
      OR NEW.created_at <> OLD.created_at
    ) THEN
      RAISE EXCEPTION 'verification photo ownership fields are immutable'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_enforce_verification_photo_write
BEFORE INSERT OR UPDATE OR DELETE ON public.verification_photos
FOR EACH ROW EXECUTE FUNCTION public.enforce_verification_photo_write();

COMMIT;
