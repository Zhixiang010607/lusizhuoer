-- CloudBase migration 051, part 2 / 10. Run this file by itself.
BEGIN;
CREATE TABLE IF NOT EXISTS public.teacher_face_operations (
  id BIGSERIAL PRIMARY KEY,
  operation_type VARCHAR(16) NOT NULL CHECK (operation_type IN ('PROVISION', 'UPSERT')),
  client_request_id VARCHAR(64) NOT NULL UNIQUE
    CHECK (client_request_id ~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$'),
  phone VARCHAR(20) NOT NULL CHECK (phone ~ '^1[3-9][0-9]{9}$'),
  teacher_name VARCHAR(100) NOT NULL CHECK (BTRIM(teacher_name) <> ''),
  staff_id BIGINT,
  teacher_id BIGINT,
  person_id VARCHAR(50) CHECK (person_id IS NULL OR person_id ~ '^T-[A-F0-9]{48}$'),
  candidate_face_id VARCHAR(128),
  image_sha256 CHAR(64) NOT NULL CHECK (image_sha256 ~ '^[a-f0-9]{64}$'),
  image_bytes INTEGER NOT NULL CHECK (image_bytes BETWEEN 4 AND 3145728),
  face_group_id VARCHAR(64) NOT NULL CHECK (face_group_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  photo_bucket_id VARCHAR(128) NOT NULL
    CHECK (photo_bucket_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  actor_staff_account_id BIGINT NOT NULL,
  auth_uid VARCHAR(128),
  auth_owner_token_sha256 CHAR(64)
    CHECK (auth_owner_token_sha256 IS NULL OR auth_owner_token_sha256 ~ '^[a-f0-9]{64}$'),
  owner_token_sha256 CHAR(64) NOT NULL CHECK (owner_token_sha256 ~ '^[a-f0-9]{64}$'),
  lease_generation BIGINT NOT NULL DEFAULT 1 CHECK (lease_generation > 0),
  lease_expires_at TIMESTAMPTZ NOT NULL,
  operation_status VARCHAR(24) NOT NULL DEFAULT 'RUNNING'
    CHECK (operation_status IN ('RUNNING', 'SUCCEEDED', 'CANCELLED', 'CLEANUP_PENDING')),
  previous_person_id VARCHAR(50)
    CHECK (previous_person_id IS NULL OR previous_person_id ~ '^T-[A-F0-9]{48}$'),
  previous_photo_reference TEXT,
  previous_face_enrollment_status VARCHAR(16) NOT NULL DEFAULT 'PENDING'
    CHECK (previous_face_enrollment_status IN ('PENDING', 'ENROLLED')),
  previous_face_consent_at TIMESTAMPTZ,
  previous_face_enrolled_at TIMESTAMPTZ,
  previous_face_enrolled_by_account_id BIGINT,
  error_code VARCHAR(100),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CLOCK_TIMESTAMP(),
  succeeded_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cleanup_completed_at TIMESTAMPTZ,
  CONSTRAINT teacher_face_operation_bound_ids CHECK (
    (staff_id IS NULL AND teacher_id IS NULL AND person_id IS NULL)
    OR (staff_id IS NOT NULL AND teacher_id IS NOT NULL AND person_id IS NOT NULL)
  ),
  CONSTRAINT teacher_face_operation_previous_pair CHECK (
    (previous_person_id IS NULL AND previous_photo_reference IS NULL
      AND previous_face_enrollment_status = 'PENDING'
      AND previous_face_consent_at IS NULL AND previous_face_enrolled_at IS NULL
      AND previous_face_enrolled_by_account_id IS NULL)
    OR (previous_person_id IS NOT NULL AND previous_photo_reference IS NOT NULL
      AND previous_face_enrollment_status = 'ENROLLED')
  ),
  CONSTRAINT teacher_face_operation_cleanup_state CHECK (
    cleanup_completed_at IS NULL OR operation_status = 'CANCELLED'
  )
);

COMMIT;
