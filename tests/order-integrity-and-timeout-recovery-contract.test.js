"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const cloud = read("cloudfunctions/faceRecognition/index.js");
const business = read("store-business.js");
const acknowledgement = read("business-submission-ack.js");
const migration = read("database/migrations/058_order_integrity_and_submission_recovery.sql");

function includes(source, expected, label) {
  assert.ok(source.includes(expected), `${label}: missing ${JSON.stringify(expected)}`);
}

function functionSource(source, name) {
  const marker = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = marker.exec(source);
  assert.ok(match, `function ${name} must exist`);
  const signatureEnd = source.indexOf(") {", match.index + match[0].length);
  assert.ok(signatureEnd >= 0, `function ${name} signature must be complete`);
  const bodyStart = signatureEnd + 2;
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, index + 1);
    }
  }
  throw new Error(`function ${name} body is incomplete`);
}

// The database, not the browser, is the final state-machine authority.
for (const marker of ["CURRENT_RECHARGE_INTEGRITY_V58", "CURRENT_VERIFICATION_INTEGRITY_V58"]) {
  includes(migration, marker, "migration 058 guard marker");
}
includes(migration, "trg_058_recharge_integrity", "recharge integrity trigger");
includes(migration, "trg_058_verification_integrity", "verification integrity trigger");
includes(migration, "NEW.recharge_type NOT IN ('NEW','REFUND') OR NEW.record_status <> 'PENDING'", "recharge insertion state");
includes(migration, "NEW.verification_type NOT IN ('NORMAL','EXPERIENCE') OR NEW.record_status <> 'APPROVED'", "verification insertion state");
includes(migration, "submitted_by_account_id IS DISTINCT FROM OLD.submitted_by_account_id", "submitter is immutable");
includes(migration, "NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key", "idempotency key is immutable");
includes(migration, "OLD.record_status = 'APPROVED' AND NEW.record_status = 'VOIDED'", "approved verification void remains supported");
assert.ok(!migration.includes("verification_type = 'SUPPLEMENT'"), "retired supplemental verification must not be reintroduced");

for (const file of [
  "database/cloudbase-console/058-01-recharge-integrity-function.sql",
  "database/cloudbase-console/058-02-verification-integrity-function.sql",
  "database/cloudbase-console/058-03-order-integrity-triggers.sql"
]) {
  const bytes = Buffer.byteLength(read(file), "utf8");
  assert.ok(bytes <= 3500, `${file} must stay below the CloudBase SQL editor safety size; got ${bytes} bytes`);
}
includes(read("database/cloudbase-console/058-readonly-verify.sql"), "THEN 'READY' ELSE 'MISSING'", "read-only migration verification");

// The browser persists a request number before the cloud call. A network
// timeout can only query that original number; it cannot generate a new order.
includes(business, 'const VERSION = "0.14.60"', "static workflow version");
includes(business, "localStorage.setItem(key, JSON.stringify(intent))", "submission intent persistence");
includes(business, "const saved = JSON.parse(localStorage.getItem(key)", "submission intent readback");
includes(business, 'beginBusinessSubmission("RECHARGE", { storeId, ...payload })', "recharge persistent idempotency");
includes(business, 'beginBusinessSubmission("VERIFICATION", {', "verification persistent idempotency");
includes(business, 'action: "recoverBusinessSubmission"', "server recovery call");
includes(business, "wrapped.submissionUncertain = true", "transport timeout is classified as uncertain");
includes(business, "为防止重复充值或重复扣次，本页继续锁定", "unknown result locks repeat submission");
includes(business, "if (!submissionRecoveryLocked) submit.disabled = false", "recharge button stays locked after uncertainty");
includes(business, "const ready = !submissionRecoveryLocked", "verification button stays locked after uncertainty");
includes(business, "submissionIntentKey: businessSubmissionStorageKey", "detail navigation carries the exact acknowledgement key");
includes(acknowledgement, 'intent.state !== "CONFIRMED"', "detail page clears only a server-confirmed intent");
includes(acknowledgement, "intent.clientRequestId !== clientRequestId", "detail acknowledgement is bound to the same request ID");
assert.ok(!business.includes("nextRechargeRequestId"), "memory-only recharge request IDs must be retired");
assert.ok(!business.includes("nextVerificationRequestId"), "memory-only verification request IDs must be retired");
assert.ok(business.indexOf("localStorage.setItem(key, JSON.stringify(intent))") < business.indexOf('action: "createRechargeApplication"'), "recharge intent must be persisted before invocation");

const verificationIntentStart = business.indexOf('intent = beginBusinessSubmission("VERIFICATION", {');
const verificationIntentEnd = business.indexOf("});", verificationIntentStart);
const verificationIdentity = business.slice(verificationIntentStart, verificationIntentEnd);
assert.ok(!verificationIdentity.includes("faceRequestId"), "short-lived face request ID must not be persisted");
assert.ok(!verificationIdentity.includes("faceEvidenceToken"), "biometric evidence token must not be persisted");

