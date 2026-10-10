SELECT 'attendance_type_column' AS item,
       CASE WHEN EXISTS (
         SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'teacher_attendance_records'
            AND column_name = 'attendance_type'
            AND is_nullable = 'NO'
       ) THEN 'READY' ELSE 'MISSING' END AS status
UNION ALL
SELECT 'attendance_daily_type_unique',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_constraint
          WHERE conrelid = TO_REGCLASS('public.teacher_attendance_records')
            AND conname = 'uq_teacher_attendance_account_date_type'
       ) THEN 'READY' ELSE 'MISSING' END
UNION ALL
SELECT 'attendance_two_punch_trigger',
       CASE WHEN EXISTS (
         SELECT 1 FROM pg_trigger
          WHERE tgrelid = TO_REGCLASS('public.teacher_attendance_records')
            AND tgname = 'trg_teacher_attendance_insert_v78'
            AND NOT tgisinternal
       ) THEN 'READY' ELSE 'MISSING' END
UNION ALL
SELECT 'clock_out_requires_clock_in',
       CASE WHEN POSITION('clock-out requires an existing same-day clock-in' IN PG_GET_FUNCTIONDEF(
         TO_REGPROCEDURE('public.enforce_teacher_attendance_insert_v78()')
       )) > 0 THEN 'READY' ELSE 'MISSING' END
UNION ALL
SELECT 'legacy_rows_are_clock_in',
       CASE WHEN NOT EXISTS (
         SELECT 1 FROM public.teacher_attendance_records
          WHERE attendance_type IS DISTINCT FROM 'CLOCK_IN'
            AND attendance_type IS DISTINCT FROM 'CLOCK_OUT'
       ) THEN 'READY' ELSE 'MISSING' END;
