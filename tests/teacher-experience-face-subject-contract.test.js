"use strict";

// Regression contract for the post-048 teacher-face EXPERIENCE path.  It is
// deliberately source-level: these assertions exercise the authorization and
// transactional shape that CloudBase PostgreSQL cannot be run in locally.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const migration = read("database/migrations/049_teacher_experience_face_subject_and_quota_fixes.sql");
const staff = read("cloudfunctions/staffAccount/index.js");
const face = read("cloudfunctions/faceRecognition/index.js");
const balanceMigration = read("database/migrations/044_refund_application_workflow.sql");
const operationRetirement = read("database/migrations/047_retire_operation_accounts.sql");
const consoleDir = path.join(root, "database", "cloudbase-console");

function functionSource(source, name) {
  const marker = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = marker.exec(source);
  assert.ok(match, `function ${name} must exist`);
  const signatureEnd = source.indexOf(") {", match.index + match[0].length);
  assert.ok(signatureEnd >= 0, `function ${name} signature must be complete`);
  let depth = 0;
  for (let index = signatureEnd + 2; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, index + 1);
    }
  }
  throw new Error(`function ${name} body is incomplete`);
}

function sqlFunction(source, name) {
  const marker = `CREATE OR REPLACE FUNCTION public.${name}(`;
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `SQL function ${name} must exist`);
  const end = source.indexOf("\n$$;", start);
  assert.ok(end > start, `SQL function ${name} must end its dollar-quoted body`);
  return source.slice(start, end + 4);
}

function transactionBody(source) {
  const begin = source.indexOf("BEGIN;");
  const commit = source.lastIndexOf("\nCOMMIT;");
  assert.ok(begin >= 0 && commit > begin, "console part must be a complete transaction");
  return source.slice(begin + "BEGIN;".length, commit).trim().replace(/\r\n/g, "\n");
}

// Migration 049 is deployable one CloudBase paste at a time.  The console
// sequence is not merely documentation: it must reproduce the canonical
// migration exactly so the live database gets the same security boundary.
const consoleParts = fs.readdirSync(consoleDir)
  .filter((filename) => /^049-\d{2}-.+\.sql$/.test(filename) && !filename.includes("readonly-verify"))
  .sort();
assert.ok(consoleParts.length >= 2, "049 must ship as numbered CloudBase SQL-editor parts");
for (const filename of consoleParts) {
  const source = read(path.join("database", "cloudbase-console", filename));
  assert.ok(Buffer.byteLength(source, "utf8") < 9000, `${filename} must stay SQL-editor safe`);
  assert.match(source, /BEGIN;[\s\S]*COMMIT;\s*$/, `${filename} must be a standalone transaction`);
  assert.equal((source.match(/\$\$/g) || []).length % 2, 0, `${filename} must close every SQL function`);
}
assert.equal(
  consoleParts.map((filename) => transactionBody(read(path.join("database", "cloudbase-console", filename)))).join("\n\n"),
  transactionBody(migration),
  "049 console parts must reconstruct the canonical migration exactly"
);
const readonlyFilename = fs.existsSync(path.join(consoleDir, "049-readonly-verify.sql"))
  ? "049-readonly-verify.sql"
  : "049-14-readonly-verify.sql";
const readonlyVerification = read(path.join("database", "cloudbase-console", readonlyFilename));
assert.match(readonlyVerification, /^\s*(?:--[^\n]*\n)*SELECT\s+/i,
  "049 must include a separately runnable read-only acceptance query");
assert.doesNotMatch(readonlyVerification, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|BEGIN|COMMIT)\b/i,
  "049 acceptance query must not mutate production data");

// Fix both observed SQL-state regressions.  RETURNS TABLE output names are
// PL/pgSQL variables, so quota-table columns must always be qualified; the
// readiness CTE must also be in scope where its function definition is read.
const quotaUpsert = sqlFunction(migration, "upsert_teacher_product_experience_quota");
const quotaDelete = sqlFunction(migration, "delete_teacher_product_experience_quota");
for (const [name, source] of [["upsert", quotaUpsert], ["delete", quotaDelete]]) {
  assert.match(source, /FROM public\.teacher_product_experience_quotas AS quota[\s\S]{0,180}WHERE quota\.teacher_id = p_teacher_id[\s\S]{0,100}quota\.product_id = p_product_id/i,
    `${name} must qualify teacher/product fields and avoid SQLSTATE 42702`);
  assert.doesNotMatch(source, /WHERE\s+teacher_id\s*=\s*p_teacher_id/i,
    `${name} must not use the ambiguous unqualified teacher_id output variable`);
}
assert.match(quotaUpsert, /ON CONFLICT ON CONSTRAINT uq_teacher_product_experience_quota DO NOTHING/i,
  "quota upsert must use the named unique constraint rather than another ambiguous output-column conflict target");

