-- CloudBase migration 053, part 1 / 1. Run this file by itself.
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
