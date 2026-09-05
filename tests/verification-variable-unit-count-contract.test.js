"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const migration = read("database/migrations/064_variable_verification_unit_count.sql");
const consoleSql = read("database/cloudbase-console/064-01-variable-verification-unit-count.sql");
const verifySql = read("database/cloudbase-console/064-readonly-verify.sql");
const cloud = read("cloudfunctions/faceRecognition/index.js");
const web = read("store-business.js");
const mini = read("miniprogram-app/miniprogram/pages/verification/index.js");
const miniView = read("miniprogram-app/miniprogram/pages/verification/index.wxml");
const context = read("PROJECT_CONTEXT.md");

test("migration 064 replaces fixed-one constraints with bounded selected counts", () => {
  assert.equal(consoleSql, migration, "the copy-paste CloudBase SQL must exactly match the canonical migration");
  assert.match(migration, /verification_records_unit_count_check[\s\S]*CHECK \(unit_count BETWEEN 1 AND 999\)/);
  assert.match(migration, /teacher_experience_quota_usages_unit_count_check[\s\S]*CHECK \(unit_count BETWEEN 1 AND 999\)/);
  assert.match(migration, /p_unit_count INTEGER[\s\S]*p_unit_count < 1 OR p_unit_count > 999/);
  assert.match(migration, /existing_record\.unit_count IS DISTINCT FROM p_unit_count/,
    "a repeated idempotency key cannot change the selected count");
  assert.match(migration, /quota\.available_count < p_unit_count/);
  assert.match(migration, /available_count = quota_row\.available_count - p_unit_count/);
  assert.match(migration, /used_count = quota_row\.used_count \+ p_unit_count/);
  assert.match(migration, /quota\.quota_month, p_unit_count, quota_before, quota\.available_count/);
  assert.match(migration, /p_product_id,[\s\n]+p_unit_count, normalized_status/,
    "the verification row must store the operator-selected count");
  assert.match(migration, /verification unit count is required by migration 064/,
    "legacy fixed-one signatures must fail closed");
  assert.match(migration, /device_signal_outbox/,
    "the same atomic writer must retain the device signal outbox");
});

test("the database and cloud service remain the count authority", () => {
  assert.match(read("database/migrations/063_lock_down_database_client_access.sql"), /available_units < NEW\.unit_count/,
    "paid verification must still reject insufficient balance at the database boundary");
  assert.match(cloud, /const FUNCTION_VERSION = PHOTO_ONLY_FUNCTION \? "v10" : "v112"/);
  assert.match(cloud, /const unitCount = Number\(event\.unitCount\)/);
  assert.match(cloud, /unitCount < 1 \|\| unitCount > 999/);
  assert.match(cloud, /Number\(record\.unit_count\) === unitCount/,
    "server idempotency verification must compare the count");
  assert.match(cloud, /\$\{unitCount\}::integer/,
    "the selected count must be passed into both database writers");
  assert.match(cloud, /deviceSignal:[\s\S]{0,300}unitCount: Number\(record\.unit_count\)/,
    "device authorization data must expose only the stored count");
  assert.match(cloud, /create_verification_with_face_photo\(character varying,bigint,bigint,bigint,bigint,integer/,
    "health/schema checks must require migration 064 instead of accepting the fixed-one function");
});

test("web and mini-program require an explicit count and bind it to idempotency", () => {
  for (const file of [
    "verification-create.html",
    "verification-experience.html",
    "teacher-verification-create.html",
    "teacher-verification-experience.html"
  ]) {
    const html = read(file);
    assert.match(html, /id="verificationUnitCount"/);
    assert.match(html, /min="1" max="999"/);
    assert.match(html, /required disabled/);
  }

  assert.match(web, /syncVerificationUnitCount\(\) !== null/);
  assert.match(web, /const payload = \{ customerCode:[^\n]*unitCount,/);
  assert.match(web, /productId: project\.id,[\s\n]+unitCount,[\s\n]+teacherId/,
    "the browser fingerprint identity must include the selected count");
  assert.match(web, /Number\(result\.unitCount\) !== unitCount \|\| Number\(result\.deviceSignal\?\.unitCount\) !== unitCount/);

  assert.match(miniView, /体验次数' : '核销次数'/);
  assert.match(miniView, /bindinput="inputUnitCount"/);
  assert.doesNotMatch(miniView, /本次核销 1 次/);
  assert.match(mini, /inputUnitCount\(event\)/);
  assert.match(mini, /unitCount, teacherId: String\(this\.data\.selectedTeacher\?\.teacherId \|\| ""\)/,
    "the mini-program submission fingerprint must include the selected count");
  assert.match(mini, /Number\(qualification\.unitCount\) !== unitCount/);
});

test("rules, deployment handoff and read-only checks retire fixed-one behavior", () => {
  assert.match(context, /不能隐藏、预填或固定为 1/);
  assert.match(context, /废弃正常核销和体验核销固定为 1 次/);
  assert.match(context, /faceRecognition v112/);
  assert.match(verifySql, /legacy fixed-one writers blocked/);
  assert.match(verifySql, /client execution remains closed/);
  assert.match(verifySql, /experience usage matches verification/);
  assert.match(verifySql, /unit_count\[\^0-9\]\*>= \*1/,
    "the verifier must accept PostgreSQL's normalized lower-bound rendering");
  assert.match(verifySql, /unit_count\[\^0-9\]\*<= \*999/,
    "the verifier must accept PostgreSQL's normalized upper-bound rendering");
});
