"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const migration = read("database/migrations/079_supplement_verification_review.sql");
const consoleSql = read("database/cloudbase-console/079-01-supplement-verification-review.sql");
const verifySql = read("database/cloudbase-console/079-readonly-verify.sql");
const hotfixMigration = read("database/migrations/080_fix_supplement_verification_id_ambiguity.sql");
const hotfixConsoleSql = read("database/cloudbase-console/080-01-fix-supplement-verification-id-ambiguity.sql");
const hotfixVerifySql = read("database/cloudbase-console/080-readonly-verify.sql");
const face = read("cloudfunctions/faceRecognition/index.js");
const staff = read("cloudfunctions/staffAccount/index.js");
const verificationJs = read("miniprogram-app/miniprogram/pages/verification/index.js");
const verificationWxml = read("miniprogram-app/miniprogram/pages/verification/index.wxml");
const homeWxml = read("miniprogram-app/miniprogram/pages/home/index.wxml");
const homeWxss = read("miniprogram-app/miniprogram/pages/home/index.wxss");
const reviewsJs = read("miniprogram-app/miniprogram/pages/reviews/index.js");
const queryTools = read("miniprogram-app/miniprogram/services/query-tools.js");
const orderJs = read("miniprogram-app/miniprogram/pages/order-detail/index.js");
const orderWxml = read("miniprogram-app/miniprogram/pages/order-detail/index.wxml");

assert.equal(consoleSql, migration, "079 CloudBase SQL must exactly match the canonical migration");
assert.equal(hotfixConsoleSql, hotfixMigration, "080 CloudBase SQL must exactly match the canonical migration");
assert.match(migration, /CURRENT_VERIFICATION_INTEGRITY_V79/);
assert.match(migration, /verification_type = 'SUPPLEMENT' AND NEW\.record_status <> 'PENDING'/);
assert.match(migration, /SUPPLEMENT_VERIFICATION_CREATE_V79/);
assert.match(migration, /p_unit_count < 1 OR p_unit_count > 999/);
assert.match(migration, /pg_advisory_xact_lock\(hashtext\(p_idempotency_key\)\)/);
assert.match(migration, /record_status, submitted_by_account_id, message,[\s\S]*'SUPPLEMENT'[\s\S]*'PENDING'/);
assert.doesNotMatch(
  migration.slice(migration.indexOf("CREATE OR REPLACE FUNCTION public.create_supplement_verification_application")),
  /INSERT INTO public\.(?:verification_photos|device_signal_outbox|verification_ble_qualifications)/,
  "supplement submission must not create face, photo, BLE, or device evidence"
);
assert.match(migration, /available_units < p_unit_count/,
  "submission must reject an already insufficient paid balance");
assert.match(migration, /TO_REGPROCEDURE\('public\.enforce_paid_verification_available_balance_v63\(\)'\)/,
  "migration preflight must retain the approval-time paid-balance guard");
assert.match(migration, /REVOKE ALL ON FUNCTION public\.create_supplement_verification_application[\s\S]*FROM PUBLIC, anon, authenticated/);
for (const marker of [
  "supplement_create_function", "supplement_pending_integrity", "supplement_teacher_matrix",
  "approval_balance_guard", "supplement_no_device_signal", "supplement_service_role_only"
]) assert.match(verifySql, new RegExp(marker));
for (const source of [migration, hotfixMigration]) {
  const submissionFunction = source.slice(source.indexOf(
    "CREATE OR REPLACE FUNCTION public.create_supplement_verification_application"
  ));
  assert.match(submissionFunction, /store\.id = p_store_id/);
  assert.match(submissionFunction, /product\.id = p_product_id/);
  assert.match(submissionFunction, /submitter\.id = p_submitted_by_account_id/);
  assert.doesNotMatch(submissionFunction, /WHERE id = p_(?:store|product|submitted_by_account)_id/,
    "supplement submission must qualify table identifiers that conflict with output columns");
}
assert.match(hotfixMigration, /SUPPLEMENT_VERIFICATION_CREATE_V80/);
assert.match(hotfixVerifySql, /supplement_qualified_identifiers/);
assert.match(hotfixVerifySql, /supplement_service_role_only/);

