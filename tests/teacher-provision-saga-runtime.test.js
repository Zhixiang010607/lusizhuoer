"use strict";

// Runtime and source-boundary coverage for staffAccount's teacher-creation
// saga. External CloudBase services are stubbed only at callFunction; the
// production signature, timeout and strict proof validator execute unchanged.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const file = path.join(root, "cloudfunctions", "staffAccount", "index.js");
const source = fs.readFileSync(file, "utf8");

function between(first, last) {
  const start = source.indexOf(first);
  const end = source.indexOf(last, start + first.length);
  assert.ok(start >= 0 && end > start, `missing source region ${first}`);
  return source.slice(start, end);
}

function fail(message, code = "BAD_REQUEST") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

assert.match(source, /const FUNCTION_VERSION = "v62"/);
assert.match(source, /const TEACHER_FACE_DELEGATION_TIMEOUT_MS = 60 \* 1000/);
assert.match(source, /const TEACHER_FACE_TARGET_MAX_RUNTIME_MS = 90 \* 1000/);
assert.match(source, /finalRollbackNotBefore - Date\.now\(\)/,
  "final rollback must wait beyond every possibly live child invocation");
assert.match(source, /teacher-face:\$\{normalizedTeacherId\}:\$\{normalizedStaffId\}:\$\{imageDigest\}/,
  "PersonId must be scoped to the concrete teacher and staff account as well as the image");

const delegation = between(
  "const TEACHER_FACE_DELEGATION_VERSION",
  "function productTemplateStorageSettings"
);
assert.match(delegation, /callFunction\(\{[\s\S]*name: "faceRecognition"[\s\S]*\}, \{ timeout: TEACHER_FACE_DELEGATION_TIMEOUT_MS \}\)/,
  "the inner service call must use the supported second-argument timeout");
assert.match(delegation, /person\.confirmed === true[\s\S]*photo\.authenticated === true[\s\S]*Number\(photo\.bytes\)[\s\S]*photo\.sha256[\s\S]*database\.confirmed === true/,
  "success must require remote Person, authenticated exact photo and database proofs");
assert.match(delegation, /TEACHER_FACE_REMOTE_READBACK_INCOMPLETE/,
  "an incomplete nested service response must fail closed");

const createProfile = between("async function createStaffDatabaseProfile", "async function assertPhoneCanUseRole");
assert.match(createProfile, /if \(!durableStaffId\)[\s\S]*SELECT id[\s\S]*auth_uid = \$\{sqlText\(uid\)\}[\s\S]*phone = \$\{sqlText\(phone\)\}/,
  "empty writable-CTE Rows must be recovered by an exact durable SELECT");

const finalReadback = between("async function authoritativeTeacherProvisioningState", "async function deleteTeacherProvisioningDatabaseRows");
assert.match(finalReadback, /teacher\.teacher_status = 'ACTIVE'[\s\S]*account\.account_status = 'ACTIVE'/);
assert.match(finalReadback, /exactAuthenticationUserByUid\(uid\)[\s\S]*normalizedMainlandPhone\(identity\.Phone\) !== phone[\s\S]*identity\.UserStatus/,
  "final success must independently prove the exact active auth UID and phone");

const compensation = between("async function compensateFailedTeacherProvision", "async function archiveStoreProvisioning");
const fenceWait = compensation.indexOf("finalRollbackNotBefore - Date.now()");
const rollback = compensation.indexOf('operation: "ROLLBACK"');
const databaseDelete = compensation.indexOf("deleteTeacherProvisioningDatabaseRows");
const authDelete = compensation.indexOf("deleteTeacherProvisioningAuthentication");
assert.ok(fenceWait >= 0 && rollback > fenceWait && databaseDelete > rollback && authDelete > databaseDelete,
  "saga compensation must fence the writer, rollback, then delete/read back DB and auth");
assert.equal(compensation.indexOf('operation: "ROLLBACK"', rollback + 1), -1,
  "a single rollback after the writer fence replaces unsafe early cleanup");
assert.match(compensation, /TEACHER_PROVISION_COMPENSATION_PENDING[\s\S]*cleanupPending = failures/,
  "unverified cleanup must remain an explicit failed/pending result");

