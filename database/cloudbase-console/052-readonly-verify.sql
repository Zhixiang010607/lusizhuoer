-- Migration 052 read-only verification. This file changes no data.
SELECT requirement, kind, object_name,
       CASE WHEN ready THEN 'READY' ELSE 'MISSING' END AS status
FROM (
  VALUES
    ('052', 'column', 'auth_create_returned_uid varchar(128)',
      EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='teacher_face_operations'
           AND column_name='auth_create_returned_uid'
           AND data_type='character varying' AND character_maximum_length=128
      )),
    ('052', 'column', 'auth_create_confirmed_at timestamptz',
      EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='teacher_face_operations'
           AND column_name='auth_create_confirmed_at'
           AND data_type='timestamp with time zone'
      )),
    ('052', 'constraint', 'teacher Auth create receipt checks',
      (SELECT COUNT(*)=2 FROM pg_constraint
        WHERE conrelid=TO_REGCLASS('public.teacher_face_operations')
          AND conname IN ('teacher_face_operation_auth_create_receipt_valid',
                          'teacher_face_operation_auth_create_receipt_pair'))),
    ('052', 'data', 'create receipts are paired and owned PROVISION rows',
      NOT EXISTS (
        SELECT 1 FROM public.teacher_face_operations
         WHERE (auth_create_returned_uid IS NULL) <> (auth_create_confirmed_at IS NULL)
            OR (
              auth_create_returned_uid IS NOT NULL
              AND (
                operation_type <> 'PROVISION'
                OR auth_uid IS NULL
                OR auth_owner_token_sha256 IS NULL
              )
            )
      )),
    ('052', 'security', 'PUBLIC table privileges remain revoked',
      NOT HAS_TABLE_PRIVILEGE('public','public.teacher_face_operations','SELECT,INSERT,UPDATE,DELETE'))
) AS checks(requirement, kind, object_name, ready)
ORDER BY kind, object_name;
