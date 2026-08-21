"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const authUi = read("auth-ui.js");
const businessUi = read("store-business.js");
const cloud = read("cloudfunctions/faceRecognition/index.js");
const styles = read("styles.css");
const pages = [
  "customer-create.html",
  "recharge-create.html",
  "refund-create.html",
  "verification-create.html",
  "verification-experience.html"
];
const allBusinessPages = [
  ...pages,
  "teacher-recharge-create.html",
  "teacher-refund-create.html",
  "teacher-verification-create.html",
  "teacher-verification-experience.html"
];
const teacherBusinessPages = allBusinessPages.filter((page) => page.startsWith("teacher-"));

function includes(source, expected, label) {
  assert.ok(source.includes(expected), `${label}: missing ${JSON.stringify(expected)}`);
}

function functionSource(source, name) {
  const marker = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = marker.exec(source);
  assert.ok(match, `function ${name} must exist`);
  const start = match.index;
  const signatureEnd = source.indexOf(") {", match.index + match[0].length);
  assert.ok(signatureEnd >= 0, `function ${name} signature must be complete`);
  const bodyStart = signatureEnd + 2;
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`function ${name} body is incomplete`);
}

// Headquarters and teachers use the exact same five shared documents. No
// role-specific copy can drift away from the common fields or layout.
for (const page of pages) {
  includes(authUi, `"${page}"`, `HQ route ${page}`);
  const html = read(page);
  includes(html, `data-store-business=`, `${page} reuses the shared workflow`);
  includes(html, "store-business.js?v=0.14.56", `${page} workflow cache key`);
  includes(html, "styles.css?v=", `${page} responsive store selector styles`);
  assert.ok(!fs.existsSync(path.join(root, `hq-${page}`)), `${page} must not have a duplicated HQ page`);
}
for (const file of fs.readdirSync(root).filter((file) => file.endsWith(".html") && read(file).includes("auth-ui.js?v="))) {
  const expectedAuthVersion = "0.19.1";
  includes(read(file), `auth-ui.js?v=${expectedAuthVersion}`, `${file} auth cache key`);
}
for (const page of teacherBusinessPages) includes(read(page), "store-business.js?v=0.14.56", `${page} shared script version`);
includes(authUi, '"teacher-recharge-create.html": "recharge-create.html"', "legacy teacher recharge route redirects to the shared page");
includes(authUi, '"teacher-refund-create.html": "refund-create.html"', "legacy teacher refund route redirects to the shared page");
includes(authUi, '"teacher-verification-create.html": "verification-create.html"', "legacy teacher verification route redirects to the shared page");
includes(authUi, '"teacher-verification-experience.html": "verification-experience.html"', "legacy teacher experience route redirects to the shared page");

for (const [href, label] of [
  ["customer-create.html", "客户建立"],
  ["recharge-create.html", "办卡充值"],
  ["refund-create.html", "退费申请"],
  ["verification-create.html", "核销办理"],
  ["verification-experience.html", "体验核销"]
]) includes(authUi, `["${href}", "${label}"]`, `HQ business navigation ${label}`);
includes(authUi, 'teacher: new Set(["teacher-work-orders.html"', "teacher route allowlist");
for (const [href, label] of [
  ["customer-create.html", "客户建立"],
  ["recharge-create.html", "办卡充值"],
  ["refund-create.html", "退费申请"],
  ["verification-create.html", "核销办理"],
  ["verification-experience.html", "体验核销"]
]) includes(authUi, `["${href}", "${label}"]`, `teacher shared business navigation ${label}`);
assert.ok(!authUi.includes("verification-supplemental.html"), "retired supplemental route must not remain in access or navigation");
assert.ok(!authUi.includes("teacher-verification-supplemental.html"), "retired teacher supplemental route must not remain in access or navigation");
includes(authUi, 'data-menu="hq-business"', "dedicated HQ business navigation group");
includes(authUi, 'a[href^="verification-review.html"]', "verification-review entry is hidden without deleting its route");
includes(authUi, 'link.hidden = true', "retired verification-review entry is not displayed");
assert.ok(authUi.includes('"verification-review.html"'), "historical verification-review access route must remain available");
assert.ok(fs.existsSync(path.join(root, "verification-review.html")), "historical verification-review implementation must remain on disk");

