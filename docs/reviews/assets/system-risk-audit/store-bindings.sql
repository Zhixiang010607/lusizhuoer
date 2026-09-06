SELECT 'active store missing active matching account' AS check_name, COUNT(*)::bigint AS observed_count
FROM public.stores s LEFT JOIN public.staff_accounts a ON a.id = s.store_account_id
WHERE s.store_status = 'ACTIVE' AND (a.id IS NULL OR a.account_status <> 'ACTIVE' OR a.role_code <> 'store')
UNION ALL
SELECT 'active store account without active store', COUNT(*)::bigint FROM public.staff_accounts a
WHERE a.role_code = 'store' AND a.account_status = 'ACTIVE' AND NOT EXISTS
(SELECT 1 FROM public.stores s WHERE s.store_account_id = a.id AND s.store_status = 'ACTIVE')
UNION ALL
SELECT 'store contact differs from account phone', COUNT(*)::bigint
FROM public.stores s JOIN public.staff_accounts a ON a.id = s.store_account_id
JOIN public.store_contacts c ON c.store_id = s.id AND c.contact_status = 'ACTIVE'
WHERE c.contact_phone <> a.phone
UNION ALL
SELECT 'same phone across multiple active store contacts', COUNT(*)::bigint
FROM (SELECT contact_phone FROM public.store_contacts WHERE contact_status = 'ACTIVE' GROUP BY contact_phone HAVING COUNT(*) > 1) duplicates;
