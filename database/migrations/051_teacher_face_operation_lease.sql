-- Durable fencing for teacher-face provisioning and replacement sagas.
-- Control rows are retained as audit/tombstone records; they are not teacher
-- business profiles. Only a SHA-256 digest of the per-invocation owner token
-- is stored. Migration 051 must be deployed before staffAccount v59 and
-- faceRecognition v75 using the teacher-face-v3 delegation contract.

BEGIN;

DO $$
BEGIN
  IF TO_REGCLASS('public.staff_accounts') IS NULL
     OR TO_REGCLASS('public.teachers') IS NULL
     OR TO_REGPROCEDURE('public.sync_teacher_profile()') IS NULL
     OR TO_REGPROCEDURE('public.sync_teacher_account_status()') IS NULL THEN
    RAISE EXCEPTION 'teacher face operation prerequisites are missing; execute migrations through 050 first';
  END IF;
END;
$$;

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

CREATE UNIQUE INDEX IF NOT EXISTS uq_teacher_face_operation_open_phone
  ON public.teacher_face_operations (phone)
  WHERE operation_status IN ('RUNNING', 'CANCELLED', 'CLEANUP_PENDING')
    AND cleanup_completed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_teacher_face_operation_open_teacher
  ON public.teacher_face_operations (teacher_id)
  WHERE teacher_id IS NOT NULL
    AND operation_status IN ('RUNNING', 'CANCELLED', 'CLEANUP_PENDING')
    AND cleanup_completed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_teacher_face_operation_open_person
  ON public.teacher_face_operations (person_id)
  WHERE person_id IS NOT NULL
    AND operation_status IN ('RUNNING', 'CANCELLED', 'CLEANUP_PENDING')
    AND cleanup_completed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_teacher_face_operation_status_lease
  ON public.teacher_face_operations (operation_status, lease_expires_at, id);

CREATE OR REPLACE FUNCTION public.assert_teacher_face_operation_input(
  p_type VARCHAR, p_request VARCHAR, p_phone VARCHAR, p_name VARCHAR,
  p_sha VARCHAR, p_bytes INTEGER, p_group VARCHAR, p_bucket VARCHAR, p_actor BIGINT,
  p_owner VARCHAR, p_ttl INTEGER
)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF p_type NOT IN ('PROVISION','UPSERT')
     OR p_request !~ '^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$'
     OR p_phone !~ '^1[3-9][0-9]{9}$'
     OR BTRIM(COALESCE(p_name,''))='' OR CHAR_LENGTH(p_name)>100
     OR p_sha !~ '^[a-f0-9]{64}$' OR p_bytes NOT BETWEEN 4 AND 3145728
     OR p_group !~ '^[A-Za-z0-9_-]{1,64}$'
     OR p_bucket !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
     OR p_owner !~ '^[a-f0-9]{64}$'
     OR p_actor IS NULL OR p_actor<1
     OR p_ttl NOT BETWEEN 300 AND 1800 THEN
    RAISE EXCEPTION 'invalid teacher face operation lease' USING ERRCODE='22023';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.acquire_teacher_face_operation(
  p_type VARCHAR, p_request VARCHAR, p_phone VARCHAR, p_name VARCHAR,
  p_sha VARCHAR, p_bytes INTEGER, p_group VARCHAR, p_bucket VARCHAR, p_actor BIGINT,
  p_owner VARCHAR, p_ttl INTEGER
)
RETURNS TABLE(operation_id BIGINT, acquired BOOLEAN, operation_status VARCHAR,
              lease_generation BIGINT, lease_expires_at TIMESTAMPTZ,
              cleanup_completed_at TIMESTAMPTZ)
