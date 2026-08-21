-- Read-only verification for migration 053. Expected: every row is RETIRED.
WITH checks(kind, object_name, retired) AS (
  VALUES
    ('table', 'public.teacher_face_operations',
      TO_REGCLASS('public.teacher_face_operations') IS NULL),
    ('function', 'public.assert_teacher_face_operation_input',
      TO_REGPROCEDURE('public.assert_teacher_face_operation_input(varchar,varchar,varchar,varchar,varchar,integer,varchar,varchar,bigint,varchar,integer)') IS NULL),
    ('function', 'public.acquire_teacher_face_operation',
      TO_REGPROCEDURE('public.acquire_teacher_face_operation(varchar,varchar,varchar,varchar,varchar,integer,varchar,varchar,bigint,varchar,integer)') IS NULL),
    ('function', 'public.bind_teacher_face_operation',
      TO_REGPROCEDURE('public.bind_teacher_face_operation(bigint,varchar,bigint,varchar,varchar,bigint,bigint,varchar,varchar,text,varchar,varchar,varchar,bigint)') IS NULL),
    ('function', 'public.transition_teacher_face_operation',
      TO_REGPROCEDURE('public.transition_teacher_face_operation(bigint,varchar,bigint,varchar,varchar,varchar,text,boolean)') IS NULL),
    ('function', 'public.bind_teacher_face_operation_face_id',
      TO_REGPROCEDURE('public.bind_teacher_face_operation_face_id(bigint,varchar,bigint,varchar,varchar)') IS NULL),
    ('function', 'public.takeover_teacher_face_operation_cleanup',
      TO_REGPROCEDURE('public.takeover_teacher_face_operation_cleanup(bigint,varchar,integer)') IS NULL)
)
SELECT kind, object_name, CASE WHEN retired THEN 'RETIRED' ELSE 'STILL_PRESENT' END AS status
FROM checks
ORDER BY kind, object_name;
