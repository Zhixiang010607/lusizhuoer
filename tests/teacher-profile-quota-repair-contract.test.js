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

// The HQ UI exposes all necessary actions, but with different gates: face
// maintenance is allowed while archived; business quota writes are not.
for (const id of [
  "staffFaceAction", "staffCredentialAction", "staffStatusAction",
  "openTeacherFaceUpdateCamera", "captureTeacherFaceUpdate", "saveTeacherFaceUpdate",
  "saveTeacherExperienceConfig", "saveTeacherExperienceRecharge"
]) {
  assert.ok(read("staff-detail.html").includes(`id=\"${id}\"`), `teacher detail must expose ${id}`);
}
const faceControls = jsBetween(detailUi, "function syncTeacherFaceUpdateControls", "function clearTeacherFaceUpdate");
assert.doesNotMatch(faceControls, /isStaffArchived\(\)/,
  "archiving must not prevent HQ from adding/replacing an optional teacher face");
assert.match(detailUi, /faceAction\.disabled = !teacherId\(\)/,
  "face action must only depend on a usable teacher master identity");
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
// old PENDING/no-photo teachers can still be restored and then supplement a
// face in the detail page, but no generic provisioning route may create one.
const genericProvision = staff.slice(
  staff.indexOf('if (action === "provisionStaff")'),
  staff.indexOf('if (action === "createStoreWithAccount")', staff.indexOf('if (action === "provisionStaff")'))
);
assert.ok(genericProvision.length > 0, "generic staff provision dispatcher must remain separately auditable");
const teacherCreationReject = genericProvision.indexOf('if (role === "teacher") {\n      fail("新建老师必须先拍摄并通过人脸检测。", "TEACHER_FACE_REQUIRED")');
assert.ok(teacherCreationReject >= 0, "generic teacher provisioning must fail closed with a stable mandatory-face code");
for (const laterWrite of [
  "assertPhoneCanUseRole(phone, role)", "findAuthUserByExactPhone(phone)",
  "manager().user.createUser", "createStaffDatabaseProfile"
]) {
  const index = genericProvision.indexOf(laterWrite);
  assert.ok(index > teacherCreationReject,
    `TEACHER_FACE_REQUIRED must be raised before ${laterWrite} can touch identity or PostgreSQL`);
}
assert.match(read("teacher-create.html"), /老师人脸（必填）/,
  "new-teacher page must label face enrollment as mandatory");
assert.doesNotMatch(read("teacher-create.html"), /老师人脸（可选）|不会阻止账号创建或激活|可后续补录/,
  "new-teacher copy must not promise a no-face create path");
assert.match(createUi, /Boolean\(capturedFaceImage\)[\s\S]{0,300}Boolean\(\$\("teacherFaceConsent"\)\.checked\)[\s\S]{0,160}faceValidated/,
  "submit enablement must require a captured face, consent and completed quality/liveness validation");
assert.doesNotMatch(createUi, /window\.CloudBasePhoneAuth\.provisionTeacher\(\{ staffName: name, phone, initialPassword \}\)/,
  "new-teacher UI must never call the generic no-face provisioning API");
