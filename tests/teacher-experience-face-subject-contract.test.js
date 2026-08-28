"use strict";

// Migration 054 contract: EXPERIENCE is gifted by the logged-in teacher,
// consumes that teacher's quota, and verifies/stores the selected customer.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const face = read("cloudfunctions/faceRecognition/index.js");
const business = read("store-business.js");
const auth = read("auth-ui.js");
const experiencePage = read("verification-experience.html");
const detail = read("business-detail.js");
const migration = read("database/migrations/054_teacher_only_customer_face_experience.sql");
const consoleMigration = read("database/cloudbase-console/054-01-teacher-only-customer-face-experience.sql");
const balanceMigration = read("database/migrations/044_refund_application_workflow.sql");

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
  assert.ok(begin >= 0 && commit > begin, "migration must be a complete transaction");
  return source.slice(begin + "BEGIN;".length, commit).trim().replace(/\r\n/g, "\n");
}

const accessBlock = auth.slice(auth.indexOf("const access ="), auth.indexOf("let session ="));
const teacherAccess = /teacher:\s*new Set\(\[([^\]]+)\]/.exec(accessBlock)?.[1] || "";
const storeAccess = /store:\s*new Set\(\[([^\]]+)\]/.exec(accessBlock)?.[1] || "";
const hqAccess = /hq:\s*new Set\(\[([^\]]+)\]/.exec(accessBlock)?.[1] || "";
assert.match(teacherAccess, /verification-experience\.html/, "teacher access retains EXPERIENCE");
assert.doesNotMatch(storeAccess, /verification-experience\.html/, "store access removes EXPERIENCE");
assert.doesNotMatch(hqAccess, /verification-experience\.html/, "HQ access removes EXPERIENCE");
assert.match(business, /page === "verification-experience" && session\?\.role !== "teacher"\) return/,
  "stale non-teacher EXPERIENCE pages stop before loading business data");

assert.match(experiencePage, /赠送老师（当前账号）/, "teacher giver is account-bound");
assert.match(experiencePage, /客户本人 1:1 人脸验证/, "selected customer is the face subject");
assert.match(experiencePage, /客户建档照和客户本次现场照/, "receipt copy promises customer photos");
assert.doesNotMatch(experiencePage, /老师本人 1:1|验证老师|老师现场体验核销人脸/,
  "EXPERIENCE exposes no teacher-face capture copy");
const setupVerification = functionSource(business, "setupVerification");
assert.match(setupVerification, /action: "verifyCustomerFace"/,
  "normal and EXPERIENCE use the same customer 1:1 action");
assert.doesNotMatch(setupVerification, /verifyTeacherExperienceFace|teacherFaceUnavailable/,
  "EXPERIENCE does not inspect or capture the teacher face");
assert.match(setupVerification, /faceSubjectType: "CUSTOMER"[\s\S]{0,100}faceSubjectTeacherId: ""/,
  "new EXPERIENCE handoff state is customer evidence");

const entitlements = functionSource(face, "getTeacherExperienceEntitlements");
assert.match(entitlements, /caller\.role !== "teacher"[\s\S]{0,160}FORBIDDEN/,
  "store and HQ cannot read the EXPERIENCE creation entitlement path");
assert.match(entitlements, /positiveDatabaseId\(caller\.teacherId, "老师"\)/,
  "entitlements use the authenticated teacher ID");
const qualification = functionSource(face, "createVerificationBleQualification");
const finalizer = functionSource(face, "finalizeVerificationApplicationInternal");
assert.match(qualification, /experienceVerification && caller\.role !== "teacher"[\s\S]{0,180}FORBIDDEN/,
  "store and HQ are rejected server-side for EXPERIENCE creation");
assert.match(qualification, /caller\.role === "teacher"[\s\S]{0,220}positiveDatabaseId\(caller\.teacherId, "老师"\)/,
  "teacher identity comes from the authenticated account");
assert.match(finalizer, /create_experience_verification_with_customer_face_photo/,
  "EXPERIENCE calls the customer-photo atomic entry point");
assert.doesNotMatch(`${qualification}\n${finalizer}`, /TEACHER_FACE_REQUIRED_FOR_EXPERIENCE|face_enrollment_status|face_person_id/,
  "teacher face does not gate EXPERIENCE creation");

const customerFace = functionSource(face, "verifyCustomerFace");
const evidence = functionSource(face, "persistVerifiedFaceEvidence");
assert.match(customerFace, /PersonId: String\(customer\.face_person_id\)/,
  "customer validation uses the selected customer's server-side PersonId");
assert.match(evidence, /'CUSTOMER', NULL, \$\{sqlText\(faceRequestId\)\}/,
  "all new verification drafts are customer-scoped");
assert.doesNotMatch(face, /function\s+verifyTeacherExperienceFace|action === "verifyTeacherExperienceFace"/,
  "retired teacher-face EXPERIENCE action is not callable");
assert.doesNotMatch(face, /\bSearchPersons\s*\(|function\s+searchCustomer\s*\(/,
  "face matching remains selected-person 1:1, never 1:N");

assert.ok(Buffer.byteLength(consoleMigration, "utf8") < 9000,
  "054 CloudBase SQL stays below the editor-safe size");
assert.equal(transactionBody(consoleMigration), transactionBody(migration),
  "054 console SQL exactly mirrors the canonical migration");
const authority = sqlFunction(migration, "create_experience_verification_with_customer_face_photo");
assert.match(authority, /account\.role_code = 'teacher'[\s\S]{0,220}teacher\.id = p_teacher_id/,
  "database binds the submitter account to the consumed teacher quota");
assert.match(authority, /quota\.quota_status = 'ACTIVE'[\s\S]{0,80}FOR UPDATE/,
  "database locks an active teacher/product quota before consumption");
assert.match(authority, /draft\.face_subject_type = 'CUSTOMER'[\s\S]{0,120}draft\.face_subject_teacher_id IS NULL/,
  "database accepts only selected-customer face evidence");
assert.match(authority, /create_verification_with_face_photo\([\s\S]{0,100}'EXPERIENCE'::VARCHAR/,
  "database reuses the proven customer profile/live-photo atomic writer");
assert.match(migration, /DROP FUNCTION IF EXISTS public\.create_experience_verification_with_teacher_face_photo/,
  "migration retires the old teacher-photo write entry point");
const complete = sqlFunction(migration, "assert_experience_verification_complete");
assert.match(complete, /teacher_experience_quota_usages[\s\S]{0,900}photo_slot = 0[\s\S]{0,280}face_subject_type = 'CUSTOMER'[\s\S]{0,900}photo_slot = 1[\s\S]{0,280}face_subject_type = 'CUSTOMER'/,
  "integrity guard requires quota usage and both customer photos");
assert.doesNotMatch(`${authority}\n${complete}`, /customer_product_balances/i,
  "EXPERIENCE does not consume customer purchased-unit balances");

assert.match(detail, /\["TEACHER", "CUSTOMER"\]\.includes\(explicit\)/,
  "detail view retains truthful historical subject rendering");
const balanceRefresh = sqlFunction(balanceMigration, "refresh_customer_balance");
assert.match(balanceRefresh, /verification_type IN \('NORMAL', 'SUPPLEMENT'\)/,
  "customer purchased balance continues excluding EXPERIENCE");

console.log("teacher-only customer-face experience contract: PASS");