const quotaSchema = functionSource(staff, "requireTeacherExperienceQuotaSchema");
const readinessDefinitionInScope = /WITH function_definitions AS \([\s\S]*?AS recharge_definition[\s\S]*?\)[\s\S]*?SELECT[\s\S]*?(?:FROM|CROSS JOIN) function_definitions/i.test(quotaSchema)
  || /COALESCE\(\s*PG_GET_FUNCTIONDEF\(TO_REGPROCEDURE\([\s\S]*?\)\),\s*''\s*\)\s*~\*/i.test(quotaSchema);
assert.ok(readinessDefinitionInScope,
  "quota readiness SQL must keep its function definition in scope and avoid SQLSTATE 42703");
assert.doesNotMatch(quotaSchema, /recharge_definition\s*~\*/i,
  "quota readiness SQL must not reference the old unjoined recharge_definition alias");
for (const [name, expected] of [
  ["getHqTeacherExperienceEntitlements", "FROM public.teacher_product_experience_quotas"],
  ["upsertTeacherExperienceEntitlement", "public.upsert_teacher_product_experience_quota("],
  ["rechargeTeacherExperienceEntitlement", "public.recharge_teacher_product_experience_quota("]
]) {
  const source = functionSource(staff, name);
  assert.match(source, /await requireTeacherExperienceQuotaSchema\(\);/,
    `${name} must use the valid schema guard before its database path`);
  assert.ok(source.includes(expected), `${name} must retain its read/configure/recharge database operation`);
}

// Identity comes from CloudBase auth UID, never from an event-provided staff,
// store, or teacher identity.  Store users are pinned to their store; teacher
// users are pinned to themselves; HQ is intentionally allowed to select a
// live store/teacher for centralized management.
const activeBusiness = functionSource(face, "activeBusinessCaller");
assert.match(activeBusiness, /WHERE a\.auth_uid = \$\{sqlText\(uid\)\}/,
  "business caller must resolve the actor from the authenticated UID");
assert.match(activeBusiness, /requestedStore && requestedStore !== String\(store\.storeId\)[\s\S]{0,180}FORBIDDEN/,
  "a store account must not submit work for another store");
assert.match(activeBusiness, /if \(account\.role_code === "teacher"\)[\s\S]{0,280}account\.teacher_id/,
  "a teacher caller must have a server-resolved teacher profile");
assert.match(activeBusiness, /teacherId: account\.role_code === "teacher" \? String\(account\.teacher_id\)/,
  "a teacher caller must get its canonical teacher ID from the server profile");

const rechargeCreate = functionSource(face, "createRechargeApplication");
const verificationCreate = functionSource(face, "createVerificationApplication");
for (const [name, source, mismatch] of [
  ["recharge/refund", rechargeCreate, "老师账号只能把"],
  ["verification", verificationCreate, "老师账号只能把核销绑定到本人"]
]) {
  assert.match(source, /caller\.role === "teacher"[\s\S]{0,260}FORBIDDEN/,
    `${name} must reject a teacherId supplied for a different teacher`);
  assert.ok(source.includes(mismatch), `${name} must return an actionable identity-mismatch message`);
}
assert.match(rechargeCreate, /SELECT \$\{sqlText\(applicationType\)\}, \$\{caller\.storeId\}[\s\S]{0,420}\$\{caller\.staffId\}/,
  "recharge/refund record store and submitter must come from the caller");
assert.match(verificationCreate, /\$\{caller\.storeId\}::bigint,[\s\S]{0,420}\$\{caller\.staffId\}::bigint/,
  "verification record store and submitter must come from the caller");
