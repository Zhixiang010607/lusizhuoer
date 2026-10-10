SELECT 'daily_report_200_character_trigger' AS item,
       CASE WHEN POSITION('200 characters' IN PG_GET_FUNCTIONDEF(
         TO_REGPROCEDURE('public.enforce_staff_daily_report_today_v73()')
       )) > 0 THEN 'READY' ELSE 'MISSING' END AS status;
