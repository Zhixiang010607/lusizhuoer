-- Migration 049 read-only verification. This file changes no data.
SELECT requirement, kind, object_name,
       CASE WHEN ready THEN 'READY' ELSE 'MISSING' END AS status
FROM (
  VALUES
    ('049', 'column', 'public.teachers.profile_photo_file_id',
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='teachers' AND column_name='profile_photo_file_id')),
    ('049', 'column', 'public.verification_records.face_subject_type',
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='verification_records' AND column_name='face_subject_type')),
    ('049', 'column', 'public.verification_photo_drafts.face_subject_type',
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='verification_photo_drafts' AND column_name='face_subject_type')),
    ('049', 'function', 'public.upsert_teacher_product_experience_quota(bigint,bigint,integer,bigint)',
      COALESCE(POSITION('quota.teacher_id = p_teacher_id' IN PG_GET_FUNCTIONDEF(TO_REGPROCEDURE('public.upsert_teacher_product_experience_quota(bigint,bigint,integer,bigint)'))),0)>0),
    ('049', 'function', 'public.create_experience_verification_with_teacher_face_photo(...)',
      TO_REGPROCEDURE('public.create_experience_verification_with_teacher_face_photo(bigint,bigint,bigint,bigint,bigint,text,character varying,character varying,character varying)') IS NOT NULL),
    ('049', 'trigger', 'public.trg_assert_experience_verification_complete',
      EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid='public.verification_records'::regclass AND tgname='trg_assert_experience_verification_complete' AND NOT tgisinternal))
) AS checks(requirement, kind, object_name, ready)
ORDER BY kind, object_name;
