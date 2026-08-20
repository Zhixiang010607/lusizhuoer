"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const fallbackDir = path.join(root, "database", "cloudbase-console", "048-4kb");
const files = [
  "01-sync-teacher-profile.sql",
  "02-sync-teacher-account-status.sql",
  "03-active-experience-subjects.sql",
  "04-quota-resettable.sql",
  "05-reset-single-quota.sql",
  "06-reset-all-quotas.sql",
  "07-configure-quota.sql",
  "08-remove-quota.sql",
  "09-01-validate-recharge-request.sql",
  "09-02-recharge-active-quota.sql",
  "10-active-order-master-data.sql",
  "11-lock-active-verification-subjects.sql",
  "12-usage-guard.sql",
  "13-permissions-and-comments.sql",
  "14-verify-fallback.sql"
];

assert.deepEqual(
  fs.readdirSync(fallbackDir).filter((filename) => filename.endsWith(".sql")).sort(),
  files,
  "048 4KB fallback must have an explicit, complete execution sequence"
);

const sourceByFile = new Map();
for (const filename of files) {
  const source = fs.readFileSync(path.join(fallbackDir, filename), "utf8");
  sourceByFile.set(filename, source);
  assert.ok(Buffer.byteLength(source, "utf8") <= 3500, `${filename} must fit the 3.5KB editor limit`);
  assert.ok(
    Buffer.byteLength(source.replace(/\n/g, "\r\n"), "utf8") <= 3500,
    `${filename} must remain below the limit after a Windows CRLF checkout`
  );
  assert.match(source, /BEGIN;[\s\S]*COMMIT;\s*$/, `${filename} must be one complete transaction`);
  assert.doesNotMatch(source, /^ROLLBACK;/m, `${filename} must not mix recovery with migration SQL`);

  const delimiters = source.match(/\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$/g) || [];
  const counts = new Map();
  for (const delimiter of delimiters) counts.set(delimiter, (counts.get(delimiter) || 0) + 1);
  for (const [delimiter, count] of counts) {
    assert.equal(count % 2, 0, `${filename} has an unclosed ${delimiter} block`);
  }

  const definitions = source.match(/CREATE OR REPLACE FUNCTION public\./g) || [];
  assert.ok(definitions.length <= 1, `${filename} must keep each function in its own pasteable file`);
  if (definitions.length === 1) {
    assert.equal(delimiters.length, 2, `${filename} must contain one complete function body`);
  }
}

const bundled = files.map((filename) => sourceByFile.get(filename)).join("\n");
for (const functionName of [
  "sync_teacher_profile",
  "sync_teacher_account_status",
  "assert_active_teacher_experience_subjects",
  "teacher_experience_quota_is_resettable",
  "reset_teacher_experience_quota",
  "reset_teacher_experience_quotas",
  "upsert_teacher_product_experience_quota",
  "delete_teacher_product_experience_quota",
  "validate_teacher_experience_quota_recharge",
  "recharge_teacher_product_experience_quota",
  "assert_active_order_master_data",
  "lock_active_verification_subjects",
  "assert_active_teacher_experience_quota_usage"
]) {
  assert.match(bundled, new RegExp(`CREATE OR REPLACE FUNCTION public\\.${functionName}\\(`));
}

const activeSubjects = sourceByFile.get("03-active-experience-subjects.sql");
assert.doesNotMatch(activeSubjects, /face_enrollment_status/, "teacher face must not gate active quota subjects");
assert.match(activeSubjects, /teacher_status = 'ACTIVE'/);
assert.match(activeSubjects, /account_status = 'ACTIVE'/);

const configure = sourceByFile.get("07-configure-quota.sql");
assert.match(configure, /available_count = p_monthly_allowance/);
assert.match(configure, /quota_status = 'ACTIVE'/);
assert.match(configure, /'CONFIGURED'/);

const remove = sourceByFile.get("08-remove-quota.sql");
assert.match(remove, /quota_status = 'ARCHIVED'/);
assert.match(remove, /'REMOVED'/);

const recharge = sourceByFile.get("09-02-recharge-active-quota.sql");
assert.match(recharge, /validate_teacher_experience_quota_recharge/);
assert.match(recharge, /idempotency key belongs to a different teacher experience recharge/);
assert.match(recharge, /manual_recharge_count = manual_recharge_count \+ p_unit_count/);

const usageGuard = sourceByFile.get("12-usage-guard.sql");
assert.match(usageGuard, /CREATE TRIGGER trg_assert_active_teacher_experience_quota_usage/);
assert.match(usageGuard, /quota_status = 'ACTIVE'/);

const permissions = sourceByFile.get("13-permissions-and-comments.sql");
assert.match(permissions, /REVOKE ALL ON FUNCTION public\.validate_teacher_experience_quota_recharge/);
assert.match(permissions, /REVOKE ALL ON FUNCTION public\.recharge_teacher_product_experience_quota/);

const verification = sourceByFile.get("14-verify-fallback.sql");
assert.match(verification, /teacher_experience_quota_configuration_events/);
assert.match(verification, /trg_assert_active_teacher_experience_quota_usage/);

console.log("CloudBase 048 4KB fallback: PASS");
