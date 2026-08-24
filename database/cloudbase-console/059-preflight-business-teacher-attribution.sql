-- Migration 059 read-only history preflight.

WITH business_rows AS (
  SELECT teacher_id, submitted_by_account_id FROM public.recharge_records
  UNION ALL
  SELECT teacher_id, submitted_by_account_id FROM public.verification_records
), checks AS (
  SELECT 'store recharge/refund rows with a selected teacher'::text AS check_name,
         COUNT(*)::bigint AS record_count,
         CASE WHEN COUNT(*) = 0 THEN 'READY' ELSE 'REVIEW' END::text AS status
    FROM public.recharge_records record
    JOIN public.staff_accounts submitter ON submitter.id = record.submitted_by_account_id
   WHERE submitter.role_code = 'store' AND record.teacher_id IS NOT NULL

  UNION ALL

  SELECT 'store normal verification rows with a selected teacher', COUNT(*)::bigint,
         CASE WHEN COUNT(*) > 0 THEN 'READY' ELSE 'EMPTY' END
    FROM public.verification_records record
    JOIN public.staff_accounts submitter ON submitter.id = record.submitted_by_account_id
   WHERE submitter.role_code = 'store' AND record.verification_type = 'NORMAL'
     AND record.teacher_id IS NOT NULL

  UNION ALL

  SELECT 'store normal verification rows missing a teacher', COUNT(*)::bigint,
         CASE WHEN COUNT(*) = 0 THEN 'READY' ELSE 'LEGACY_REVIEW' END
    FROM public.verification_records record
    JOIN public.staff_accounts submitter ON submitter.id = record.submitted_by_account_id
   WHERE submitter.role_code = 'store' AND record.verification_type = 'NORMAL'
     AND record.teacher_id IS NULL

  UNION ALL

  SELECT 'store experience verification rows', COUNT(*)::bigint,
         CASE WHEN COUNT(*) = 0 THEN 'READY' ELSE 'INVALID_LEGACY' END
    FROM public.verification_records record
    JOIN public.staff_accounts submitter ON submitter.id = record.submitted_by_account_id
   WHERE submitter.role_code = 'store' AND record.verification_type = 'EXPERIENCE'

  UNION ALL

  SELECT 'teacher-submitted rows attributed to a different teacher', COUNT(*)::bigint,
         CASE WHEN COUNT(*) = 0 THEN 'READY' ELSE 'INVALID_LEGACY' END
    FROM business_rows record
    JOIN public.staff_accounts submitter ON submitter.id = record.submitted_by_account_id
    LEFT JOIN public.teachers own_teacher ON own_teacher.staff_account_id = submitter.id
   WHERE submitter.role_code = 'teacher'
     AND record.teacher_id IS DISTINCT FROM own_teacher.id

  UNION ALL

  SELECT 'non-store/teacher rows with a selected teacher', COUNT(*)::bigint,
         CASE WHEN COUNT(*) = 0 THEN 'READY' ELSE 'INVALID_LEGACY' END
    FROM business_rows record
    JOIN public.staff_accounts submitter ON submitter.id = record.submitted_by_account_id
   WHERE submitter.role_code NOT IN ('store', 'teacher')
     AND record.teacher_id IS NOT NULL
)
SELECT check_name, record_count, status
FROM checks
ORDER BY check_name;