const browserStorage = {};
const localStorageHarness = {
  getItem: (key) => Object.prototype.hasOwnProperty.call(browserStorage, key) ? browserStorage[key] : null,
  setItem: (key, value) => { browserStorage[key] = String(value); },
  removeItem: (key) => { delete browserStorage[key]; }
};
function submissionHarness() {
  const context = {
    module: { exports: {} },
    session: { role: "teacher", account: "13800000000" },
    page: "recharge",
    storeId: "9",
    localStorage: localStorageHarness,
    window: { crypto: { randomUUID: () => "request_12345678" } },
    submissionRecoveryLocked: false
  };
  vm.createContext(context);
  vm.runInContext([
    functionSource(business, "businessSubmissionFingerprint"),
    functionSource(business, "businessSubmissionStorageKey"),
    functionSource(business, "readBusinessSubmission"),
    functionSource(business, "writeBusinessSubmission"),
    functionSource(business, "beginBusinessSubmission"),
    functionSource(business, "confirmBusinessSubmission"),
    "module.exports = { beginBusinessSubmission, readBusinessSubmission, confirmBusinessSubmission };"
  ].join("\n"), context);
  return context;
}
const firstPage = submissionHarness();
const firstIntent = firstPage.module.exports.beginBusinessSubmission("RECHARGE", {
  storeId: "9", customerCode: "客户敏感编号", productId: "3", message: "私密备注"
});
assert.equal(firstIntent.clientRequestId, "request_12345678");
assert.equal(Object.keys(browserStorage).length, 1, "one pending intent must be stored");
assert.ok(!Object.values(browserStorage)[0].includes("客户敏感编号"), "customer identity must not be stored in clear text");
assert.ok(!Object.values(browserStorage)[0].includes("私密备注"), "business note must not be stored in clear text");

const reloadedPage = submissionHarness();
assert.equal(reloadedPage.module.exports.readBusinessSubmission("RECHARGE").clientRequestId, "request_12345678", "a page reload must recover the same request ID");
assert.throws(
  () => reloadedPage.module.exports.beginBusinessSubmission("RECHARGE", { storeId: "9", customerCode: "另一个客户" }),
  (error) => error.code === "SUBMISSION_RECOVERY_REQUIRED"
);
assert.equal(reloadedPage.module.exports.confirmBusinessSubmission("RECHARGE", "31"), true);
const acknowledgementKey = Object.keys(browserStorage)[0];
const acknowledgementPage = {
  URLSearchParams,
  location: { search: `?submissionIntentKey=${encodeURIComponent(acknowledgementKey)}&clientRequestId=request_12345678` },
  localStorage: localStorageHarness,
  console
};
vm.createContext(acknowledgementPage);
vm.runInContext(acknowledgement, acknowledgementPage);
assert.equal(Object.keys(browserStorage).length, 0, "the loaded detail page must acknowledge and clear the completed intent");

// Recovery is scoped to the same authenticated account and store. For a
// verification it is complete only after the device outbox row (and, for
// experience, quota usage audit row) exists.
const recoverySource = functionSource(cloud, "recoverBusinessSubmission");
const attributionSource = functionSource(cloud, "teacherBusinessAttributionSourceCondition");
includes(cloud, 'const FUNCTION_VERSION = PHOTO_ONLY_FUNCTION ? "v9" : "v94"', "cloud function version");
includes(cloud, 'if (action === "recoverBusinessSubmission")', "recovery dispatcher");
includes(recoverySource, "r.idempotency_key", "recharge lookup by idempotency key");
includes(recoverySource, "v.idempotency_key", "verification lookup by idempotency key");
includes(recoverySource, "record.submitted_by_account_id", "original submitter scope");
includes(recoverySource, "record.store_id", "original store scope");
includes(recoverySource, "Boolean(record.signal_id)", "device signal completeness");
includes(recoverySource, "Boolean(record.quota_usage_id)", "experience quota audit completeness");

const fail = (message, code = "BAD_REQUEST") => { const error = new Error(message); error.code = code; throw error; };
const state = { rows: [] };
const harness = {
  module: { exports: {} },
  activeBusinessCaller: async () => ({ staffId: 17, storeId: 9 }),
  rechargeSubmissionKey: (value) => `key:${value}`,
  sqlText: (value) => `'${String(value)}'`,
  executeSql: async () => state.rows,
  fail
};
vm.createContext(harness);
vm.runInContext(`${attributionSource}\n${recoverySource}\nmodule.exports = recoverBusinessSubmission;`, harness);
const recoverBusinessSubmission = harness.module.exports;

(async () => {
  state.rows = [];
  assert.deepEqual(
    JSON.parse(JSON.stringify(await recoverBusinessSubmission({ recordType: "RECHARGE", clientRequestId: "request_12345678" }))),
    { ok: true, found: false, complete: false, recordType: "RECHARGE" }
  );

  state.rows = [{
    id: 31, verification_code: "VX31", verification_type: "NORMAL", store_id: 9,
    teacher_id: 4, customer_id: 5, product_id: 6, unit_count: 1,
    record_status: "APPROVED", submitted_by_account_id: 17,
    customer_code: "C5", customer_name: "客户", product_code: "P6", product_name: "项目",
    teacher_code: "T4", teacher_name: "老师", signal_id: null, quota_usage_id: null
  }];
  const incomplete = await recoverBusinessSubmission({ recordType: "VERIFICATION", clientRequestId: "request_12345678" });
  assert.equal(incomplete.found, true);
  assert.equal(incomplete.complete, false);

  state.rows[0].signal_id = 81;
  const complete = await recoverBusinessSubmission({ recordType: "VERIFICATION", clientRequestId: "request_12345678" });
  assert.equal(complete.complete, true);
  assert.equal(complete.verificationId, "31");

  state.rows[0].store_id = 10;
  await assert.rejects(
    recoverBusinessSubmission({ recordType: "VERIFICATION", clientRequestId: "request_12345678" }),
    (error) => error.code === "FORBIDDEN"
  );

  console.log("order integrity and timeout recovery contract tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