LANGUAGE plpgsql
AS $$
DECLARE o public.teacher_face_operations%ROWTYPE; n TIMESTAMPTZ := CLOCK_TIMESTAMP();
BEGIN
  PERFORM public.assert_teacher_face_operation_input(
    p_type,p_request,p_phone,p_name,p_sha,p_bytes,p_group,p_bucket,p_actor,p_owner,p_ttl);
  SELECT x.* INTO o FROM public.teacher_face_operations x
   WHERE x.client_request_id=p_request FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO public.teacher_face_operations
      (operation_type,client_request_id,phone,teacher_name,image_sha256,image_bytes,face_group_id,
       photo_bucket_id,actor_staff_account_id,owner_token_sha256,lease_expires_at)
    VALUES (p_type,p_request,p_phone,p_name,p_sha,p_bytes,p_group,p_bucket,p_actor,p_owner,
            n+make_interval(secs=>p_ttl))
    RETURNING * INTO o;
    RETURN QUERY SELECT o.id,TRUE,o.operation_status,o.lease_generation,
                        o.lease_expires_at,o.cleanup_completed_at;
    RETURN;
  END IF;
  IF o.operation_type<>p_type OR o.phone<>p_phone OR o.teacher_name<>p_name
     OR o.image_sha256<>p_sha OR o.image_bytes<>p_bytes
     OR (o.operation_status<>'SUCCEEDED' AND o.face_group_id<>p_group)
     OR (o.operation_status<>'SUCCEEDED' AND o.photo_bucket_id<>p_bucket)
     OR o.actor_staff_account_id<>p_actor THEN
    RAISE EXCEPTION 'teacher face request mismatch' USING ERRCODE='23505';
  END IF;
  IF o.owner_token_sha256=p_owner
     AND o.operation_status='RUNNING' AND o.lease_expires_at>n THEN
    RETURN QUERY SELECT o.id,TRUE,o.operation_status,o.lease_generation,
                        o.lease_expires_at,o.cleanup_completed_at;
    RETURN;
  END IF;
  IF o.operation_status='SUCCEEDED' THEN
    UPDATE public.teacher_face_operations x SET owner_token_sha256=p_owner,
      lease_generation=x.lease_generation+1,
      lease_expires_at=n+make_interval(secs=>p_ttl),updated_at=n
     WHERE x.id=o.id RETURNING x.* INTO o;
    RETURN QUERY SELECT o.id,TRUE,o.operation_status,o.lease_generation,
                        o.lease_expires_at,o.cleanup_completed_at;
    RETURN;
  END IF;
  IF (o.operation_status='CANCELLED' AND o.cleanup_completed_at IS NOT NULL)
     OR o.lease_expires_at>n THEN
    RETURN QUERY SELECT o.id,FALSE,o.operation_status,o.lease_generation,
                        o.lease_expires_at,o.cleanup_completed_at;
    RETURN;
  END IF;
  UPDATE public.teacher_face_operations x SET owner_token_sha256=p_owner,
    lease_generation=x.lease_generation+1,
    lease_expires_at=n+make_interval(secs=>p_ttl),
    operation_status='CLEANUP_PENDING',cleanup_completed_at=NULL,updated_at=n
   WHERE x.id=o.id RETURNING x.* INTO o;
  RETURN QUERY SELECT o.id,TRUE,o.operation_status,o.lease_generation,
                      o.lease_expires_at,o.cleanup_completed_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.bind_teacher_face_operation(
  p_operation_id BIGINT, p_owner_token_sha256 VARCHAR, p_lease_generation BIGINT,
  p_auth_uid VARCHAR, p_auth_owner_token_sha256 VARCHAR,
  p_staff_id BIGINT, p_teacher_id BIGINT, p_person_id VARCHAR,
  p_previous_person_id VARCHAR, p_previous_photo_reference TEXT,
  p_previous_face_enrollment_status VARCHAR, p_previous_face_consent_at VARCHAR,
  p_previous_face_enrolled_at VARCHAR, p_previous_face_enrolled_by_account_id BIGINT
)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE op public.teacher_face_operations%ROWTYPE;
BEGIN
  SELECT operation.* INTO op FROM public.teacher_face_operations AS operation
   WHERE operation.id = p_operation_id
     AND operation.owner_token_sha256 = p_owner_token_sha256
     AND operation.lease_generation = p_lease_generation
   FOR UPDATE;
  IF NOT FOUND OR op.operation_status <> 'RUNNING' OR op.lease_expires_at <= CLOCK_TIMESTAMP() THEN
    RAISE EXCEPTION 'teacher face operation lease is not writable' USING ERRCODE = '55000';
  END IF;
  IF (p_auth_uid IS NOT NULL AND op.auth_uid IS NOT NULL AND op.auth_uid <> p_auth_uid)
     OR (p_auth_owner_token_sha256 IS NOT NULL AND op.auth_owner_token_sha256 IS NOT NULL
       AND op.auth_owner_token_sha256 <> p_auth_owner_token_sha256)
     OR (p_staff_id IS NOT NULL AND op.staff_id IS NOT NULL AND op.staff_id <> p_staff_id)
     OR (p_teacher_id IS NOT NULL AND op.teacher_id IS NOT NULL AND op.teacher_id <> p_teacher_id)
     OR (p_person_id IS NOT NULL AND op.person_id IS NOT NULL AND op.person_id <> p_person_id)
     OR (op.staff_id IS NOT NULL AND (
       op.previous_person_id IS DISTINCT FROM p_previous_person_id
       OR op.previous_photo_reference IS DISTINCT FROM p_previous_photo_reference
       OR op.previous_face_enrollment_status IS DISTINCT FROM p_previous_face_enrollment_status
       OR op.previous_face_consent_at IS DISTINCT FROM NULLIF(p_previous_face_consent_at,'')::timestamptz
       OR op.previous_face_enrolled_at IS DISTINCT FROM NULLIF(p_previous_face_enrolled_at,'')::timestamptz
       OR op.previous_face_enrolled_by_account_id IS DISTINCT FROM p_previous_face_enrolled_by_account_id
     )) THEN
    RAISE EXCEPTION 'teacher face operation binding conflict' USING ERRCODE = '23505';
  END IF;
  UPDATE public.teacher_face_operations AS target
     SET auth_uid = COALESCE(target.auth_uid, p_auth_uid),
         auth_owner_token_sha256 = COALESCE(target.auth_owner_token_sha256, p_auth_owner_token_sha256),
         staff_id = COALESCE(target.staff_id, p_staff_id),
         teacher_id = COALESCE(target.teacher_id, p_teacher_id),
         person_id = COALESCE(target.person_id, p_person_id),
         previous_person_id = p_previous_person_id,
         previous_photo_reference = p_previous_photo_reference,
         previous_face_enrollment_status = p_previous_face_enrollment_status,
         previous_face_consent_at = NULLIF(p_previous_face_consent_at, '')::timestamptz,
         previous_face_enrolled_at = NULLIF(p_previous_face_enrolled_at, '')::timestamptz,
         previous_face_enrolled_by_account_id = p_previous_face_enrolled_by_account_id,
         updated_at = CLOCK_TIMESTAMP()
   WHERE target.id = op.id;
  RETURN op.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.transition_teacher_face_operation(
  p_operation_id BIGINT, p_owner_token_sha256 VARCHAR, p_lease_generation BIGINT,
  p_expected_status VARCHAR, p_new_status VARCHAR,
  p_error_code VARCHAR, p_error_message TEXT, p_cleanup_complete BOOLEAN
)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE op public.teacher_face_operations%ROWTYPE; now_value TIMESTAMPTZ := CLOCK_TIMESTAMP();
BEGIN
  SELECT operation.* INTO op FROM public.teacher_face_operations AS operation
   WHERE operation.id = p_operation_id
     AND operation.owner_token_sha256 = p_owner_token_sha256
     AND operation.lease_generation = p_lease_generation
   FOR UPDATE;
  IF NOT FOUND OR op.operation_status <> p_expected_status
     OR op.lease_expires_at <= now_value THEN
    RAISE EXCEPTION 'teacher face operation transition lost ownership or status changed' USING ERRCODE = '55000';
  END IF;
  IF NOT ((p_expected_status = 'RUNNING' AND p_new_status IN ('SUCCEEDED','CANCELLED','CLEANUP_PENDING'))
       OR (p_expected_status = 'CANCELLED' AND p_new_status IN ('CANCELLED','CLEANUP_PENDING'))
       OR (p_expected_status = 'CLEANUP_PENDING' AND p_new_status IN ('CANCELLED','CLEANUP_PENDING'))) THEN
    RAISE EXCEPTION 'invalid teacher face operation transition' USING ERRCODE = '22023';
  END IF;
  IF p_cleanup_complete AND p_new_status <> 'CANCELLED' THEN
    RAISE EXCEPTION 'only a cancelled operation can complete cleanup' USING ERRCODE = '22023';
  END IF;
  UPDATE public.teacher_face_operations AS target
     SET operation_status = p_new_status,
         error_code = NULLIF(LEFT(COALESCE(p_error_code,''),100),''),
         error_message = NULLIF(LEFT(COALESCE(p_error_message,''),1000),''),
         succeeded_at = CASE WHEN p_new_status = 'SUCCEEDED' THEN now_value ELSE target.succeeded_at END,
         cancelled_at = CASE WHEN p_new_status IN ('CANCELLED','CLEANUP_PENDING')
                             THEN COALESCE(target.cancelled_at,now_value) ELSE target.cancelled_at END,
         cleanup_completed_at = CASE WHEN p_cleanup_complete THEN now_value ELSE NULL END,
         updated_at = now_value
   WHERE target.id = op.id;
  RETURN op.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.bind_teacher_face_operation_face_id(
  p_operation_id BIGINT, p_owner_token_sha256 VARCHAR,
  p_lease_generation BIGINT, p_group VARCHAR, p_candidate_face_id VARCHAR
)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE op public.teacher_face_operations%ROWTYPE;
BEGIN
  IF p_group !~ '^[A-Za-z0-9_-]{1,64}$'
     OR BTRIM(COALESCE(p_candidate_face_id,'')) = '' OR CHAR_LENGTH(p_candidate_face_id) > 128 THEN
    RAISE EXCEPTION 'invalid teacher face candidate FaceId' USING ERRCODE = '22023';
  END IF;
  SELECT operation.* INTO op FROM public.teacher_face_operations AS operation
   WHERE operation.id = p_operation_id
     AND operation.owner_token_sha256 = p_owner_token_sha256
     AND operation.lease_generation = p_lease_generation
   FOR UPDATE;
  IF NOT FOUND OR op.operation_status <> 'RUNNING' OR op.lease_expires_at <= CLOCK_TIMESTAMP()
     OR op.person_id IS NULL OR op.face_group_id <> p_group THEN
    RAISE EXCEPTION 'teacher face operation lease cannot bind FaceId' USING ERRCODE = '55000';
  END IF;
  IF op.candidate_face_id IS NOT NULL AND op.candidate_face_id <> p_candidate_face_id THEN
    RAISE EXCEPTION 'teacher face operation candidate FaceId conflict' USING ERRCODE = '23505';
  END IF;
  UPDATE public.teacher_face_operations AS target
     SET candidate_face_id = COALESCE(target.candidate_face_id,p_candidate_face_id),
         updated_at = CLOCK_TIMESTAMP()
   WHERE target.id = op.id;
  RETURN op.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.takeover_teacher_face_operation_cleanup(
  p_operation_id BIGINT, p_owner_token_sha256 VARCHAR, p_lease_seconds INTEGER
)
RETURNS TABLE(operation_id BIGINT, operation_status VARCHAR,
              lease_generation BIGINT, lease_expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
AS $$
DECLARE op public.teacher_face_operations%ROWTYPE; now_value TIMESTAMPTZ := CLOCK_TIMESTAMP();
BEGIN
  IF p_owner_token_sha256 !~ '^[a-f0-9]{64}$' OR p_lease_seconds < 300 OR p_lease_seconds > 1800 THEN
    RAISE EXCEPTION 'invalid teacher face cleanup takeover' USING ERRCODE = '22023';
  END IF;
  SELECT operation.* INTO op FROM public.teacher_face_operations AS operation
   WHERE operation.id = p_operation_id FOR UPDATE;
  IF NOT FOUND OR op.operation_status NOT IN ('RUNNING','CANCELLED','CLEANUP_PENDING')
     OR op.cleanup_completed_at IS NOT NULL OR op.lease_expires_at > now_value THEN
    RAISE EXCEPTION 'teacher face operation is not eligible for cleanup takeover' USING ERRCODE = '55000';
  END IF;
  UPDATE public.teacher_face_operations AS target
     SET owner_token_sha256 = p_owner_token_sha256,
         lease_generation = target.lease_generation + 1,
         lease_expires_at = now_value + make_interval(secs => p_lease_seconds),
         operation_status = 'CLEANUP_PENDING', cleanup_completed_at = NULL,
         updated_at = now_value
   WHERE target.id = op.id RETURNING target.* INTO op;
  RETURN QUERY SELECT op.id, op.operation_status, op.lease_generation, op.lease_expires_at;
END;
$$;

REVOKE ALL ON TABLE public.teacher_face_operations FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.teacher_face_operations_id_seq FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_teacher_face_operation_input(VARCHAR,VARCHAR,VARCHAR,VARCHAR,VARCHAR,INTEGER,VARCHAR,VARCHAR,BIGINT,VARCHAR,INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.acquire_teacher_face_operation(VARCHAR,VARCHAR,VARCHAR,VARCHAR,VARCHAR,INTEGER,VARCHAR,VARCHAR,BIGINT,VARCHAR,INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bind_teacher_face_operation(BIGINT,VARCHAR,BIGINT,VARCHAR,VARCHAR,BIGINT,BIGINT,VARCHAR,VARCHAR,TEXT,VARCHAR,VARCHAR,VARCHAR,BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transition_teacher_face_operation(BIGINT,VARCHAR,BIGINT,VARCHAR,VARCHAR,VARCHAR,TEXT,BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bind_teacher_face_operation_face_id(BIGINT,VARCHAR,BIGINT,VARCHAR,VARCHAR) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.takeover_teacher_face_operation_cleanup(BIGINT,VARCHAR,INTEGER) FROM PUBLIC;

COMMENT ON TABLE public.teacher_face_operations IS
  'Migration 051 durable owner lease, cancellation fence and cleanup tombstone for teacher face sagas.';

COMMIT;