assert.match(verificationCreate, /if \(experienceVerification\) \{[\s\S]{0,180}requireTeacherExperienceQuotaLifecycleSchema\(\);[\s\S]{0,180}requireTeacherExperienceFaceSubjectSchema\(\);/,
  "only EXPERIENCE must require the teacher-face subject schema");
assert.match(verificationCreate, /if \(experienceVerification && \([\s\S]{0,420}TEACHER_FACE_REQUIRED_FOR_EXPERIENCE/,
  "the API must reject a selected teacher missing enrolled face, PersonId, or retained profile before EXPERIENCE creation");
assert.match(verificationCreate, /const createSql = experienceVerification[\s\S]{0,900}create_experience_verification_with_teacher_face_photo[\s\S]{0,900}: `SELECT \* FROM public\.create_verification_with_face_photo\(/,
  "EXPERIENCE must use the new teacher-face atomic function while NORMAL keeps the original customer-face function");

// NORMAL remains customer-face verification.  Its customer PersonId and its
// two evidence photos must be server-derived and cannot be supplied/replayed
// by the browser.  This is deliberately separate from the new EXPERIENCE
// teacher-face subject below.
const customerFace = functionSource(face, "verifyCustomerFace");
assert.match(customerFace, /SELECT id, customer_code, customer_name, face_person_id, profile_photo_file_id[\s\S]{0,380}created_store_id = \$\{caller\.storeId\}/,
  "normal customer face verification must resolve the customer inside the caller store");
assert.match(customerFace, /PersonId: String\(customer\.face_person_id\)/,
  "normal verification must never trust a browser-provided customer PersonId");
assert.match(customerFace, /INSERT INTO public\.verification_photo_drafts[\s\S]{0,500}\(evidence_token, store_id, customer_id, submitted_by_account_id,[\s\S]{0,700}\$\{caller\.staffId\}/,
  "normal live-face evidence must be bound to token, store, customer, and submitting account");

const teacherExperienceFace = functionSource(face, "verifyTeacherExperienceFace");
assert.match(teacherExperienceFace, /caller\.role === "teacher"[\s\S]{0,260}老师账号只能使用本人人脸办理体验核销[\s\S]{0,160}FORBIDDEN/,
  "a teacher account must not capture another teacher's EXPERIENCE face evidence");
assert.match(teacherExperienceFace, /SELECT t\.id, t\.teacher_code, t\.teacher_name, t\.face_person_id,[\s\S]{0,500}t\.teacher_status = 'ACTIVE'[\s\S]{0,260}a\.account_status = 'ACTIVE'/,
  "EXPERIENCE face verification must server-resolve an active selected teacher");
assert.match(teacherExperienceFace, /teacher\.face_enrollment_status !== "ENROLLED"[\s\S]{0,360}TEACHER_FACE_REQUIRED_FOR_EXPERIENCE/,
  "an active no-face teacher may log in but cannot create EXPERIENCE face evidence");
assert.match(teacherExperienceFace, /PersonId: String\(teacher\.face_person_id\)/,
  "EXPERIENCE must never trust a browser-provided teacher PersonId");
assert.match(teacherExperienceFace, /INSERT INTO public\.verification_photo_drafts[\s\S]{0,650}face_subject_type, face_subject_teacher_id[\s\S]{0,900}'TEACHER', \$\{sqlText\(teacherId\)\}::bigint/,
  "teacher live-face evidence must be scoped to the selected teacher as well as store/customer/submitter/request");
assert.match(face, /if \(action === "verifyTeacherExperienceFace"\) return await verifyTeacherExperienceFace\(event\);/,
  "teacher-face capture must be exposed through an explicit server action, not a client-side face-ID swap");

const normalAtomic = sqlFunction(read("database/migrations/046_teacher_face_and_experience_quotas.sql"), "create_verification_with_face_photo");
assert.match(normalAtomic, /photo_slot, photo_kind[\s\S]{0,900}\(created_record\.id, 0, 'PROFILE'[\s\S]{0,500}\(created_record\.id, 1, 'FACE'/,
  "the legacy normal atomic path must retain customer PROFILE + live FACE evidence");
assert.match(normalAtomic, /normalized_type = 'EXPERIENCE'[\s\S]{0,1500}teacher_experience_quota_usages/i,
  "legacy compatibility keeps existing EXPERIENCE quota audit rows readable");

// New EXPERIENCE rows remain customer-linked business records, but their two
// photos are the selected teacher's retained profile and live teacher capture.
// Both paths are atomically locked and the quota debit has its own immutable
// usage link; EXPERIENCE must not debit customer purchased units.
const teacherSubjectLock = sqlFunction(migration, "lock_active_teacher_experience_subjects");
assert.match(migration, /ALTER TABLE public\.teachers\s+ADD COLUMN IF NOT EXISTS profile_photo_file_id/i,
  "teacher face enrollment must retain a private profile-photo reference for later EXPERIENCE snapshots");
const staffProfile = functionSource(staff, "findStaffProfile");
const staffStatusAction = staff.slice(staff.indexOf('if (action === "setStaffStatus")'), staff.indexOf('fail("不支持的操作")'));
assert.doesNotMatch(staffProfile, /face_enrollment_status === "ENROLLED"|TEACHER_FACE_REQUIRED/i,
  "a teacher without a face must still be able to have an active login profile");
assert.match(staffStatusAction, /if \(staff\.role_code === "teacher"\)[\s\S]{0,360}requireTeacherOptionalFaceActivationSchema\(\);/,
  "activating a teacher must retain the no-face activation policy");
assert.doesNotMatch(staffStatusAction, /TEACHER_FACE_REQUIRED/i,
  "staff activation must not accidentally reuse the EXPERIENCE-only face gate");
const teacherFaceUpsert = functionSource(staff, "upsertTeacherFace");
const delegatedTeacherFaceUpsert = functionSource(face, "upsertDelegatedTeacherFace");
assert.match(teacherFaceUpsert, /delegateTeacherFace\(\{[\s\S]{0,260}operation:\s*"UPSERT"/,
  "later teacher face enrollment/replacement must use the signed face service");
assert.match(delegatedTeacherFaceUpsert, /uploadTeacherProfilePhoto\([\s\S]{0,1400}profile_photo_file_id = \$\{sqlText\(storedPhoto\.reference\)\}/,
  "the delegated replacement must persist a retained private profile photo");
assert.match(teacherSubjectLock, /teacher\.face_enrollment_status = 'ENROLLED'[\s\S]{0,220}teacher\.face_person_id/i,
  "EXPERIENCE requires an enrolled selected teacher face without changing account activation");
assert.match(teacherSubjectLock, /TEACHER_FACE_REQUIRED_FOR_EXPERIENCE/,
  "missing teacher face must have a stable, actionable server error");
const experienceAtomic = sqlFunction(migration, "create_experience_verification_with_teacher_face_photo");
const experienceInsert = sqlFunction(migration, "insert_teacher_experience_verification");
assert.match(experienceAtomic, /PERFORM pg_advisory_xact_lock\(hashtext\(p_idempotency_key\)\)[\s\S]{0,280}find_teacher_experience_verification_replay\(/,
  "EXPERIENCE public entry point must serialize its idempotent replay lookup");
assert.match(experienceAtomic, /created_record := public\.insert_teacher_experience_verification\(/,
  "EXPERIENCE public entry point must use its same-transaction insert helper after a non-replay lookup");
assert.match(experienceInsert, /VALUES \('EXPERIENCE', p_store_id, p_teacher_id, p_customer_id, p_product_id, 1,[\s\S]{0,480}'TEACHER', p_teacher_id\)/,
  "EXPERIENCE must keep customer_id as the business subject while recording teacher as face subject");
assert.match(experienceInsert, /lock_active_teacher_experience_subjects\([\s\S]{0,1500}consume_teacher_experience_quota\([\s\S]{0,500}bind_teacher_experience_face_photos\(/,
  "EXPERIENCE must lock teacher face subject, debit quota, and bind evidence in one atomic function");
assert.doesNotMatch(`${experienceAtomic}\n${experienceInsert}`, /customer_product_balances/i,
  "EXPERIENCE must never deduct customer purchased-unit balances");
const teacherPhotoBinding = sqlFunction(migration, "bind_teacher_experience_face_photos");
assert.match(teacherPhotoBinding, /face_subject_type = 'TEACHER'[\s\S]{0,260}face_subject_teacher_id = p_teacher_id/,
  "teacher live-face draft must be scoped to the selected teacher");
assert.match(teacherPhotoBinding, /0, 'PROFILE'[\s\S]{0,420}'TEACHER', p_teacher_id[\s\S]{0,420}1, 'FACE'/,
  "EXPERIENCE photo slots must be teacher retained PROFILE then teacher live FACE");
assert.match(migration, /EXPERIENCE verification requires its teacher as the face subject/,
  "a trigger must reject direct legacy customer-face EXPERIENCE inserts");
assert.match(migration, /non-EXPERIENCE verification requires its customer as the face subject/,
  "the new guard must preserve customer face evidence for NORMAL rows");

// Historical compatibility: existing NORMAL/SUPPLEMENT balances still count
// as paid consumption, EXPERIENCE stays outside that customer ledger, legacy
// VOID stays visible, and only active HQ accounts may review approvals.
const balanceRefresh = sqlFunction(balanceMigration, "refresh_customer_balance");
assert.match(balanceRefresh, /verification_type IN \('NORMAL', 'SUPPLEMENT'\)/,
  "customer balance refresh must keep historical SUPPLEMENT while excluding EXPERIENCE");
assert.doesNotMatch(balanceRefresh, /verification_totals AS \([\s\S]{0,600}EXPERIENCE/i,
  "the customer balance-ledger consumption CTE must not start charging EXPERIENCE to customers");
assert.match(balanceMigration, /recharge_type IN \('NEW', 'VOID', 'REFUND'\)/,
  "legacy VOID recharge rows must remain schema-compatible historical data");
assert.match(operationRetirement, /reviewer_role IS DISTINCT FROM 'hq'/,
  "only active HQ accounts may review recharge/refund/verification records");

console.log("teacher experience face-subject contract: PASS");
