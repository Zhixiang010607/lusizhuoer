"use strict";

// Regression coverage for the forward-only repair after the optional-face
// teacher rollout.  This remains source-level because the local runner does
// not have a CloudBase PostgreSQL instance, but it locks the deployed SQL and
// service boundaries that caused the observed teacher-home failures.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const migrationDir = path.join(root, "database", "migrations");
const consoleDir = path.join(root, "database", "cloudbase-console");
const migrationName = "050_teacher_profile_repair_and_quota_ambiguity.sql";
const migration = read(path.join("database", "migrations", migrationName));
const staff = read("cloudfunctions/staffAccount/index.js");
const faceService = read("cloudfunctions/faceRecognition/index.js");
const teacherCreateService = read("cloudfunctions/teacherCreate/index.js");
const createUi = read("teacher-create.js");
const detailUi = read("staff-detail.js");
const managementUi = read("teacher-management.js");
const phoneAuth = read("cloudbase-phone-auth.js");

function sqlFunction(source, name) {
  const marker = `CREATE OR REPLACE FUNCTION public.${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `${name} must be present`);
  const end = source.indexOf("\n$$;", start);
  assert.ok(end > start, `${name} must have a complete dollar-quoted body`);
  return source.slice(start, end + 4);
}

function jsBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `${startMarker} must remain a distinct implementation region`);
  return source.slice(start, end);
}

function transactionBody(source) {
  const start = source.indexOf("BEGIN;");
  const end = source.lastIndexOf("\nCOMMIT;");
  assert.ok(start >= 0 && end > start, "console SQL must be a complete transaction");
  return source.slice(start + "BEGIN;".length, end).trim().replace(/\r\n/g, "\n");
}

assert.ok(fs.existsSync(path.join(migrationDir, migrationName)),
  "050 must remain a forward migration rather than editing already-executed 046–049");

// Each CloudBase paste must stay safely beneath the editor's actual Windows
// CRLF limit.  The readonly check is deliberately separate and mutation-free.
const expectedParts = [
  "050-01-prerequisites.sql",
  "050-02-sync-teacher-profile.sql",
  "050-03-sync-teacher-account-status.sql",
  "050-04-backfill-teacher-profiles.sql",
  "050-05-delete-active-quota.sql",
  "050-06-recharge-qualified.sql",
  "050-07-permissions-comments.sql"
];
assert.deepEqual(
  fs.readdirSync(consoleDir).filter((file) => /^050-\d\d-.+\.sql$/i.test(file)).sort(),
  expectedParts,
  "050 must ship the complete ordered CloudBase SQL-editor sequence"
);
for (const file of expectedParts) {
  const source = read(path.join("database", "cloudbase-console", file));
  assert.match(source, /BEGIN;[\s\S]*COMMIT;\s*$/, `${file} must be independently pasteable`);
  assert.ok(Buffer.byteLength(source.replace(/\n/g, "\r\n"), "utf8") <= 3500,
    `${file} must fit the 3.5KB CloudBase editor limit after CRLF conversion`);
  const delimiters = source.match(/\$[A-Za-z_][A-Za-z0-9_]*\$|\$\$/g) || [];
  const counts = new Map();
  for (const delimiter of delimiters) counts.set(delimiter, (counts.get(delimiter) || 0) + 1);
  for (const [delimiter, count] of counts) {
    assert.equal(count % 2, 0, `${file} must close every ${delimiter} body`);
  }
}
assert.equal(
  expectedParts
    .map((file) => transactionBody(read(path.join("database", "cloudbase-console", file))))
    .join("\n\n"),
  transactionBody(migration),
  "050 console parts must reconstruct the canonical migration exactly"
);
const readonly = read("database/cloudbase-console/050-readonly-verify.sql");
assert.match(readonly, /^\s*(?:--[^\n]*\n)*WITH\s+/i,
  "050 must provide a separately runnable readonly acceptance query");
assert.doesNotMatch(readonly, /^\s*(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|BEGIN|COMMIT)\b/im,
  "050 readonly acceptance must never change production data");
assert.match(readonly, /teacher accounts missing teacher master[\s\S]*teacher\/account status parity/,
  "050 verification must expose both profile repair and status-parity outcomes");

// Every teacher account must have a teacher master.  PENDING means no face is
// enrolled yet; it must not turn an otherwise ACTIVE account into ARCHIVED.
const profileSync = sqlFunction(migration, "sync_teacher_profile");
assert.match(profileSync, /IF NEW\.role_code <> 'teacher'/,
  "the profile trigger must only affect teacher accounts");
assert.match(profileSync, /desired_status := CASE WHEN NEW\.account_status = 'ACTIVE' THEN 'ACTIVE' ELSE 'ARCHIVED' END/,
  "teacher master status must follow the account, independent of face enrollment");
assert.match(profileSync, /face_enrollment_status\)\s*VALUES[\s\S]{0,220}'PENDING'/,
  "a repaired no-face teacher must retain the PENDING enrollment state");
assert.doesNotMatch(profileSync, /face_person_id|face_enrollment_status\s*=\s*'ENROLLED'/,
  "a teacher face must not become an activation prerequisite in the profile trigger");
assert.match(migration, /INSERT INTO public\.teachers[\s\S]{0,1000}FROM public\.staff_accounts AS account[\s\S]{0,260}account\.role_code = 'teacher'[\s\S]{0,360}ON CONFLICT \(staff_account_id\) DO UPDATE/i,
  "050 must backfill every legacy teacher account idempotently before users hit a broken detail page");
const accountSync = sqlFunction(migration, "sync_teacher_account_status");
assert.match(accountSync, /desired_status := CASE WHEN NEW\.teacher_status = 'ACTIVE' THEN 'ACTIVE' ELSE 'ARCHIVED' END/,
  "teacher archive/restore must mirror into the login account");
assert.doesNotMatch(accountSync, /face_enrollment_status|face_person_id/i,
  "teacher archive/restore must remain face-independent");

// 42702 was caused by RETURNS TABLE output variables shadowing quota columns.
// A qualified RHS is non-negotiable; config, top-up and direct retry must all
// be safe after this migration.
const recharge = sqlFunction(migration, "recharge_teacher_product_experience_quota");
assert.match(recharge, /RETURNS TABLE\([\s\S]*manual_recharge_count INTEGER/i,
  "the regression test must cover the output name that previously shadowed the column");
assert.match(recharge, /UPDATE public\.teacher_product_experience_quotas AS quota_target[\s\S]{0,500}available_count\s*=\s*quota_target\.available_count\s*\+\s*p_unit_count,[\s\S]{0,180}manual_recharge_count\s*=\s*quota_target\.manual_recharge_count\s*\+\s*p_unit_count/i,
  "recharge must qualify both mutable quota RHS columns and cannot raise SQLSTATE 42702");
assert.doesNotMatch(recharge, /manual_recharge_count\s*=\s*manual_recharge_count\s*\+/i,
  "recharge must never restore the ambiguous unqualified manual_recharge_count expression");
assert.match(recharge, /assert_active_teacher_experience_subjects\(p_teacher_id\s*,\s*p_product_id\)/,
  "new top-ups must reject archived teachers and products at the database boundary");
const rechargeConsole = read("database/cloudbase-console/050-06-recharge-qualified.sql");
assert.match(rechargeConsole, /UPDATE public\.teacher_product_experience_quotas AS quota_target[\s\S]{0,420}manual_recharge_count=quota_target\.manual_recharge_count\+p_unit_count/i,
  "the console recharge definition must carry the same output-column fix");

// Deleting a configuration is also a write.  UI read-only treatment alone is
// insufficient because a stale browser can call the cloud function directly.
const deleteQuota = sqlFunction(migration, "delete_teacher_product_experience_quota");
assert.match(deleteQuota, /assert_teacher_experience_quota_actor\(p_actor_account_id\)[\s\S]{0,260}assert_active_teacher_experience_subjects\(p_teacher_id, p_product_id\)/,
  "quota deletion must require both an HQ actor and active teacher/product masters");
assert.match(deleteQuota, /SET quota_status = 'ARCHIVED'/,
  "deleting configuration must preserve audit history as an archived entitlement");
assert.match(deleteQuota, /event_type[\s\S]{0,360}'REMOVED'/,
  "deleted configuration must retain its immutable removal event");

// The standard teacher home exposes account/quota actions and the independent
// direct face maintenance flow. Saving a face must not change account status.
for (const id of [
  "staffCredentialAction", "staffStatusAction",
  "saveTeacherExperienceConfig", "saveTeacherExperienceRecharge",
  "staffFaceAction", "teacherFaceUpdatePanel", "teacherFaceUpdateCamera"
]) {
  assert.ok(read("staff-detail.html").includes(`id=\"${id}\"`), `teacher detail must expose ${id}`);
}
assert.match(detailUi, /navigator\.mediaDevices\?\.getUserMedia/,
  "teacher detail must capture a real photograph for add/replacement");
