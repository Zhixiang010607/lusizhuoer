SELECT material_status, COUNT(*) AS materials, COALESCE(SUM(file_bytes), 0) AS bytes
FROM public.training_materials GROUP BY material_status ORDER BY material_status;
