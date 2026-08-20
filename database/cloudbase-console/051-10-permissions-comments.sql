-- CloudBase migration 051, part 10 / 10. Run this file by itself.
BEGIN;
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