// The selector is created only for HQ on the shared, non-teacher pages. It
// starts with an empty prompt, locks the whole workflow with inert, and reloads
// before changing a confirmed store so customer/face/idempotency state cannot
// leak between stores.
includes(businessUi, 'const teacherMode = session?.role === "teacher" && businessPages.includes(page)', "teacher shared workflow mode");
includes(businessUi, 'const sharedTeacherMode = teacherMode && !legacyTeacherMode', "teacher uses the shared five-page documents");
includes(businessUi, 'const hqMode = session?.role === "hq"', "HQ workflow mode");
includes(businessUi, '!document.body.hasAttribute("data-teacher-business")', "HQ cannot enter teacher workflow documents");
includes(businessUi, 'workflow.setAttribute("inert", "")', "workflow locked before store confirmation");
includes(businessUi, 'control.disabled = true', "legacy browsers also disable workflow controls");
includes(businessUi, 'control.setAttribute("tabindex", "-1")', "pre-confirm controls leave keyboard order");
includes(businessUi, 'workflow.removeAttribute("inert")', "confirmed store unlocks shared workflow");
includes(businessUi, '<option value="">请选择本次办理门店</option>', "concrete store prompt");
assert.ok(!businessUi.includes('<option value="ALL"'), "HQ business store selector must never expose ALL");
includes(businessUi, 'window.location.reload()', "safe store reselection clears all state");
includes(businessUi, 'stopFaceCamera()', "store reselection releases the camera");
includes(businessUi, 'window.addEventListener("pageshow"', "HQ workflow observes BFCache restoration");
includes(businessUi, "hqMode || sharedTeacherMode", "HQ and teacher BFCache restoration force a clean workflow");
includes(businessUi, '{ ...payload, storeId }', "every scoped HQ action includes the selected store");
includes(businessUi, '["getTeacherBusinessContext", "getHqBusinessContext"].includes(payload.action)', "context requests do not send an unconfirmed store");
includes(businessUi, 'sharedTeacherMode ? "getTeacherBusinessContext" : "getHqBusinessContext"', "shared selector loads the correct role context");
includes(businessUi, 'nextCustomerEnrollmentRequestId({ storeId,', "customer idempotency is store-bound");
includes(businessUi, 'nextRechargeRequestId({ storeId, ...payload })', "recharge idempotency is store-bound");
includes(businessUi, 'nextVerificationRequestId({ storeId, ...payload })', "verification idempotency is store-bound");
includes(businessUi, '${escapeHtml(customer.name)} · ${escapeHtml(formatBirthday(customer.birthday))}', "shared customer dropdown shows birthday instead of customer number");
assert.ok(!businessUi.includes('${escapeHtml(customer.name)}（${escapeHtml(customer.id)}）</option>'), "shared customer dropdown must not expose the customer number");
includes(styles, ".hq-business-store-row", "HQ store selector layout");
includes(styles, ".business-store-unconfirmed", "HQ workflow lock fallback styling");
includes(styles, "pointer-events: none", "legacy browsers cannot click pre-confirm controls");
includes(styles, "body[data-store-business] .hq-business-store-panel", "mobile HQ store selector layout");
includes(styles, "grid-template-columns: minmax(160px, 1.35fr) minmax(130px, .85fr) minmax(88px, auto)", "customer lookup columns resize with the available width");
includes(styles, "gap: clamp(8px, 1vw, 12px)", "customer lookup column spacing adapts to the viewport");
includes(authUi, 'window.matchMedia("(max-width: 1100px)")', "phone and tablet navigation groups start collapsed");
includes(authUi, 'document.querySelectorAll(".side-menu-group[open]")', "compact navigation removes every default-open group");

// Server-side scope is authoritative on every action. HQ and teachers require
// one positive ACTIVE store; stores remain pinned to their account binding.
const activeBusinessSource = functionSource(cloud, "activeBusinessCaller");
includes(activeBusinessSource, '["teacher", "hq"].includes(account.role_code)', "HQ allowed by business caller");
includes(activeBusinessSource, 'positiveDatabaseId(event.storeId, "门店")', "concrete positive store ID");
includes(activeBusinessSource, "store_status = 'ACTIVE'", "business store must stay active");
includes(activeBusinessSource, 'requestedStore !== String(store.storeId)', "store event tampering rejected");