assert.match(createUi, /await window\.CloudBasePhoneAuth\.provisionTeacherWithFace\(\{[\s\S]{0,400}consent: true/,
  "new-teacher UI must use the atomic face-bound provisioning API only");
assert.match(phoneAuth, /async provisionTeacherWithFace\(\{ staffName, phone, initialPassword, faceImageBase64, clientRequestId, consent = false \}\)/,
  "shared auth client must retain the dedicated face-bound teacher provisioning API");

// Creation/replacement never claims success until profile-photo persistence is
// confirmed.  The two Cloud Functions have deliberately separated duties:
// staffAccount owns the login/master activation and signs an internal command;
// faceRecognition owns Tencent IAI, private-photo storage and the atomic
// face-pointer switch.  Keep both halves under test so a future refactor does
// not accidentally turn this back into a browser-callable or half-completed
// workflow.
const delegatedFace = jsBetween(staff, "async function delegateTeacherFace", "function productTemplateStorageSettings");
assert.match(delegatedFace, /crypto\.createHmac\("sha256", teacherFaceDelegationSigningKey\(\)\)[\s\S]{0,260}teacherFaceDelegationCanonical\(fields\)/,
  "staffAccount must sign the complete teacher-face delegation command rather than trusting browser ids");
assert.match(delegatedFace, /imageDigest[\s\S]{0,900}imageBytes/,
  "the signed command must bind its exact JPEG digest and byte length");
assert.match(delegatedFace, /operationId[\s\S]{0,160}ownerToken[\s\S]{0,160}leaseGeneration/,
  "the signed command must bind its durable operation lease");
assert.match(delegatedFace, /name: "faceRecognition"[\s\S]{0,520}upsertDelegatedTeacherFace[\s\S]{0,220}readbackDelegatedTeacherFace[\s\S]{0,220}rollbackDelegatedTeacherFace[\s\S]{0,220}finalizeDelegatedTeacherFace/,
  "teacher enrollment must use the private cross-function face endpoint");
assert.match(delegatedFace, /!result\.teacher\?\.facePhotoReady \|\| result\.teacher\?\.faceEnrollmentStatus !== "ENROLLED"/,
  "staffAccount must reject a delegated response that did not retain the teacher photo");

const faceProvision = jsBetween(staff, "async function provisionTeacherWithFace", "// Face enrollment is deliberately independent");
const faceActivationReadback = jsBetween(staff, "async function activatePersistedTeacherFaceProfile", "async function provisionTeacherWithFace");
assert.match(faceProvision, /userStatus: "BLOCKED"/,
  "face provisioning must create the credential unavailable until enrollment is complete");
assert.match(faceProvision, /initialAccountStatus: "ARCHIVED"/,
  "face provisioning must create the teacher master unavailable until enrollment is complete");
assert.match(faceProvision, /delegationInput = \{[\s\S]{0,260}operation: "PROVISION"[\s\S]{0,520}personId: facePersonId[\s\S]{0,320}image[\s\S]{0,220}delegateTeacherFaceWithReadbackRetry\(delegationInput\)/,
  "face provisioning must delegate the exact new face, teacher, actor and image rather than trusting client data");
assert.match(faceProvision, /activatePersistedTeacherFaceProfile\(\{[\s\S]{0,220}personId: facePersonId/,
  "face provisioning must use the durable activation/readback boundary");
assert.match(faceActivationReadback, /face_person_id = \$\{sqlText\(personId\)\}[\s\S]{0,300}face_enrollment_status = 'ENROLLED'[\s\S]{0,220}profile_photo_file_id/,
  "face provisioning may activate only after the delegated service persisted the exact face identity and private photo");
assert.match(faceActivationReadback, /await executeSql\([\s\S]{0,900}const rows = await executeSql\(/,
  "teacher activation must read the durable row after a writable statement instead of trusting RETURNING rows");
assert.match(faceProvision, /authoritativeTeacherProvisioningState\(\{[\s\S]{0,320}photoReference: remoteProof\.photoReference/,
  "a teacher must pass final database and authentication readback before creation succeeds");
assert.match(faceProvision, /if \(!existing\)[\s\S]{0,1400}compensateFailedTeacherProvision\(\{/,
  "a failed new teacher must enter the all-or-none compensation saga");
assert.match(faceProvision, /readbackConfirmed: true[\s\S]{0,160}verification: finalVerification/,
  "the success response must explicitly expose the completed authoritative readback");
assert.match(faceProvision, /facePhotoReady = Boolean\([\s\S]{0,320}face_person_id[\s\S]{0,220}profile_photo_file_id/,
  "the new-teacher success response must derive photo readiness from exact database pointers");
assert.match(faceProvision, /manager\(\)\.user\.modifyUser\(\{ uid, userStatus: "ACTIVE"/,
  "face provisioning may only activate the login after the enrolled profile is persisted");

const faceReplace = jsBetween(staff, "async function upsertTeacherFace", "async function requireTeacherExperienceQuotaSchema");
assert.match(faceReplace, /delegationInput = \{[\s\S]{0,220}operation: "UPSERT"[\s\S]{0,480}personId: nextPersonId/,
  "face replacement must bind a deterministic next PersonId into the signed service command");
assert.match(faceReplace, /await bindTeacherFaceOperation\(faceOperation,[\s\S]{0,1200}await delegateTeacherFaceWithReadbackRetry\(delegationInput\)/,
  "face replacement must bind its durable operation before invoking the signed service transaction");
assert.doesNotMatch(faceReplace, /persistedRows|响应丢失后已自动恢复|face_person_id = \$\{sqlText\(nextPersonId\)\}/,
  "a lost replacement response must never be declared successful from a local DB-only probe");
assert.match(faceReplace, /老师人脸资料未能保存，原人脸保持不变/,
  "an unproven replacement must retain the previous teacher face");
assert.doesNotMatch(faceReplace, /api\.CreatePerson|uploadTeacherProfilePhoto|deleteTeacherFacePerson/,
  "staffAccount must not split the delegated face transaction across two services");

const verifyDelegation = jsBetween(faceService, "function verifyTeacherFaceDelegation", "function cleanVerificationJpeg");
assert.match(verifyDelegation, /issuedAt < now - TEACHER_FACE_DELEGATION_MAX_AGE_MS/,
  "the face endpoint must reject expired v3 saga commands");
assert.match(verifyDelegation, /\["PROVISION", "UPSERT", "READBACK", "ROLLBACK", "FINALIZE"\]\.includes\(operation\)/,
  "the face endpoint must accept only the five signed v3 saga operations");
assert.match(verifyDelegation, /imageDigest[\s\S]{0,180}imageBytes[\s\S]{0,1800}crypto\.createHmac\("sha256", teacherFaceDelegationSigningKey\(\)\)[\s\S]{0,250}crypto\.timingSafeEqual/,
  "the face endpoint must recompute a payload-bound HMAC in constant time before writing a face");
assert.match(verifyDelegation, /mutating[\s\S]{0,220}老师人脸写入委托必须携带 JPEG 原图/,
  "PROVISION/UPSERT must require the original JPEG while readback/cleanup may reconcile from signed digest and length");
assert.match(verifyDelegation, /if \(suppliedImage\) \{[\s\S]{0,180}cleanVerificationJpeg\(suppliedImage, "老师人脸照片", MAX_IMAGE_BYTES\)/,
  "any supplied teacher image must be decoded and revalidated as JPEG bytes");
assert.match(verifyDelegation, /faceGroupId !== required\("FACE_GROUP_ID"\)/,
  "mutating delegations must be bound to the configured face group before creating remote state");
assert.match(verifyDelegation, /photoBucketId !== photoStorageSettings\(\)\.bucketId/,
  "mutating delegations must be bound to the configured private photo bucket before uploading state");

const delegatedUpsert = jsBetween(faceService, "async function upsertDelegatedTeacherFace", "async function readbackDelegatedTeacherFace");
assert.match(delegatedUpsert, /current\.actor_role !== "hq" \|\| current\.actor_status !== "ACTIVE"/,
  "the delegated endpoint must pin the signer actor to an active HQ account in PostgreSQL");
assert.match(delegatedUpsert, /teacher\.id = \$\{command\.teacherId\}[\s\S]{0,180}teacher\.staff_account_id = \$\{command\.staffId\}/,
  "the delegated endpoint must bind the signed teacher and staff ids to the current database row");
const createIndex = delegatedUpsert.indexOf("api.CreatePerson(");
const bindFaceIndex = delegatedUpsert.indexOf("bindTeacherFaceOperationFaceId(", createIndex);
const uploadIndex = delegatedUpsert.indexOf("uploadTeacherProfilePhoto(");
const persistIndex = delegatedUpsert.indexOf("UPDATE public.teachers AS teacher", uploadIndex);
assert.ok(createIndex >= 0 && bindFaceIndex > createIndex
  && uploadIndex > bindFaceIndex && persistIndex > uploadIndex,
  "the face service must create, bind FaceId, upload and atomically switch the new identity in order");
assert.doesNotMatch(delegatedUpsert, /deleteTeacherFacePerson(?:Exact)?\(api, groupId, previousPersonId/,
  "UPSERT must retain the old Person until a later signed FINALIZE after caller confirmation");
assert.match(delegatedUpsert, /face_person_id IS NOT DISTINCT FROM[\s\S]{0,260}profile_photo_file_id IS NOT DISTINCT FROM/,
  "the face pointer switch must be optimistic, so a concurrent replacement cannot overwrite another face");
const pointerFenceIndex = delegatedUpsert.indexOf("AND ${runningLeaseSql}", persistIndex);
const finalPhotoReadIndex = delegatedUpsert.indexOf("confirmTeacherProfilePhoto(", persistIndex);
const finalLeaseReadIndex = delegatedUpsert.indexOf("await assertRunningLease();", finalPhotoReadIndex);
assert.ok(pointerFenceIndex > persistIndex && finalPhotoReadIndex > pointerFenceIndex
  && finalLeaseReadIndex > finalPhotoReadIndex,
"the pointer UPDATE and final authenticated photo read must remain fenced by the durable RUNNING owner");
assert.match(delegatedUpsert, /deleteTeacherProfilePhotoExact\([\s\S]{0,160}storedPhoto, assertCleanupLease, command\.operationId[\s\S]{0,1000}deleteTeacherFacePersonExact\([\s\S]{0,180}api, groupId, command\.personId, assertCleanupLease, command\.operationId/,
  "a failed transaction may clean only its own lease-authorized candidate resources");

// A mobile directory must not hide these same actions behind a fixed-height
// pane; responsive specifics live in the UI-agent contract, while this check
// keeps the business row wired to the action buttons.
const directoryStatusAction = jsBetween(managementUi, "async function toggleTeacherStatus", "document.addEventListener");
assert.match(directoryStatusAction, /window\.CloudBasePhoneAuth\.setMasterStatus\(\{ teacherId, status: next \}\)/,
  "directory archive/restore must prefer the teacher-master status route");
assert.match(directoryStatusAction, /window\.CloudBasePhoneAuth\.setStaffStatus\(\{[\s\S]{0,180}uid: String\(teacher\.auth_uid \|\| ""\), phone: teacherPhone\(teacher\), status: next/,
  "directory archive/restore must retain the legacy account route for historical rows");

console.log("teacher profile/quota repair contract: PASS");
