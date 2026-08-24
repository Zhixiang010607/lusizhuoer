-- Migration 059 read-only verification. Every row must report READY.

WITH expected(table_name, trigger_name, function_name, marker, needs_change_event) AS (
  VALUES
    ('recharge_records', 'trg_058_recharge_integrity',
     'enforce_current_recharge_integrity', 'CURRENT_RECHARGE_INTEGRITY_V58', TRUE),
    ('verification_records', 'trg_058_verification_integrity',
     'enforce_current_verification_integrity', 'CURRENT_VERIFICATION_INTEGRITY_V58', TRUE),
    ('recharge_records', 'trg_059_recharge_business_teacher',
     'enforce_business_teacher_matrix_v59', 'BUSINESS_TEACHER_MATRIX_V59', FALSE),
    ('verification_records', 'trg_059_verification_business_teacher',
     'enforce_business_teacher_matrix_v59', 'BUSINESS_TEACHER_MATRIX_V59', FALSE)
), actual AS (
  SELECT relation.relname AS table_name,
         trigger.tgname AS trigger_name,
         procedure.proname AS function_name,
         procedure_namespace.nspname AS function_schema,
         PG_GET_FUNCTIONDEF(procedure.oid) AS function_def,
         trigger.tgenabled <> 'D' AS enabled,
         trigger.tgtype AS trigger_type
    FROM pg_trigger trigger
    JOIN pg_class relation ON relation.oid = trigger.tgrelid
    JOIN pg_namespace relation_namespace ON relation_namespace.oid = relation.relnamespace
    JOIN pg_proc procedure ON procedure.oid = trigger.tgfoid
    JOIN pg_namespace procedure_namespace ON procedure_namespace.oid = procedure.pronamespace
   WHERE relation_namespace.nspname = 'public' AND NOT trigger.tgisinternal
), results AS (
  SELECT expected.table_name AS object_group,
         expected.trigger_name AS object_name,
         CASE
           WHEN actual.function_schema = 'public'
            AND actual.function_name = expected.function_name
            AND POSITION(expected.marker IN actual.function_def) > 0
            AND actual.enabled
            AND (actual.trigger_type & 1) = 1
            AND (actual.trigger_type & 2) = 2
            AND (actual.trigger_type & 4) = 4
            AND (actual.trigger_type & 8) = 0
            AND (actual.trigger_type & 32) = 0
            AND ((expected.needs_change_event AND (actual.trigger_type & 16) = 16)
              OR (NOT expected.needs_change_event AND (actual.trigger_type & 16) = 0))
            AND (expected.function_name <> 'enforce_business_teacher_matrix_v59' OR (
              POSITION('STORE_BINDING_CURRENT_V59' IN actual.function_def) > 0
              AND POSITION('STORE_BINDING_LEGACY_V59' IN actual.function_def) > 0
              AND POSITION('STORE_BINDING_DYNAMIC_V59' IN actual.function_def) > 0
              AND POSITION('STORE_RECHARGE_REFUND_TEACHER_OPTIONAL_V59' IN actual.function_def) > 0
              AND POSITION('STORE_NORMAL_TEACHER_REQUIRED_V59' IN actual.function_def) > 0
              AND POSITION('STORE_EXPERIENCE_DENIED_V59' IN actual.function_def) > 0
              AND POSITION('TEACHER_SELF_ATTRIBUTION_V59' IN actual.function_def) > 0
            ))
           THEN 'READY' ELSE 'MISSING'
         END AS status
    FROM expected
    LEFT JOIN actual USING (table_name, trigger_name)
)
SELECT object_group, object_name, status
FROM results
ORDER BY object_group, object_name;