const fail = (message, code = "BAD_REQUEST") => { const error = new Error(message); error.code = code; throw error; };
const state = { accountRole: "hq", storeExists: true };
const activeHarness = {
  module: { exports: {} },
  app: () => ({ auth: () => ({ getUserInfo: () => ({ uid: "hq-user" }) }) }),
  executeSql: async (sql) => {
    if (sql.includes("FROM public.staff_accounts")) return [{
      staff_id: 41,
      role_code: state.accountRole,
      account_status: "ACTIVE",
      teacher_id: state.accountRole === "teacher" ? 8 : null,
      teacher_code: "TCH008",
      teacher_name: "老师八",
      teacher_status: "ACTIVE"
    }];
    if (sql.includes("FROM public.stores")) return state.storeExists
      ? [{ id: 7, store_code: "STR007", store_name: "测试门店", store_status: "ACTIVE" }]
      : [];
    throw new Error(`unexpected SQL: ${sql}`);
  },
  sqlText: (value) => `'${String(value)}'`,
  fail,
  activeStoreCaller: async () => ({ uid: "store-user", staffId: 5, storeId: 7, storeCode: "STR007", storeName: "测试门店" })
};
vm.createContext(activeHarness);
vm.runInContext([
  functionSource(cloud, "positiveDatabaseId"),
  activeBusinessSource,
  "module.exports = activeBusinessCaller;"
].join("\n"), activeHarness);
const activeBusinessCaller = activeHarness.module.exports;

(async () => {
  state.accountRole = "hq";
  state.storeExists = true;
  const hq = await activeBusinessCaller({ storeId: "7" });
  assert.equal(hq.role, "hq");
  assert.equal(hq.storeId, 7);
  assert.equal(hq.storeCode, "STR007");
  await assert.rejects(activeBusinessCaller({}), (error) => error.code === "BAD_REQUEST");
  await assert.rejects(activeBusinessCaller({ storeId: "ALL" }), (error) => error.code === "BAD_REQUEST");
  state.storeExists = false;
  await assert.rejects(activeBusinessCaller({ storeId: "7" }), (error) => error.code === "STORE_NOT_ACTIVE");
  state.storeExists = true;
  state.accountRole = "operation";
  await assert.rejects(activeBusinessCaller({ storeId: "7" }), (error) => error.code === "FORBIDDEN");
  state.accountRole = "store";
  await assert.rejects(activeBusinessCaller({ storeId: "8" }), (error) => error.code === "FORBIDDEN");

  const creationHarness = {
    module: { exports: {} },
    currentRole: "hq",
    activeBusinessCaller: async () => ({ role: creationHarness.currentRole, staffId: 41, storeId: 7 }),
    fail
  };
  vm.createContext(creationHarness);
  vm.runInContext(`${functionSource(cloud, "activeCustomerCreationCaller")}\nmodule.exports = activeCustomerCreationCaller;`, creationHarness);
  const creationCaller = creationHarness.module.exports;
  assert.equal((await creationCaller({ storeId: "7" })).role, "hq");
  creationHarness.currentRole = "store";
  assert.equal((await creationCaller({})).role, "store");
  creationHarness.currentRole = "teacher";
  assert.equal((await creationCaller({ storeId: "7" })).role, "teacher");

  includes(functionSource(cloud, "registerCustomer"), "activeCustomerCreationCaller(event)", "shared customer enrollment authority");
  includes(functionSource(cloud, "validateCapture"), "activeCustomerCreationCaller(event)", "shared capture validation authority");
  includes(functionSource(cloud, "getHqBusinessContext"), "store_status = 'ACTIVE'", "HQ context returns only active stores");
  includes(functionSource(cloud, "createRechargeApplication"), 'String(record.submitted_by_account_id) === String(caller.staffId)', "recharge idempotency replay stays bound to its original submitter");
  includes(cloud, 'if (action === "getHqBusinessContext")', "HQ context dispatcher");
  includes(cloud, '["hq", "store", "teacher"].includes(caller.role)', "HQ submitter can edit verification photos");
  includes(cloud, '["hq", "store", "teacher"].includes(context.caller.role)', "HQ upload ownership guard");
  includes(cloud, 'const FUNCTION_VERSION = PHOTO_ONLY_FUNCTION ? "v7" : "v86"', "deployable service versions");

  console.log("hq business workflow tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
