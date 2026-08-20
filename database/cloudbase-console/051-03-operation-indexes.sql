-- CloudBase migration 051, part 3 / 10. Run this file by itself.
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS uq_teacher_face_operation_open_phone
  ON public.teacher_face_operations (phone)
  WHERE operation_status IN ('RUNNING', 'CANCELLED', 'CLEANUP_PENDING')
    AND cleanup_completed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_teacher_face_operation_open_teacher
  ON public.teacher_face_operations (teacher_id)
  WHERE teacher_id IS NOT NULL
    AND operation_status IN ('RUNNING', 'CANCELLED', 'CLEANUP_PENDING')
    AND cleanup_completed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_teacher_face_operation_open_person
  ON public.teacher_face_operations (person_id)
  WHERE person_id IS NOT NULL
    AND operation_status IN ('RUNNING', 'CANCELLED', 'CLEANUP_PENDING')
    AND cleanup_completed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_teacher_face_operation_status_lease
  ON public.teacher_face_operations (operation_status, lease_expires_at, id);

COMMIT;
