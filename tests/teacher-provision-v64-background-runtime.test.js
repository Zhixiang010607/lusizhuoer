"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const staff = fs.readFileSync(path.join(root, "cloudfunctions/staffAccount/index.js"), "utf8");
const teacherCreate = fs.readFileSync(path.join(root, "teacher-create.js"), "utf8");
const cloudbasePhoneAuth = fs.readFileSync(path.join(root, "cloudbase-phone-auth.js"), "utf8");

function namedFunctionSource(source, name, asyncRequired = true) {
  const match = new RegExp(`${asyncRequired ? "async\\s+" : "(?:async\\s+)?"}function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match, `missing${asyncRequired ? " async" : ""} function ${name}`);
  const parametersOpen = source.indexOf("(", match.index);
  let parameterDepth = 0;
  let parametersClose = -1;
  for (let index = parametersOpen; index < source.length; index += 1) {
    if (source[index] === "(") parameterDepth += 1;
    if (source[index] === ")") {
      parameterDepth -= 1;
      if (parameterDepth === 0) { parametersClose = index; break; }
    }
  }
  assert.ok(parametersClose > parametersOpen, `unterminated parameters for ${name}`);
  const open = source.indexOf("{", parametersClose);
  let depth = 0;
  let quote = "";
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") { blockComment = false; index += 1; }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "/" && next === "/") { lineComment = true; index += 1; continue; }
    if (char === "/" && next === "*") { blockComment = true; index += 1; continue; }
    if (char === "'" || char === '"' || char === "`") { quote = char; continue; }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, index + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

const functionSource = (source, name) => namedFunctionSource(source, name, true);
const plainFunctionSource = (source, name) => namedFunctionSource(source, name, false);

function failure(message, code) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function numericId(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("bad id");
  return number;
}

function sqlText(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

async function within(promise, milliseconds, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${milliseconds} ms`)), milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitUntil(predicate, milliseconds, label) {
  return within((async () => {
    while (!predicate()) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  })(), milliseconds, label);
}

assert.match(staff, /const FUNCTION_VERSION = "v64"/,
  "the non-blocking teacher provisioning contract must publish as staffAccount v64");
assert.match(staff, /TEACHER_FACE_SAME_REQUEST_OWNER_VERSION = "teacher-face-owner-v63"/,
  "v64 must preserve the owner-token derivation version so exact v63 operations remain resumable");
assert.match(staff, /TEACHER_PROVISION_V63_INVOCATION_ACTIVE_PREFIX = "V63_INVOCATION_ACTIVE:"/);
assert.match(staff, /TEACHER_PROVISION_V63_AUTH_RETRY_READY = "V63_AUTH_RETRY_READY"/);

const beginSource = functionSource(staff, "beginTeacherProvisionWithFace");
assert.match(beginSource, /acquireTeacherFaceOperation\s*\(/,
  "begin must durably allocate/idempotently recover the operation before returning");
assert.match(beginSource, /accepted\s*:/,
  "begin must explicitly acknowledge a queued/background operation");
assert.match(beginSource, /operationId/);
assert.match(beginSource, /faceImageSha256/);
assert.match(beginSource, /faceImageBytes/);
assert.match(beginSource,
  /event\.faceImageBase64[\s\S]{0,180}TEACHER_FACE_BEGIN_IMAGE_FORBIDDEN/,
  "begin must explicitly reject callers that try to send raw face bytes");
assert.doesNotMatch(beginSource, /teacherFaceImage\s*\(/,
  "begin validates only the digest/byte metadata; image decoding belongs to the worker request");
assert.doesNotMatch(beginSource,
  /manager\s*\(|createUser\s*\(|modifyUser\s*\(|deleteUsers\s*\(|delegateTeacherFace|createStaffDatabaseProfile\s*\(/,
  "the fast begin endpoint must not enter Auth, face, photo or profile work");
assert.match(staff,
  /action\s*===\s*"beginTeacherProvisionWithFace"[\s\S]{0,500}beginTeacherProvisionWithFace\s*\(/,
  "main must expose the metadata-only begin action");

const statusSource = functionSource(staff, "getTeacherFaceOperationStatus");
const statusPayloadSource = plainFunctionSource(staff, "teacherProvisionOperationStatusPayload");
const resultReadSource = functionSource(staff, "readTeacherProvisionResult");
assert.match(statusSource, /readOnly/,
  "the status endpoint must require the explicit read-only polling contract");
assert.doesNotMatch(statusSource,
  /manager\s*\(|delegateTeacherFace|reconcileTeacherFaceOperation\s*\(|makeTeacherAuthOwnershipUncertaintyCleanupEligible\s*\(|takeoverTeacherFaceOperationCleanup\s*\(/,
  "status polling may observe the operation but must never run a worker or cleanup mutation");
assert.doesNotMatch(statusSource,
  /executeSql\s*\(|acquireTeacherFaceOperation\s*\(|claimTeacherProvisionInvocation\s*\(|transitionTeacherFaceOperation\s*\(|markTeacherProvisionWorkerReady\s*\(|releaseTeacherProvisionCleanupLease\s*\(/,
  "the status endpoint is a single operation read plus pure status projection");
assert.match(resultReadSource,
  /readTeacherFaceOperation\s*\(operationId\)/,
  "final proof must begin from the exact durable operation id");
for (const field of [
  "client_request_id", "phone", "teacher_name", "image_sha256", "image_bytes",
  "actor_staff_account_id", "owner_token_sha256"
]) {
  assert.match(resultReadSource, new RegExp(`row\\.${field}`),
    `final proof must bind the immutable operation ${field}`);
}
assert.match(resultReadSource,
  /payloadSecretDigest[\s\S]{0,700}ownerTokenHash[\s\S]{0,900}TEACHER_FACE_OPERATION_REPLAY_MISMATCH/,
  "password-derived owner proof and original photograph digest/bytes must match before readback");
assert.match(resultReadSource, /operation_status\s*\|\|\s*""\)\s*!==\s*"SUCCEEDED"/,
  "final proof is unavailable before durable SUCCEEDED");
assert.doesNotMatch(resultReadSource,
  /acquireTeacherFaceOperation\s*\(|claimTeacherProvisionInvocation\s*\(|transitionTeacherFaceOperation\s*\(|markTeacherProvisionWorkerReady\s*\(|releaseTeacherProvisionCleanupLease\s*\(|reconcileTeacherFaceOperation\s*\(|manager\s*\(|delegateTeacherFace\s*\(/,
  "concurrent proof readers must never acquire/claim/transition/cleanup or call a mutating remote action");
assert.doesNotMatch(resultReadSource,
  /\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM|TRUNCATE|ALTER\s+TABLE|DROP\s+TABLE)\b/i,
  "final proof may issue SELECTs but no SQL writes");

const frontendSafeSecondsSource = plainFunctionSource(teacherCreate, "safeProvisionRecoverySeconds");
const frontendTransientSource = plainFunctionSource(teacherCreate, "transientTeacherProvisionTransport");
const frontendRegisterComponentSource = plainFunctionSource(teacherCreate, "registerComponent");
const frontendResponseDataSource = plainFunctionSource(teacherCreate, "responseData");
const frontendFaceValidationSource = functionSource(teacherCreate, "callFaceValidation");
const frontendProofSource = plainFunctionSource(teacherCreate, "teacherProvisionProof");
const frontendBeginSource = functionSource(teacherCreate, "beginTeacherProvision");
const frontendPollingSource = functionSource(teacherCreate, "provisionTeacherWithBackgroundPolling");
assert.match(frontendBeginSource,
  /\{\s*faceImageBase64:\s*_omittedFaceImage[\s\S]{0,500}beginTeacherProvisionWithFace\s*\(beginInput\)/,
  "the fast browser begin request must remove the original image before sending metadata");
assert.match(frontendPollingSource,
  /Promise\.resolve\(\)[\s\S]{0,180}provisionTeacherWithFace\s*\(input\)/,
  "the long worker invocation must be launched without being awaited by the UI loop");
assert.match(teacherCreate, /const teacherProvisionWorkerDeliveryStates = new Map\(\)/,
  "worker delivery attempts must persist for the page lifetime, not reset on another click");
assert.match(frontendPollingSource,
  /workerDeliveryDelaysMs = Object\.freeze\(\[0, 15 \* 1000, 45 \* 1000\]\)/,
  "large worker payloads need bounded 0/15s/45s delivery fences");
assert.match(frontendPollingSource,
  /workerDeliveryState\.attempts >= workerDeliveryDelaysMs\.length/,
  "one page may deliver a request at most three times even if READY persists");
assert.match(frontendFaceValidationSource,
  /Promise\.race\(\[validationRequest, validationWatchdog\]\)[\s\S]{0,180}clearTimeout\(watchdogTimer\)/,
  "face preflight must have a clearing 15-second browser watchdog");
assert.match(frontendFaceValidationSource, /FACE_VALIDATION_TIMEOUT[\s\S]{0,120}15 \* 1000/,
  "a never-settling face preflight must return control after 15 seconds");
assert.match(frontendPollingSource,
  /getTeacherFaceOperationStatus\s*\(\{\s*operationId,\s*readOnly:\s*true\s*\}\)/,
  "every browser status poll must explicitly request the read-only contract");
assert.match(frontendPollingSource,
  /readTeacherProvisionResult\s*\(\{[\s\S]{0,100}\.\.\.input,[\s\S]{0,100}operationId,[\s\S]{0,100}readOnly:\s*true/,
  "terminal proof must replay the exact frozen worker payload plus operation id through the read-only endpoint");
const frontendSucceededBranch = frontendPollingSource.slice(
  frontendPollingSource.indexOf('if (status === "SUCCEEDED"'),
  frontendPollingSource.indexOf('if ((status === "CANCELLED"')
);
assert.match(frontendSucceededBranch, /teacherProvisionProof\s*\(proofReplayResult\)/,
  "a durable SUCCEEDED row is not UI success until read-only replay returns all proofs");
assert.doesNotMatch(frontendSucceededBranch, /provisionTeacherWithFace\s*\(/,
  "SUCCEEDED proof replay must never call the mutating worker again");
assert.match(cloudbasePhoneAuth, /const teacherProvisionStatusFlights = new Map\(\)/);
assert.match(cloudbasePhoneAuth, /const teacherProvisionResultFlights = new Map\(\)/);
assert.match(cloudbasePhoneAuth,
  /getTeacherFaceOperationStatus[\s\S]{0,900}teacherProvisionStatusFlights\.get\(key\)[\s\S]{0,900}promiseWithWatchdog\(flight/,
  "status watchdog observers must reuse one underlying flight per operation id");
assert.match(cloudbasePhoneAuth,
  /readTeacherProvisionResult[\s\S]{0,1400}teacherProvisionResultFlights\.get\(key\)[\s\S]{0,1400}faceImageBase64[\s\S]{0,1400}promiseWithWatchdog\(flight/,
  "proof watchdog observers must reuse one full-payload read flight per operation id");

function completeTeacherProvisionProof() {
  return {
    ok: true,
    resultReadOnly: true,
    readbackConfirmed: true,
    uid: "teacher-auth-proof",
    verification: {
      personConfirmed: true,
      privatePhotoConfirmed: true,
      delegatedDatabaseConfirmed: true,
      finalDatabaseConfirmed: true,
      facePhotoReady: true,
      teacherActive: true,
      accountActive: true,
      credentialActive: true,
      complete: true
    },
    teacher: {
      teacherId: "701",
      faceEnrollmentStatus: "ENROLLED",
      facePhotoReady: true,
      teacherStatus: "ACTIVE",
      accountStatus: "ACTIVE",
      credentialStatus: "ACTIVE"
    }
  };
}

function frontendHarness(api, { minimumWaitAdvance = 2_000 } = {}) {
  let now = 1_000_000;
  const progress = [];
  const sandbox = {
    module: { exports: {} },
    window: { CloudBasePhoneAuth: api },
    Date: { now: () => now },
    wait: async (milliseconds) => {
      now += Math.max(minimumWaitAdvance, Number(milliseconds) || 0);
      await Promise.resolve();
    },
    setMessage: () => {},
    setProvisionPayloadLocked: () => {},
    syncSubmit: () => {},
    showTeacherProvisionProgress: (...args) => { progress.push(args); }
  };
  vm.createContext(sandbox);
  vm.runInContext(`
    let provisionRecoveryGeneration = 0;
    let provisionRecoveryPending = false;
    let activeProvisionOperationId = "";
    const teacherProvisionWorkerDeliveryStates = new Map();
    ${frontendSafeSecondsSource}
    ${frontendTransientSource}
    ${frontendProofSource}
    ${frontendBeginSource}
    ${frontendPollingSource}
    module.exports = {
      teacherProvisionProof,
      beginTeacherProvision,
      provisionTeacherWithBackgroundPolling
    };
  `, sandbox, { filename: "teacher-create-v64-background-runtime.js" });
  return { functions: sandbox.module.exports, progress, now: () => now };
}

(async () => {
  // The initial request must resolve from metadata/lease work even if every
  // Manager mutation in the process would hang forever. In particular, begin
  // is not allowed to call the old synchronous worker as a helper.
  {
    let acquireCalls = 0;
    let managerCalls = 0;
    let faceCalls = 0;
    let workerCalls = 0;
    const sandbox = {
      module: { exports: {} },
      Buffer,
      crypto,
      requireTeacherFaceSchema: async () => {},
      requireTeacherExperienceFaceSubjectSchema: async () => {},
      requireTeacherFaceOperationSchema: async () => {},
      validatePhone: (value) => String(value),
      validatePassword: (value) => String(value),
      teacherFaceProvisionRequestId: (value) => String(value),
      teacherProvisionAuthenticationUid: () => "teacher-auth-background",
      teacherFaceProvisionImageMetadata: () => ({
        imageDigest: "ef".repeat(32), imageBytes: 4
      }),
      teacherFaceOperationImageMetadata: () => ({
        imageDigest: "ef".repeat(32), imageBytes: 4
      }),
      numericId,
      acquireTeacherFaceOperation: async () => {
        acquireCalls += 1;
        return {
          id: "81",
          status: "RUNNING",
          ownerToken: "ab".repeat(32),
          ownerTokenHash: "cd".repeat(32),
          leaseGeneration: 1,
          imageDigest: "ef".repeat(32),
          imageBytes: 4,
          faceGroupId: "teacher-face-group",
          photoBucketId: "customer-photos"
        };
      },
      readTeacherFaceOperation: async () => ({
        operation_id: "81", operation_status: "RUNNING", error_code: null
      }),
      markTeacherProvisionWorkerReady: async () => ({
        operation_id: "81", operation_status: "RUNNING", error_code: "V64_WORKER_READY",
        client_request_id: "background_begin_0001", lease_retry_after_seconds: 720
      }),
      releaseTeacherProvisionCleanupLease: async () => null,
      teacherOperationLeaseRetryAfterSeconds: () => 720,
      teacherProvisionOperationStatusPayload: (row) => ({
        operationId: String(row.operation_id),
        clientRequestId: String(row.client_request_id),
        status: "RUNNING", stage: "READY", workerReady: true,
        retrySameRequest: true, retryAfterSeconds: 0,
        cleanupComplete: false, retryAllowed: false
      }),
      FUNCTION_VERSION: "v64",
      manager: () => {
        managerCalls += 1;
        return { user: { createUser: () => new Promise(() => {}) } };
      },
      delegateTeacherFace: async () => { faceCalls += 1; return new Promise(() => {}); },
      provisionTeacherWithFace: async () => { workerCalls += 1; return new Promise(() => {}); },
      fail: failure
    };
    vm.createContext(sandbox);
    vm.runInContext(`${beginSource}\nmodule.exports = beginTeacherProvisionWithFace;`, sandbox,
      { filename: "staffAccount-begin-teacher-provision.js" });
    const result = await within(sandbox.module.exports(
      { profile: { staffId: "900" } },
      {
        staffName: "后台老师", phone: "13900000007", initialPassword: "Aa1!aaaa",
        clientRequestId: "background_begin_0001", consent: true,
        faceImageSha256: "ef".repeat(32), faceImageBytes: 4
      }
    ), 100, "beginTeacherProvisionWithFace");
    assert.equal(result.accepted, true);
    assert.equal(String(result.operationId), "81");
    assert.equal(result.clientRequestId, "background_begin_0001");
    assert.ok(["PENDING", "RUNNING"].includes(String(result.status)));
    assert.equal(acquireCalls, 1);
    assert.equal(managerCalls, 0, "a hanging Manager SDK must be unreachable from begin");
    assert.equal(faceCalls, 0, "face/photo work must be unreachable from begin");
    assert.equal(workerCalls, 0, "begin must not await or directly run the worker");
  }

  // A worker may be stuck in an external Manager promise, but a separate
  // read-only status invocation must still return promptly. ACTIVE is never an
  // instruction to launch a second worker.
  {
    let createReached = false;
    let workerSettled = false;
    const activeRow = {
      operation_id: "82",
      operation_type: "PROVISION",
      operation_status: "RUNNING",
      error_code: "V64_INVOCATION_ACTIVE:" + "aa".repeat(32),
      lease_retry_after_seconds: 700,
      cleanup_completed_at: null
    };
    const workerSandbox = {
      module: { exports: {} }, Buffer, crypto,
      TEACHER_FACE_COMPENSATION_SETTLE_MS: 350,
      TEACHER_AUTH_CREATE_UNCERTAINTY_FENCE_SECONDS: 90,
      TEACHER_AUTH_SAME_REQUEST_RETRY_SECONDS: 2,
      requireTeacherFaceSchema: async () => {},
      requireTeacherExperienceFaceSubjectSchema: async () => {},
      requireTeacherFaceOperationSchema: async () => {},
      validatePhone: (value) => String(value),
      validatePassword: (value) => String(value),
      teacherFaceProvisionRequestId: (value) => String(value),
      teacherProvisionAuthenticationUid: () => "teacher-auth-hanging",
      teacherProvisionAuthenticationLease: () => `teacher-face-saga:82:${"ab".repeat(32)}`,
      teacherFaceImage: () => ({
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), base64: "/9j/2Q=="
      }),
      numericId, sqlText,
      acquireTeacherFaceOperation: async () => ({
        id: "82", ownerToken: "ab".repeat(32), ownerTokenHash: "cd".repeat(32),
        leaseGeneration: 2, status: "RUNNING", imageDigest: "ef".repeat(32), imageBytes: 4,
        faceGroupId: "teacher-face-group", photoBucketId: "customer-photos"
      }),
      claimTeacherProvisionInvocation: async (operation) => operation,
      executeSql: async (sql) => {
        if (sql.includes("FROM public.staff_accounts a")) return [];
        throw new Error(`unexpected SQL before hanging Auth create: ${sql.slice(0, 100)}`);
      },
      bindTeacherFaceOperation: async () => {},
      exactAuthenticationUserByUid: async () => null,
      findAuthUserByExactPhoneReadOnly: async () => null,
      teacherSagaOwnsAuthentication: () => false,
      manager: () => ({ user: {
        createUser: async () => {
          createReached = true;
          return new Promise(() => {});
        }
      } }),
      readTeacherProvisionAuthenticationWithRetry: async () => ({ user: null, owned: false }),
      teacherAuthCreateDefinitelyRejected: () => false,
      cloudErrorDetails: (error) => ({ code: error?.code || "", message: error?.message || "" }),
      transitionTeacherFaceOperation: async () => {},
      fail: failure,
      console: { error() {} }
    };
    vm.createContext(workerSandbox);
    const workerSource = functionSource(staff, "provisionTeacherWithFace");
    vm.runInContext(`${workerSource}\nmodule.exports = provisionTeacherWithFace;`, workerSandbox,
      { filename: "staffAccount-background-teacher-worker.js" });
    const worker = workerSandbox.module.exports(
      { profile: { staffId: "900" } },
      {
        staffName: "挂起老师", phone: "13900000007", initialPassword: "Aa1!aaaa",
        clientRequestId: "background_worker_0001", consent: true,
        faceImageBase64: "data:image/jpeg;base64,/9j/2Q=="
      }
    ).finally(() => { workerSettled = true; });
    await waitUntil(() => createReached, 100,
      "background worker reaching the deliberately hanging Manager call");
    assert.equal(createReached, true, "the fixture must really be suspended inside Manager createUser");
    assert.equal(workerSettled, false);

    const statusSandbox = {
      module: { exports: {} },
      requireHq: () => {},
      requireTeacherFaceOperationSchema: async () => {},
      numericId,
      readTeacherFaceOperation: async () => ({ ...activeRow }),
      teacherAuthOwnershipUncertaintyOperation: () => false,
      makeTeacherAuthOwnershipUncertaintyCleanupEligible: async () => ({ ...activeRow }),
      teacherOperationLeaseRetryAfterSeconds: () => 700,
      teacherAuthOwnershipUncertaintyRetryAfterSeconds: () => 700,
      teacherProvisionInvocationActive: (code) => /^V6[34]_INVOCATION_ACTIVE:/.test(String(code || "")),
      teacherProvisionWorkerReady: (code) => String(code || "") === "V64_WORKER_READY",
      reconcileTeacherFaceOperation: async () => { throw new Error("ACTIVE must not be reconciled early"); },
      fail: failure
    };
    vm.createContext(statusSandbox);
    vm.runInContext(`${statusPayloadSource}\n${statusSource}\nmodule.exports = getTeacherFaceOperationStatus;`, statusSandbox,
      { filename: "staffAccount-read-teacher-provision-status.js" });
    const status = await within(statusSandbox.module.exports(
      { profile: { role: "hq" } }, { operationId: "82", readOnly: true }
    ), 100, "getTeacherFaceOperationStatus while worker is hanging");
    assert.equal(String(status.operationId), "82");
    assert.equal(status.status, "RUNNING");
    assert.notEqual(status.retrySameRequest, true,
      "ACTIVE status must never authorize a concurrent second worker");
    assert.equal(workerSettled, false,
      "the status proof must be independent of the unresolved worker invocation");
    void worker;
  }

  // The database-published stage is the sole concurrency signal. ACTIVE only
  // waits; READY alone authorizes exactly one same-request worker; a fully
  // cleaned cancellation unlocks a new request; SUCCEEDED asks the client to
  // obtain the normal five-proof replay without performing writes here.
  {
    async function readStatus(row) {
      const sandbox = {
        module: { exports: {} },
        requireHq: () => {},
        requireTeacherFaceOperationSchema: async () => {},
        numericId,
        readTeacherFaceOperation: async () => ({
          operation_id: "83",
          operation_type: "PROVISION",
          lease_retry_after_seconds: 120,
          cleanup_completed_at: null,
          ...row
        }),
        teacherOperationLeaseRetryAfterSeconds: (value) => Number(value.lease_retry_after_seconds || 0),
        teacherAuthOwnershipUncertaintyOperation: () => false,
        teacherAuthOwnershipUncertaintyRetryAfterSeconds: () => 0,
        teacherProvisionInvocationActive: (code) => /^V6[34]_INVOCATION_ACTIVE:/.test(String(code || "")),
        teacherProvisionWorkerReady: (code) => String(code || "") === "V64_WORKER_READY",
        fail: failure
      };
      vm.createContext(sandbox);
      vm.runInContext(`${statusPayloadSource}\n${statusSource}\nmodule.exports = getTeacherFaceOperationStatus;`, sandbox);
      return within(sandbox.module.exports(
        { profile: { role: "hq" } }, { operationId: "83", readOnly: true }
      ), 100, `read status ${row.error_code || row.operation_status}`);
    }

    const active = await readStatus({
      operation_status: "RUNNING",
      error_code: "V64_INVOCATION_ACTIVE:" + "bb".repeat(32)
    });
    assert.equal(active.status, "RUNNING");
    assert.equal(active.stage, "WORKER_RUNNING");
    assert.equal(active.workerReady, false);
    assert.equal(active.retrySameRequest, false);

    const legacyActive = await readStatus({
      operation_status: "RUNNING",
      error_code: "V63_INVOCATION_ACTIVE:" + "cc".repeat(32)
    });
    assert.equal(legacyActive.status, "RUNNING");
    assert.equal(legacyActive.stage, "WORKER_RUNNING",
      "a still-live v63 invocation must remain wait-only after the v64 deployment");
    assert.equal(legacyActive.workerReady, false);
    assert.equal(legacyActive.retrySameRequest, false);

    const ready = await readStatus({
      operation_status: "RUNNING",
      error_code: "V64_WORKER_READY"
    });
    assert.equal(ready.status, "RUNNING");
    assert.equal(ready.stage, "READY");
    assert.equal(ready.workerReady, true);
    assert.equal(ready.retrySameRequest, true,
      "READY is the only stage that may start a replacement worker invocation");
    assert.ok(Number(ready.retryAfterSeconds) >= 0);

    const succeeded = await readStatus({
      operation_status: "SUCCEEDED",
      error_code: null,
      lease_retry_after_seconds: 0
    });
    assert.equal(succeeded.status, "SUCCEEDED");
    assert.equal(succeeded.workerReady, false);
    assert.equal(succeeded.retrySameRequest, false);

    const cancelled = await readStatus({
      operation_status: "CANCELLED",
      error_code: "AUTH_CREATE_REJECTED",
      cleanup_completed_at: "2026-08-21T00:00:00.000Z",
      lease_retry_after_seconds: 0
    });
    assert.equal(cancelled.status, "CANCELLED");
    assert.equal(cancelled.cleanupComplete, true);
    assert.equal(cancelled.retryAllowed, true,
      "only a cancellation with durable cleanup proof may unlock a fresh request/photo");
    assert.equal(cancelled.workerReady, false);
    assert.equal(cancelled.retrySameRequest, false);
  }

  // The dedicated terminal result endpoint is a replay verifier, not a worker.
  // It must prove the exact operation, actor, immutable request, password-derived
  // owner token and original photo before issuing only authoritative reads.
  {
    const input = {
      operationId: "101",
      staffName: "最终证明老师",
      phone: "13900000011",
      initialPassword: "Aa1!proof-password",
      clientRequestId: "result_read_0001",
      consent: true,
      faceImageBase64: "data:image/jpeg;base64,/9j/result-proof",
      readOnly: true
    };
    const imageBuffer = Buffer.from(input.faceImageBase64, "utf8");
    const imageDigest = crypto.createHash("sha256").update(imageBuffer).digest("hex");
    const payloadSecretDigest = crypto.createHash("sha256")
      .update(input.initialPassword, "utf8").digest("hex");
    const sameRequestOwnerToken = (value) => crypto.createHash("sha256").update(JSON.stringify([
      value.operationType, value.clientRequestId, value.phone, value.teacherName,
      value.imageDigest, value.imageBytes, value.faceGroupId, value.photoBucketId,
      String(value.actorStaffId), value.payloadSecretDigest
    ])).digest("hex");
    const ownerToken = sameRequestOwnerToken({
      operationType: "PROVISION",
      clientRequestId: input.clientRequestId,
      phone: input.phone,
      teacherName: input.staffName,
      imageDigest,
      imageBytes: imageBuffer.length,
      faceGroupId: "teacher-face-group",
      photoBucketId: "customer-private-photos",
      actorStaffId: 900,
      payloadSecretDigest
    });
    const ownerTokenHash = crypto.createHash("sha256").update(ownerToken).digest("hex");
    const personId = `person-${imageDigest.slice(0, 20)}`;
    const operationRow = {
      operation_id: "101",
      operation_type: "PROVISION",
      operation_status: "SUCCEEDED",
      client_request_id: input.clientRequestId,
      phone: input.phone,
      teacher_name: input.staffName,
      image_sha256: imageDigest,
      image_bytes: imageBuffer.length,
      actor_staff_account_id: "900",
      owner_token_sha256: ownerTokenHash,
      auth_owner_token_sha256: ownerTokenHash,
      face_group_id: "teacher-face-group",
      photo_bucket_id: "customer-private-photos",
      lease_generation: 7,
      staff_id: "901",
      teacher_id: "701",
      auth_uid: "teacher-auth-result-proof",
      person_id: personId
    };
    let operationReads = 0;
    let sqlReads = 0;
    let delegatedReads = 0;
    let finalReads = 0;
    const sandbox = {
      module: { exports: {} },
      Buffer,
      crypto,
      requireTeacherFaceSchema: async () => {},
      requireTeacherExperienceFaceSubjectSchema: async () => {},
      requireTeacherFaceOperationSchema: async () => {},
      numericId,
      validatePhone: (value) => String(value),
      validatePassword: (value) => String(value),
      teacherFaceProvisionRequestId: (value) => String(value),
      teacherFaceImage: (value) => ({ buffer: Buffer.from(String(value), "utf8") }),
      teacherFaceOperationImageMetadata: (image) => ({
        imageDigest: crypto.createHash("sha256").update(image.buffer).digest("hex"),
        imageBytes: image.buffer.length
      }),
      teacherProvisionPayloadSecretDigest: (value) => crypto.createHash("sha256")
        .update(String(value), "utf8").digest("hex"),
      teacherFaceSameRequestOwnerToken: sameRequestOwnerToken,
      teacherFaceOwnerTokenHash: (value) => crypto.createHash("sha256").update(value).digest("hex"),
      teacherOperationLeaseRetryAfterSeconds: () => 60,
      teacherProvisionOperationStatusPayload: () => ({ stage: "SUCCEEDED" }),
      readTeacherFaceOperation: async (operationId) => {
        operationReads += 1;
        return String(operationId) === "101" ? { ...operationRow } : null;
      },
      teacherFacePersonId: (buffer) => `person-${crypto.createHash("sha256")
        .update(buffer).digest("hex").slice(0, 20)}`,
      sqlText,
      executeSql: async (sql) => {
        assert.match(String(sql), /^\s*SELECT\b/i,
          "readTeacherProvisionResult must reject every non-SELECT SQL command");
        sqlReads += 1;
        return [{
          staff_id: "901", auth_uid: "teacher-auth-result-proof", role_code: "teacher",
          account_status: "ACTIVE", teacher_id: "701", teacher_code: "T701",
          teacher_name: input.staffName, teacher_status: "ACTIVE",
          face_person_id: personId, face_enrollment_status: "ENROLLED",
          profile_photo_file_id: "private-photo-101"
        }];
      },
      teacherFaceDelegationLease: (operation) => ({
        faceOperationId: operation.id,
        faceOperationOwnerToken: operation.ownerToken,
        faceOperationLeaseGeneration: operation.leaseGeneration
      }),
      finalDelegatedTeacherFaceReadback: async (readback, operation, statuses) => {
        delegatedReads += 1;
        assert.equal(readback.operation, "READBACK");
        assert.equal(readback.personId, personId);
        assert.equal(operation.id, "101");
        assert.equal(operation.ownerToken, ownerToken);
        assert.equal(operation.ownerTokenHash, ownerTokenHash);
        assert.deepEqual(Array.from(statuses), ["SUCCEEDED"]);
        return { verifiedReadback: {
          person: { confirmed: true },
          photo: { authenticated: true },
          database: { confirmed: true },
          photoReference: "private-photo-101"
        } };
      },
      authoritativeTeacherProvisioningState: async (value) => {
        finalReads += 1;
        assert.equal(value.personId, personId);
        assert.equal(value.photoReference, "private-photo-101");
        return {
          database: {
            staff_account_id: "901", id: "701", teacher_code: "T701",
            teacher_name: input.staffName, teacher_status: "ACTIVE",
            account_status: "ACTIVE", face_person_id: personId,
            face_enrollment_status: "ENROLLED", face_enrolled_at: "2026-08-21T00:00:00Z",
            profile_photo_file_id: "private-photo-101"
          },
          identity: { UserStatus: "ACTIVE" }
        };
      },
      acquireTeacherFaceOperation: () => { throw new Error("result read acquired a lease"); },
      claimTeacherProvisionInvocation: () => { throw new Error("result read claimed a worker"); },
      transitionTeacherFaceOperation: () => { throw new Error("result read transitioned state"); },
      manager: () => { throw new Error("result read called Manager mutation"); },
      delegateTeacherFace: () => { throw new Error("result read called face mutation"); },
      fail: failure
    };
    vm.createContext(sandbox);
    vm.runInContext(`${resultReadSource}\nmodule.exports = readTeacherProvisionResult;`, sandbox,
      { filename: "staffAccount-read-teacher-provision-result.js" });

    const caller = { profile: { staffId: "900" } };
    const result = await within(sandbox.module.exports(caller, { ...input }), 100,
      "read-only teacher provision proof");
    assert.equal(result.ok, true);
    assert.equal(result.resultReadOnly, true);
    assert.equal(result.readbackConfirmed, true);
    assert.equal(result.verification.complete, true);
    assert.equal(result.uid, "teacher-auth-result-proof");
    assert.equal(result.teacher.faceEnrollmentStatus, "ENROLLED");
    assert.equal(result.teacher.facePhotoReady, true);

    // Two concurrent readers are independent pure reads: neither invalidates
    // the other's lease/generation and both return the complete proof.
    const concurrent = await within(Promise.all([
      sandbox.module.exports(caller, { ...input }),
      sandbox.module.exports(caller, { ...input })
    ]), 100, "concurrent read-only terminal proofs");
    assert.equal(concurrent[0].verification.complete, true);
    assert.equal(concurrent[1].verification.complete, true);
    assert.equal(operationReads, 3);
    assert.equal(sqlReads, 3);
    assert.equal(delegatedReads, 3);
    assert.equal(finalReads, 3);

    const mismatches = [
      [{ ...input, staffName: "另一位老师" }, "name"],
      [{ ...input, phone: "13900000012" }, "phone"],
      [{ ...input, initialPassword: "Aa1!wrong-password" }, "password owner"],
      [{ ...input, clientRequestId: "result_read_other" }, "request id"],
      [{ ...input, faceImageBase64: `${input.faceImageBase64}-different` }, "original photo"]
    ];
    for (const [mismatch, label] of mismatches) {
      await assert.rejects(
        sandbox.module.exports(caller, mismatch),
        (error) => error?.code === "TEACHER_FACE_OPERATION_REPLAY_MISMATCH",
        `mismatched ${label} must not read or return terminal proof`
      );
    }
    await assert.rejects(
      sandbox.module.exports({ profile: { staffId: "901" } }, { ...input }),
      (error) => error?.code === "TEACHER_FACE_OPERATION_REPLAY_MISMATCH",
      "a different actor cannot replay the operation"
    );
    await assert.rejects(
      sandbox.module.exports(caller, { ...input, operationId: "102" }),
      (error) => error?.code === "NOT_FOUND",
      "the result read is scoped to the exact operation id"
    );
    assert.equal(sqlReads, 3,
      "mismatch rejection must happen before staff/teacher or remote proof reads");
    assert.equal(delegatedReads, 3);
    assert.equal(finalReads, 3);
  }

  // Concurrent observers share one read. A browser watchdog must then evict
  // only that hung flight so the next serial tick can recover; a late stale
  // completion may never erase or replace the newer operation-scoped flight.
  {
    let nextTimerId = 1;
    const timers = new Map();
    const requests = [];
    const window = {
      CloudBaseAuthConfig: { env: "runtime-test" },
      registerAuth: () => {},
      registerFunctions: () => {},
      setTimeout: (callback) => {
        const id = nextTimerId++;
        timers.set(id, callback);
        return id;
      },
      clearTimeout: (id) => { timers.delete(id); }
    };
    window.cloudbase = {
      init: () => ({
        callFunction: (request) => new Promise((resolve, reject) => {
          requests.push({ request, resolve, reject });
        })
      })
    };
    const sandbox = {
      window,
      Promise,
      Map,
      Date,
      JSON,
      Object,
      String,
      Number,
      Math,
      Error,
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} }
    };
    vm.createContext(sandbox);
    vm.runInContext(cloudbasePhoneAuth, sandbox,
      { filename: "cloudbase-phone-auth-v64-flight-runtime.js" });
    const api = window.CloudBasePhoneAuth;
    const fireOnlyTimer = () => {
      assert.equal(timers.size, 1, "exactly one watchdog observer should be pending");
      const [id, callback] = timers.entries().next().value;
      timers.delete(id);
      callback();
    };

    const firstStatus = api.getTeacherFaceOperationStatus({ operationId: "201", readOnly: true });
    const concurrentStatus = api.getTeacherFaceOperationStatus({ operationId: "201", readOnly: true });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].request.data.action, "getTeacherFaceOperationStatus");
    assert.equal(requests[0].request.data.readOnly, true);
    requests[0].resolve({ result: {
      ok: true, operationId: "201", status: "RUNNING", stage: "WORKER_RUNNING"
    } });
    const sharedStatuses = await Promise.all([firstStatus, concurrentStatus]);
    assert.equal(sharedStatuses[0].operationId, "201");
    assert.equal(sharedStatuses[1].operationId, "201");
    assert.equal(timers.size, 0);

    const staleStatus = api.getTeacherFaceOperationStatus({ operationId: "202", readOnly: true });
    assert.equal(requests.length, 2);
    fireOnlyTimer();
    await assert.rejects(staleStatus, (error) => error?.code === "CLIENT_REQUEST_TIMEOUT");
    const replacementStatus = api.getTeacherFaceOperationStatus({ operationId: "202", readOnly: true });
    assert.equal(requests.length, 3,
      "watchdog expiry must release a hung status flight so the next tick starts a pure-read retry");
    requests[1].resolve({ result: {
      ok: true, operationId: "202", status: "RUNNING", stage: "STALE_LATE_RESULT"
    } });
    await Promise.resolve();
    const sharedReplacementStatus = api.getTeacherFaceOperationStatus({ operationId: "202", readOnly: true });
    assert.equal(requests.length, 3,
      "a stale flight's late finally must not erase the newer status flight");
    requests[2].resolve({ result: {
      ok: true, operationId: "202", status: "SUCCEEDED", stage: "SUCCEEDED"
    } });
    const replacementStatuses = await Promise.all([replacementStatus, sharedReplacementStatus]);
    assert.equal(replacementStatuses[0].stage, "SUCCEEDED");
    assert.equal(replacementStatuses[1].stage, "SUCCEEDED");

    const frozenProofInput = Object.freeze({
      operationId: "203", staffName: "单例证明老师", phone: "13900000013",
      initialPassword: "Aa1!singleton", clientRequestId: "singleton_result_0001",
      consent: true, faceImageBase64: "data:image/jpeg;base64,/9j/singleton",
      readOnly: true
    });
    const staleProof = api.readTeacherProvisionResult(frozenProofInput);
    assert.equal(requests.length, 4);
    const proofRequest = requests[3].request.data;
    assert.equal(proofRequest.action, "readTeacherProvisionResult");
    for (const key of [
      "operationId", "staffName", "phone", "initialPassword", "clientRequestId",
      "consent", "faceImageBase64", "readOnly"
    ]) {
      assert.equal(proofRequest[key], frozenProofInput[key],
        `proof wrapper must preserve frozen ${key}`);
    }
    fireOnlyTimer();
    await assert.rejects(staleProof, (error) => error?.code === "CLIENT_REQUEST_TIMEOUT");
    const replacementProof = api.readTeacherProvisionResult(frozenProofInput);
    assert.equal(requests.length, 5,
      "watchdog expiry must release a hung result flight so the next tick starts a pure-read retry");
    requests[3].resolve({ result: { ...completeTeacherProvisionProof(), uid: "stale-proof" } });
    await Promise.resolve();
    const sharedReplacementProof = api.readTeacherProvisionResult(frozenProofInput);
    assert.equal(requests.length, 5,
      "a stale result flight's late finally must not erase the newer proof flight");
    requests[4].resolve({ result: completeTeacherProvisionProof() });
    const proofs = await Promise.all([replacementProof, sharedReplacementProof]);
    assert.equal(proofs[0].resultReadOnly, true);
    assert.equal(proofs[0].verification.complete, true);
    assert.equal(proofs[1].uid, "teacher-auth-proof");
    assert.equal(timers.size, 0);
  }

  // Camera preflight is another external Promise that may never settle. Its
  // local watchdog must fail without saving anything, ignore a late response,
  // and clear timers on both timeout and normal completion.
  {
    let nextTimerId = 1;
    const timers = new Map();
    const clearedTimers = [];
    const calls = [];
    let firstResolve;
    const faceApp = {
      callFunction: (request) => {
        calls.push(request);
        if (calls.length === 1) {
          return new Promise((resolve) => { firstResolve = resolve; });
        }
        return Promise.resolve({ result: { ok: true, quality: { score: 88 }, liveness: { checked: true } } });
      }
    };
    const window = {
      cloudbase: { init: () => faceApp },
      CloudBaseAuthConfig: { env: "face-validation-runtime" },
      registerAuth: () => {},
      registerFunctions: () => {},
      setTimeout: (callback, milliseconds) => {
        assert.equal(milliseconds, 15_000);
        const id = nextTimerId++;
        timers.set(id, callback);
        return id;
      },
      clearTimeout: (id) => {
        clearedTimers.push(id);
        timers.delete(id);
      }
    };
    const sandbox = { module: { exports: {} }, window, Promise, Error, Object, JSON };
    vm.createContext(sandbox);
    vm.runInContext(`
      let faceServiceApp = null;
      ${frontendRegisterComponentSource}
      ${frontendResponseDataSource}
      ${frontendFaceValidationSource}
      module.exports = callFaceValidation;
    `, sandbox, { filename: "teacher-face-validation-watchdog-runtime.js" });

    const timedOut = sandbox.module.exports("data:image/jpeg;base64,/9j/2Q==");
    assert.equal(calls.length, 1);
    assert.equal(timers.size, 1);
    const timeoutCallback = timers.values().next().value;
    timeoutCallback();
    await assert.rejects(timedOut, (error) => error?.code === "FACE_VALIDATION_TIMEOUT");
    assert.equal(timers.size, 0, "timeout rejection must clear its watchdog timer");
    firstResolve({ result: { ok: true, quality: { score: 100 }, liveness: { checked: true } } });
    await Promise.resolve();
    assert.equal(calls.length, 1,
      "a late validation response cannot restart or mutate the already failed capture flow");

    const succeeded = await sandbox.module.exports("data:image/jpeg;base64,/9j/2Q==");
    assert.equal(succeeded.ok, true);
    assert.equal(calls.length, 2);
    assert.equal(timers.size, 0, "normal completion must also clear its watchdog timer");
    assert.equal(clearedTimers.length, 2);
  }

  // Input/configuration rejection is definitive and must unlock editing. Only
  // transport uncertainty preserves the same frozen request for safe resume.
  {
    const definitive = Object.assign(new Error("bad request"), { code: "BAD_REQUEST" });
    const definitiveHarness = frontendHarness({
      beginTeacherProvisionWithFace: async () => { throw definitive; }
    });
    let caught = null;
    try {
      await definitiveHarness.functions.beginTeacherProvision({
        staffName: "输入错误老师", phone: "13900000014", initialPassword: "bad",
        clientRequestId: "definitive_begin_0001", consent: true,
        faceImageBase64: "data:image/jpeg;base64,/9j/2Q=="
      }, { faceImageSha256: "34".repeat(32), faceImageBytes: 4 });
    } catch (error) {
      caught = error;
    }
    assert.equal(caught, definitive);
    assert.notEqual(caught.sameRequestResumeDeferred, true,
      "a definitive validation failure must not permanently lock the form/photo");

    let uncertainCalls = 0;
    const uncertainHarness = frontendHarness({
      beginTeacherProvisionWithFace: async () => {
        uncertainCalls += 1;
        throw Object.assign(new Error("network timed out"), { code: "TIMEOUT" });
      }
    });
    caught = null;
    try {
      await uncertainHarness.functions.beginTeacherProvision({
        staffName: "网络不确定老师", phone: "13900000015", initialPassword: "Aa1!aaaa",
        clientRequestId: "uncertain_begin_0001", consent: true,
        faceImageBase64: "data:image/jpeg;base64,/9j/2Q=="
      }, { faceImageSha256: "56".repeat(32), faceImageBytes: 4 });
    } catch (error) {
      caught = error;
    }
    assert.equal(uncertainCalls, 3);
    assert.equal(caught.sameRequestResumeDeferred, true,
      "transport uncertainty must retain the exact request/photo for idempotent resume");
  }

  // The browser launches the long worker fire-and-forget. Even if that first
  // promise never settles, read-only polling continues and a terminal row is
  // accepted only after an independent same-payload replay yields every
  // authoritative proof.
  {
    const beginCalls = [];
    const workerCalls = [];
    const statusCalls = [];
    const proofCalls = [];
    const statuses = [
      { ok: true, operationId: "91", status: "RUNNING", stage: "WORKER_RUNNING",
        workerReady: false, retrySameRequest: false, retryAfterSeconds: 1 },
      { ok: true, operationId: "91", status: "SUCCEEDED", stage: "SUCCEEDED",
        workerReady: false, retrySameRequest: false, retryAfterSeconds: 0 }
    ];
    const api = {
      beginTeacherProvisionWithFace: async (value) => {
        beginCalls.push(value);
        return { ok: true, accepted: true, operationId: "91", status: "RUNNING",
          stage: "READY", workerReady: true, retrySameRequest: true, retryAfterSeconds: 0 };
      },
      provisionTeacherWithFace: (value) => {
        workerCalls.push(value);
        return new Promise(() => {});
      },
      getTeacherFaceOperationStatus: async (value) => {
        statusCalls.push(value);
        return statuses.shift() || statuses[statuses.length - 1];
      },
      readTeacherProvisionResult: async (value) => {
        proofCalls.push(value);
        return completeTeacherProvisionProof();
      }
    };
    const { functions } = frontendHarness(api);
    const input = Object.freeze({
      staffName: "不阻塞老师", phone: "13900000007", initialPassword: "Aa1!aaaa",
      clientRequestId: "frontend_background_0001", consent: true,
      faceImageBase64: "data:image/jpeg;base64,/9j/2Q=="
    });
    const result = await within(functions.provisionTeacherWithBackgroundPolling(input, {
      faceImageSha256: "ef".repeat(32), faceImageBytes: 4
    }), 500, "browser orchestration with a never-settling worker promise");
    assert.equal(result.uid, "teacher-auth-proof");
    assert.equal(beginCalls.length, 1);
    assert.equal(Object.hasOwn(beginCalls[0], "faceImageBase64"), false,
      "raw face bytes must not be part of the fast begin request");
    assert.equal(beginCalls[0].faceImageSha256, "ef".repeat(32));
    assert.equal(beginCalls[0].faceImageBytes, 4);
    assert.equal(workerCalls.length, 1,
      "the terminal readback must not invoke the hanging mutating worker again");
    assert.equal(workerCalls[0], input,
      "the worker must receive the original immutable request including the photo");
    assert.equal(proofCalls.length, 1);
    assert.equal(proofCalls[0].operationId, "91");
    assert.equal(proofCalls[0].readOnly, true);
    for (const key of [
      "staffName", "phone", "initialPassword", "clientRequestId", "consent", "faceImageBase64"
    ]) {
      assert.equal(proofCalls[0][key], input[key],
        `terminal proof must replay the exact frozen ${key}`);
    }
    assert.equal(Object.keys(proofCalls[0]).length, Object.keys(input).length + 2,
      "terminal proof may add only operationId and readOnly to the frozen worker payload");
    assert.ok(statusCalls.length >= 2);
    assert.ok(statusCalls.every((value) => value.operationId === "91" && value.readOnly === true),
      "polling must be operation-scoped and read-only even while a worker hangs");
  }

  // An ACTIVE lease is observation-only. It must not start a duplicate worker;
  // a cleaned cancellation is the only terminal failure that unlocks retry.
  {
    let workerCalls = 0;
    const statusCalls = [];
    const api = {
      beginTeacherProvisionWithFace: async () => ({
        ok: true, accepted: true, operationId: "92", status: "RUNNING",
        stage: "WORKER_RUNNING", workerReady: false, retrySameRequest: false,
        retryAfterSeconds: 1
      }),
      provisionTeacherWithFace: async () => { workerCalls += 1; },
      getTeacherFaceOperationStatus: async (value) => {
        statusCalls.push(value);
        return { ok: true, operationId: "92", status: "CANCELLED", stage: "CANCELLED",
          cleanupComplete: true, retryAllowed: true, retryAfterSeconds: 0 };
      }
    };
    const { functions } = frontendHarness(api);
    let caught = null;
    try {
      await within(functions.provisionTeacherWithBackgroundPolling({
        staffName: "活跃租约老师", phone: "13900000008", initialPassword: "Aa1!aaaa",
        clientRequestId: "frontend_active_0001", consent: true,
        faceImageBase64: "data:image/jpeg;base64,/9j/2Q=="
      }, { faceImageSha256: "ab".repeat(32), faceImageBytes: 4 }), 500,
      "ACTIVE browser polling contract");
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, "cleaned cancellation must be reported as failure, never success");
    assert.equal(caught.cleanupComplete, true);
    assert.equal(workerCalls, 0, "ACTIVE must not launch or duplicate a worker");
    assert.equal(statusCalls.length, 1);
    assert.equal(statusCalls[0].operationId, "92");
    assert.equal(statusCalls[0].readOnly, true);
  }

  // READY is a fresh durable authorization. A failed fire-and-forget attempt
  // can be replaced only after a later status read publishes READY again.
  {
    let workerCalls = 0;
    let proofCalls = 0;
    const statusCalls = [];
    const statuses = [
      { ok: true, operationId: "93", status: "RUNNING", stage: "READY",
        workerReady: true, retrySameRequest: true, retryAfterSeconds: 0 },
      { ok: true, operationId: "93", status: "SUCCEEDED", stage: "SUCCEEDED",
        workerReady: false, retrySameRequest: false, retryAfterSeconds: 0 }
    ];
    const api = {
      beginTeacherProvisionWithFace: async () => ({
        ok: true, accepted: true, operationId: "93", status: "RUNNING", stage: "READY",
        workerReady: true, retrySameRequest: true, retryAfterSeconds: 0
      }),
      provisionTeacherWithFace: async () => {
        workerCalls += 1;
        if (workerCalls === 1) throw Object.assign(new Error("transport timeout"), { code: "TIMEOUT" });
        return { ok: true, accepted: true };
      },
      getTeacherFaceOperationStatus: async (value) => {
        statusCalls.push(value);
        return statuses.shift();
      },
      readTeacherProvisionResult: async (value) => {
        assert.equal(value.operationId, "93");
        assert.equal(value.readOnly, true);
        assert.equal(value.staffName, "可重启老师");
        assert.equal(value.phone, "13900000009");
        assert.equal(value.initialPassword, "Aa1!aaaa");
        assert.equal(value.clientRequestId, "frontend_ready_0001");
        assert.equal(value.consent, true);
        assert.equal(value.faceImageBase64, "data:image/jpeg;base64,/9j/2Q==");
        proofCalls += 1;
        return completeTeacherProvisionProof();
      }
    };
    const { functions } = frontendHarness(api, { minimumWaitAdvance: 16_000 });
    const result = await within(functions.provisionTeacherWithBackgroundPolling({
      staffName: "可重启老师", phone: "13900000009", initialPassword: "Aa1!aaaa",
      clientRequestId: "frontend_ready_0001", consent: true,
      faceImageBase64: "data:image/jpeg;base64,/9j/2Q=="
    }, { faceImageSha256: "cd".repeat(32), faceImageBytes: 4 }), 500,
    "READY-authorized replacement worker");
    assert.equal(result.uid, "teacher-auth-proof");
    assert.equal(workerCalls, 2,
      "READY permits exactly one replacement worker and SUCCEEDED performs no mutation");
    assert.equal(proofCalls, 1);
    assert.equal(statusCalls.length, 2);
    assert.ok(statusCalls.every((value) => value.readOnly === true));
  }

  // A malicious or stale status source that continuously publishes READY must
  // not produce a 2-second 3 MiB request storm. Attempts persist across another
  // orchestration call for the same request id and remain fenced 0/15s/45s.
  {
    const workerStartedAt = [];
    const statusCalls = [];
    let readClock = () => 0;
    let beginCalls = 0;
    const ready = () => ({
      ok: true, operationId: "95", status: "RUNNING", stage: "READY",
      workerReady: true, retrySameRequest: true, retryAfterSeconds: 1
    });
    const api = {
      beginTeacherProvisionWithFace: async () => {
        beginCalls += 1;
        return { ok: true, accepted: true, operationId: "95", ...ready() };
      },
      provisionTeacherWithFace: () => {
        workerStartedAt.push(readClock());
        return new Promise(() => {});
      },
      getTeacherFaceOperationStatus: async (value) => {
        statusCalls.push(value);
        return statusCalls.length <= 36
          ? ready()
          : { ok: true, operationId: "95", status: "SUCCEEDED", stage: "SUCCEEDED" };
      },
      readTeacherProvisionResult: async () => completeTeacherProvisionProof()
    };
    const harness = frontendHarness(api);
    readClock = harness.now;
    const input = Object.freeze({
      staffName: "持续就绪老师", phone: "13900000016", initialPassword: "Aa1!aaaa",
      clientRequestId: "frontend_ready_storm_0001", consent: true,
      faceImageBase64: "data:image/jpeg;base64,/9j/2Q=="
    });
    const metadata = { faceImageSha256: "78".repeat(32), faceImageBytes: 4 };
    const first = await within(
      harness.functions.provisionTeacherWithBackgroundPolling(input, metadata),
      500,
      "continuous READY delivery fencing"
    );
    assert.equal(first.uid, "teacher-auth-proof");
    assert.equal(workerStartedAt.length, 3,
      "continuous READY may deliver no more than three worker payloads per page/request");
    assert.ok(workerStartedAt[1] - workerStartedAt[0] >= 15_000,
      "the second full-payload delivery must wait at least 15 seconds");
    assert.ok(workerStartedAt[2] - workerStartedAt[1] >= 45_000,
      "the third full-payload delivery must wait the configured 45-second fence");

    // Re-enter the same helper with the same request id. The module-level
    // delivery state must prevent the click/re-entry from resetting the cap.
    const second = await within(
      harness.functions.provisionTeacherWithBackgroundPolling(input, metadata),
      500,
      "same-request page-lifetime delivery cap"
    );
    assert.equal(second.uid, "teacher-auth-proof");
    assert.equal(beginCalls, 2);
    assert.equal(workerStartedAt.length, 3,
      "the same request cannot obtain three more deliveries by re-entering the helper");
    assert.ok(statusCalls.every((value) => value.operationId === "95" && value.readOnly === true));
  }

  // A success-looking response with any missing proof is false. Verify both
  // the proof predicate itself and the SUCCEEDED polling branch.
  {
    const { functions } = frontendHarness({});
    const requiredMutations = [
      (value) => { value.ok = false; },
      (value) => { value.resultReadOnly = false; },
      (value) => { value.readbackConfirmed = false; },
      (value) => { value.verification.complete = false; },
      (value) => { value.verification.personConfirmed = false; },
      (value) => { value.verification.privatePhotoConfirmed = false; },
      (value) => { value.verification.delegatedDatabaseConfirmed = false; },
      (value) => { value.verification.finalDatabaseConfirmed = false; },
      (value) => { value.verification.facePhotoReady = false; },
      (value) => { value.verification.teacherActive = false; },
      (value) => { value.verification.accountActive = false; },
      (value) => { value.verification.credentialActive = false; },
      (value) => { value.teacher.faceEnrollmentStatus = "PENDING"; },
      (value) => { value.teacher.facePhotoReady = false; },
      (value) => { value.teacher.teacherStatus = "ARCHIVED"; },
      (value) => { value.teacher.accountStatus = "BLOCKED"; },
      (value) => { value.teacher.credentialStatus = "BLOCKED"; },
      (value) => { value.teacher.teacherId = ""; },
      (value) => { value.uid = ""; }
    ];
    assert.ok(functions.teacherProvisionProof(completeTeacherProvisionProof()));
    for (const mutate of requiredMutations) {
      const incomplete = JSON.parse(JSON.stringify(completeTeacherProvisionProof()));
      mutate(incomplete);
      assert.equal(functions.teacherProvisionProof(incomplete), null,
        "no individual proof may be inferred or omitted");
    }

    let proofReadCalls = 0;
    let mutationCalls = 0;
    const incompleteApi = {
      beginTeacherProvisionWithFace: async () => ({
        ok: true, accepted: true, operationId: "94", status: "SUCCEEDED", stage: "SUCCEEDED"
      }),
      provisionTeacherWithFace: async () => {
        mutationCalls += 1;
        throw new Error("SUCCEEDED must never call the mutating worker");
      },
      readTeacherProvisionResult: async () => {
        proofReadCalls += 1;
        return { ok: true, resultReadOnly: true, readbackConfirmed: true,
          verification: { complete: true } };
      },
      getTeacherFaceOperationStatus: async () => ({
        ok: true, operationId: "94", status: "SUCCEEDED", stage: "SUCCEEDED"
      })
    };
    const incompleteHarness = frontendHarness(incompleteApi);
    let caught = null;
    try {
      await within(incompleteHarness.functions.provisionTeacherWithBackgroundPolling({
        staffName: "缺证明老师", phone: "13900000010", initialPassword: "Aa1!aaaa",
        clientRequestId: "frontend_incomplete_0001", consent: true,
        faceImageBase64: "data:image/jpeg;base64,/9j/2Q=="
      }, { faceImageSha256: "12".repeat(32), faceImageBytes: 4 }), 500,
      "incomplete SUCCEEDED proof rejection");
    } catch (error) {
      caught = error;
    }
    assert.ok(caught, "an incomplete replay must never resolve as teacher creation success");
    assert.match(String(caught.message), /最终证明/);
    assert.equal(proofReadCalls, 1);
    assert.equal(mutationCalls, 0);
  }

  console.log("teacher provision v64 background runtime contract: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
