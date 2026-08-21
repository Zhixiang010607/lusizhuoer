"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const includes = (source, expected, label) => assert.ok(source.includes(expected), `${label}: missing ${JSON.stringify(expected)}`);

const business = read("store-business.js");
const detail = read("business-detail.js");
const experience = read("verification-experience.html");
const normal = read("verification-create.html");

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
includes(business, 'select.hidden = true', "teacher does not reselect or rewrite their own identity");
includes(business, 'value.textContent = `${teacher.name || "当前老师"}', "read-only identity explains automatic binding");
includes(business, "老师账号只能将业务绑定给本人", "client rejects a tampered teacher value");
assert.doesNotMatch(business, /teacherFaceUnavailable|faceEnrollmentStatus|facePhotoReady|faceReadinessKnown/,
  "teacher business binding must not depend on a teacher photograph or face enrollment state");

// EXPERIENCE is gifted by the authenticated teacher, while the selected
// customer owns both immutable face images. NORMAL uses the same 1:1 action.
includes(business, 'action: "verifyCustomerFace"', "experience and normal both verify the selected customer");
includes(business, 'customerCode: selectedCustomer.id', "experience remains bound to the selected customer");
includes(business, 'faceSubjectType: "CUSTOMER"', "new EXPERIENCE local detail state keeps the customer face subject");
includes(business, "所选客户 1:1 人脸验证", "experience success names the customer as face subject");
includes(experience, "自动绑定当前老师账号", "experience page explains teacher account binding");
includes(experience, "客户本人 1:1 人脸验证", "experience page explains customer face matching");
includes(experience, "不扣客户购买余额", "experience page explains teacher quota isolation");
includes(normal, "与当前所选客户进行 1:1 验证", "normal verification still compares the customer face");

// Detail labels use the authoritative photo payload first. This preserves the
// true subject of historical EXPERIENCE rows that were stored as CUSTOMER.
includes(detail, "payload?.faceSubjectType", "detail prefers authoritative face subject metadata");
includes(detail, '["TEACHER", "CUSTOMER"].includes(explicit)', "detail accepts only known subject types");
includes(detail, '老师登记照', "teacher evidence slot zero is labelled as teacher registration");
includes(detail, "老师本次体验核销照", "teacher evidence slot one is labelled as teacher live verification");
includes(detail, '客户原始留存照', "normal and historical customer evidence retains customer label");

console.log("role-bound business workflow contract: PASS");