function compensationRuntime({
  failRollback = false,
  lateCommitAfterMs = null
} = {}) {
  const order = [];
  const delays = [];
  const state = { remoteObjectPresent: false, lateCommitted: false };
  let rollbackCount = 0;
  const sandbox = {
    module: { exports: {} },
    console: { error: () => {} },
    TEACHER_FACE_COMPENSATION_SETTLE_MS: 350,
    cloudErrorDetails: (error) => ({ code: String(error?.code || ""), message: String(error?.message || "") }),
    requestIdFrom: () => "",
    blockTeacherAuthentication: async () => { order.push("auth:block"); },
    exactAuthenticationUserByUid: async () => ({ Uid: "teacher-owned" }),
    readTeacherFaceOperation: async () => ({
      operation_id: "51", auth_uid: "teacher-owned",
      auth_owner_token_sha256: "owned", operation_status: "CANCELLED"
    }),
    resolveTeacherProvisioningRows: async () => {
      order.push("db:discover");
      return { staff_id: "41", teacher_id: "7" };
    },
    delegateTeacherFace: async ({ operation }) => {
      assert.equal(operation, "ROLLBACK");
      rollbackCount += 1;
      order.push(`face:rollback:${rollbackCount}`);
      if (failRollback) {
        throw Object.assign(new Error(`rollback ${rollbackCount} unavailable`), { code: "FACE_ROLLBACK_FAILED" });
      }
      state.remoteObjectPresent = false;
      return { ok: true };
    },
    deleteTeacherProvisioningDatabaseRows: async () => { order.push("db:delete-confirmed"); },
    teacherProvisioningDelay: async (milliseconds) => {
      delays.push(milliseconds);
      order.push("settle");
      if (lateCommitAfterMs !== null && milliseconds >= lateCommitAfterMs) {
        state.remoteObjectPresent = true;
        state.lateCommitted = true;
        order.push("face:late-upsert-commit");
      }
    },
    teacherSagaOwnsAuthentication: () => true,
    teacherOperationOwnsAuthentication: () => true,
    teacherFaceDelegationLease: () => ({
      operationId: "51", ownerToken: "ab".repeat(32), leaseGeneration: 1,
      imageDigest: "12".repeat(32), imageBytes: 4
    }),
    transitionTeacherFaceOperation: async (operation, _expected, next) => {
      operation.status = next;
    },
    deleteTeacherProvisioningAuthentication: async () => { order.push("auth:delete-confirmed"); },
    archiveTeacherProvisioning: async () => { order.push("db:archive-pending"); }
  };
  vm.createContext(sandbox);
  vm.runInContext(`${compensation}\nmodule.exports = compensateFailedTeacherProvision;`, sandbox, {
    filename: "staff-teacher-compensation-runtime.js"
  });
  return {
    compensate: sandbox.module.exports,
    order,
    delays,
    state,
    finishLateChild() {
      if (!state.lateCommitted) state.remoteObjectPresent = true;
    }
  };
}

