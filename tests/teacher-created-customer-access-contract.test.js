"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const cloud = read("cloudfunctions", "faceRecognition", "index.js");
const migration = read("database", "migrations", "057_teacher_created_customer_access.sql");
const consoleMigration = read("database", "cloudbase-console", "057-01-teacher-created-customer-access.sql");
const reference = read("database", "customer-fields-reference.md");

assert.match(cloud, /const FUNCTION_VERSION = PHOTO_ONLY_FUNCTION \? "v9" : "v109"/);

for (const sql of [migration, consoleMigration]) {
  assert.match(sql, /ADD COLUMN IF NOT EXISTS created_by_account_id BIGINT;/,
    "creator account column must remain nullable for historical rows");
  assert.match(sql, /FOREIGN KEY \(created_by_account_id\)[\s\S]*REFERENCES public\.staff_accounts\(id\)[\s\S]*ON DELETE SET NULL/,
    "creator identity must reference the actual login account");
  assert.match(sql, /idx_customers_created_by_account[\s\S]*created_by_account_id, created_at DESC, id DESC/,
    "creator access must have a bounded lookup index");
  assert.doesNotMatch(sql, /UPDATE public\.customers[\s\S]*created_by_account_id\s*=/,
    "historical customers must never be guessed or automatically assigned to a teacher");
}

const scope = cloud.slice(cloud.indexOf("function teacherCustomerAccessCondition"), cloud.indexOf("function customerStatusCode"));
const attributionSource = cloud.slice(cloud.indexOf("function teacherBusinessAttributionSourceCondition"), cloud.indexOf("function trustedBusinessTeacherIdSql"));
const ownership = cloud.slice(cloud.indexOf("function teacherBusinessOwnershipCondition"), cloud.indexOf("function teacherBusinessAttributionCondition"));
const attribution = cloud.slice(cloud.indexOf("function teacherBusinessAttributionCondition"), cloud.indexOf("function teacherCustomerAccessCondition"));
assert.match(scope, /caller\.role === "store"[^\n]*created_store_id = \$\{caller\.storeId\}/,
  "store access remains based on the owning store, not teacher ownership");
assert.match(ownership, /\$\{alias\}\.submitted_by_account_id = \$\{sqlText\(caller\.staffId\)\}::bigint/,
  "business write ownership must use the exact submitting login account");
assert.doesNotMatch(ownership, /teacher_id|caller\.teacherId/,
  "write ownership must never be inferred from the selected teacher");
assert.match(attribution, /\$\{alias\}\.teacher_id = \$\{sqlText\(caller\.teacherId\)\}::bigint/,
  "business attribution must use the teacher selected on the order");
assert.match(attribution, /teacherBusinessAttributionSourceCondition\(alias, recordFamily\)/,
  "business attribution must reject untrusted historical submitter roles");
assert.match(attributionSource, /role_code = 'store'[\s\S]*role_code = 'teacher'[\s\S]*attribution_submitter_teacher\.id = \$\{alias\}\.teacher_id/,
  "store selections remain attributable while teacher submissions must be self-bound");
assert.match(attributionSource, /recordFamily === "RECHARGE"[\s\S]*verification_type = 'NORMAL'[\s\S]*verification_type IN \('NORMAL', 'EXPERIENCE'\)/,
  "store EXPERIENCE and retired verification categories must never create attribution");
assert.match(scope, /created_by_account_id = \$\{sqlText\(caller\.staffId\)\}::bigint[\s\S]*teacherBusinessAttributionCondition\(caller, "teacher_verification", "VERIFICATION"\)/,
  "teacher access must accept same-account creation and attributed approved verification relationships");
assert.match(scope, /teacher_verification\.record_status = 'APPROVED'[\s\S]*verification_type IN \('NORMAL', 'EXPERIENCE'\)/,
  "the existing effective verification relationship remains valid");
assert.match(scope, /teacher_recharge\.record_status = 'APPROVED'[\s\S]*recharge_type IN \('NEW', 'REFUND'\)/,
  "approved recharge and refund relationships must grant the same customer access");

const registration = cloud.slice(cloud.indexOf("async function registerCustomer"), cloud.indexOf("async function validateCapture"));
assert.match(registration, /created_store_id, created_by_account_id\)[\s\S]*\$\{caller\.storeId\}, \$\{caller\.staffId\}/,
  "every new customer stores both the selected store and the actual creator account");
assert.match(registration, /String\(existing\.created_by_account_id\) === String\(caller\.staffId\)/,
  "an idempotency replay cannot be claimed by a different store, teacher, or headquarters account");

const teacherCustomers = cloud.slice(cloud.indexOf("async function getTeacherBusinessCustomers"), cloud.indexOf("async function getTeacherWorkspace"));
assert.match(teacherCustomers, /c\.created_by_account_id = \$\{sqlText\(caller\.staffId\)\}::bigint/,
  "teacher homepage customer lists must include customers created by the same login account");
assert.match(teacherCustomers, /r\.record_status = 'APPROVED'[\s\S]*r\.recharge_type IN \('NEW', 'REFUND'\)/,
  "teacher homepage customer lists must include approved recharge and refund relationships");
assert.match(teacherCustomers, /teacherBusinessAttributionCondition\(caller, "v", "VERIFICATION"\)[\s\S]*teacherBusinessAttributionCondition\(caller, "r", "RECHARGE"\)/,
  "teacher homepage customer lists must include effective business attributed by teacher_id");

assert.match(reference, /门店账号建立时该字段保存门店账号，不会直接绑定任何老师/);
assert.match(reference, /历史客户[\s\S]*保持 `NULL`[\s\S]*不能[\s\S]*猜测老师归属/);

console.log("teacher-created customer access contract: PASS");
