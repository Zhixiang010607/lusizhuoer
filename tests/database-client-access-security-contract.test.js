"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

const migration = read("database", "migrations", "063_lock_down_database_client_access.sql");
const existingAcl = read("database", "cloudbase-console", "063-01-existing-object-lockdown.sql");
const defaultAcl = read("database", "cloudbase-console", "063-02-default-privilege-lockdown.sql");
const balanceGuard = read("database", "cloudbase-console", "063-03-paid-verification-balance-guard.sql");
const verifyAccess = read("database", "cloudbase-console", "063-readonly-verify-01-access.sql");
const verifyDefaults = read("database", "cloudbase-console", "063-readonly-verify-02-defaults-and-balance.sql");
const diagnoseFunctions = read("database", "cloudbase-console", "063-readonly-diagnose-function-access.sql");
const verify = `${verifyAccess}\n${verifyDefaults}`;
const readme = read("database", "cloudbase-console", "063-README.md");
const projectContext = read("PROJECT_CONTEXT.md");
const rootReadme = read("README.md");
const face = read("cloudfunctions", "faceRecognition", "index.js");
const staff = read("cloudfunctions", "staffAccount", "index.js");

for (const source of [migration, existingAcl]) {
  assert.match(source, /REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC, anon, authenticated/);
  assert.match(source, /REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC, anon, authenticated/);
  assert.match(source, /REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated/);
  assert.match(source, /REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated/);
  assert.match(source, /GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO service_role/);
  assert.match(source, /GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO service_role/);
}

for (const source of [migration, defaultAcl]) {
  assert.match(source, /SELECT PG_GET_USERBYID\(class\.relowner\)/,
    "future ACL lockdown must discover actual CloudBase object-owner roles");
  assert.match(source, /SELECT PG_GET_USERBYID\(proc\.proowner\)/);
  assert.match(source, /ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated/);
  assert.match(source, /ALTER DEFAULT PRIVILEGES FOR ROLE %I REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated/);
  assert.match(source, /IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated/);
  assert.match(source, /GRANT EXECUTE ON FUNCTIONS TO service_role/);
  assert.match(source, /EXCEPTION WHEN insufficient_privilege/,
    "CloudBase-owned roles must not abort the current migration owner's repair");
  assert.match(source, /owner_row\.role_name = CURRENT_USER::TEXT[\s\S]*RAISE;/,
    "failure to close the current migration owner's defaults must remain fatal");
  assert.match(source, /schema denial remains authoritative/);
}

