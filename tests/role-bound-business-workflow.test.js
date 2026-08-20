"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const includes = (source, expected, label) => assert.ok(source.includes(expected), `${label}: missing ${JSON.stringify(expected)}`);

const business = read("store-business.js");
const detail = read("business-detail.js");
const experience = read("verification-experience.html");
const normal = read("verification-create.html");

function functionSource(source, name) {
  const marker = new RegExp(`function\\s+${name}\\s*\\(`);
  const match = marker.exec(source);
  assert.ok(match, `function ${name} exists`);
  const signatureEnd = source.indexOf(") {", match.index + match[0].length);
  assert.ok(signatureEnd >= 0, `function ${name} signature is complete`);
  const bodyStart = signatureEnd + 2;
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, index + 1);
    }
  }
  throw new Error(`function ${name} is incomplete`);
}

// A store account has no editable store field: its authenticated session
// binding is restored before every cloud call and is also part of idempotency.
includes(business, 'const accountStoreId = session?.role === "store" ? String(session?.store || "") : ""', "store scope comes from the signed-in account");
includes(business, 'if (session.role === "store")', "every business cloud call reasserts store scope");
includes(business, "storeId = accountStoreId", "page state cannot replace the store account binding");
includes(business, "nextRechargeRequestId({ storeId, ...payload })", "recharge idempotency remains store-bound");
includes(business, "nextVerificationRequestId({ storeId, ...payload })", "verification idempotency remains store-bound");

// A teacher account is represented by exactly the teacher profile returned for
// the authenticated UID; the page does not load or expose the all-teacher list.
includes(business, "if (teacherMode) {", "teacher-specific binding branch exists");
includes(business, "normalizedTeacherProfile(teacherBusinessProfile || {})", "teacher binding uses authenticated context");
includes(business, "databaseTeachers = teacher.id ? [teacher] : []", "teacher account has one possible business teacher");
includes(business, 'hasFace: explicitReadiness === null ? faceStatus === "ENROLLED" : explicitReadiness', "retained face photo readiness overrides legacy enrollment status");
includes(business, 'select.hidden = true', "teacher does not reselect or rewrite their own identity");
includes(business, 'value.textContent = `${teacher.name || "当前老师"}', "read-only identity explains automatic binding");
includes(business, "老师账号只能将业务绑定给本人", "client rejects a tampered teacher value");

const profileHarness = { module: { exports: {} } };
vm.createContext(profileHarness);
vm.runInContext([
  functionSource(business, "normalizedTeacherProfile"),
  functionSource(business, "teacherFaceUnavailable"),
  "module.exports = { normalizedTeacherProfile, teacherFaceUnavailable };"
].join("\n"), profileHarness);
const retainedPhotoMissing = profileHarness.module.exports.normalizedTeacherProfile({
  teacherId: "8",
  faceEnrollmentStatus: "ENROLLED",
  facePhotoReady: false
});
assert.equal(retainedPhotoMissing.hasFace, false, "explicit missing retained photo overrides legacy ENROLLED status");
assert.equal(profileHarness.module.exports.teacherFaceUnavailable(retainedPhotoMissing), true, "experience is blocked without the retained teacher registration photo");

// EXPERIENCE is customer-owned as a business record, but the two face images
// and quota belong to the teacher. NORMAL remains a customer-face operation.
includes(business, 'action: experiencePage ? "verifyTeacherExperienceFace" : "verifyCustomerFace"', "experience and normal face subjects use different server actions");
includes(business, 'customerCode: selectedCustomer.id', "experience remains bound to the selected customer");
includes(business, '...(experiencePage ? { teacherId: faceTeacher.id } : {})', "experience face request identifies the quota teacher");
includes(business, 'faceSubjectType: experience ? "TEACHER" : "CUSTOMER"', "newly created local detail state keeps the verified face subject");
includes(business, "所选老师本人 1:1 人脸验证", "experience success names the teacher as face subject");
includes(business, "该老师尚未补录人脸", "no-face teacher receives a clear experience-only blocker");
includes(business, "客户仍可作为业务归属", "missing teacher face does not change customer attribution");
includes(experience, "客户作为业务归属", "experience page explains customer attribution");
includes(experience, "老师本人 1:1 人脸验证", "experience page explains teacher face matching");
includes(experience, "不扣客户项目余额", "experience page explains teacher quota isolation");
includes(normal, "与当前所选客户进行 1:1 验证", "normal verification still compares the customer face");

// Detail labels use the authoritative photo payload first. This preserves the
// true subject of historical EXPERIENCE rows that were stored as CUSTOMER.
includes(detail, "payload?.faceSubjectType", "detail prefers authoritative face subject metadata");
includes(detail, '["TEACHER", "CUSTOMER"].includes(explicit)', "detail accepts only known subject types");
includes(detail, '老师登记照', "teacher evidence slot zero is labelled as teacher registration");
includes(detail, "老师本次体验核销照", "teacher evidence slot one is labelled as teacher live verification");
includes(detail, '客户原始留存照', "normal and historical customer evidence retains customer label");

console.log("role-bound business workflow contract: PASS");