assert.match(face, /const FUNCTION_VERSION = PHOTO_ONLY_FUNCTION \? "v11" : "v125"/);
assert.match(face, /async function createSupplementVerificationApplication\(event\)/);
assert.match(face, /caller\.role === "teacher"[\s\S]*requestedTeacherId !== String\(caller\.teacherId\)/);
assert.match(face, /create_supplement_verification_application\(/);
assert.match(face, /action === "createSupplementVerificationApplication"/);
assert.match(face, /recordType === "SUPPLEMENT"/);
assert.match(face, /const complete = supplement \|\|/,
  "supplement recovery must not wait for a device signal that is intentionally absent");
assert.match(staff, /const FUNCTION_VERSION = "v87"/);
assert.match(staff, /v\.verification_type = 'SUPPLEMENT' AND v\.void_request_status = 'NONE'/);
assert.match(staff, /VERIFICATION_REVIEW_NOT_ALLOWED/,
  "HQ verification review must reject normal and experience records");
assert.match(staff, /insufficient purchased units[\s\S]*INSUFFICIENT_BALANCE/,
  "HQ approval must surface the database balance guard as a clear rejection");

assert.match(homeWxml, /teacher-business-heading">客户<\/text>/);
assert.match(homeWxml, /teacher-business-heading">核销<\/text>/);
assert.match(homeWxml, /data-mode="SUPPLEMENT">补录核销申请<\/view>/);
assert.match(homeWxss, /teacher-business-sections[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
assert.match(homeWxss, /@media \(min-width: 700px\)[\s\S]*teacher-business-sections \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
assert.match(verificationJs, /if \(this\.data\.supplement\) return this\.submitSupplement\(\)/);
assert.match(verificationJs, /callFace\("createSupplementVerificationApplication"/);
assert.match(verificationJs, /submission\.begin\("SUPPLEMENT"/);
assert.match(verificationWxml, /wx:if="\{\{!supplement\}\}" class="card submit-card[\s\S]*<view wx:else class="card submit-card[\s\S]*提交总部审核/);
assert.match(verificationWxml, /wx:if="\{\{!supplement\}\}"[\s\S]*camera-capture/,
  "face capture must stay on normal/experience only");
assert.match(verificationWxml, /wx:if="\{\{!supplement\}\}"[\s\S]*扫码并连接设备/,
  "BLE controls must stay on normal/experience only");
assert.match(reviewsJs, /type === "verification" \? "VERIFICATION"/);
assert.match(reviewsJs, /category: "SUPPLEMENT"/);

assert.doesNotMatch(queryTools, /value: "SUPPLEMENT"/,
  "ordinary query filters must not expose supplement as a separate public type");
assert.match(queryTools, /originalType === "SUPPLEMENT"[\s\S]{0,80}recordStatus === "APPROVED"[\s\S]{0,80}\? "NORMAL"/,
  "only approved supplemental records normalize to normal verification");
assert.match(queryTools, /: originalType;/,
  "pending and rejected supplemental records keep their exact internal detail route");
assert.match(orderJs, /\["NORMAL", "SUPPLEMENT", "EXPERIENCE"\]/);
assert.match(orderJs, /const photoManifestFlight = verification && request\.recordId/,
  "supplement details must fetch the same authorized photo manifest as other verification orders");
assert.match(orderJs, /if \(isSupplement\) await this\.loadPhotos\(photoManifestFlight\)/,
  "supplement details load photos without loading customer ratings");
assert.match(orderWxml, /wx:if="\{\{baseType === 'VERIFICATION'\}\}" class="card photo-section"/,
  "supplement detail must expose its three supplemental photo slots");
assert.match(orderWxml, /补录核销无现场留存照片/,
  "supplement detail must keep the onsite evidence slot visibly and immutably empty");
assert.match(orderWxml, /baseType === 'VERIFICATION' && !isSupplement[\s\S]*class="card rating-card"/,
  "supplement detail must still omit the customer rating section");

console.log("supplement verification restoration contract: PASS");