const provision = between("async function provisionTeacherWithFace", "// Face enrollment is deliberately independent");
assert.match(provision, /delegateTeacherFaceWithReadbackRetry\(delegationInput\)/);
assert.match(provision, /authoritativeTeacherProvisioningState\(\{/);
assert.match(provision, /readbackConfirmed: true[\s\S]*verification: finalVerification/);
assert.match(provision, /accountStatus: String\(final\.account_status\)/);
assert.doesNotMatch(provision, /facePhotoReady:\s*true/,
  "creation must derive photo readiness from final proof instead of hard-coding it");
assert.match(provision, /if \(!existing\)[\s\S]*compensateFailedTeacherProvision/,
  "only a genuinely new teacher may be removed by the creation saga");

const replacement = between("async function upsertTeacherFace", "async function requireTeacherExperienceQuotaSchema");
assert.match(replacement, /delegateTeacherFaceWithReadbackRetry\(delegationInput\)/);
assert.match(replacement, /previousPersonId,[\s\S]*previousPhotoReference[\s\S]*operation: "FINALIZE"/,
  "replacement must sign the exact previous pointers and finalize only after proof");
assert.match(replacement, /rollbackFailedTeacherFaceUpsert\(delegationInput, error, faceOperation\)/,
  "a possibly committed replacement failure must restore the exact previous pointers");
assert.doesNotMatch(replacement, /响应丢失后已自动恢复|persistedRows|face_person_id = \$\{sqlText\(nextPersonId\)\}/,
  "existing-face maintenance may not claim success from a local DB-only recovery");

assert.match(delegation, /operation: "READBACK"/,
  "lost write responses must recover through a signed read-only probe");
assert.doesNotMatch(delegation, /const recovered = await delegateTeacherFace\(input\)/,
  "response recovery must never replay the mutating UPSERT");
const fencePosition = delegation.indexOf("mutationMayRunUntil - Date.now()");
const finalReadPosition = delegation.indexOf("delegateTeacherFace(readbackInput)", fencePosition);
assert.ok(fencePosition >= 0 && finalReadPosition > fencePosition,
  "READBACK can become success only after the mutating invocation's 90-second fence");

const exportedError = between("exports.main = async", "};\n");
assert.match(exportedError, /cleanupComplete/);
assert.match(exportedError, /cleanupPending/);

const delegationRuntime = `${delegation}\nmodule.exports = { delegateTeacherFace, delegateTeacherFaceWithReadbackRetry };`;

function runtime(responseOrError) {
  const calls = [];
  const logs = [];
  const delays = [];
  const sandbox = {
    module: { exports: {} },
    Buffer,
    crypto,
    process: { env: { CLOUDBASE_APIKEY: "runtime-secret" } },
    TEACHER_FACE_DELEGATION_TIMEOUT_MS: 60 * 1000,
    TEACHER_FACE_COMPENSATION_SETTLE_MS: 0,
    TEACHER_FACE_TARGET_MAX_RUNTIME_MS: 90 * 1000,
    TEACHER_FACE_COMPLETION_FENCE_SAFETY_MS: 5 * 1000,
    teacherProvisioningDelay: async (milliseconds) => { delays.push(milliseconds); },
    fail,
    requestIdFrom: (error) => String(error?.RequestId || error?.requestId || ""),
    cloudErrorDetails: (error) => ({
      code: String(error?.response?.data?.Response?.Error?.Code || error?.code || ""),
      message: String(error?.response?.data?.Response?.Error?.Message || error?.message || "").slice(0, 300)
    }),
    console: { error: (...values) => logs.push(values) },
    getApp: () => ({
      callFunction: async (...args) => {
        calls.push(args);
        if (typeof responseOrError === "function") return await responseOrError(args, calls.length);
        if (responseOrError instanceof Error) throw responseOrError;
        return responseOrError;
      }
    })
  };
  vm.createContext(sandbox);
  vm.runInContext(delegationRuntime, sandbox, { filename: "staff-teacher-delegation-runtime.js" });
  return {
    delegate: sandbox.module.exports.delegateTeacherFace,
    recover: sandbox.module.exports.delegateTeacherFaceWithReadbackRetry,
    calls, logs, delays
  };
}

function validResponse(image, ids) {
  const digest = crypto.createHash("sha256").update(image.buffer).digest("hex");
  const reference = `pg://teacher-private/teachers/${ids.teacherId}/profile-history/${ids.personId}-${digest.slice(0, 32)}.jpg`;
  const objectName = reference.replace("pg://teacher-private/", "");
  return {
    result: {
      ok: true,
      teacher: {
        faceEnrollmentStatus: "ENROLLED",
        facePhotoReady: true,
        profilePhotoFileId: reference
      },
      readback: {
        person: {
          personId: ids.personId, personName: ids.teacherName,
          groupId: "teacher-group", faceId: "face-authoritative", confirmed: true
        },
        photo: {
          reference, bucketId: "teacher-private", objectName,
          bytes: image.buffer.length, sha256: digest,
          contentType: "image/jpeg", authenticated: true
        },
        database: {
          teacherId: String(ids.teacherId), staffId: String(ids.staffId),
          personId: ids.personId, photoReference: reference,
          faceEnrollmentStatus: "ENROLLED", confirmed: true
        }
      }
    }
  };
}

(async () => {
  const image = { buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), base64: "/9j/2Q==" };
  const ids = {
    operation: "PROVISION", teacherId: 7, staffId: 41, actorStaffId: 900,
    personId: "T-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    teacherName: "老师七", image, faceGroupId: "teacher-group",
    photoBucketId: "teacher-private",
    operationId: "51", ownerToken: "ab".repeat(32), leaseGeneration: 1
  };

  {
    const harness = runtime(validResponse(image, ids));
    const result = await harness.delegate(ids);
    assert.equal(result.verifiedReadback.person.confirmed, true);
    assert.equal(result.verifiedReadback.photo.authenticated, true);
    assert.equal(harness.calls.length, 1);
    assert.equal(harness.calls[0][1]?.timeout, 60 * 1000);
    assert.equal(harness.calls[0][0]?.data?.action, "upsertDelegatedTeacherFace");
    assert.equal(harness.calls[0][0]?.data?.previousPersonId, "");
    assert.equal(harness.calls[0][0]?.data?.previousPhotoReference, "");
  }

  {
    const incomplete = validResponse(image, ids);
    delete incomplete.result.readback.photo.sha256;
    const harness = runtime(incomplete);
    await assert.rejects(harness.delegate(ids), (error) => error.code === "TEACHER_FACE_REMOTE_READBACK_INCOMPLETE");
  }

  {
    const previousPersonId = "T-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
    const previousPhotoReference = "pg://teacher-private/teachers/7/profile-history/previous.jpg";
    const previousFaceConsentAt = "2026-08-01T01:02:03.123456Z";
    const previousFaceEnrolledAt = "2026-08-01T01:02:04.654321Z";
    const previousFaceEnrolledByAccountId = "901";
    const harness = runtime({
      result: {
        ok: true,
        cleanup: {
          databaseRestored: true,
          previousPersonId,
          previousPhotoReference,
          previousFaceEnrollmentStatus: "ENROLLED",
          previousFaceConsentAt,
          previousFaceEnrolledAt,
          previousFaceEnrolledByAccountId,
          previousMetadataRestored: true,
          personDeleted: true,
          photoDeleted: true,
          teacherId: "7",
          staffId: "41",
          operationId: ids.operationId,
          leaseGeneration: String(ids.leaseGeneration),
          faceGroupId: ids.faceGroupId,
          photoBucketId: ids.photoBucketId,
          personId: ids.personId
        }
      }
    });
    await harness.delegate({
      ...ids, operation: "ROLLBACK", previousPersonId, previousPhotoReference,
      previousFaceEnrollmentStatus: "ENROLLED", previousFaceConsentAt,
      previousFaceEnrolledAt, previousFaceEnrolledByAccountId
    });
    assert.equal(harness.calls[0][0]?.data?.action, "rollbackDelegatedTeacherFace");
    assert.equal(harness.calls[0][0]?.data?.previousPersonId, previousPersonId);
    assert.equal(harness.calls[0][0]?.data?.previousPhotoReference, previousPhotoReference);
  }

  {
    const nested = Object.assign(new Error("outer invocation failed"), {
      requestId: "req-nested",
      response: { data: { Response: { Error: { Code: "FUNCTION_TIMEOUT", Message: "inner timed out" } } } }
    });
    const harness = runtime(nested);
    await assert.rejects(harness.delegate(ids), (error) => {
      assert.equal(error.code, "TEACHER_FACE_DELEGATION_FAILED");
      assert.equal(error.requestId, "req-nested");
      assert.equal(error.causeCode, "FUNCTION_TIMEOUT");
      assert.equal(error.causeMessage, "inner timed out");
      return true;
    });
    assert.equal(harness.logs.length, 1, "nested invocation failures must be logged safely");
  }

  // A lost UPSERT response gets no second write. The sole READBACK is invoked
  // only after awaiting the exact 90-second child lifetime plus safety margin.
  {
    const transport = Object.assign(new Error("upsert response lost"), { code: "FUNCTION_TIMEOUT" });
    const harness = runtime((args, callNumber) => {
      if (callNumber === 1) throw transport;
      return validResponse(image, ids);
    });
    const result = await harness.recover(ids);
    assert.equal(result.verifiedReadback.database.confirmed, true);
    assert.deepEqual(
      harness.calls.map((call) => call[0]?.data?.action),
      ["upsertDelegatedTeacherFace", "readbackDelegatedTeacherFace"]
    );
    assert.equal(harness.delays.length, 1);
    assert.ok(harness.delays[0] >= 90_000,
      "the stable readback must await the mutating child's full lifetime and margin");
  }

  {
    const harness = compensationRuntime();
    const result = await harness.compensate({
      uid: "teacher-owned", phone: "13900000007", authUser: {}, authCreated: true,
      faceOperation: { id: "51", status: "CANCELLED", ownerToken: "ab".repeat(32),
        ownerTokenHash: "owned", leaseGeneration: 1 },
      staffId: "41", teacherId: "7", actorStaffId: "900",
      personId: ids.personId, teacherName: ids.teacherName, image,
      originalError: Object.assign(new Error("activation failed"), { code: "AUTH_ACTIVATION_FAILED" })
    });
    assert.equal(result.ok, true);
    assert.deepEqual(Array.from(harness.order), [
      "auth:block", "db:discover", "settle", "face:rollback:1",
      "db:delete-confirmed", "auth:delete-confirmed"
    ]);
  }

  // If the post-fence cleanup still cannot be proven, the function remains a
  // failure and preserves both the archived DB marker and blocked Auth user.
  {
    const harness = compensationRuntime({ failRollback: true });
    await assert.rejects(
      harness.compensate({
        uid: "teacher-owned", phone: "13900000007", authUser: {}, authCreated: true,
        faceOperation: { id: "51", status: "CANCELLED", ownerToken: "ab".repeat(32),
          ownerTokenHash: "owned", leaseGeneration: 1 },
        staffId: "41", teacherId: "7", actorStaffId: "900",
        personId: ids.personId, teacherName: ids.teacherName, image,
        originalError: new Error("activation failed")
      }),
      (error) => {
        assert.equal(error.code, "TEACHER_PROVISION_COMPENSATION_PENDING");
        assert.equal(error.cleanupPending.some((entry) => entry.stage === "FACE_ROLLBACK_CONFIRM"), true);
        return true;
      }
    );
    assert.equal(harness.order.includes("db:delete-confirmed"), false);
    assert.equal(harness.order.includes("auth:delete-confirmed"), false);
    assert.equal(harness.order.at(-1), "db:archive-pending");
  }

  // A timed-out UPSERT may keep running in faceRecognition after the 60-second
  // SDK call returns. The completion fence holds rollback until that child is
  // extinct, so a late object is observed and removed before cleanup success.
  {
    const harness = compensationRuntime({ lateCommitAfterMs: 25_000 });
    const originalError = Object.assign(new Error("second invocation timed out"), {
      code: "TEACHER_FACE_DELEGATION_FAILED",
      delegationMayRunUntil: Date.now() + 30_000
    });
    const result = await harness.compensate({
      uid: "teacher-owned", phone: "13900000007", authUser: {}, authCreated: true,
      faceOperation: { id: "51", status: "CANCELLED", ownerToken: "ab".repeat(32),
        ownerTokenHash: "owned", leaseGeneration: 1 },
      staffId: "41", teacherId: "7", actorStaffId: "900",
      personId: ids.personId, teacherName: ids.teacherName, image, originalError
    });
    harness.finishLateChild();
    assert.equal(result.ok, true);
    assert.ok(harness.delays[0] >= 25_000,
      "final rollback must wait until the second child invocation cannot still commit");
    assert.equal(harness.state.lateCommitted, true,
      "the test must actually place the late commit inside the writer fence");
    assert.equal(harness.state.remoteObjectPresent, false,
      "final rollback must remove the object created by the late second invocation");
    assert.ok(
      harness.order.indexOf("face:late-upsert-commit") < harness.order.indexOf("face:rollback:1")
      && harness.order.indexOf("face:rollback:1") < harness.order.indexOf("db:delete-confirmed"),
      "the simulated late commit must occur before the single post-fence rollback"
    );
  }

  console.log("teacher provision saga runtime contract: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
