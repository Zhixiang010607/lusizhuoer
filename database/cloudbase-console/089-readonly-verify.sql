-- Independent read-only verification; do not insert a real test punch.
SELECT 'HD photo constraint' AS check_name,
 CASE WHEN EXISTS (SELECT 1 FROM pg_constraint
  WHERE conrelid='public.teacher_attendance_records'::regclass
    AND conname='teacher_attendance_photo_check_v89' AND convalidated
    AND pg_get_constraintdef(oid) LIKE '%3145728%'
    AND pg_get_constraintdef(oid) LIKE '%10000%'
    AND pg_get_constraintdef(oid) LIKE '%25165824%')
  AND NOT EXISTS (SELECT 1 FROM pg_constraint
   WHERE conrelid='public.teacher_attendance_records'::regclass
    AND conname='teacher_attendance_photo_check_v88') THEN 'READY' ELSE 'MISSING' END AS status
UNION ALL
SELECT 'Original immutable guards', CASE WHEN
 (SELECT COUNT(*) FROM pg_trigger
  WHERE tgrelid='public.teacher_attendance_records'::regclass AND NOT tgisinternal
   AND tgenabled='O' AND tgname IN
    ('trg_teacher_attendance_insert_v78','trg_z_teacher_attendance_photo_v88'))=2
 THEN 'READY' ELSE 'MISSING' END
UNION ALL
SELECT 'Existing photo integrity', CASE WHEN NOT EXISTS (
 SELECT 1 FROM public.teacher_attendance_records WHERE photo_object_ref IS NOT NULL
 AND (photo_bytes NOT BETWEEN 4 AND 3145728 OR photo_taken_at IS DISTINCT FROM checked_in_at
  OR photo_width NOT BETWEEN 160 AND 10000 OR photo_height NOT BETWEEN 160 AND 10000
  OR photo_sha256 !~ '^[a-f0-9]{64}$')) THEN 'READY' ELSE 'MISSING' END
UNION ALL
SELECT 'No client table access', CASE WHEN
 NOT has_table_privilege('anon','public.teacher_attendance_records','SELECT')
 AND NOT has_table_privilege('authenticated','public.teacher_attendance_records','SELECT')
 AND NOT has_table_privilege('anon','public.teacher_attendance_records','INSERT')
 AND NOT has_table_privilege('authenticated','public.teacher_attendance_records','INSERT')
 THEN 'READY' ELSE 'MISSING' END;
