-- Migration 053: permanently retire the legacy teacher face Saga.
-- Existing teachers, face references, quotas, work orders and business history
-- are deliberately outside this migration. Only the 051/052 orchestration
-- state and its private helper functions are removed.

BEGIN;

DROP FUNCTION IF EXISTS public.takeover_teacher_face_operation_cleanup(
  bigint, varchar, integer
);
DROP FUNCTION IF EXISTS public.bind_teacher_face_operation_face_id(
  bigint, varchar, bigint, varchar, varchar
);
DROP FUNCTION IF EXISTS public.transition_teacher_face_operation(
  bigint, varchar, bigint, varchar, varchar, varchar, text, boolean
);
DROP FUNCTION IF EXISTS public.bind_teacher_face_operation(
  bigint, varchar, bigint, varchar, varchar, bigint, bigint, varchar,
  varchar, text, varchar, varchar, varchar, bigint
);
DROP FUNCTION IF EXISTS public.acquire_teacher_face_operation(
  varchar, varchar, varchar, varchar, varchar, integer, varchar, varchar,
  bigint, varchar, integer
);
DROP FUNCTION IF EXISTS public.assert_teacher_face_operation_input(
  varchar, varchar, varchar, varchar, varchar, integer, varchar, varchar,
  bigint, varchar, integer
);

DROP TABLE IF EXISTS public.teacher_face_operations;

COMMIT;