for (const source of [migration, balanceGuard]) {
  assert.match(source, /PAID_VERIFICATION_BALANCE_GUARD_V63/);
  assert.match(source, /NEW\.verification_type NOT IN \('NORMAL', 'SUPPLEMENT'\)/,
    "experience verification must stay outside purchased-balance consumption");
  assert.match(source, /FROM public\.customers AS customer[\s\S]*FOR UPDATE/,
    "paid verification must serialize on the customer row");
  assert.match(source, /FROM public\.customer_product_balances AS balance[\s\S]*FOR UPDATE/,
    "paid verification must lock the materialized last-unit balance");
  assert.match(source, /FROM public\.recharge_records AS recharge[\s\S]*recharge\.record_status = 'APPROVED'/);
  assert.match(source, /FROM public\.verification_records AS verification[\s\S]*verification\.verification_type IN \('NORMAL', 'SUPPLEMENT'\)/);
  assert.match(source, /available_units < NEW\.unit_count/);
  assert.match(source, /available_units := LEAST\(/,
    "the guard must fail closed when either materialized or aggregate balance is lower");
  assert.match(source, /insufficient purchased units/);
  assert.match(source, /BEFORE INSERT OR UPDATE OF record_status ON public\.verification_records/);
  assert.match(source, /REVOKE ALL ON FUNCTION public\.enforce_paid_verification_available_balance_v63\(\)[\s\S]*FROM PUBLIC, anon, authenticated/);
}

assert.equal((verifyAccess.match(/UNION ALL/g) || []).length, 3,
  "063 access verification must return four checks in one result table");
assert.equal((verifyDefaults.match(/UNION ALL/g) || []).length, 3,
  "063 defaults/balance verification must return four checks in one result table");
assert.match(verify, /client schema access closed/);
assert.match(verify, /client table access closed/);
assert.match(verify, /client sequence access closed/);
assert.match(verify, /client function execution closed/);
assert.match(verify, /migration owner defaults closed/);
assert.match(verify, /service role retained/);
assert.match(verify, /paid verification balance trigger/);
assert.match(verify, /paid verification balance guard body/);
assert.match(verify, /CASE WHEN record_count = 0 THEN 'READY' ELSE 'UNSAFE' END/);
assert.match(verifyAccess, /PG_GET_USERBYID\(proc\.proowner\) = 'tencentdb_cloudbase_root'/);
assert.match(verifyAccess, /'guard_system_tables', 'guard_system_tables_on_drop'/);
assert.match(verifyAccess, /NOT function\.provider_guard[\s\S]*HAS_SCHEMA_PRIVILEGE\('anon', 'public', 'USAGE'\)/,
  "provider guard exception must stay conditional on schema containment");
assert.match(verifyAccess, /NOT function\.provider_guard[\s\S]*HAS_SCHEMA_PRIVILEGE\('authenticated', 'public', 'USAGE'\)/);

assert.match(diagnoseFunctions, /WITH RECURSIVE client_roles/);
assert.match(diagnoseFunctions, /HAS_FUNCTION_PRIVILEGE\(client\.oid, routine\.oid, 'EXECUTE'\)/);
assert.match(diagnoseFunctions, /ACLEXPLODE\(COALESCE\(/);
assert.match(diagnoseFunctions, /routine_signature[\s\S]*routine_type[\s\S]*owner_role[\s\S]*grant_sources/);
assert.doesNotMatch(diagnoseFunctions, /\b(REVOKE|GRANT|ALTER|DROP|CREATE|INSERT|UPDATE|DELETE)\b/,
  "diagnostic must remain read-only");

assert.match(readme, /063-01-existing-object-lockdown\.sql[\s\S]*063-02-default-privilege-lockdown\.sql[\s\S]*063-03-paid-verification-balance-guard\.sql[\s\S]*063-readonly-verify-01-access\.sql[\s\S]*063-readonly-verify-02-defaults-and-balance\.sql/);
assert.match(readme, /不产生新的云函数 ZIP/);
assert.match(projectContext, /`anon`／`authenticated` 对该 schema、表、序列和函数均为零权限/);
assert.match(projectContext, /余额不足时整个事务以约束错误失败/);
assert.match(rootReadme, /安全迁移 063 已于 2026-08-26 完成三段执行[\s\S]*8 行全部 `READY`/);
assert.match(projectContext, /迁移 063 的三段控制台 SQL 已由用户在 2026-08-26 执行[\s\S]*8 行均为 `record_count = 0`、`status = READY`/);

const rechargeStart = face.indexOf("async function createRechargeApplication(event)");
const rechargeEnd = face.indexOf("async function requireVerificationSubmissionSchema", rechargeStart);
const rechargeSource = face.slice(rechargeStart, rechargeEnd);
assert.ok(rechargeStart >= 0 && rechargeEnd > rechargeStart);
assert.match(rechargeSource, /INSERT INTO public\.recharge_records[\s\S]*'PENDING'/,
  "recharge applications must still be inserted pending instead of trusting a client status");

const verificationStart = face.indexOf("async function createVerificationApplication(event)");
const verificationEnd = face.indexOf("async function recoverBusinessSubmission(event)", verificationStart);
const verificationSource = face.slice(verificationStart, verificationEnd);
assert.ok(verificationStart >= 0 && verificationEnd > verificationStart);
assert.match(verificationSource, /faceEvidenceToken/);
assert.match(verificationSource, /\^\[0-9a-f\]\{48\}\$/);
assert.match(verificationSource, /create_verification_with_face_photo/);
assert.match(verificationSource, /FROM public\.device_signal_outbox/,
  "device authorization must be returned from the committed database outbox");

const reviewStart = staff.indexOf("async function reviewOrder(caller, event)");
const reviewEnd = staff.indexOf("async function requireTeacherStatusSchema", reviewStart);
const reviewSource = staff.slice(reviewStart, reviewEnd);
assert.ok(reviewStart >= 0 && reviewEnd > reviewStart);
assert.match(reviewSource, /requireReviewer\(caller\)/,
  "cloud-function review must continue to enforce headquarters identity before SQL");

console.log("database client access security contract: PASS");
