-- Migration 051 read-only verification. This file changes no data.
WITH definitions AS (
  SELECT COALESCE(PG_GET_FUNCTIONDEF(TO_REGPROCEDURE(
           'public.transition_teacher_face_operation(bigint,character varying,bigint,character varying,character varying,character varying,text,boolean)'
         )), '') AS transition_fn
)
SELECT requirement, kind, object_name,
       CASE WHEN ready THEN 'READY' ELSE 'MISSING' END AS status
FROM (
  VALUES
    ('051', 'table', 'public.teacher_face_operations',
      TO_REGCLASS('public.teacher_face_operations') IS NOT NULL),
    ('051', 'column', 'candidate_face_id + face_group_id + photo_bucket_id',
      (SELECT COUNT(*)=3 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='teacher_face_operations'
          AND column_name IN ('candidate_face_id','face_group_id','photo_bucket_id'))),
    ('051', 'function', 'public.acquire_teacher_face_operation(...)',
      TO_REGPROCEDURE('public.acquire_teacher_face_operation(character varying,character varying,character varying,character varying,character varying,integer,character varying,character varying,bigint,character varying,integer)') IS NOT NULL),
    ('051', 'function', 'public.bind_teacher_face_operation(...)',
      TO_REGPROCEDURE('public.bind_teacher_face_operation(bigint,character varying,bigint,character varying,character varying,bigint,bigint,character varying,character varying,text,character varying,character varying,character varying,bigint)') IS NOT NULL),
    ('051', 'function', 'public.transition_teacher_face_operation(...)',
      TO_REGPROCEDURE('public.transition_teacher_face_operation(bigint,character varying,bigint,character varying,character varying,character varying,text,boolean)') IS NOT NULL),
    ('051', 'function', 'public.bind_teacher_face_operation_face_id(...)',
      TO_REGPROCEDURE('public.bind_teacher_face_operation_face_id(bigint,character varying,bigint,character varying,character varying)') IS NOT NULL),
    ('051', 'function', 'public.takeover_teacher_face_operation_cleanup(...)',
      TO_REGPROCEDURE('public.takeover_teacher_face_operation_cleanup(bigint,character varying,integer)') IS NOT NULL),
    ('051', 'fence', 'expired owner cannot transition',
      (SELECT transition_fn ~* 'lease_expires_at[[:space:]]*<=[[:space:]]*now_value' FROM definitions)),
    ('051', 'index', 'uq_teacher_face_operation_open_phone',
      EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
               AND tablename='teacher_face_operations'
               AND indexname='uq_teacher_face_operation_open_phone')),
    ('051', 'index', 'uq_teacher_face_operation_open_teacher',
      EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
               AND tablename='teacher_face_operations'
               AND indexname='uq_teacher_face_operation_open_teacher')),
    ('051', 'index', 'uq_teacher_face_operation_open_person',
      EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public'
               AND tablename='teacher_face_operations'
               AND indexname='uq_teacher_face_operation_open_person')),
    ('051', 'security', 'PUBLIC table privileges revoked',
      NOT HAS_TABLE_PRIVILEGE('public','public.teacher_face_operations','SELECT,INSERT,UPDATE,DELETE'))
) AS checks(requirement, kind, object_name, ready)
ORDER BY kind, object_name;
