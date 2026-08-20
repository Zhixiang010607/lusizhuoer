"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
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

assert.match(staff,
  /const ownerToken = operationType === "PROVISION" && sameRequestPayloadSecretDigest[\s\S]{0,520}teacherFaceSameRequestOwnerToken\([\s\S]{0,420}: crypto\.randomBytes\(32\)\.toString\("hex"\)/,
  "PROVISION must use a deterministic exact-request owner while UPSERT/takeover retains a random owner");
assert.match(staff,
  /function teacherFaceSameRequestOwnerToken[\s\S]{0,900}crypto\.createHmac\("sha256", teacherFaceDelegationSigningKey\(\)\)[\s\S]{0,700}payloadSecretDigest/,
  "the same-request owner must be an API-key-backed HMAC over the normalized payload and password digest");
assert.match(staff,
  /sameRequestPayloadSecretDigest: crypto\.createHash\("sha256"\)[\s\S]{0,120}\.update\(password, "utf8"\)\.digest\("hex"\)/,
  "the initial password must bind the deterministic owner without entering the durable operation row");
const sameRequestCatch = between(
  staff,
  "if (error?.authCreationUncertain && error?.retrySameRequest)",
  "\n    let cancellationError = null;"
);
assert.match(sameRequestCatch, /markTeacherProvisionAuthRetryReady\(faceOperation\)/,
  "a lost createUser response must atomically release ACTIVE before authorizing same-request replay");
assert.doesNotMatch(sameRequestCatch, /transitionTeacherFaceOperation|deleteTeacherProvisioningAuthentication/,
  "v64 same-request resume must not cancel, tombstone or delete the account");
assert.match(staff,
  /TEACHER_PROVISION_INVOCATION_ACTIVE_PREFIX = "V64_INVOCATION_ACTIVE:"[\s\S]*async function claimTeacherProvisionInvocation[\s\S]{0,500}crypto\.randomBytes\(32\)\.toString\("hex"\)[\s\S]{0,900}lease_generation = target\.lease_generation \+ 1[\s\S]{0,1100}COALESCE\(target\.error_code, ''\) IN \([\s\S]{0,260}TEACHER_PROVISION_AUTH_RETRY_READY[\s\S]{0,260}TEACHER_PROVISION_V63_AUTH_RETRY_READY/,
  "the single-invocation claim must be a generation CAS available only to fresh or explicitly READY work");
assert.match(staff,
  /async function claimTeacherProvisionInvocation[\s\S]{0,3200}String\(current\.error_code \|\| ""\) === invocationCode[\s\S]{0,1100}operation\.invocationCode = invocationCode/,
  "a lost CAS response may be accepted only after an independent exact nonce readback");
assert.match(staff,
  /async function markTeacherProvisionAuthRetryReady[\s\S]{0,900}target\.error_code = \$\{sqlText\(operation\.invocationCode\)\}/,
  "only the active invocation may publish the server-authorized retry state");
assert.match(staff,
  /TEACHER_AUTH_CREATE_READBACK_DELAYS_MS = Object\.freeze\(\[\s*0, 250, 500, 1000\s*\]\)/,
  "Auth ownership readback must be bounded to the short 1.75-second window");
assert.match(staff, /TEACHER_AUTH_CREATE_UNCERTAINTY_FENCE_SECONDS = 90/,
  "Auth-only uncertainty must not inherit the 12-minute face-service fence");
assert.match(staff, /teacherAuthCreateReceiptFastPath: true/,
  "health must distinguish the exact createUser receipt fast path in production");
assert.match(staff, /teacherAuthSameRequestResume: true/,
  "v64 health must advertise exact-request automatic resume");
assert.match(staff, /teacherAuthSameRequestRetrySeconds: TEACHER_AUTH_SAME_REQUEST_RETRY_SECONDS/,
  "v64 health must expose the short same-request retry interval");
assert.match(staff, /teacherProvisionSingleInvocationGuard: true/,
  "health must advertise the v64 single-invocation CAS guard");
assert.match(staff, /teacherProvisionBeginWorkerStatus: true[\s\S]{0,180}teacherProvisionReadOnlyStatus: true[\s\S]{0,180}teacherProvisionReadOnlyResult: true/,
  "v64 health must advertise the begin/worker/read-only status/result protocol");
assert.match(staff, /makeTeacherAuthOwnershipUncertaintyCleanupEligible\(operationId\)[\s\S]*takeoverTeacherFaceOperationCleanup\(operationId\)/,
  "the trusted reconciler must safely release legacy Auth-only tombstones after the short fence");
assert.match(staff,
  /const eligible = await makeTeacherAuthOwnershipUncertaintyCleanupEligible\(operationId\);[\s\S]{0,420}teacherOperationLeaseRetryAfterSeconds\(eligible\) > 0[\s\S]{0,180}continue;[\s\S]{0,180}takeoverTeacherFaceOperationCleanup\(operationId\)/,
  "a legacy scan match that fails the strict Auth-only predicate must retain its original lease");
assert.match(staff, /EXTRACT\(EPOCH FROM \([\s\S]{0,220}lease_retry_after_seconds[\s\S]{0,420}auth_uncertainty_retry_after_seconds/,
  "retry countdowns must be calculated by PostgreSQL instead of parsing timezone-dependent timestamps in JavaScript");
assert.match(staff, /if \(action === "getTeacherFaceOperationStatus"\)[\s\S]{0,180}getTeacherFaceOperationStatus\(caller, event\)/,
  "HQ must be able to poll the durable operation without replaying creation");
assert.match(staff, /retryAllowed: status === "CANCELLED" && cleanupComplete/,
  "a successful operation must never tell the client to submit the same teacher again");
assert.match(staff, /operationId: error\?\.operationId[\s\S]{0,180}retrySameRequest:[\s\S]{0,180}retryAfterSeconds/,
  "the safe pending response must expose operation id, same-request instruction and bounded retry delay");
assert.match(staff, /teacherAuthCreateDefinitelyRejected\(createError\)[\s\S]{0,360}AUTH_CREATE_REJECTED/,
  "a definite Auth validation or authority rejection must not enter the ambiguous 90-second fence");
const provisionAuthSource = between(
  staff, "async function provisionTeacherWithFace", "\n\n// Face enrollment is deliberately independent"
);
assert.ok(provisionAuthSource.indexOf("await claimTeacherProvisionInvocation(faceOperation)")
  < provisionAuthSource.indexOf("FROM public.staff_accounts a"),
"the invocation CAS must complete before any teacher profile, Auth or face work starts");
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
assert.doesNotMatch(provisionAuthSource,
  /if \(!authUser && createError && isDuplicateAuthError\(createError\)\)[\s\S]{0,500}AUTH_ACCOUNT_ALREADY_EXISTS/,
  "a duplicate response plus a stale exact-UID read is not proof of an unrelated account; it must resume the same request");
assert.match(provisionAuthSource,
  /faceOperation\.status === "SUCCEEDED"[\s\S]{0,300}operationRow\.auth_owner_token_sha256[\s\S]{0,100}faceOperation\.ownerTokenHash[\s\S]{0,500}TEACHER_FACE_OPERATION_REPLAY_MISMATCH/,
  "SUCCEEDED replay must bind the stored Auth owner to the exact HMAC request payload");
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
  assert.equal(api.teacherAuthCreateDefinitelyRejected({
    code: "FailedOperation.DuplicatedData"
  }), false, "a duplicate result may be a delayed receipt from this deterministic request");
  assert.equal(api.isDuplicateAuthError({ code: "HTTP_503", status: 503, message: "duplicate request" }), false,
    "free-form duplicate text in an uncertain transport wrapper is not ownership proof");
}

{
  const sandbox = {
    module: { exports: {} },
    crypto,
    teacherFaceDelegationSigningKey: () => Buffer.from("same-request-test-key", "utf8")
  };
  vm.createContext(sandbox);
  const ownerSource = between(
    staff,
    "const TEACHER_FACE_SAME_REQUEST_OWNER_VERSION",
    "\n\nfunction teacherFaceGroupId"
  );
  vm.runInContext(
    `${ownerSource}\nmodule.exports = teacherFaceSameRequestOwnerToken;`, sandbox
  );
  const exactRequest = {
    operationType: "PROVISION",
    clientRequestId: "teacher_create_same_request_01",
    phone: "13900000007",
    teacherName: "相同请求老师",
    imageDigest: "ab".repeat(32),
    imageBytes: 123456,
    faceGroupId: "lusizhuoerdatabase",
    photoBucketId: "customer-photos",
    actorStaffId: 900,
    payloadSecretDigest: "cd".repeat(32)
  };
  const first = sandbox.module.exports(exactRequest);
  const replay = sandbox.module.exports({ ...exactRequest });
  assert.equal(first, replay,
    "the exact same clientRequestId and normalized payload must reacquire the same owner");
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, sandbox.module.exports({
    ...exactRequest, payloadSecretDigest: "ef".repeat(32)
  }), "a changed password digest must not inherit the original live operation");
  assert.notEqual(first, sandbox.module.exports({
    ...exactRequest, clientRequestId: "teacher_create_changed_request_02"
  }), "a new clientRequestId must not share the same owner");
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
  // The v64 ACTIVE/READY marker is a database CAS, not a browser convention.
  // Two cloud-function instances holding the same owner and generation race
  // here: exactly one may claim ACTIVE. Once that owner publishes READY, one
  // later instance can claim the next generation.
  {
    const row = {
      id: "71",
      operation_type: "PROVISION",
      operation_status: "RUNNING",
      owner_token_sha256: "aa".repeat(32),
      lease_generation: 7,
      lease_expires_at: "2099-01-01T00:00:00.000Z",
      error_code: null
    };
    let claimWrites = 0;
    let readyWrites = 0;
    let loseNextClaimResponse = false;
    const executeSql = async (sql) => {
      const generation = Number(
        /target\.lease_generation = (\d+)::bigint/.exec(sql)?.[1]
      );
      const ownerHash = /target\.owner_token_sha256 = '([^']+)'/.exec(sql)?.[1] || "";
      if (sql.includes("lease_generation = target.lease_generation + 1")) {
        const eligible = row.operation_status === "RUNNING"
          && row.owner_token_sha256 === ownerHash
          && row.lease_generation === generation
          && [null, "", "V64_WORKER_READY", "V63_AUTH_RETRY_READY"].includes(row.error_code);
        if (!eligible) return [];
        row.error_code = /SET error_code = '([^']+)'/.exec(sql)?.[1] || "";
        row.lease_generation += 1;
        claimWrites += 1;
        if (loseNextClaimResponse) {
          loseNextClaimResponse = false;
          throw Object.assign(new Error("CAS response lost after commit"), { code: "TIMEOUT" });
        }
        return [{
          lease_generation: row.lease_generation,
          lease_expires_at: row.lease_expires_at
        }];
      }
      if (sql.includes("SET error_code = 'V64_WORKER_READY'")) {
        const eligible = row.operation_status === "RUNNING"
          && row.owner_token_sha256 === ownerHash
          && row.lease_generation === generation
          && row.error_code === /target\.error_code = '([^']+)'/.exec(sql)?.[1];
        if (!eligible) return [];
        row.error_code = "V64_WORKER_READY";
        readyWrites += 1;
        return [{ lease_generation: row.lease_generation }];
      }
      throw new Error(`unexpected invocation-guard SQL: ${sql.slice(0, 120)}`);
    };
    const sandbox = {
      module: { exports: {} },
      crypto,
      TEACHER_PROVISION_INVOCATION_ACTIVE_PREFIX: "V64_INVOCATION_ACTIVE:",
      TEACHER_PROVISION_AUTH_RETRY_READY: "V64_WORKER_READY",
      TEACHER_PROVISION_V63_AUTH_RETRY_READY: "V63_AUTH_RETRY_READY",
      TEACHER_FACE_OPERATION_LEASE_SECONDS: 720,
      executeSql,
      sqlText,
      numericId,
      readTeacherFaceOperation: async () => ({ ...row }),
      teacherOperationLeaseRetryAfterSeconds: () => 720,
      teacherProvisionInvocationActive: (code) => /^V6[34]_INVOCATION_ACTIVE:/.test(String(code || "")),
      assertTeacherFaceOperationLease: async (operation, statuses) => {
        assert.equal(operation.ownerTokenHash, row.owner_token_sha256);
        assert.equal(operation.leaseGeneration, row.lease_generation);
        assert.deepEqual(JSON.parse(JSON.stringify(statuses)), ["RUNNING"]);
        return { ...row };
      },
      fail(message, code) { const error = new Error(message); error.code = code; throw error; }
    };
    vm.createContext(sandbox);
    const guardSource = between(
      staff,
      "async function claimTeacherProvisionInvocation",
      "\n\nasync function takeoverTeacherFaceOperationCleanup"
    );
    vm.runInContext(`${guardSource}\nmodule.exports = {
      claimTeacherProvisionInvocation, markTeacherProvisionAuthRetryReady
    };`, sandbox);
    const base = {
      id: row.id,
      ownerTokenHash: row.owner_token_sha256,
      leaseGeneration: row.lease_generation,
      status: "RUNNING"
    };
    const raced = await Promise.allSettled([
      sandbox.module.exports.claimTeacherProvisionInvocation({ ...base }),
      sandbox.module.exports.claimTeacherProvisionInvocation({ ...base })
    ]);
    const winners = raced.filter((item) => item.status === "fulfilled");
    const losers = raced.filter((item) => item.status === "rejected");
    assert.equal(winners.length, 1, "only one same-generation invocation may become ACTIVE");
    assert.equal(losers.length, 1);
    assert.equal(losers[0].reason?.code, "TEACHER_PROVISION_INVOCATION_IN_PROGRESS");
    assert.equal(claimWrites, 1);
    assert.equal(row.lease_generation, 8);
    assert.match(row.error_code, /^V64_INVOCATION_ACTIVE:[a-f0-9]{64}$/);

    const winner = winners[0].value;
    await sandbox.module.exports.markTeacherProvisionAuthRetryReady(winner);
    assert.equal(readyWrites, 1);
    assert.equal(row.error_code, "V64_WORKER_READY");
    const resumed = await sandbox.module.exports.claimTeacherProvisionInvocation({
      ...base, leaseGeneration: row.lease_generation
    });
    assert.equal(resumed.leaseGeneration, 9,
      "a server-published READY request may claim exactly one new generation");
    assert.match(row.error_code, /^V64_INVOCATION_ACTIVE:[a-f0-9]{64}$/);
    assert.equal(claimWrites, 2);

    await sandbox.module.exports.markTeacherProvisionAuthRetryReady(resumed);
    loseNextClaimResponse = true;
    const recoveredAfterLostWriteReceipt = await sandbox.module.exports
      .claimTeacherProvisionInvocation({
        ...base, leaseGeneration: row.lease_generation
      });
    assert.equal(recoveredAfterLostWriteReceipt.leaseGeneration, 10);
    assert.match(row.error_code, /^V64_INVOCATION_ACTIVE:[a-f0-9]{64}$/);
    assert.equal(claimWrites, 3,
      "a lost UPDATE response must be recovered only by the exact random ACTIVE nonce readback");
  }

  // An ACTIVE marker means an earlier function may still be alive after the
  // caller lost its HTTP response. The second invocation must stop at claim,
  // before teacher-profile SQL, Auth create or delegated face work.
  {
    let claimCalls = 0;
    let downstreamDatabaseCalls = 0;
    let authCalls = 0;
    let faceCalls = 0;
    const operation = {
      id: "72", ownerToken: "bb".repeat(32), ownerTokenHash: "cc".repeat(32),
      leaseGeneration: 11, status: "RUNNING", imageDigest: "dd".repeat(32), imageBytes: 4
    };
    const sandbox = {
      module: { exports: {} }, Buffer, crypto,
      requireTeacherFaceSchema: async () => {},
      requireTeacherExperienceFaceSubjectSchema: async () => {},
      requireTeacherFaceOperationSchema: async () => {},
      validatePhone: (value) => String(value),
      validatePassword: (value) => String(value),
      teacherFaceProvisionRequestId: (value) => String(value),
      teacherProvisionAuthenticationUid: () => "teacher-auth-active",
      teacherFaceImage: () => ({
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), base64: "/9j/2Q=="
      }),
      numericId,
      sqlText,
      acquireTeacherFaceOperation: async () => operation,
      claimTeacherProvisionInvocation: async () => {
        claimCalls += 1;
        const error = new Error("first invocation remains ACTIVE");
        error.code = "TEACHER_PROVISION_INVOCATION_IN_PROGRESS";
        throw error;
      },
      executeSql: async () => { downstreamDatabaseCalls += 1; return []; },
      manager: () => { authCalls += 1; return { user: {} }; },
      delegateTeacherFace: async () => { faceCalls += 1; },
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
          staffName: "单执行老师", phone: "13900000007", initialPassword: "Aa1!aaaa",
          clientRequestId: "active_guard_0001", consent: true, faceImageBase64: "unused"
        }
      ),
      (error) => error.code === "TEACHER_PROVISION_INVOCATION_IN_PROGRESS"
    );
    assert.equal(claimCalls, 1);
    assert.equal(downstreamDatabaseCalls, 0);
    assert.equal(authCalls, 0);
    assert.equal(faceCalls, 0);
  }

  // A SUCCEEDED operation is replayable only by the identical HMAC-bound
  // payload. Changing only the initial password changes the current owner
  // hash and must fail before any mutation or delegated read/write. The exact
  // payload may perform the final read-only verification and return success.
  {
    const storedOwnerHash = "10".repeat(32);
    const changedOwnerHash = "20".repeat(32);
    const originalPassword = "Aa1!original";
    const originalDigest = crypto.createHash("sha256")
      .update(originalPassword, "utf8").digest("hex");
    async function runSucceededReplay(initialPassword) {
      const counters = {
        claims: 0, databaseWrites: 0, auth: 0, delegated: 0,
        authoritative: 0, transitions: 0, deletes: 0, binds: 0
      };
      const existing = {
        staff_id: "101", auth_uid: "teacher-auth-replay", role_code: "teacher",
        account_status: "ACTIVE", teacher_id: "201", teacher_code: "TCH0201",
        teacher_name: "回放老师", teacher_status: "ACTIVE",
        face_person_id: "T-REPLAY", face_enrollment_status: "ENROLLED",
        profile_photo_file_id: "private/photo/replay.jpg"
      };
      const operationRow = {
        operation_status: "SUCCEEDED",
        auth_uid: existing.auth_uid,
        auth_owner_token_sha256: storedOwnerHash,
        staff_id: existing.staff_id,
        teacher_id: existing.teacher_id,
        person_id: existing.face_person_id
      };
      const sandbox = {
        module: { exports: {} }, Buffer, crypto,
        requireTeacherFaceSchema: async () => {},
        requireTeacherExperienceFaceSubjectSchema: async () => {},
        requireTeacherFaceOperationSchema: async () => {},
        validatePhone: (value) => String(value),
        validatePassword: (value) => String(value),
        teacherFaceProvisionRequestId: (value) => String(value),
        teacherProvisionAuthenticationUid: () => existing.auth_uid,
        teacherFaceImage: () => ({
          buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), base64: "/9j/2Q=="
        }),
        teacherFacePersonId: () => existing.face_person_id,
        numericId,
        sqlText,
        acquireTeacherFaceOperation: async (input) => ({
          id: "73",
          ownerToken: "owner",
          ownerTokenHash: input.sameRequestPayloadSecretDigest === originalDigest
            ? storedOwnerHash : changedOwnerHash,
          leaseGeneration: 4,
          status: "SUCCEEDED",
          imageDigest: "30".repeat(32),
          imageBytes: 4
        }),
        claimTeacherProvisionInvocation: async () => { counters.claims += 1; },
        executeSql: async (sql) => {
          if (/\b(?:INSERT|UPDATE|DELETE)\b/i.test(sql)) counters.databaseWrites += 1;
          if (sql.includes("FROM public.staff_accounts a")) return [existing];
          throw new Error(`unexpected replay SQL: ${sql.slice(0, 120)}`);
        },
        assertTeacherFaceOperationLease: async () => operationRow,
        teacherFaceDelegationLease: () => ({}),
        finalDelegatedTeacherFaceReadback: async () => {
          counters.delegated += 1;
          return { verifiedReadback: {
            person: { confirmed: true },
            photo: { authenticated: true },
            database: { confirmed: true },
            photoReference: existing.profile_photo_file_id
          } };
        },
        authoritativeTeacherProvisioningState: async () => {
          counters.authoritative += 1;
          return {
            database: {
              id: existing.teacher_id,
              staff_account_id: existing.staff_id,
              teacher_code: existing.teacher_code,
              teacher_name: existing.teacher_name,
              teacher_status: "ACTIVE",
              account_status: "ACTIVE",
              face_person_id: existing.face_person_id,
              face_enrollment_status: "ENROLLED",
              face_enrolled_at: "2026-08-21T00:00:00.000Z",
              profile_photo_file_id: existing.profile_photo_file_id
            },
            identity: { UserStatus: "ACTIVE" }
          };
        },
        manager: () => { counters.auth += 1; return { user: {} }; },
        transitionTeacherFaceOperation: async () => { counters.transitions += 1; },
        deleteTeacherProvisioningAuthentication: async () => { counters.deletes += 1; },
        bindTeacherFaceOperation: async () => { counters.binds += 1; },
        fail(message, code) { const error = new Error(message); error.code = code; throw error; }
      };
      vm.createContext(sandbox);
      const provisionSource = between(
        staff, "async function provisionTeacherWithFace", "\n\n// Face enrollment is deliberately independent"
      );
      vm.runInContext(`${provisionSource}\nmodule.exports = provisionTeacherWithFace;`, sandbox);
      const promise = sandbox.module.exports(
        { profile: { staffId: "900" } },
        {
          staffName: existing.teacher_name,
          phone: "13900000007",
          initialPassword,
          clientRequestId: "succeeded_replay_0001",
          consent: true,
          faceImageBase64: "unused"
        }
      );
      return { promise, counters };
    }

    const changed = await runSucceededReplay("Aa1!changed");
    await assert.rejects(changed.promise,
      (error) => error.code === "TEACHER_FACE_OPERATION_REPLAY_MISMATCH");
    assert.deepEqual(changed.counters, {
      claims: 0, databaseWrites: 0, auth: 0, delegated: 0,
      authoritative: 0, transitions: 0, deletes: 0, binds: 0
    }, "a password-changed replay must stop before every mutation/delegation boundary");

    const exact = await runSucceededReplay(originalPassword);
    const replay = await exact.promise;
    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);
    assert.equal(replay.passwordInitialized, false);
    assert.deepEqual(exact.counters, {
      claims: 0, databaseWrites: 0, auth: 0, delegated: 1,
      authoritative: 1, transitions: 0, deletes: 0, binds: 0
    }, "an exact SUCCEEDED payload may perform read-only final verification only");
  }

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
    let acquireInput = null;
    const profileFailure = Object.assign(new Error("stop after fast Auth path"), {
      code: "PROFILE_TEST_STOP"
    });
    const sandbox = {
      module: { exports: {} }, Buffer, crypto,
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
      acquireTeacherFaceOperation: async (input) => { acquireInput = input; return operation; },
      claimTeacherProvisionInvocation: async (target) => target,
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
      "an exact fulfilled createUser receipt must skip even the short discovery loop");
    assert.equal(blockCalls, 0,
      "the exact receipt path must not issue a redundant BLOCK/readback round trip");
    assert.equal(acquireInput?.sameRequestPayloadSecretDigest,
      crypto.createHash("sha256").update("Aa1!aaaa", "utf8").digest("hex"),
      "the deterministic PROVISION owner must bind the exact initial password by digest");
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
      module: { exports: {} }, Buffer, crypto,
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
      claimTeacherProvisionInvocation: async (target) => target,
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
      TEACHER_AUTH_CREATE_READBACK_DELAYS_MS: [0, 250, 500, 1000],
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

  // v63 must retain reconciler compatibility for Auth-only tombstones already
  // emitted by v59-v62, without classifying a face-stage row as eligible for
  // the legacy 90-second fence.
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
  // to the short readback window. v63 must retain the exact RUNNING generation
  // and tell the browser to replay the same request after two seconds. It may
  // not enter legacy cleanup, delete an account or declare cleanup complete.
  {
    const transitions = [];
    let authDeleteCalls = 0;
    let claimCalls = 0;
    let readyMarks = 0;
    const operation = {
      id: "51", ownerToken: "ab".repeat(32), ownerTokenHash: "12".repeat(32),
      leaseGeneration: 1, status: "RUNNING", imageDigest: "34".repeat(32), imageBytes: 4
    };
    const sandbox = {
      module: { exports: {} }, Buffer, crypto, TEACHER_FACE_COMPENSATION_SETTLE_MS: 0,
      TEACHER_AUTH_CREATE_UNCERTAINTY_FENCE_SECONDS: 90,
      TEACHER_AUTH_SAME_REQUEST_RETRY_SECONDS: 2,
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
      claimTeacherProvisionInvocation: async (target) => { claimCalls += 1; return target; },
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
      markTeacherProvisionAuthRetryReady: async (target) => {
        assert.equal(target, operation);
        readyMarks += 1;
        return target;
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
      (error) => error.code === "TEACHER_AUTH_CREATE_RETRY_SAME_REQUEST"
        && error.authCreationUncertain === true
        && error.operationId === "51"
        && error.retrySameRequest === true
        && error.retryAfterSeconds === 2
    );
    assert.deepEqual(transitions, [],
      "a fresh v64 ambiguity must not transition RUNNING to cleanup");
    assert.equal(claimCalls, 1);
    assert.equal(readyMarks, 1,
      "retrySameRequest may be returned only after ACTIVE atomically becomes READY");
    assert.equal(operation.status, "RUNNING");
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
