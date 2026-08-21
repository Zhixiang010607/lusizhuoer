"use strict";

// Migration 053 is intentionally destructive only toward the abandoned
// teacher-face Saga. This contract keeps that retirement exact while proving
// that the replacement is one direct teacherCreate service, not a compatibility
// layer spread across staffAccount and faceRecognition again.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const staff = read("cloudfunctions/staffAccount/index.js");
const face = read("cloudfunctions/faceRecognition/index.js");
const teacher = read("cloudfunctions/teacherCreate/index.js");
const browser = read("cloudbase-phone-auth.js");
const canonical053 = read("database/migrations/053_retire_legacy_teacher_face_saga.sql");
const console053 = read("database/cloudbase-console/053-01-retire-legacy-teacher-face-saga.sql");
const verify053 = read("database/cloudbase-console/053-readonly-verify.sql");

assert.match(staff, /const FUNCTION_VERSION = "v66"/);
assert.match(face, /const FUNCTION_VERSION = PHOTO_ONLY_FUNCTION \? "v4" : "v76"/);
assert.match(teacher, /const FUNCTION_VERSION = "teacher-create-v4"/);

const retiredImplementationNames = [
  "teacher_face_operations",
  "assert_teacher_face_operation_input",
  "acquire_teacher_face_operation",
  "bind_teacher_face_operation",
  "bind_teacher_face_operation_face_id",
  "transition_teacher_face_operation",
  "takeover_teacher_face_operation_cleanup",
  "provisionTeacherWithFace",
  "beginTeacherProvisionWithFace",
  "getTeacherFaceOperationStatus",
  "resumeTeacherFaceOperation",
  "cancelTeacherFaceOperation",
  "handleTrustedTeacherFaceReconcileTimer",
  "TEACHER_FACE_RECONCILE_TIMER",
  "delegateTeacherFace",
  "upsertDelegatedTeacherFace",
  "readbackDelegatedTeacherFace",
  "rollbackDelegatedTeacherFace",
  "finalizeDelegatedTeacherFace",
  "teacher-face-v3"
];
for (const name of retiredImplementationNames) {
  assert.equal(staff.includes(name), false, `staffAccount must permanently retire ${name}`);
  assert.equal(face.includes(name), false, `faceRecognition must permanently retire ${name}`);
  assert.equal(teacher.includes(name), false, `teacherCreate must not emulate retired ${name}`);
}
for (const service of [staff, face, teacher]) {
  assert.doesNotMatch(service, /\.callFunction\s*\(/,
    "teacher services must not call another Cloud Function to continue the retired workflow");
}
assert.doesNotMatch(staff, /if \(action === "(?:provisionTeacherWithFace|beginTeacherProvisionWithFace|getTeacherFaceOperationStatus|resumeTeacherFaceOperation|cancelTeacherFaceOperation|upsertTeacherFace)"\)/,
  "staffAccount must expose none of the six retired teacher-face actions");
assert.doesNotMatch(face, /if \(action === "(?:upsertDelegatedTeacherFace|readbackDelegatedTeacherFace|rollbackDelegatedTeacherFace|finalizeDelegatedTeacherFace)"\)/,
  "faceRecognition must expose none of the retired private delegation actions");

assert.match(staff, /if \(role === "teacher"\) \{[\s\S]{0,220}TEACHER_CREATE_SERVICE_REQUIRED/,
  "generic staff creation must fail before attempting compatibility behavior");
assert.match(teacher, /if \(action === "createTeacher"\) return await createTeacher\(event\)/,
  "teacherCreate v4 must own direct teacher creation");
assert.doesNotMatch(teacher, /upsertTeacherFace|replaceTeacherFace|switchTeacherFace|restoreTeacherFace/,
  "teacherCreate v4 must expose no post-creation face write path");
assert.match(browser, /async createTeacherWithFace\([\s\S]{0,700}callTeacherCreate\(\s*\{[\s\S]{0,120}action: "createTeacher"/,
  "the browser must call teacherCreate directly for creation");
assert.doesNotMatch(browser, /upsertTeacherFace|replaceTeacherFace/,
  "the browser must expose no post-creation face maintenance client");

const createStart = teacher.indexOf("async function createTeacher");
const createEnd = teacher.indexOf("function health", createStart);
assert.ok(createStart >= 0 && createEnd > createStart,
  "direct teacher creation must have one auditable implementation");
const create = teacher.slice(createStart, createEnd);
assert.equal((create.match(/await inspectFace\(/g) || []).length, 1,
  "one creation request performs exactly one quality pass");
assert.equal((create.match(/await inspectLiveness\(/g) || []).length, 1,
  "one creation request performs exactly one liveness pass");
assert.match(create, /confirmPerson\([\s\S]{0,260}confirmPhoto\([\s\S]{0,800}finalReadback\(/,
  "creation must prove the same remote identity, retained original and database record");
assert.match(create, /manager\(\)\.user\.modifyUser\(\{ uid: authentication\.uid, userStatus: "ACTIVE"[\s\S]{0,500}finalReadback\(/,
  "creation activates only before a final authoritative readback");

function body(source) {
  const begin = source.indexOf("BEGIN;");
  const commit = source.lastIndexOf("\nCOMMIT;");
  assert.ok(begin >= 0 && commit > begin, "053 must be one complete transaction");
  return source.slice(begin, commit + "\nCOMMIT;".length).replace(/\r\n/g, "\n");
}
const executable = (source) => body(source)
  .replace(/^\s*--.*$/gm, "")
  .replace(/\s+/g, "");
assert.equal(executable(console053), executable(canonical053),
  "the one-paste CloudBase 053 transaction must exactly match the canonical migration");
assert.equal((canonical053.match(/DROP FUNCTION IF EXISTS public\./g) || []).length, 6,
  "053 must drop exactly the six private Saga helpers");
assert.equal((canonical053.match(/DROP TABLE IF EXISTS public\.teacher_face_operations/g) || []).length, 1,
  "053 must drop exactly the Saga table");
assert.doesNotMatch(canonical053, /\bCASCADE\b/i,
  "053 must fail closed if an unexpected dependency exists, not cascade into business data");
assert.doesNotMatch(canonical053,
  /\b(?:DROP|TRUNCATE|DELETE\s+FROM|ALTER)\s+(?:TABLE\s+)?(?:public\.)?(?:teachers|staff_accounts|teacher_product_experience_quotas|teacher_experience_quota_(?:recharges|resets|usages)|recharge_records|verification_records|stores|products)\b/i,
  "053 must not mutate teachers, accounts, quotas, work orders, stores or products");

assert.doesNotMatch(verify053, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|BEGIN|COMMIT)\b/i,
  "053 acceptance verification must be read-only");
assert.equal((verify053.match(/TO_REG(?:CLASS|PROCEDURE)\(/g) || []).length, 7,
  "053 verification must check the table plus all six helper functions");
assert.match(verify053, /'RETIRED'[\s\S]{0,80}'STILL_PRESENT'/,
  "053 verification must clearly expose any object that was not retired");

console.log("teacher face Saga retirement contract: PASS");
