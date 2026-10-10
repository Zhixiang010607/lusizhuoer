SELECT 'product_receipt_instruction_constraint' AS item,
       CASE WHEN EXISTS (
         SELECT 1
           FROM pg_constraint
          WHERE conrelid = TO_REGCLASS('public.products')
            AND conname = 'products_receipt_instruction_length_check'
            AND POSITION('1000' IN PG_GET_CONSTRAINTDEF(oid)) > 0
            AND POSITION('3000' IN PG_GET_CONSTRAINTDEF(oid)) = 0
       ) THEN 'READY' ELSE 'MISSING' END AS status
UNION ALL
SELECT 'product_receipt_instruction_columns',
       CASE WHEN (
         SELECT COUNT(*)
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'products'
            AND column_name IN ('verification_receipt_instructions', 'recharge_receipt_instructions')
            AND data_type = 'text'
       ) = 2 THEN 'READY' ELSE 'MISSING' END;
