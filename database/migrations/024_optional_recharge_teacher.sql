BEGIN;

DO $$
DECLARE
  constraint_name TEXT;
BEGIN
  FOR constraint_name IN
    SELECT constraint_record.conname
      FROM pg_constraint constraint_record
     WHERE constraint_record.conrelid = 'public.recharge_records'::regclass
       AND constraint_record.contype = 'c'
       AND pg_get_constraintdef(constraint_record.oid) ~* 'teacher_id[[:space:]]+IS[[:space:]]+NOT[[:space:]]+NULL'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.recharge_records DROP CONSTRAINT %I',
      constraint_name
    );
  END LOOP;
END
$$;

ALTER TABLE public.recharge_records
  ALTER COLUMN teacher_id DROP NOT NULL;

COMMENT ON COLUMN public.recharge_records.teacher_id IS
  'Optional business teacher selected for this recharge order.';

COMMIT;
