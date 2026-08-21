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

assert.match(cloud, /const FUNCTION_VERSION = PHOTO_ONLY_FUNCTION \? "v5" : "v84"/);

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

const scope = cloud.slice(cloud.indexOf("function customerProfileScope"), cloud.indexOf("function customerStatusCode"));
assert.match(scope, /caller\.role === "store"[^\n]*created_store_id = \$\{caller\.storeId\}/,
  "store access remains based on the owning store, not teacher ownership");
assert.match(scope, /caller\.role === "teacher"[\s\S]*created_by_account_id = \$\{sqlText\(caller\.staffId\)\}::bigint[\s\S]*\bOR\b[\s\S]*teacher_verification\.teacher_id = \$\{sqlText\(caller\.teacherId\)\}::bigint/,
  "teacher access must accept either same-account creation or an approved verification relationship");
assert.match(scope, /teacher_verification\.record_status = 'APPROVED'[\s\S]*verification_type IN \('NORMAL', 'EXPERIENCE'\)/,
  "the existing effective verification relationship remains valid");

const registration = cloud.slice(cloud.indexOf("async function registerCustomer"), cloud.indexOf("async function validateCapture"));
assert.match(registration, /created_store_id, created_by_account_id\)[\s\S]*\$\{caller\.storeId\}, \$\{caller\.staffId\}/,
  "every new customer stores both the selected store and the actual creator account");
assert.match(registration, /String\(existing\.created_by_account_id\) === String\(caller\.staffId\)/,
  "an idempotency replay cannot be claimed by a different store, teacher, or headquarters account");

const teacherCustomers = cloud.slice(cloud.indexOf("async function getTeacherBusinessCustomers"), cloud.indexOf("async function getTeacherWorkspace"));
assert.doesNotMatch(teacherCustomers, /created_by_account_id/,
  "teacher homepage customer lists remain based on completed verification business, not mere creation");

assert.match(reference, /门店账号建立时该字段保存门店账号，不会直接绑定任何老师/);
assert.match(reference, /历史客户[\s\S]*保持 `NULL`[\s\S]*不能[\s\S]*猜测老师归属/);

console.log("teacher-created customer access contract: PASS");
