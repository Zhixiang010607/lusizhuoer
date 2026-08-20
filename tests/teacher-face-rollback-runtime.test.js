"use strict";

// The teacher-creation saga must be able to compensate a completed face
// delegation without trusting delete responses. This executes the production
// rollback ordering against in-memory DB/Storage/IAI boundaries.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "cloudfunctions", "faceRecognition", "index.js"),
  "utf8"
);

function functionSource(name, nextName) {
  const start = source.indexOf(`async function ${name}`);
  const end = source.indexOf(`\n${nextName}`, start + 1);
  assert.ok(start >= 0 && end > start, `missing source region ${name}`);
  return source.slice(start, end);
}

const rollbackSource = functionSource(
  "rollbackDelegatedTeacherFace", "async function getCustomerPhotoUrl"
);
const finalizeSource = functionSource(
  "finalizeDelegatedTeacherFace", "async function getCustomerPhotoUrl"
);

function sourceBetween(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `missing source region ${startMarker}`);
  return source.slice(start, end);
}

function failure(message, code = "BAD_REQUEST") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function harness({ conflict = false, remoteFailsOnce = false, restorePrevious = false,
  sameCandidate = false } = {}) {
  const personId = "T-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const expectedReference = `pg://original-photo-bucket/teachers/7/profile-history/${personId}-0123456789abcdef0123456789abcdef.jpg`;
  const previousPersonId = sameCandidate
    ? personId
    : restorePrevious
    ? "T-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"
    : "";
  const previousPhotoReference = sameCandidate
    ? expectedReference
    : restorePrevious
    ? "pg://customer-photos/teachers/7/profile-history/old-face.jpg"
    : "";
  const hadPrevious = restorePrevious || sameCandidate;
  const previousFaceConsentAt = hadPrevious ? "2026-07-01T01:02:03.123456Z" : "";
  const previousFaceEnrolledAt = hadPrevious ? "2026-07-01T01:02:04.654321Z" : "";
  const previousFaceEnrolledByAccountId = hadPrevious ? "811" : "";
  const state = {
    facePersonId: conflict ? "T-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" : personId,
    faceEnrollmentStatus: "ENROLLED",
    photoReference: expectedReference,
    faceConsentAt: sameCandidate ? previousFaceConsentAt : "2026-08-20T01:02:03.000000Z",
    faceEnrolledAt: sameCandidate ? previousFaceEnrolledAt : "2026-08-20T01:02:04.000000Z",
    faceEnrolledByAccountId: sameCandidate ? previousFaceEnrolledByAccountId : "900",
    updateCount: 0,
    photoDeleteCount: 0,
    personDeleteCount: 0,
    remoteAttempt: 0,
    order: []
  };
  const context = {
    module: { exports: {} },
    console: { warn() {} },
    verifyTeacherFaceDelegation: () => ({
      operation: "ROLLBACK",
      teacherId: 7,
      staffId: 41,
      actorStaffId: 900,
      personId,
      teacherName: "老师七",
      faceGroupId: "face-group",
      photoBucketId: "original-photo-bucket",
      imageDigest: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      operationId: 51,
      leaseGeneration: 3,
      previousPersonId,
      previousPhotoReference,
      previousFaceEnrollmentStatus: hadPrevious ? "ENROLLED" : "PENDING",
      previousFaceConsentAt,
      previousFaceEnrolledAt,
      previousFaceEnrolledByAccountId
    }),
    assertTeacherFaceOperationLease: async () => ({ operation_status: "CANCELLED" }),
    teacherFaceOperationLeaseExistsSql: () => "TRUE",
    teacherProfilePhotoObject: () => ({
      bucketId: "customer-photos",
      objectName: expectedReference.replace(/^pg:\/\/[^/]+\//, ""),
      reference: expectedReference
    }),
    sqlText: (value) => `'${String(value).replace(/'/g, "''")}'`,
    fail: failure,
    faceClient: () => ({}),
    required: () => "drifted-config-group",
    confirmTeacherFacePerson: async (_api, groupId, confirmedPersonId, _faceId, personName) => {
      state.order.push("read-old-person");
      assert.equal(groupId, "face-group");
      assert.equal(confirmedPersonId, previousPersonId);
      assert.equal(personName, undefined,
        "durable cleanup must not depend on a mutable teacher display name");
      return { confirmed: true };
    },
    confirmRetainedTeacherProfilePhoto: async (reference) => {
      state.order.push("read-old-photo");
      assert.equal(reference, previousPhotoReference);
      return { authenticatedReadback: true };
    },
    deleteTeacherProfilePhotoExact: async () => {
      state.order.push("delete-photo-and-read-missing");
      state.photoDeleteCount += 1;
      state.remoteAttempt += 1;
      return !(remoteFailsOnce && state.remoteAttempt === 1);
    },
    deleteTeacherFacePersonExact: async (_api, groupId) => {
      assert.equal(groupId, "face-group",
        "rollback must use the group persisted in the signed operation lease");
      state.order.push("delete-person-and-read-missing");
      state.personDeleteCount += 1;
      return true;
    },
    executeSql: async (sql) => {
      if (sql.includes("FROM public.teachers AS teacher") && sql.includes("teacher.teacher_name")) {
        return [{
          actor_role: "hq",
          actor_status: "ACTIVE",
          teacher_id: 7,
          staff_account_id: 41,
          teacher_name: "老师七",
          face_person_id: state.facePersonId,
          face_enrollment_status: state.faceEnrollmentStatus,
          profile_photo_file_id: state.photoReference,
          face_consent_at_canonical: state.faceConsentAt || "",
          face_enrolled_at_canonical: state.faceEnrolledAt || "",
          face_enrolled_by_account_id: state.faceEnrolledByAccountId || ""
        }];
      }
      if (sql.includes("UPDATE public.teachers AS teacher")) {
        state.order.push(hadPrevious ? "restore-database" : "clear-database");
        state.updateCount += 1;
        state.facePersonId = previousPersonId;
        state.faceEnrollmentStatus = hadPrevious ? "ENROLLED" : "PENDING";
        state.photoReference = previousPhotoReference;
        state.faceConsentAt = previousFaceConsentAt;
        state.faceEnrolledAt = previousFaceEnrolledAt;
        state.faceEnrolledByAccountId = previousFaceEnrolledByAccountId;
        return [];
      }
      if (sql.includes("SELECT teacher.face_person_id")) {
        state.order.push("read-database-cleared");
        return [{
          face_person_id: state.facePersonId,
          face_enrollment_status: state.faceEnrollmentStatus,
          profile_photo_file_id: state.photoReference,
          face_consent_at_canonical: state.faceConsentAt || "",
          face_enrolled_at_canonical: state.faceEnrolledAt || "",
          face_enrolled_by_account_id: state.faceEnrolledByAccountId || ""
        }];
      }
      throw new Error(`unexpected SQL: ${sql.slice(0, 120)}`);
    }
  };
  vm.createContext(context);
  vm.runInContext(`${rollbackSource}\nmodule.exports = rollbackDelegatedTeacherFace;`, context, {
    filename: "faceRecognition-teacher-face-rollback.js"
  });
  return { state, rollback: context.module.exports };
}

(async () => {
  // Migration 051 lease ownership is checked from durable PostgreSQL state,
  // not merely from the signed payload. A wrong owner token or expired
  // RUNNING generation is rejected; the same owner may reconcile CANCELLED.
  {
    const leaseSource = sourceBetween(
      "function teacherFaceLeaseOwnerHash", "function cleanVerificationJpeg"
    );
    const crypto = require("node:crypto");
    const ownerToken = "ab".repeat(32);
    const command = {
      operation: "UPSERT", operationId: "51", ownerToken, leaseGeneration: "3",
      teacherId: 7, staffId: 41, actorStaffId: 900,
      personId: "T-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      teacherName: "老师七", imageDigest: "12".repeat(32), imageBytes: 12345,
      faceGroupId: "face-group",
      photoBucketId: "original-photo-bucket",
      previousPersonId: "T-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
      previousPhotoReference: "pg://customer-photos/teachers/7/old.jpg",
      previousFaceEnrollmentStatus: "ENROLLED",
      previousFaceConsentAt: "2026-07-01T01:02:03.123456Z",
      previousFaceEnrolledAt: "2026-07-01T01:02:04.654321Z",
      previousFaceEnrolledByAccountId: "811"
    };
    const state = { status: "RUNNING", active: true };
    const context = {
      module: { exports: {} }, crypto,
      fail: failure,
      databaseBoolean: (value) => value === true,
      executeSql: async () => [{
        operation_id: "51", operation_type: "UPSERT", teacher_name: "老师七",
        face_group_id: "face-group",
        photo_bucket_id: "original-photo-bucket",
        staff_id: "41", teacher_id: "7", person_id: command.personId,
        image_sha256: command.imageDigest, image_bytes: "12345",
        actor_staff_account_id: "900",
        owner_token_sha256: crypto.createHash("sha256").update(ownerToken).digest("hex"),
        lease_generation: "3", operation_status: state.status, lease_active: state.active,
        previous_person_id: command.previousPersonId,
        previous_photo_reference: command.previousPhotoReference,
        previous_face_enrollment_status: "ENROLLED",
        previous_face_consent_at_canonical: command.previousFaceConsentAt,
        previous_face_enrolled_at_canonical: command.previousFaceEnrolledAt,
        previous_face_enrolled_by_account_id: "811"
      }]
    };
    vm.createContext(context);
    vm.runInContext(`${leaseSource}\nmodule.exports = assertTeacherFaceOperationLease;`, context);
    assert.equal((await context.module.exports(command, ["RUNNING"])).operation_id, "51");
    await assert.rejects(
      context.module.exports({ ...command, ownerToken: "cd".repeat(32) }, ["RUNNING"]),
      (error) => error.code === "TEACHER_FACE_OPERATION_LEASE_LOST"
    );
    state.active = false;
    await assert.rejects(
      context.module.exports(command, ["RUNNING"]),
      (error) => error.code === "TEACHER_FACE_OPERATION_LEASE_LOST"
    );
    state.status = "CANCELLED";
    await assert.rejects(
      context.module.exports(command, ["CANCELLED"]),
      (error) => error.code === "TEACHER_FACE_OPERATION_LEASE_LOST",
      "an expired cancelled owner must not execute remote rollback deletes"
    );
    state.active = true;
    assert.equal((await context.module.exports(command, ["CANCELLED"])).operation_id, "51");
  }

  // Even when two accounts submit the same request id and byte-identical
  // photo, the remote PersonId is bound to the concrete teacher/staff pair.
  {
    const subjectSource = sourceBetween(
      "function teacherFaceSubjectPersonId", "function verifyTeacherFaceDelegation"
    );
    const context = { module: { exports: {} }, crypto: require("node:crypto"), fail: failure };
    vm.createContext(context);
    vm.runInContext(`${subjectSource}\nmodule.exports = teacherFaceSubjectPersonId;`, context);
    const digest = "12".repeat(32);
    const first = context.module.exports(7, 41, digest);
    const second = context.module.exports(8, 42, digest);
    assert.match(first, /^T-[A-F0-9]{48}$/);
    assert.match(second, /^T-[A-F0-9]{48}$/);
    assert.notEqual(first, second,
      "the same image/request across teachers must never reuse a Tencent PersonId");

    const scopedDeleteSource = sourceBetween(
      "async function teacherFacePersonGroupIds", "function teacherFaceResult"
    );
    const deleted = [];
    const deleteContext = {
      module: { exports: {} }, console: { warn() {} }, fail: failure,
      teacherFaceRemoteDeleteUnreferenced: async () => true,
      teacherFacePersonMissingError: () => false
    };
    vm.createContext(deleteContext);
    vm.runInContext(
      `${scopedDeleteSource}\nmodule.exports = deleteTeacherFacePersonExact;`,
      deleteContext
    );
    let memberships = ["face-group"];
    assert.equal(await deleteContext.module.exports({
      async GetPersonGroupInfo() {
        return { TotalCount: memberships.length,
          PersonGroupInfos: memberships.map((GroupId) => ({ GroupId })) };
      },
      async DeletePersonFromGroup({ PersonId }) {
        deleted.push(PersonId);
        memberships = [];
      }
    }, "face-group", first, async () => {}), true);
    assert.deepEqual(deleted, [first]);
    assert.notEqual(deleted[0], second,
      "cleaning one teacher's same-image candidate must not address the other account's PersonId");
  }

  // Deterministic derivation also needs a legacy-data guard: an old corrupt
  // row may already point another account at the same PersonId. Duplicate
  // recovery may accept only an empty reference set or this exact teacher.
  {
    const referenceGuardSource = sourceBetween(
      "async function assertTeacherFacePersonSubjectReferences",
      "async function deleteTeacherProfilePhotoExact"
    );
    let references = [{ reference_kind: "teacher", reference_id: "7" }];
    const context = {
      module: { exports: {} },
      teacherFacePersonDatabaseReferences: async () => references,
      fail: failure
    };
    vm.createContext(context);
    vm.runInContext(
      `${referenceGuardSource}\nmodule.exports = assertTeacherFacePersonSubjectReferences;`,
      context
    );
    assert.equal((await context.module.exports("T-CANDIDATE", 7)).length, 1);
    references = [{ reference_kind: "teacher", reference_id: "8" }];
    await assert.rejects(
      context.module.exports("T-CANDIDATE", 7),
      (error) => error.code === "TEACHER_FACE_PERSON_CONFLICT"
    );
    references = [{ reference_kind: "customer", reference_id: "88" }];
    await assert.rejects(
      context.module.exports("T-CANDIDATE", 7),
      (error) => error.code === "TEACHER_FACE_PERSON_CONFLICT"
    );
  }

  // A SUCCEEDED operation may finalize while a newer replacement is already
  // using its old Person as a candidate/rollback target. Active operation-row
  // references are global references too, excluding only the deleting saga.
  {
    const operationReferenceSource = sourceBetween(
      "function teacherFaceOperationExclusionSql",
      "async function assertTeacherFacePersonSubjectReferences"
    );
    let capturedSql = "";
    const context = {
      module: { exports: {} },
      console: { warn() {} },
      sqlText: (value) => `'${String(value).replace(/'/g, "''")}'`,
      executeSql: async (sql) => {
        capturedSql = sql;
        return [{ reference_kind: "teacher_face_operation", reference_id: "52" }];
      }
    };
    vm.createContext(context);
    vm.runInContext(
      `${operationReferenceSource}\nmodule.exports = teacherFaceRemoteDeleteUnreferenced;`,
      context
    );
    assert.equal(await context.module.exports("person", "T-CANDIDATE", "51"), false);
    assert.match(capturedSql, /operation\.id <> 51::bigint/);
    assert.match(capturedSql, /operation\.person_id[\s\S]{0,100}operation\.previous_person_id/);
  }

  // Legacy data can still contain an accidentally shared PersonId or object.
  // Every remote delete must stop before touching Storage/IAI when any global
  // database reference remains.
  {
    let personDeletes = 0;
    const exactPersonDeleteSource = sourceBetween(
      "async function deleteTeacherFacePersonExact", "function teacherFaceResult"
    );
    const personContext = {
      module: { exports: {} },
      console: { warn() {} },
      teacherFaceRemoteDeleteUnreferenced: async () => false,
      teacherFacePersonMissingError: () => false
    };
    vm.createContext(personContext);
    vm.runInContext(`${exactPersonDeleteSource}\nmodule.exports = deleteTeacherFacePersonExact;`, personContext);
    const personDeleted = await personContext.module.exports({
      async DeletePerson() { personDeletes += 1; },
      async GetPersonBaseInfo() { return {}; }
    }, "face-group", "T-SHARED", async () => {});
    assert.equal(personDeleted, false);
    assert.equal(personDeletes, 0, "referenced PersonId must not reach DeletePerson");

    let photoDeletes = 0;
    const exactPhotoDeleteSource = sourceBetween(
      "async function deleteTeacherProfilePhotoExact", "async function uploadTeacherProfilePhoto"
    );
    const photoContext = {
      module: { exports: {} },
      console: { warn() {} },
      teacherFaceRemoteDeleteUnreferenced: async () => false,
      photoStorageSettings: () => ({ accessToken: "token", envId: "env" }),
      manager: () => ({ storage: { async deleteObject() { photoDeletes += 1; } } }),
      storageObjectMissing: () => false
    };
    vm.createContext(photoContext);
    vm.runInContext(`${exactPhotoDeleteSource}\nmodule.exports = deleteTeacherProfilePhotoExact;`, photoContext);
    const photoDeleted = await photoContext.module.exports({
      bucketId: "customer-photos",
      objectName: "teachers/shared.jpg",
      reference: "pg://customer-photos/teachers/shared.jpg"
    }, async () => {});
    assert.equal(photoDeleted, false);
    assert.equal(photoDeletes, 0, "referenced teacher photo must not reach Storage delete");
  }

  // Tencent DeletePerson is global across all groups. Compensation must use
  // DeletePersonFromGroup and prove only this application's membership is
  // gone, leaving an unexpected second-group membership intact.
  {
    const scopedDeleteSource = sourceBetween(
      "async function teacherFacePersonGroupIds", "function teacherFaceResult"
    );
    const memberships = new Set(["face-group", "other-group"]);
    const calls = [];
    const context = {
      module: { exports: {} },
      console: { warn() {} },
      fail: failure,
      teacherFaceRemoteDeleteUnreferenced: async () => true,
      teacherFacePersonMissingError: () => false
    };
    vm.createContext(context);
    vm.runInContext(
      `${scopedDeleteSource}\nmodule.exports = deleteTeacherFacePersonExact;`,
      context
    );
    const removed = await context.module.exports({
      async GetPersonGroupInfo() {
        return {
          TotalCount: memberships.size,
          PersonGroupInfos: [...memberships].map((GroupId) => ({ GroupId }))
        };
      },
      async DeletePersonFromGroup({ GroupId, PersonId }) {
        calls.push({ operation: "DeletePersonFromGroup", GroupId, PersonId });
        memberships.delete(GroupId);
      },
      async DeletePerson() {
        throw new Error("global DeletePerson must never be called");
      }
    }, "face-group", "T-MULTI-GROUP", async () => {});
    assert.equal(removed, false,
      "removing only the bound group must not be reported as global Person deletion");
    assert.deepEqual(calls, [{
      operation: "DeletePersonFromGroup", GroupId: "face-group", PersonId: "T-MULTI-GROUP"
    }]);
    assert.deepEqual([...memberships], ["other-group"],
      "cleanup must preserve every non-application group and remain pending");
  }

  {
    const subject = harness();
    const result = await subject.rollback({});
    assert.equal(result.ok, true);
    assert.equal(result.rolledBack, true);
    assert.deepEqual(JSON.parse(JSON.stringify(result.cleanup)), {
      teacherId: "7",
      staffId: "41",
      operationId: 51,
      leaseGeneration: 3,
      faceGroupId: "face-group",
      photoBucketId: "original-photo-bucket",
      personId: "T-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      photoReference: "pg://original-photo-bucket/teachers/7/profile-history/T-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA-0123456789abcdef0123456789abcdef.jpg",
      previousPersonId: "",
      previousPhotoReference: "",
      previousFaceEnrollmentStatus: "PENDING",
      previousFaceConsentAt: "",
      previousFaceEnrolledAt: "",
      previousFaceEnrolledByAccountId: "",
      previousMetadataRestored: true,
      databaseRestored: true,
      databaseCleared: true,
      photoDeleted: true,
      personDeleted: true
    });
    assert.deepEqual(subject.state.order.slice(0, 2), [
      "clear-database", "read-database-cleared"
    ], "DB pointers must be cleared and read back before remote deletion");
  }

  {
    const subject = harness({ conflict: true });
    await assert.rejects(
      subject.rollback({}),
      (error) => error.code === "TEACHER_FACE_ROLLBACK_CONFLICT"
    );
    assert.equal(subject.state.updateCount, 0);
    assert.equal(subject.state.photoDeleteCount, 0);
    assert.equal(subject.state.personDeleteCount, 0);
  }

  {
    const subject = harness({ remoteFailsOnce: true });
    await assert.rejects(
      subject.rollback({}),
      (error) => error.code === "TEACHER_FACE_ROLLBACK_REMOTE_FAILED"
    );
    assert.equal(subject.state.faceEnrollmentStatus, "PENDING");
    assert.equal(subject.state.updateCount, 1);
    const result = await subject.rollback({});
    assert.equal(result.cleanup.databaseCleared, true);
    assert.equal(result.cleanup.photoDeleted, true);
    assert.equal(result.cleanup.personDeleted, true);
    assert.equal(subject.state.updateCount, 1,
      "an idempotent retry must not rewrite an already-cleared DB pointer");
  }

  // Existing-teacher replacement rollback first proves the retained old
  // Person/photo, conditionally restores their exact pointers, then deletes
  // only the failed candidate. The original enrollment remains authoritative.
  {
    const subject = harness({ restorePrevious: true });
    const result = await subject.rollback({});
    assert.equal(result.cleanup.databaseRestored, true);
    assert.equal(result.cleanup.databaseCleared, false);
    assert.equal(result.cleanup.previousPersonId,
      "T-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC");
    assert.equal(result.cleanup.previousPhotoReference,
      "pg://customer-photos/teachers/7/profile-history/old-face.jpg");
    assert.equal(result.cleanup.previousFaceEnrollmentStatus, "ENROLLED");
    assert.equal(result.cleanup.previousFaceConsentAt, "2026-07-01T01:02:03.123456Z");
    assert.equal(result.cleanup.previousFaceEnrolledAt, "2026-07-01T01:02:04.654321Z");
    assert.equal(result.cleanup.previousFaceEnrolledByAccountId, "811");
    assert.equal(result.cleanup.previousMetadataRestored, true);
    assert.equal(subject.state.facePersonId,
      "T-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC");
    assert.equal(subject.state.faceEnrollmentStatus, "ENROLLED");
    assert.equal(subject.state.photoReference,
      "pg://customer-photos/teachers/7/profile-history/old-face.jpg");
    const restoreIndex = subject.state.order.indexOf("restore-database");
    const deleteIndex = subject.state.order.indexOf("delete-photo-and-read-missing");
    assert.ok(subject.state.order.includes("read-old-person"));
    assert.ok(subject.state.order.includes("read-old-photo"));
    assert.ok(restoreIndex >= 0 && deleteIndex > restoreIndex,
      "old pointers must be restored and read back before candidate cleanup");
  }

  // Replaying an UPSERT with the same JPEG derives the already-enrolled
  // PersonId and photo reference. The cancelled operation is already at its
  // previous state, so rollback must be a read-only proof and must not delete
  // either pre-existing remote resource.
  {
    const subject = harness({ sameCandidate: true });
    const result = await subject.rollback({});
    assert.equal(result.cleanup.databaseRestored, true);
    assert.equal(result.cleanup.databaseCleared, false);
    assert.equal(result.cleanup.personId, result.cleanup.previousPersonId);
    assert.equal(result.cleanup.photoReference, result.cleanup.previousPhotoReference);
    assert.equal(result.cleanup.photoDeleted, true);
    assert.equal(result.cleanup.personDeleted, true);
    assert.equal(subject.state.updateCount, 0,
      "same-candidate rollback must not rewrite an already exact old snapshot");
    assert.equal(subject.state.photoDeleteCount, 0,
      "same-candidate rollback must not delete the retained photo");
    assert.equal(subject.state.personDeleteCount, 0,
      "same-candidate rollback must not delete the retained Person");
  }

  // Successful same-candidate replay also makes FINALIZE a no-op. In
  // particular it must not call the group-scoped delete helper for the Person
  // that remains current.
  {
    let personDeleteCount = 0;
    const context = {
      module: { exports: {} },
      verifyTeacherFaceDelegation: () => ({
        operation: "FINALIZE",
        faceGroupId: "face-group",
        photoBucketId: "original-photo-bucket",
        previousPersonId: "T-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        personId: "T-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
      }),
      assertTeacherFaceOperationLease: async () => ({ operation_status: "SUCCEEDED" }),
      deleteTeacherFacePersonExact: async () => { personDeleteCount += 1; return true; }
    };
    vm.createContext(context);
    vm.runInContext(`${finalizeSource}\nmodule.exports = finalizeDelegatedTeacherFace;`, context);
    const result = await context.module.exports({});
    assert.equal(result.ok, true);
    assert.equal(result.finalized, true);
    assert.equal(personDeleteCount, 0,
      "same-candidate FINALIZE must preserve the current pre-existing Person");
  }

  assert.match(source, /if \(action === "rollbackDelegatedTeacherFace"\)/,
    "the signed rollback action must remain dispatched only by its private action name");
  assert.match(source, /\["PROVISION", "UPSERT", "READBACK", "ROLLBACK", "FINALIZE"\]/,
    "ROLLBACK must pass the same signed, expiring service delegation verifier");
  assert.match(rollbackSource, /AND \$\{rollbackLeaseSql\}/,
    "rollback pointer restoration must atomically fence the durable cancellation owner");
  assert.doesNotMatch(rollbackSource, /actor_role|actor_status|只有活跃总部账号可以回滚/,
    "durable cleanup must not become stranded if the original HQ actor is later archived");
  assert.doesNotMatch(rollbackSource, /老师姓名已变更/,
    "durable cleanup must not become stranded after an unrelated teacher rename");

  console.log("teacher face rollback runtime: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
