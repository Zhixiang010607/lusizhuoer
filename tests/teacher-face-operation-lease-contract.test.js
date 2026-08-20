"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const staff = fs.readFileSync(path.join(root, "cloudfunctions", "staffAccount", "index.js"), "utf8");
const migration = fs.readFileSync(
  path.join(root, "database", "migrations", "051_teacher_face_operation_lease.sql"), "utf8"
);
const authCreateReceiptMigration = fs.readFileSync(
  path.join(root, "database", "migrations", "052_teacher_auth_create_receipt.sql"), "utf8"
);
const consoleDir = path.join(root, "database", "cloudbase-console");

function between(source, first, last) {
  const start = source.indexOf(first);
  const end = source.indexOf(last, start + first.length);
  assert.ok(start >= 0 && end > start, `missing source region ${first}`);
  return source.slice(start, end);
}

assert.match(migration, /owner_token_sha256 CHAR\(64\)/);
assert.match(migration, /face_group_id VARCHAR\(64\) NOT NULL/);
assert.match(migration, /photo_bucket_id VARCHAR\(128\) NOT NULL/);
assert.doesNotMatch(migration, /\n\s*owner_token\s+(?:TEXT|VARCHAR|CHAR)/i,
  "the durable table may store only the owner-token SHA-256 digest");
assert.match(migration, /operation_status IN \('RUNNING', 'SUCCEEDED', 'CANCELLED', 'CLEANUP_PENDING'\)/);
assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS uq_teacher_face_operation_open_phone/);
assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS uq_teacher_face_operation_open_teacher/);
assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS uq_teacher_face_operation_open_person/);
assert.match(migration,
  /IF NOT FOUND OR op\.operation_status <> p_expected_status[\s\S]*op\.lease_expires_at <= now_value THEN/,
  "an expired owner must be rejected while the transition row lock is held");
assert.match(migration,
  /operation_status = 'CLEANUP_PENDING'[\s\S]*lease_generation = target\.lease_generation \+ 1|lease_generation=x\.lease_generation\+1[\s\S]*operation_status='CLEANUP_PENDING'/,
  "expired acquisition must rotate generation and become cleanup-only");
assert.match(authCreateReceiptMigration,
  /ADD COLUMN IF NOT EXISTS auth_create_returned_uid VARCHAR\(128\)/,
  "a fulfilled createUser receipt must durably retain the UID actually returned by Auth");
assert.match(authCreateReceiptMigration,
  /ADD COLUMN IF NOT EXISTS auth_create_confirmed_at TIMESTAMPTZ/,
  "a fulfilled createUser receipt needs a durable confirmation timestamp");
assert.match(authCreateReceiptMigration,
  /auth_create_confirmed_at IS NULL[\s\S]*auth_create_returned_uid IS NOT NULL/,
  "the receipt timestamp may never exist without its returned UID");
assert.ok(fs.existsSync(path.join(consoleDir, "052-01-auth-create-receipt.sql")));
assert.ok(fs.existsSync(path.join(consoleDir, "052-readonly-verify.sql")));

assert.match(staff, /const ownerToken = crypto\.randomBytes\(32\)\.toString\("hex"\)/,
  "each invocation needs an unpredictable, non-idempotency-derived owner token");
assert.match(staff, /error\?\.authCreationUncertain[\s\S]*"RUNNING", "CLEANUP_PENDING"/,
  "a lost createUser response must remain an open cleanup tombstone");