assert.match(detailUi, /CloudBasePhoneAuth\.upsertTeacherFace\(\{[\s\S]{0,300}teacherId:[\s\S]{0,160}faceImageBase64:/,
  "teacher detail must submit face maintenance to the dedicated direct service");
assert.match(detailUi, /保存人脸不会改变老师账号状态|保存人脸不会恢复登录或改变封存状态/,
  "teacher face maintenance must remain independent from activation");
assert.match(detailUi, /已登记 · 用于体验核销/,
  "teacher detail must retain a read-only enrollment status for experience verification");
const quotaGuard = jsBetween(detailUi, "function canManageTeacherExperience", "function teacherId");
assert.match(quotaGuard, /isStaffArchived\(\)[\s\S]{0,260}不能配置、删除或充值/,
  "archived teachers must be explicitly read-only for configuration, deletion and top-up");
for (const method of [
  "upsertTeacherExperienceEntitlement",
  "deleteTeacherExperienceEntitlement",
  "rechargeTeacherExperienceEntitlement"
]) {
  assert.ok(detailUi.includes(`canManageTeacherExperience(\"${method}\"`),
    `${method} must retain the stale-page archive guard`);
}
assert.match(detailUi, /totalExperienceCount/,
  "teacher home must preserve the server-provided per-product experience totals");
assert.match(detailUi, /累计完成体验/,
  "teacher home must label the historical per-product experience total clearly");
assert.match(detailUi, /体验额度已保存并立即生效[\s\S]{0,220}当前可用次数现为 \$\{monthlyAllowance\}/,
  "configuration must state that it replaces the current quota immediately rather than adding to it");
assert.match(detailUi, /teacher_experience_recharge|teacherExperienceRecharge/,
  "independent teacher top-up must keep its own idempotency request lifecycle");

// New teachers must be face-bound.  This does not change legacy activation:
// old PENDING/no-photo teachers can still be restored, while the exceptional
// backend repair path remains out of the standard UI. No generic provisioning
// route may create a new teacher without a face.
const genericProvision = staff.slice(
  staff.indexOf('if (action === "provisionStaff")'),
  staff.indexOf('if (action === "createStoreWithAccount")', staff.indexOf('if (action === "provisionStaff")'))
);
assert.ok(genericProvision.length > 0, "generic staff provision dispatcher must remain separately auditable");
const teacherCreationReject = genericProvision.indexOf('if (role === "teacher") {\n      fail("新建老师必须使用独立 teacherCreate 服务。", "TEACHER_CREATE_SERVICE_REQUIRED")');
assert.ok(teacherCreationReject >= 0, "generic teacher provisioning must fail closed and redirect callers to teacherCreate");
for (const laterWrite of [
  "assertPhoneCanUseRole(phone, role)", "findAuthUserByExactPhone(phone)",
  "manager().user.createUser", "createStaffDatabaseProfile"
]) {
  const index = genericProvision.indexOf(laterWrite);
  assert.ok(index > teacherCreationReject,
    `TEACHER_CREATE_SERVICE_REQUIRED must be raised before ${laterWrite} can touch identity or PostgreSQL`);
}
assert.match(read("teacher-create.html"), /老师人脸（必填）/,
  "new-teacher page must label face enrollment as mandatory");
assert.doesNotMatch(read("teacher-create.html"), /老师人脸（可选）|不会阻止账号创建或激活|可后续补录/,
  "new-teacher copy must not promise a no-face create path");
assert.match(createUi, /Boolean\(capturedFaceImage\)[\s\S]{0,300}Boolean\(\$\("teacherFaceConsent"\)\.checked\)/,
  "submit enablement must require a captured face and consent before the one formal server validation");
assert.doesNotMatch(createUi, /window\.CloudBasePhoneAuth\.provisionTeacher\(\{ staffName: name, phone, initialPassword \}\)/,
  "new-teacher UI must never call the generic no-face provisioning API");
assert.match(createUi,
  /await window\.CloudBasePhoneAuth\.createTeacherWithFace\(\{[\s\S]{0,420}faceImageBase64: capturedFaceImage[\s\S]{0,220}consent: true/,
  "new-teacher UI must await one dedicated create request with the original photo");
assert.match(phoneAuth,
  /async createTeacherWithFace\(\{ staffName, phone, initialPassword, faceImageBase64, clientRequestId, consent = false \}\)[\s\S]{0,700}action: "createTeacher"/,
  "shared auth client must expose the dedicated one-call teacher creation API");
for (const legacy of ["beginTeacherProvisionWithFace", "getTeacherFaceOperationStatus", "readTeacherProvisionResult"]) {
  assert.equal(createUi.includes(legacy) || phoneAuth.includes(legacy), false,
    `active teacher create clients must not retain ${legacy}`);
}

// Creation and replacement are now owned wholly by teacherCreate. There is no
// compatibility call into staffAccount/faceRecognition and no durable Saga.
const createTeacher = jsBetween(teacherCreateService, "async function createTeacher", "function health");
const replaceTeacherFace = jsBetween(teacherCreateService, "async function upsertTeacherFace", "async function createTeacher");
assert.match(createTeacher, /const actor = await requireHq\(\)[\s\S]{0,300}event\.consent !== true/,
  "direct teacher creation must be HQ-only and require explicit consent");
assert.match(createTeacher, /await inspectFace\(api, image\.base64\)[\s\S]{0,120}await inspectLiveness\(api, image\.base64\)/,
  "the one direct creation call must perform the server-side quality and liveness checks");
assert.match(createTeacher, /confirmPerson\([\s\S]{0,260}confirmPhoto\([\s\S]{0,700}finalReadback\(/,
  "creation must read back remote Person, retained original and the database row before success");
assert.match(createTeacher, /manager\(\)\.user\.modifyUser\(\{ uid: authentication\.uid, userStatus: "ACTIVE"/,
  "the login may activate only inside the final direct creation boundary");
assert.match(replaceTeacherFace, /const actor = await requireHq\(\)[\s\S]{0,240}event\.consent !== true/,
  "face replacement must be HQ-only and require fresh consent");
assert.match(replaceTeacherFace, /await switchTeacherFace\([\s\S]{0,800}confirmPerson\([\s\S]{0,240}confirmPhoto\([\s\S]{0,220}readTeacherById\(/,
  "replacement must switch and then re-read the same Person, original photo and database pointers");
assert.match(replaceTeacherFace, /if \(switched\)[\s\S]{0,320}restoreTeacherFace\([\s\S]{0,1600}TEACHER_FACE_UPDATE_CLEANUP_INCOMPLETE/,
  "an unproven replacement must restore the prior pointers or return an explicit cleanup failure");
assert.doesNotMatch(`${staff}\n${faceService || ""}`, /teacher_face_operations|upsertDelegatedTeacherFace|delegateTeacherFace/,
  "retired staff/face services must not retain the Saga implementation");

// A mobile directory must not hide these same actions behind a fixed-height
// pane; responsive specifics live in the UI-agent contract, while this check
// keeps the business row wired to the action buttons.
const directoryStatusAction = jsBetween(managementUi, "async function toggleTeacherStatus", "document.addEventListener");
assert.match(directoryStatusAction, /window\.CloudBasePhoneAuth\.setMasterStatus\(\{ teacherId, status: next \}\)/,
  "directory archive/restore must prefer the teacher-master status route");
assert.match(directoryStatusAction, /window\.CloudBasePhoneAuth\.setStaffStatus\(\{[\s\S]{0,180}uid: String\(teacher\.auth_uid \|\| ""\), phone: teacherPhone\(teacher\), status: next/,
  "directory archive/restore must retain the legacy account route for historical rows");

console.log("teacher profile/quota repair contract: PASS");
