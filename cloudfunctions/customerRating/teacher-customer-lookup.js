"use strict";

// Read-only lookup context. Never use this predicate in mutation authorization.
function parseTeacherLookup(event, role, fail, requireCode = true) {
  const raw = event.teacherLookup;
  if (raw === undefined) return null;
  if (role !== "teacher") fail("此客户查询仅供在职老师使用。", "FORBIDDEN");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("请重新选择门店并输入完整客户姓名。", "BAD_REQUEST");
  const storeId = typeof raw.storeId === "string" ? raw.storeId.trim() : "";
  const customerName = typeof raw.customerName === "string" ? raw.customerName.trim() : "";
  const customerCode = typeof raw.customerCode === "string" ? raw.customerCode.trim() : "";
  if (!/^[1-9]\d{0,18}$/.test(storeId) || BigInt(storeId) > 9223372036854775807n
      || !customerName || Array.from(customerName).length > 40
      || /[\u0000-\u001f\u007f]/.test(customerName)
      || (requireCode && (!customerCode || customerCode.length > 96))) {
    fail("请选择门店并手动输入完整客户姓名。", "BAD_REQUEST");
  }
  return Object.freeze({ storeId, customerName, customerCode });
}

function lookupCustomerCondition(lookup, alias, sqlText) {
  if (!/^[a-z_]+$/.test(alias)) throw new Error("Invalid customer alias");
  return `(${alias}.created_store_id = ${sqlText(lookup.storeId)}::bigint
    AND ${alias}.customer_name = ${sqlText(lookup.customerName)}
    ${lookup.customerCode ? `AND ${alias}.customer_code = ${sqlText(lookup.customerCode)}` : ""}
    AND EXISTS (SELECT 1 FROM public.stores lookup_store
      WHERE lookup_store.id = ${alias}.created_store_id AND lookup_store.store_status = 'ACTIVE'))`;
}
module.exports = { parseTeacherLookup, lookupCustomerCondition };