assert.match(staff, /TEACHER_AUTH_CREATE_READBACK_DELAYS_MS = Object\.freeze\(\[[\s\S]*6000/,
  "Auth ownership must use bounded delayed readback rather than one immediate probe");
assert.match(staff, /TEACHER_AUTH_CREATE_UNCERTAINTY_FENCE_SECONDS = 90/,
  "Auth-only uncertainty must not inherit the 12-minute face-service fence");
assert.match(staff, /teacherAuthCreateReceiptFastPath: true/,
  "health must distinguish the v62 exact createUser receipt fast path in production");
assert.match(staff, /makeTeacherAuthOwnershipUncertaintyCleanupEligible\(operationId\)[\s\S]*takeoverTeacherFaceOperationCleanup\(operationId\)/,
  "the trusted reconciler must safely release legacy Auth-only tombstones after the short fence");
assert.match(staff,
  /const eligible = await makeTeacherAuthOwnershipUncertaintyCleanupEligible\(operationId\);[\s\S]{0,420}teacherOperationLeaseRetryAfterSeconds\(eligible\) > 0[\s\S]{0,180}continue;[\s\S]{0,180}takeoverTeacherFaceOperationCleanup\(operationId\)/,
  "a legacy scan match that fails the strict Auth-only predicate must retain its original lease");
assert.match(staff, /EXTRACT\(EPOCH FROM \([\s\S]{0,220}lease_retry_after_seconds[\s\S]{0,420}auth_uncertainty_retry_after_seconds/,
  "retry countdowns must be calculated by PostgreSQL instead of parsing timezone-dependent timestamps in JavaScript");
assert.match(staff, /if \(action === "getTeacherFaceOperationStatus"\)[\s\S]{0,180}getTeacherFaceOperationStatus\(caller, event\)/,
  "HQ must be able to poll the durable operation without replaying creation");
assert.match(staff, /retryAllowed: cleanupComplete && status !== "SUCCEEDED"/,
  "a successful operation must never tell the client to submit the same teacher again");
assert.match(staff, /operationId: error\?\.operationId[\s\S]{0,180}retryAfterSeconds/,
  "the safe pending response must expose only the operation id and bounded retry delay");
assert.match(staff, /teacherAuthCreateDefinitelyRejected\(createError\)[\s\S]{0,360}AUTH_CREATE_REJECTED/,
  "a definite Auth validation or authority rejection must not enter the ambiguous 90-second fence");
const provisionAuthSource = between(
  staff, "async function provisionTeacherWithFace", "\n\n// Face enrollment is deliberately independent"
);
const receiptUidPosition = provisionAuthSource.indexOf("const returnedUid =");
const persistReceiptPosition = provisionAuthSource.indexOf(
  "confirmTeacherAuthenticationCreateReceipt(", receiptUidPosition
);
const validateReceiptPosition = provisionAuthSource.indexOf(
  "teacherAuthenticationFromCreateReceipt(", persistReceiptPosition
);
const uncertainReadbackPosition = provisionAuthSource.indexOf(
  "readTeacherProvisionAuthenticationWithRetry(", validateReceiptPosition
);
assert.ok(receiptUidPosition >= 0
  && persistReceiptPosition > receiptUidPosition
  && validateReceiptPosition > persistReceiptPosition
  && uncertainReadbackPosition > validateReceiptPosition,
  "a fulfilled create receipt must be persisted and validated before only the uncertain branch polls Auth");
assert.match(provisionAuthSource.slice(receiptUidPosition, uncertainReadbackPosition), /authCreated = true/,
  "an exact createUser receipt must bypass discovery polling; only an uncertain response may poll Auth");
assert.match(staff, /if \(!completedBefore && !authCreated\)[\s\S]{0,180}blockTeacherAuthentication/,
  "an account atomically created BLOCKED must not be redundantly queried, blocked and queried again");
assert.match(staff,
  /delegated = await finalDelegatedTeacherFaceReadback\(delegationInput, faceOperation\);[\s\S]*finalState = await authoritativeTeacherProvisioningState\([\s\S]*transitionTeacherFaceOperation\(faceOperation, "RUNNING", "SUCCEEDED"\)/,
  "success requires final remote proof followed by final DB/Auth proof before SUCCEEDED");
assert.match(staff, /TEACHER_FACE_RECONCILE_TIMER_TRIGGER_NAME = "reconcile-teacher-face-operations"/);
assert.match(staff,
  /String\(fields\.imageBytes\),\s*String\(fields\.faceGroupId\),\s*String\(fields\.photoBucketId\),\s*String\(fields\.previousPersonId/,
  "the signed group and private bucket must precede the previous-face snapshot");
assert.match(staff, /String\(person\.groupId \|\| ""\) === String\(expected\.faceGroupId\)/);
assert.match(staff, /String\(photo\.bucketId \|\| ""\) === String\(expected\.photoBucketId\)/);
assert.match(staff, /LIMIT \$\{TEACHER_FACE_RECONCILE_BATCH_SIZE\}/);
assert.match(staff, /teacherOperationOwnsAuthentication\(before, phone, operationRow\)[\s\S]*userStatus: "BLOCKED"[\s\S]*UserStatus \|\| ""\)\.toUpperCase\(\) !== "BLOCKED"/,
  "saga Auth blocking needs exact ownership before write and BLOCKED readback after it");

for (let part = 1; part <= 10; part += 1) {
  const prefix = `051-${String(part).padStart(2, "0")}-`;
  const filename = fs.readdirSync(consoleDir).find((name) => name.startsWith(prefix) && name.endsWith(".sql"));
  assert.ok(filename, `missing CloudBase console part ${prefix}`);
  const contents = fs.readFileSync(path.join(consoleDir, filename), "utf8");
  const crlfBytes = Buffer.byteLength(contents.replace(/\r?\n/g, "\r\n"), "utf8");
  assert.ok(crlfBytes <= 3500, `${filename} exceeds the CRLF-safe 3500-byte console limit`);
  assert.match(contents, /BEGIN;[\s\S]*COMMIT;/);
}
assert.ok(fs.existsSync(path.join(consoleDir, "051-readonly-verify.sql")));

{
  const sandbox = {
    module: { exports: {} },
    cloudErrorDetails: (error) => ({ code: error?.code || "", message: error?.message || "" })
  };
  vm.createContext(sandbox);
  const classifier = between(
    staff, "function authErrorHttpStatus", "\n\nfunction managerDependencyInstalled"
  );
  vm.runInContext(`${classifier}\nmodule.exports = { isDuplicateAuthError, teacherAuthCreateDefinitelyRejected };`, sandbox);
  const api = sandbox.module.exports;
  assert.equal(api.teacherAuthCreateDefinitelyRejected({ code: "EXCEED_AUTHORITY", status: 403 }), true);
  assert.equal(api.teacherAuthCreateDefinitelyRejected({ code: "InvalidPassword", status: 400 }), true);
  assert.equal(api.teacherAuthCreateDefinitelyRejected({ code: "AuthFailure.SecretIdNotFound" }), true);
  assert.equal(api.teacherAuthCreateDefinitelyRejected({ code: "ETIMEDOUT" }), false);
  assert.equal(api.teacherAuthCreateDefinitelyRejected({ code: "HTTP_503", status: 503 }), false);
  assert.equal(api.teacherAuthCreateDefinitelyRejected({ code: "HTTP_429", status: 429 }), false);
  assert.equal(api.teacherAuthCreateDefinitelyRejected({ code: "CLIENT_CLOSED", status: 499 }), false,
    "a disconnected caller does not prove that the upstream create was rejected");
  assert.equal(api.teacherAuthCreateDefinitelyRejected({ code: "INVALID_PARAMETER", status: 503 }), false,
    "a 5xx transport result must win over nested rejection wording");
  assert.equal(api.teacherAuthCreateDefinitelyRejected({
    code: "INVALID_PARAMETER", response: { statusCode: 503 }
  }), false, "nested HTTP status shapes must retain the uncertainty fence");
  assert.equal(api.teacherAuthCreateDefinitelyRejected({
    code: "INVALID_PARAMETER", status: 0, response: { statusCode: 503 }
  }), false, "a zero outer status must not hide a valid nested 5xx status");
  assert.equal(api.teacherAuthCreateDefinitelyRejected({
    code: "INVALID_PARAMETER", status: "", response: { statusCode: 503 }
  }), false, "an empty outer status must not hide a valid nested 5xx status");
  assert.equal(api.teacherAuthCreateDefinitelyRejected({ code: "EXCEED_AUTHORITY", status: 429 }), false,
    "a rate-limit result must never unlock the operation early");
  assert.equal(api.isDuplicateAuthError({ code: "FailedOperation.DuplicatedData" }), true);
  assert.equal(api.isDuplicateAuthError({ code: "HTTP_503", status: 503, message: "duplicate request" }), false,
    "free-form duplicate text in an uncertain transport wrapper is not ownership proof");
}

function sqlText(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}
function numericId(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error("bad id");
  return number;
}
function runtimeFunction(sourceRegion, exportName, executeSql) {
  const sandbox = { module: { exports: {} }, executeSql, sqlText, numericId,
    console: { error() {} } };
  vm.createContext(sandbox);
  vm.runInContext(`${sourceRegion}\nmodule.exports = ${exportName};`, sandbox);
  return sandbox.module.exports;
}

(async () => {
  // A fulfilled createUser response containing the exact requested custom UID
  // is the authoritative write receipt. It must provide the known BLOCKED
  // identity immediately instead of waiting for a list/read replica.
  {
    const sandbox = {
      module: { exports: {} },
      fail(message, code) { const error = new Error(message); error.code = code; throw error; }
    };
    vm.createContext(sandbox);
    const receiptSource = between(
      staff,
      "function teacherAuthenticationFromCreateReceipt",
      "\n\nasync function readTeacherProvisionAuthenticationWithRetry"
    );
    vm.runInContext(
      `${receiptSource}\nmodule.exports = teacherAuthenticationFromCreateReceipt;`, sandbox
    );
    const receipt = sandbox.module.exports(
      { Data: { Uid: "teacher-auth-owned" } },
      "teacher-auth-owned", "13900000007", "teacher-face-saga:51:owner"
    );
    assert.deepEqual(JSON.parse(JSON.stringify(receipt)), {
      Uid: "teacher-auth-owned",
      Name: "staff_13900000007",
      Phone: "13900000007",
      UserStatus: "BLOCKED",
      Description: "teacher-face-saga:51:owner"
    });
    assert.equal(sandbox.module.exports({ Data: {} }, "teacher-auth-owned", "13900000007", "lease"), null);
    assert.throws(
      () => sandbox.module.exports(
        { Data: { Uid: "unexpected-auth" } },
        "teacher-auth-owned", "13900000007", "lease"
      ),
      (error) => error.code === "AUTH_CREATE_UID_MISMATCH"
    );
  }

  // Exercise the real teacher provisioning branch through the first local
  // profile write. An exact createUser receipt must be persisted and then
  // continue immediately: it must not enter the delayed Auth discovery helper
  // or issue a redundant BLOCK request for an account created BLOCKED.
  {
    const requestedUid = "teacher-auth-fast";
    const ownerToken = "ab".repeat(32);
    const ownerTokenHash = "cd".repeat(32);
    const operation = {
      id: "54", ownerToken, ownerTokenHash, leaseGeneration: 1,
      status: "RUNNING", imageDigest: "ef".repeat(32), imageBytes: 4
    };
    const markerUids = [];
    let createCalls = 0;
    let delayedDiscoveryCalls = 0;
    let blockCalls = 0;
    let compensationArgs = null;
    const profileFailure = Object.assign(new Error("stop after fast Auth path"), {
      code: "PROFILE_TEST_STOP"
    });
    const sandbox = {
      module: { exports: {} }, Buffer,
      requireTeacherFaceSchema: async () => {},
      requireTeacherExperienceFaceSubjectSchema: async () => {},
      requireTeacherFaceOperationSchema: async () => {},
      validatePhone: (value) => String(value),
      validatePassword: (value) => String(value),
      teacherFaceProvisionRequestId: (value) => String(value),
      teacherProvisionAuthenticationUid: () => requestedUid,
      teacherProvisionAuthenticationLease: () => `teacher-face-saga:54:${ownerToken}`,
      teacherFaceImage: () => ({
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), base64: "/9j/2Q=="
      }),
      numericId,
      sqlText,
      acquireTeacherFaceOperation: async () => operation,
      executeSql: async (sql) => {
        if (sql.includes("FROM public.staff_accounts a")) return [];
        throw new Error(`unexpected SQL in fast Auth path: ${sql.slice(0, 80)}`);
      },
      bindTeacherFaceOperation: async () => {},
      exactAuthenticationUserByUid: async () => null,
      findAuthUserByExactPhoneReadOnly: async () => null,
      teacherSagaOwnsAuthentication: (user) => String(user?.Uid || "") === requestedUid,
      manager: () => ({ user: {
        createUser: async () => {
          createCalls += 1;
          return { Data: { Uid: requestedUid } };
        }
      } }),
      confirmTeacherAuthenticationCreateReceipt: async (_operation, requested, returned) => {
        assert.equal(requested, requestedUid);
        markerUids.push(returned);
      },
      readTeacherProvisionAuthenticationWithRetry: async () => {
        delayedDiscoveryCalls += 1;
        throw new Error("exact receipt must not poll Auth discovery");
      },
      isDuplicateAuthError: () => false,
      teacherAuthCreateDefinitelyRejected: () => false,
      cloudErrorDetails: (error) => ({ code: error?.code || "", message: error?.message || "" }),
      transitionTeacherFaceOperation: async (target, _expected, next) => { target.status = next; },
      createStaffDatabaseProfile: async () => { throw profileFailure; },
      blockTeacherAuthentication: async () => { blockCalls += 1; },
      compensateFailedTeacherProvision: async (input) => { compensationArgs = input; },
      fail(message, code) { const error = new Error(message); error.code = code; throw error; },
      console: { error() {} }
    };
    vm.createContext(sandbox);
    const receiptSource = between(
      staff,
      "function teacherAuthenticationFromCreateReceipt",
      "\n\nasync function readTeacherProvisionAuthenticationWithRetry"
    );
    const provisionSource = between(
      staff, "async function provisionTeacherWithFace", "\n\n// Face enrollment is deliberately independent"
    );
    vm.runInContext(
      `${receiptSource}\n${provisionSource}\nmodule.exports = provisionTeacherWithFace;`, sandbox
    );
    await assert.rejects(
      sandbox.module.exports(
        { profile: { staffId: "900" } },
        {
          staffName: "快速老师", phone: "13900000007", initialPassword: "Aa1!aaaa",
          clientRequestId: "fast_auth_0001", consent: true, faceImageBase64: "unused"
        }
      ),
      (error) => error.code === "PROFILE_TEST_STOP"
    );
    assert.equal(createCalls, 1);
    assert.deepEqual(markerUids, [requestedUid],
      "the fulfilled receipt must be durable before teacher/profile work begins");
    assert.equal(delayedDiscoveryCalls, 0,
      "an exact fulfilled createUser receipt must skip the 13.75-second discovery loop");
    assert.equal(blockCalls, 0,
      "the exact receipt path must not issue a redundant BLOCK/readback round trip");
    assert.equal(compensationArgs?.authCreateReceiptConfirmed, true);
    assert.equal(compensationArgs?.uid, requestedUid);
  }

  // Even if CloudBase unexpectedly returns a different custom UID, persist
  // that exact receipt before rejecting the provision. If deleting that
  // returned UID cannot be confirmed, the auth-stage catch must remain
  // CLEANUP_PENDING and must never close the operation as cleanupComplete.
  {
    const requestedUid = "teacher-auth-requested";
    const returnedUid = "teacher-auth-unexpected";
    const ownerToken = "11".repeat(32);
    const operation = {
      id: "55", ownerToken, ownerTokenHash: "22".repeat(32),
      leaseGeneration: 1, status: "RUNNING", imageDigest: "33".repeat(32), imageBytes: 4
    };
    const transitions = [];
    const receiptArguments = [];
    let delayedDiscoveryCalls = 0;
    let deleteCalls = 0;
    const sandbox = {
      module: { exports: {} }, Buffer,
      requireTeacherFaceSchema: async () => {},
      requireTeacherExperienceFaceSubjectSchema: async () => {},
      requireTeacherFaceOperationSchema: async () => {},
      validatePhone: (value) => String(value),
      validatePassword: (value) => String(value),
      teacherFaceProvisionRequestId: (value) => String(value),
      teacherProvisionAuthenticationUid: () => requestedUid,
      teacherProvisionAuthenticationLease: () => `teacher-face-saga:55:${ownerToken}`,
      teacherFaceImage: () => ({
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), base64: "/9j/2Q=="
      }),
      numericId,
      sqlText,
      acquireTeacherFaceOperation: async () => operation,
      executeSql: async (sql) => {
        if (sql.includes("FROM public.staff_accounts a")) return [];
        throw new Error(`unexpected SQL in mismatch Auth path: ${sql.slice(0, 80)}`);
      },
      bindTeacherFaceOperation: async () => {},
      exactAuthenticationUserByUid: async () => null,
      findAuthUserByExactPhoneReadOnly: async () => null,
      teacherSagaOwnsAuthentication: () => false,
      manager: () => ({ user: {
        createUser: async () => ({ Data: { Uid: returnedUid } })
      } }),
      confirmTeacherAuthenticationCreateReceipt: async (_operation, requested, returned) => {
        receiptArguments.push({ requested, returned });
      },
      readTeacherProvisionAuthenticationWithRetry: async () => {
        delayedDiscoveryCalls += 1;
        throw new Error("fulfilled UID mismatch must not enter generic discovery");
      },
      transitionTeacherFaceOperation: async (target, expected, next, options = {}) => {
        transitions.push({ expected, next, cleanupComplete: options.cleanupComplete === true });
        target.status = next;
      },
      deleteTeacherProvisioningAuthentication: async (uid, options) => {
        deleteCalls += 1;
        assert.equal(uid, returnedUid);
        assert.equal(options.createReceiptConfirmed, true);
        throw Object.assign(new Error("delete receipt unavailable"), { code: "AUTH_DELETE_UNAVAILABLE" });
      },
      isDuplicateAuthError: () => false,
      teacherAuthCreateDefinitelyRejected: () => false,
      cloudErrorDetails: (error) => ({ code: error?.code || "", message: error?.message || "" }),
      fail(message, code) { const error = new Error(message); error.code = code; throw error; },
      console: { error() {} }
    };
    vm.createContext(sandbox);
    const receiptSource = between(
      staff,
      "function teacherAuthenticationFromCreateReceipt",
      "\n\nasync function readTeacherProvisionAuthenticationWithRetry"
    );
    const provisionSource = between(
      staff, "async function provisionTeacherWithFace", "\n\n// Face enrollment is deliberately independent"
    );
    vm.runInContext(
      `${receiptSource}\n${provisionSource}\nmodule.exports = provisionTeacherWithFace;`, sandbox
    );
    await assert.rejects(
      sandbox.module.exports(
        { profile: { staffId: "900" } },
        {
          staffName: "错 UID 老师", phone: "13900000007", initialPassword: "Aa1!aaaa",
          clientRequestId: "mismatch_auth_0001", consent: true, faceImageBase64: "unused"
        }
      ),
      (error) => error.code === "TEACHER_PROVISION_COMPENSATION_PENDING"
        && error.causeCode === "AUTH_CREATE_UID_MISMATCH"
    );
    assert.deepEqual(receiptArguments, [{ requested: requestedUid, returned: returnedUid }],
      "the actual returned UID must be durable before mismatch validation fails");
    assert.equal(delayedDiscoveryCalls, 0);
    assert.equal(deleteCalls, 1);
    assert.deepEqual(transitions, [
      { expected: "RUNNING", next: "CANCELLED", cleanupComplete: false },
      { expected: "CANCELLED", next: "CLEANUP_PENDING", cleanupComplete: false }
    ]);
  }

  // A durable fulfilled createUser receipt is stronger than a temporarily
  // empty list/read replica only when Auth returned the exact custom UID that
  // was requested. It permits an exact BLOCK/delete attempt, but BLOCK still
  // needs its own BLOCKED readback and DELETE needs a successful count receipt.
  {
    const requestedUid = "teacher-auth-exact";
    const returnedUid = requestedUid;
    const ownerHash = "12".repeat(32);
    const operationRow = {
      auth_uid: requestedUid,
      auth_create_returned_uid: returnedUid,
      auth_create_confirmed_at: "2026-08-21T00:00:00.000Z",
      auth_owner_token_sha256: ownerHash
    };
    const modified = [];
    const deleted = [];
    let exactReads = 0;
    const sandbox = {
      module: { exports: {} },
      assertTeacherFaceOperationLease: async () => operationRow,
      exactAuthenticationUserByUid: async () => { exactReads += 1; return null; },
      teacherOperationOwnsAuthentication: () => false,
      teacherProvisionAuthenticationUid: () => requestedUid,
      manager: () => ({ user: {
        modifyUser: async (input) => { modified.push(input); },
        deleteUsers: async (input) => {
          deleted.push(input);
          return { Data: { SuccessCount: 1, FailedCount: 0 } };
        }
      } }),
      fail(message, code) { const error = new Error(message); error.code = code; throw error; },
      stageFail(stage, message, code, cause) {
        const error = new Error(message);
        error.stage = stage;
        error.code = code;
        error.cause = cause;
        throw error;
      },
      cloudErrorDetails: (error) => ({ code: error?.code || "", message: error?.message || "" }),
      requestIdFrom: () => "",
      console: { error() {} }
    };
    vm.createContext(sandbox);
    const receiptPredicateSource = between(
      staff,
      "function teacherOperationHasAuthenticationCreateReceipt",
      "\n\nfunction teacherSagaOwnsAuthentication"
    );
    const blockSource = between(
      staff, "async function blockTeacherAuthentication", "\n\nasync function archiveTeacherProvisioning"
    );
    const deleteSource = between(
      staff,
      "async function deleteTeacherProvisioningAuthentication",
      "\n\nasync function resolveTeacherProvisioningRows"
    );
    const deletionReceiptSource = between(
      staff,
      "function teacherAuthenticationDeletionReceiptConfirmed",
      "\n\nasync function deleteTeacherProvisioningAuthentication"
    );
    vm.runInContext(`${receiptPredicateSource}\n${blockSource}\n${deletionReceiptSource}\n${deleteSource}\nmodule.exports = {
      blockTeacherAuthentication, deleteTeacherProvisioningAuthentication
    };`, sandbox);

    const faceOperation = { ownerTokenHash: ownerHash };
    await assert.rejects(
      sandbox.module.exports.blockTeacherAuthentication(returnedUid, {
        required: true, phone: "13900000007", faceOperation,
        createReceiptConfirmed: true, allowedStatuses: ["CANCELLED"]
      }),
      (error) => error.code === "AUTH_ARCHIVE_FAILED",
      "a fulfilled modify response without BLOCKED readback must remain pending"
    );
    assert.deepEqual(JSON.parse(JSON.stringify(modified)), [
      { uid: returnedUid, userStatus: "BLOCKED" }
    ], "the persisted returned UID may be blocked even while the read replica is empty");

    await sandbox.module.exports.deleteTeacherProvisioningAuthentication(returnedUid, {
      phone: "13900000007", faceOperation,
      createReceiptConfirmed: true, allowedStatuses: ["CANCELLED"]
    });
    assert.deepEqual(JSON.parse(JSON.stringify(deleted)), [{ uids: [returnedUid] }],
      "a fulfilled deleteUsers response is the authoritative deletion receipt for the persisted UID");
    assert.ok(exactReads >= 3,
      "BLOCK/delete still perform bounded exact checks even though an empty read is not absence proof");
  }

  // A persisted create receipt for a UID different from the requested custom
  // UID is evidence of an anomaly, not proof that the returned UID belongs to
  // this operation. A null read replica therefore cannot authorize blind Auth
  // mutation, and the durable operation must remain cleanup-pending.
  {
    const requestedUid = "teacher-auth-requested";
    const returnedUid = "teacher-auth-unexpected";
    const ownerHash = "34".repeat(32);
    const operationRow = {
      operation_status: "CLEANUP_PENDING",
      auth_uid: requestedUid,
      auth_create_returned_uid: returnedUid,
      auth_create_confirmed_at: "2026-08-21T00:00:00.000Z",
      auth_owner_token_sha256: ownerHash
    };
    const modified = [];
    const deleted = [];
    const sandbox = {
      module: { exports: {} },
      assertTeacherFaceOperationLease: async () => operationRow,
      exactAuthenticationUserByUid: async () => null,
      teacherOperationOwnsAuthentication: () => false,
      teacherProvisionAuthenticationUid: () => requestedUid,
      manager: () => ({ user: {
        modifyUser: async (input) => { modified.push(input); },
        deleteUsers: async (input) => {
          deleted.push(input);
          return { Data: { SuccessCount: 1, FailedCount: 0 } };
        }
      } }),
      fail(message, code) { const error = new Error(message); error.code = code; throw error; },
      stageFail(stage, message, code, cause) {
        const error = new Error(message);
        error.stage = stage;
        error.code = code;
        error.cause = cause;
        throw error;
      },
      cloudErrorDetails: (error) => ({ code: error?.code || "", message: error?.message || "" }),
      requestIdFrom: () => "",
      console: { error() {} }
    };
    vm.createContext(sandbox);
    const receiptPredicateSource = between(
      staff,
      "function teacherOperationHasAuthenticationCreateReceipt",
      "\n\nfunction teacherSagaOwnsAuthentication"
    );
    const blockSource = between(
      staff, "async function blockTeacherAuthentication", "\n\nasync function archiveTeacherProvisioning"
    );
    const deletionReceiptSource = between(
      staff,
      "function teacherAuthenticationDeletionReceiptConfirmed",
      "\n\nasync function deleteTeacherProvisioningAuthentication"
    );
    const deleteSource = between(
      staff,
      "async function deleteTeacherProvisioningAuthentication",
      "\n\nasync function resolveTeacherProvisioningRows"
    );
    vm.runInContext(`${receiptPredicateSource}\n${blockSource}\n${deletionReceiptSource}\n${deleteSource}\nmodule.exports = {
      blockTeacherAuthentication, deleteTeacherProvisioningAuthentication
    };`, sandbox);

    const faceOperation = { ownerTokenHash: ownerHash };
    await assert.rejects(
      sandbox.module.exports.blockTeacherAuthentication(returnedUid, {
        required: true, phone: "13900000007", faceOperation,
        createReceiptConfirmed: true, allowedStatuses: ["CLEANUP_PENDING"]
      }),
      (error) => error.code === "AUTH_ARCHIVE_FAILED"
        && error.cause?.code === "TEACHER_AUTH_READBACK_PENDING"
    );
    await assert.rejects(
      sandbox.module.exports.deleteTeacherProvisioningAuthentication(returnedUid, {
        phone: "13900000007", faceOperation,
        createReceiptConfirmed: true, allowedStatuses: ["CLEANUP_PENDING"]
      }),
      (error) => error.code === "TEACHER_AUTH_READBACK_PENDING"
    );
    assert.deepEqual(modified, [], "a mismatched receipt must not authorize blind BLOCK");
    assert.deepEqual(deleted, [], "a mismatched receipt must not authorize blind DELETE");
    assert.equal(operationRow.operation_status, "CLEANUP_PENDING",
      "an unreadable mismatched UID must keep its durable cleanup tombstone open");
  }

  // A fulfilled deleteUsers request can still report per-user failure. Even
  // if the account was visible before the request and the read replica is empty
  // afterward, FailedCount=1 is authoritative failure and must keep cleanup open.
  {
    const uid = "teacher-auth-delete-failed";
    const ownerHash = "45".repeat(32);
    const ownedUser = { Uid: uid };
    const operationRow = {
      operation_status: "CLEANUP_PENDING",
      auth_uid: uid,
      auth_create_returned_uid: uid,
      auth_create_confirmed_at: "2026-08-21T00:00:00.000Z",
      auth_owner_token_sha256: ownerHash
    };
    let exactReads = 0;
    let deleteCalls = 0;
    const sandbox = {
      module: { exports: {} },
      assertTeacherFaceOperationLease: async () => operationRow,
      exactAuthenticationUserByUid: async () => {
        exactReads += 1;
        return exactReads === 1 ? ownedUser : null;
      },
      teacherOperationOwnsAuthentication: (user) => user === ownedUser,
      manager: () => ({ user: {
        deleteUsers: async () => {
          deleteCalls += 1;
          return { Data: { SuccessCount: 0, FailedCount: 1 } };
        }
      } }),
      fail(message, code) { const error = new Error(message); error.code = code; throw error; }
    };
    vm.createContext(sandbox);
    const receiptPredicateSource = between(
      staff,
      "function teacherOperationHasAuthenticationCreateReceipt",
      "\n\nfunction teacherSagaOwnsAuthentication"
    );
    const deletionReceiptSource = between(
      staff,
      "function teacherAuthenticationDeletionReceiptConfirmed",
      "\n\nasync function deleteTeacherProvisioningAuthentication"
    );
    const deleteSource = between(
      staff,
      "async function deleteTeacherProvisioningAuthentication",
      "\n\nasync function resolveTeacherProvisioningRows"
    );
    vm.runInContext(
      `${receiptPredicateSource}\n${deletionReceiptSource}\n${deleteSource}\nmodule.exports = deleteTeacherProvisioningAuthentication;`,
      sandbox
    );
    await assert.rejects(
      sandbox.module.exports(uid, {
        phone: "13900000007", faceOperation: { ownerTokenHash: ownerHash },
        createReceiptConfirmed: true, allowedStatuses: ["CLEANUP_PENDING"]
      }),
      (error) => error.code === "TEACHER_AUTH_DELETE_RECEIPT_INVALID"
    );
    assert.equal(deleteCalls, 1);
    assert.equal(exactReads, 2, "delete cleanup must still perform its bounded post-read");
    assert.equal(operationRow.operation_status, "CLEANUP_PENDING",
      "a failed deletion receipt may not close the cleanup tombstone");
  }

  // If a fulfilled Auth create receipt contains a mismatched UID and Auth stays
  // unreadable, compensation cannot prove ownership for any blind mutation.
  // It must preserve an open tombstone and may never transition cleanupComplete.
  {
    const transitions = [];
    let deleteAttempts = 0;
    const returnedUid = "teacher-auth-unexpected";
    const operation = {
      id: "53", ownerToken: "ef".repeat(32), ownerTokenHash: "78".repeat(32),
      leaseGeneration: 3, status: "CANCELLED",
      row: {
        operation_id: "53", auth_uid: "teacher-auth-requested",
        auth_create_returned_uid: returnedUid,
        auth_create_confirmed_at: "2026-08-21T00:00:00.000Z",
        auth_owner_token_sha256: "78".repeat(32), operation_status: "CANCELLED"
      }
    };
    const sandbox = {
      module: { exports: {} },
      TEACHER_FACE_COMPENSATION_SETTLE_MS: 0,
      exactAuthenticationUserByUid: async () => null,
      blockTeacherAuthentication: async () => {
        throw Object.assign(new Error("BLOCKED readback pending"), { code: "AUTH_ARCHIVE_FAILED" });
      },
      resolveTeacherProvisioningRows: async () => null,
      teacherProvisioningDelay: async () => {},
      delegateTeacherFace: async () => { throw new Error("unexpected face rollback"); },
      deleteTeacherProvisioningDatabaseRows: async () => {},
      readTeacherFaceOperation: async () => operation.row,
      teacherOperationHasAuthenticationCreateReceipt: (row, uid) => Boolean(
        row?.auth_create_confirmed_at && row?.auth_create_returned_uid === uid
      ),
      teacherOperationHasBlindAuthenticationCreateReceipt: (row, uid) => Boolean(
        row?.auth_create_confirmed_at
          && row?.auth_create_returned_uid === uid
          && row?.auth_uid === uid
      ),
      teacherOperationOwnsAuthentication: () => false,
      deleteTeacherProvisioningAuthentication: async (uid, options) => {
        deleteAttempts += 1;
        assert.equal(uid, returnedUid);
        assert.equal(options.createReceiptConfirmed, true);
        throw Object.assign(new Error("delete response unavailable"), { code: "AUTH_DELETE_UNAVAILABLE" });
      },
      transitionTeacherFaceOperation: async (target, expected, next, options = {}) => {
        transitions.push({ expected, next, cleanupComplete: options.cleanupComplete === true });
        target.status = next;
      },
      archiveTeacherProvisioning: async () => {},
      cloudErrorDetails: (error) => ({ code: error?.code || "", message: error?.message || "" }),
      requestIdFrom: () => "",
      console: { error() {} }
    };
    vm.createContext(sandbox);
    const compensationSource = between(
      staff, "async function compensateFailedTeacherProvision", "\n\nasync function archiveStoreProvisioning"
    );
    vm.runInContext(`${compensationSource}\nmodule.exports = compensateFailedTeacherProvision;`, sandbox);
    await assert.rejects(
      sandbox.module.exports({
        uid: returnedUid, phone: "13900000007", authUser: null, authCreated: true,
        authCreateReceiptConfirmed: true, faceOperation: operation,
        staffId: "", teacherId: "", actorStaffId: 900, personId: "",
        teacherName: "回执错 UID 老师", image: null,
        originalError: Object.assign(new Error("UID mismatch"), { code: "AUTH_CREATE_UID_MISMATCH" })
      }),
      (error) => error.code === "TEACHER_PROVISION_COMPENSATION_PENDING"
        && Array.isArray(error.cleanupPending)
        && error.cleanupPending.length > 0
    );
    assert.equal(deleteAttempts, 0,
      "a UID mismatch receipt cannot authorize blind cleanup while Auth is unreadable");
    assert.equal(transitions.some((item) => item.cleanupComplete), false,
      "a mismatched create receipt plus unreadable Auth can never be declared cleaned");
    assert.deepEqual(transitions, [
      { expected: "CANCELLED", next: "CLEANUP_PENDING", cleanupComplete: false }
    ]);
  }

  // Auth can be committed but remain absent from the first read replica. The
  // bounded production poll must recover the exact owned UID without replaying
  // createUser or entering the long face-operation tombstone.
  {
    const delays = [];
    let reads = 0;
    const owned = { Uid: "teacher-auth-owned" };
    const sandbox = {
      module: { exports: {} },
      TEACHER_AUTH_CREATE_READBACK_DELAYS_MS: [0, 250, 500, 1000, 2000, 4000, 6000],
      teacherProvisioningDelay: async (value) => { delays.push(value); },
      exactAuthenticationUserByUid: async () => {
        reads += 1;
        return reads < 4 ? null : owned;
      },
      teacherSagaOwnsAuthentication: (user) => user === owned
    };
    vm.createContext(sandbox);
    const readbackSource = between(
      staff,
      "async function readTeacherProvisionAuthenticationWithRetry",
      "\n\nfunction teacherOperationOwnsAuthentication"
    );
    vm.runInContext(
      `${readbackSource}\nmodule.exports = readTeacherProvisionAuthenticationWithRetry;`, sandbox
    );
    const result = await sandbox.module.exports("teacher-auth-owned", "13900000007", { id: "51" });
    assert.equal(result.user, owned);
    assert.equal(result.owned, true);
    assert.equal(reads, 4);
    assert.deepEqual(delays, [250, 500, 1000]);
  }

  // v61 must also recognize and accelerate the v59 Auth-only tombstone that
  // is already present in production, without classifying a face-stage row as
  // eligible for the short fence.
  {
    const sandbox = {
      module: { exports: {} },
      TEACHER_AUTH_CREATE_UNCERTAINTY_FENCE_SECONDS: 90,
      teacherProvisionAuthenticationUid: (phone) => `uid:${phone}`
    };
    vm.createContext(sandbox);
    const predicateSource = between(
      staff,
      "function teacherAuthOwnershipUncertaintyOperation",
      "\n\nasync function shortenTeacherAuthOwnershipUncertaintyLease"
    );
    vm.runInContext(`${predicateSource}\nmodule.exports = {
      teacherAuthOwnershipUncertaintyOperation, teacherAuthOwnershipUncertaintyReadyAt,
      teacherOperationLeaseRetryAfterSeconds, teacherAuthOwnershipUncertaintyRetryAfterSeconds
    };`, sandbox);
    const legacy = {
      operation_type: "PROVISION", operation_status: "CLEANUP_PENDING",
      cleanup_completed_at: null, staff_id: null, teacher_id: null,
      person_id: null, candidate_face_id: null, phone: "13900000007",
      auth_uid: "uid:13900000007", error_code: "TEACHER_PROVISION_COMPENSATION_PENDING",
      error_message: "老师认证账号创建结果不确定，且精确 UID 未返回本请求租约。",
      cancelled_at: "2026-08-20T13:00:00.000Z",
      lease_retry_after_seconds: "50457", auth_uncertainty_retry_after_seconds: "37"
    };
    assert.equal(sandbox.module.exports.teacherAuthOwnershipUncertaintyOperation(legacy), true);
    assert.equal(
      sandbox.module.exports.teacherAuthOwnershipUncertaintyReadyAt(legacy),
      Date.parse(legacy.cancelled_at) + 90000
    );
    assert.equal(sandbox.module.exports.teacherAuthOwnershipUncertaintyRetryAfterSeconds(legacy), 37,
      "a provider/raw lease value must not leak into the Auth-only UI countdown");
    assert.equal(sandbox.module.exports.teacherOperationLeaseRetryAfterSeconds(legacy), 50457,
      "the durable lease and short Auth fence remain separate server-side values");
    assert.equal(sandbox.module.exports.teacherAuthOwnershipUncertaintyOperation({
      ...legacy, person_id: "T-BOUND"
    }), false);
  }

  // createUser may commit after its SDK response is lost and remain invisible
  // to the immediate read replica. The production creation flow must leave an
  // open cleanup tombstone; it may not mark the operation cleanup-complete.
  {
    const transitions = [];
    let authDeleteCalls = 0;
    const operation = {
      id: "51", ownerToken: "ab".repeat(32), ownerTokenHash: "12".repeat(32),
      leaseGeneration: 1, status: "RUNNING", imageDigest: "34".repeat(32), imageBytes: 4
    };
    const sandbox = {
      module: { exports: {} }, Buffer, TEACHER_FACE_COMPENSATION_SETTLE_MS: 0,
      TEACHER_AUTH_CREATE_UNCERTAINTY_FENCE_SECONDS: 90,
      requireTeacherFaceSchema: async () => {},
      requireTeacherExperienceFaceSubjectSchema: async () => {},
      requireTeacherFaceOperationSchema: async () => {},
      validatePhone: (value) => String(value),
      validatePassword: (value) => String(value),
      teacherFaceProvisionRequestId: (value) => String(value),
      teacherProvisionAuthenticationUid: () => "teacher-auth-owned",
      teacherProvisionAuthenticationLease: () => `teacher-face-saga:51:${"ab".repeat(32)}`,
      teacherFaceImage: () => ({
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), base64: "/9j/2Q=="
      }),
      numericId,
      sqlText,
      acquireTeacherFaceOperation: async () => operation,
      executeSql: async (sql) => {
        if (sql.includes("FROM public.staff_accounts a")) return [];
        throw new Error(`unexpected SQL before Auth uncertainty: ${sql.slice(0, 80)}`);
      },
      bindTeacherFaceOperation: async () => {},
      exactAuthenticationUserByUid: async () => null,
      readTeacherProvisionAuthenticationWithRetry: async () => ({
        user: null, owned: false,
        lastError: Object.assign(new Error("response lost"), { code: "TIMEOUT" })
      }),
      findAuthUserByExactPhoneReadOnly: async () => null,
      teacherSagaOwnsAuthentication: () => false,
      isDuplicateAuthError: () => false,
      teacherAuthCreateDefinitelyRejected: () => false,
      cloudErrorDetails: (error) => ({ code: error?.code || "", message: error?.message || "" }),
      teacherProvisioningDelay: async () => {},
      manager: () => ({ user: {
        createUser: async () => { throw Object.assign(new Error("response lost"), { code: "TIMEOUT" }); }
      } }),
      transitionTeacherFaceOperation: async (target, expected, next, options = {}) => {
        transitions.push({ expected, next, cleanupComplete: options.cleanupComplete === true });
        target.status = next;
      },
      shortenTeacherAuthOwnershipUncertaintyLease: async () => {},
      deleteTeacherProvisioningAuthentication: async () => { authDeleteCalls += 1; },
      fail(message, code) { const error = new Error(message); error.code = code; throw error; }
    };
    vm.createContext(sandbox);
    const provisionSource = between(
      staff, "async function provisionTeacherWithFace", "\n\n// Face enrollment is deliberately independent"
    );
    vm.runInContext(`${provisionSource}\nmodule.exports = provisionTeacherWithFace;`, sandbox);
    await assert.rejects(
      sandbox.module.exports(
        { profile: { staffId: "900" } },
        {
          staffName: "迟到老师", phone: "13900000007", initialPassword: "Aa1!aaaa",
          clientRequestId: "late_auth_0001", consent: true, faceImageBase64: "unused"
        }
      ),
      (error) => error.code === "TEACHER_PROVISION_COMPENSATION_PENDING"
        && error.authCreationUncertain === true
        && error.operationId === "51"
        && error.retryAfterSeconds === 90
    );
    assert.deepEqual(transitions, [
      { expected: "RUNNING", next: "CLEANUP_PENDING", cleanupComplete: false }
    ]);
    assert.equal(authDeleteCalls, 0, "an unobserved late Auth commit cannot be guessed or marked deleted");
  }

  // A stale reconciler may initially see the pre-bound UID as missing and
  // then observe the delayed Auth commit after other cleanup work. The final
  // boundary must read that exact UID again and delete it only after ownership
  // is confirmed; the earlier missing read is never cleanup proof.
  {
    let exactReadCalls = 0;
    let authDeleteCalls = 0;
    const operation = {
      id: "52", ownerToken: "cd".repeat(32), ownerTokenHash: "56".repeat(32),
      leaseGeneration: 2, status: "CANCELLED", row: { operation_id: "52" }
    };
    const ownedUser = { Uid: "teacher-auth-late" };
    const sandbox = {
      module: { exports: {} },
      TEACHER_FACE_COMPENSATION_SETTLE_MS: 0,
      exactAuthenticationUserByUid: async () => {
        exactReadCalls += 1;
        return exactReadCalls === 1 ? null : ownedUser;
      },
      blockTeacherAuthentication: async () => {},
      resolveTeacherProvisioningRows: async () => null,
      teacherProvisioningDelay: async () => {},
      delegateTeacherFace: async () => { throw new Error("unexpected face rollback"); },
      deleteTeacherProvisioningDatabaseRows: async () => {},
      readTeacherFaceOperation: async () => operation.row,
      teacherOperationOwnsAuthentication: (user) => user === ownedUser,
      deleteTeacherProvisioningAuthentication: async (uid) => {
        assert.equal(uid, "teacher-auth-late");
        authDeleteCalls += 1;
      },
      transitionTeacherFaceOperation: async (target, expected, next, options = {}) => {
        assert.equal(expected, "CANCELLED");
        assert.equal(next, "CANCELLED");
        assert.equal(options.cleanupComplete, true);
        target.status = next;
      },
      archiveTeacherProvisioning: async () => {},
      cloudErrorDetails: (error) => ({ code: error?.code, message: error?.message }),
      requestIdFrom: () => "",
      console: { error() {} }
    };
    vm.createContext(sandbox);
    const compensationSource = between(
      staff, "async function compensateFailedTeacherProvision", "\n\nasync function archiveStoreProvisioning"
    );
    vm.runInContext(`${compensationSource}\nmodule.exports = compensateFailedTeacherProvision;`, sandbox);
    const result = await sandbox.module.exports({
      uid: "teacher-auth-late", phone: "13900000007", authUser: null,
      authCreated: false, faceOperation: operation, staffId: "", teacherId: "",
      actorStaffId: 900, personId: "", teacherName: "迟到老师", image: null,
      originalError: Object.assign(new Error("stale operation"), { code: "STALE_OPERATION" })
    });
    assert.equal(exactReadCalls, 2, "cleanup must re-read Auth after the earlier missing result");
    assert.equal(authDeleteCalls, 1, "the late visible, exactly owned Auth user must be deleted");
    assert.equal(result.authenticationDeleted, true);
  }

  // A row with the same phone but a different UID is not this saga's row.
  // The production discovery query must therefore return no ownership match.
  let discoverySql = "";
  const resolve = runtimeFunction(
    between(staff, "async function resolveTeacherProvisioningRows", "\n\nasync function compensateFailedTeacherProvision"),
    "resolveTeacherProvisioningRows",
    async (sql) => {
      discoverySql = sql;
      const exact = sql.includes("account.auth_uid = 'owned-uid'")
        && sql.includes("account.phone = '13900000007'")
        && sql.includes("AND account.id = 41::bigint")
        && sql.includes("AND teacher.id = 7::bigint")
        && !/account\.auth_uid[^\n]+\n\s+OR account\.phone/.test(sql);
      return exact ? [] : [{ staff_id: 41, teacher_id: 7 }];
    }
  );
  assert.equal(await resolve({
    uid: "owned-uid", phone: "13900000007", staffId: "41", teacherId: "7"
  }), null);
  assert.match(discoverySql, /account\.auth_uid = 'owned-uid'[\s\S]*AND account\.phone = '13900000007'/);

  // The destructive CTE must join the exact account tuple before deleting a
  // teacher. A same-phone/different-UID victim must remain untouched.
  let victimDeleted = false;
  let call = 0;
  const removeRows = runtimeFunction(
    between(staff, "async function deleteTeacherProvisioningDatabaseRows", "\n\nasync function deleteTeacherProvisioningAuthentication"),
    "deleteTeacherProvisioningDatabaseRows",
    async (sql) => {
      call += 1;
      if (call === 1) {
        const exact = sql.includes("USING public.staff_accounts AS account")
          && sql.includes("account.id = teacher.staff_account_id")
          && sql.includes("account.auth_uid = 'owned-uid'")
          && sql.includes("account.phone = '13900000007'")
          && sql.includes("account.role_code = 'teacher'");
        victimDeleted = !exact;
        return [];
      }
      return [];
    }
  );
  await removeRows({
    staffId: "41", teacherId: "7", uid: "owned-uid",
    phone: "13900000007", personId: "T-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  });
  assert.equal(victimDeleted, false);

  let victimArchived = false;
  const archive = runtimeFunction(
    between(staff, "async function archiveTeacherProvisioning", "\n\nfunction teacherProvisioningDelay"),
    "archiveTeacherProvisioning",
    async (sql) => {
      const exact = sql.includes("account.id = 41")
        && sql.includes("account.role_code = 'teacher'")
        && sql.includes("account.auth_uid = 'owned-uid'")
        && sql.includes("account.phone = '13900000007'");
      if (!exact) victimArchived = true;
      return [];
    }
  );
  await archive("41", { uid: "owned-uid", phone: "13900000007" });
  assert.equal(victimArchived, false,
    "cleanup-pending archival must not touch a same-phone/different-UID account");

  console.log("teacher face operation lease contract: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
