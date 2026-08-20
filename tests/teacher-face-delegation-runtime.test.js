"use strict";

// Behavioural tests for the cross-function teacher-face protocol.  The real
// CloudBase/Tencent services are replaced only at their I/O boundary; the
// production sequencing, error branches and response-loss recovery execute
// unchanged in a VM.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const staffSource = fs.readFileSync(path.join(root, "cloudfunctions", "staffAccount", "index.js"), "utf8");
const faceSource = fs.readFileSync(path.join(root, "cloudfunctions", "faceRecognition", "index.js"), "utf8");

function between(source, first, last) {
  const start = source.indexOf(first);
  const end = source.indexOf(last, start + first.length);
  assert.ok(start >= 0 && end > start, `missing source region ${first}`);
  return source.slice(start, end);
}

function failure(message, code = "BAD_REQUEST") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

const delegatedUpsertSource = between(faceSource,
  "async function upsertDelegatedTeacherFace", "\nasync function getCustomerPhotoUrl");
const teacherFaceImageSource = between(staffSource,
  "function teacherFaceImage", "\nfunction teacherFacePersonId");
const teacherFacePersonIdSource = between(staffSource,
  "function teacherFacePersonId", "\n\nconst TEACHER_FACE_DELEGATION_VERSION");
const teacherFaceRequestIdSource = between(staffSource,
  "function teacherFaceProvisionRequestId", "\n\nasync function requireTeacherFaceSchema");
const staffFaceUpsertSource = between(staffSource,
  "async function upsertTeacherFace", "\n\nasync function requireTeacherExperienceQuotaSchema");
const staffFaceProvisionSource = between(staffSource,
  "async function provisionTeacherWithFace", "\n\n// Face enrollment is deliberately independent");

function sqlText(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function commandFor({ personId = "T-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } = {}) {
  return {
    teacherId: 7,
    staffId: 41,
    actorStaffId: 900,
    personId,
    teacherName: "老师七",
    faceGroupId: "face-group",
    photoBucketId: "customer-photos",
    image: { base64: "/9j/2Q==", buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }
  };
}

function delegatedHarness(mode = "success", { sameCandidate = false } = {}) {
  const command = commandFor();
  const storedPhoto = {
    bucketId: "customer-photos",
    objectName: "teachers/7/profile-history/new.jpg",
    reference: "pg://customer-photos/teachers/7/profile-history/new.jpg"
  };
  const previous = {
    personId: sameCandidate
      ? command.personId
      : "T-OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLD",
    photo: sameCandidate
      ? storedPhoto.reference
      : "pg://customer-photos/teachers/7/old.jpg",
    consentAt: "2026-08-01T01:02:03.123456Z",
    enrolledAt: "2026-08-01T01:02:04.654321Z",
    enrolledBy: "901"
  };
  const state = {
    personId: previous.personId,
    photo: previous.photo,
    status: "ENROLLED",
    consentAt: previous.consentAt,
    enrolledAt: previous.enrolledAt,
    enrolledBy: previous.enrolledBy,
    order: [],
    saved: false
  };
  const current = () => ({
    id: 7,
    staff_account_id: 41,
    teacher_code: "T007",
    teacher_name: "老师七",
    teacher_status: "ACTIVE",
    face_person_id: state.personId,
    face_enrollment_status: state.status,
    face_enrolled_at: "2026-08-20T00:00:00Z",
    face_consent_at_canonical: state.consentAt,
    face_enrolled_at_canonical: state.enrolledAt,
    face_enrolled_by_account_id: state.enrolledBy,
    profile_photo_file_id: state.photo,
    role_code: "teacher",
    account_status: "ACTIVE",
    actor_role: "hq",
    actor_status: "ACTIVE"
  });
  command.previousPersonId = state.personId;
  command.previousPhotoReference = state.photo;
  command.previousFaceEnrollmentStatus = state.status;
  command.previousFaceConsentAt = state.consentAt;
  command.previousFaceEnrolledAt = state.enrolledAt;
  command.previousFaceEnrolledByAccountId = state.enrolledBy;
  const harness = {
    module: { exports: {} },
    console: { warn() {} },
    FACE_MODEL_VERSION: "3.0",
    verifyTeacherFaceDelegation: () => command,
    assertTeacherFaceOperationLease: async () => ({ operation_status: "RUNNING" }),
    bindTeacherFaceOperationFaceId: async () => ({ candidate_face_id: "face-new" }),
    teacherFaceOperationLeaseExistsSql: () => "TRUE",
    sqlText,
    fail: failure,
    required: () => "face-group",
    faceClient: () => ({
      CreatePerson: async ({ PersonId }) => {
        state.order.push(`create:${PersonId}`);
        if (sameCandidate) {
          throw Object.assign(new Error("person already exists"), { code: "PersonDup" });
        }
        return { FaceId: "face-new" };
      }
    }),
    inspectFaceImage: async () => ({ qualityScore: 99 }),
    inspectLiveness: async () => ({ checked: true, score: 99 }),
    duplicateTeacherFacePersonError: () => sameCandidate,
    teacherProfilePhotoObject: () => storedPhoto,
    confirmTeacherFacePerson: async () => ({
      personId: command.personId, personName: command.teacherName,
      groupId: "face-group", faceId: "face-new", faceCount: 1, confirmed: true
    }),
    assertTeacherFacePersonSubjectReferences: async () => [],
    uploadTeacherProfilePhoto: async () => {
      state.order.push("upload:new");
      if (mode === "upload-fails") throw Object.assign(new Error("storage unavailable"), { code: "STORAGE_FAILED" });
      return storedPhoto;
    },
    confirmTeacherProfilePhoto: async () => {
      state.order.push("read-photo-after-database");
      if (mode === "final-readback-fails") {
        throw Object.assign(new Error("candidate photo disappeared after commit"), {
          code: "TEACHER_FACE_PHOTO_UPLOAD_INCOMPLETE"
        });
      }
      return {
        bytes: command.image.buffer.length,
        sha256: crypto.createHash("sha256").update(command.image.buffer).digest("hex"),
        contentType: "image/jpeg",
        authenticatedReadback: true
      };
    },
    deleteUploadedFile: async (photo) => {
      state.order.push(`delete-photo:${photo?.reference || "none"}`);
    },
    deleteTeacherProfilePhotoExact: async (photo) => {
      state.order.push(`delete-photo:${photo?.reference || "none"}`);
      return true;
    },
    deleteTeacherFacePerson: async (_api, _groupId, personId) => {
      state.order.push(`delete-person:${personId}`);
      return true;
    },
    deleteTeacherFacePersonExact: async (_api, _groupId, personId) => {
      state.order.push(`delete-person:${personId}`);
      return true;
    },
    teacherFaceResult: (row, accountStatus, createdNow, replaced, warning = "") => ({
      ok: true,
      createdNow,
      replaced,
      warning: warning || undefined,
      teacher: {
        teacherId: String(row.id),
        teacherStatus: row.teacher_status,
        accountStatus,
        faceEnrollmentStatus: row.face_enrollment_status,
        facePhotoReady: Boolean(row.profile_photo_file_id)
      }
    }),
    executeSql: async (sql) => {
      if (sql.includes("FROM public.teachers AS teacher") && sql.includes("JOIN public.staff_accounts AS actor")) {
        return [current()];
      }
      if (sql.includes("UPDATE public.teachers AS teacher")) {
        if (sql.includes(`SET face_person_id = '${previous.personId}'`)
            && sql.includes(`face_consent_at = '${previous.consentAt}'`)) {
          state.order.push("database:restore-old-face");
          state.personId = previous.personId;
          state.photo = previous.photo;
          state.status = "ENROLLED";
          state.consentAt = previous.consentAt;
          state.enrolledAt = previous.enrolledAt;
          state.enrolledBy = previous.enrolledBy;
          state.saved = false;
          return [];
        }
        state.order.push("database:switch-new-face");
        if (mode === "database-fails") throw Object.assign(new Error("database write interrupted"), { code: "DATABASE_ERROR" });
        state.personId = command.personId;
        state.photo = storedPhoto.reference;
        state.status = "ENROLLED";
        state.consentAt = "2026-08-20T00:00:00.000000Z";
        state.enrolledAt = "2026-08-20T00:00:00.000000Z";
        state.enrolledBy = String(command.actorStaffId);
        state.saved = true;
        return mode === "empty-write-result" ? [] : [current()];
      }
      if (sql.includes("SELECT teacher.face_person_id, teacher.face_enrollment_status")) {
        return [{
          face_person_id: state.personId,
          face_enrollment_status: state.status,
          profile_photo_file_id: state.photo,
          face_consent_at_canonical: state.consentAt,
          face_enrolled_at_canonical: state.enrolledAt,
          face_enrolled_by_account_id: state.enrolledBy
        }];
      }
      // The nested response-loss and outer compensation probes only accept an
      // exact new person/photo pair.  A failed switch returns no proof.
      if (sql.includes("face_person_id =") && sql.includes("profile_photo_file_id =")) {
        if (state.saved && state.personId === command.personId && state.photo === storedPhoto.reference) {
          return [current()];
        }
        return [];
      }
      throw new Error(`unexpected delegated SQL: ${sql.slice(0, 100)}`);
    }
  };
  vm.createContext(harness);
  vm.runInContext(`${delegatedUpsertSource}\nmodule.exports = upsertDelegatedTeacherFace;`, harness, {
    filename: "faceRecognition-delegated-teacher-face.js"
  });
  return { command, state, upsert: harness.module.exports };
}

function imageData(bytes) {
  return `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
}

(async () => {
  // New face persistence is ordered create -> immutable photo -> optimistic
  // database switch. The old identity is deliberately retained until the
  // caller accepts the signed readback and sends FINALIZE.
  {
    const { command, state, upsert } = delegatedHarness("success");
    const result = await upsert({});
    assert.equal(result.ok, true);
    assert.equal(result.createdNow, true);
    assert.equal(result.replaced, true);
    assert.equal(result.teacher.facePhotoReady, true);
    assert.equal(state.personId, command.personId);
    assert.deepEqual(state.order, [
      `create:${command.personId}`,
      "upload:new",
      "database:switch-new-face",
      "read-photo-after-database"
    ]);
  }

  // CloudBase can commit UPDATE ... RETURNING without exposing any Rows.  The
  // delegated service must read back the exact person/photo pair and return
  // success instead of compensating a write that is already durable.
  {
    const { command, state, upsert } = delegatedHarness("empty-write-result");
    const result = await upsert({});
    assert.equal(result.ok, true);
    assert.equal(result.createdNow, true);
    assert.equal(result.replaced, true);
    assert.equal(result.teacher.facePhotoReady, true);
    assert.equal(state.personId, command.personId);
    assert.equal(state.saved, true);
    assert.deepEqual(state.order, [
      `create:${command.personId}`,
      "upload:new",
      "database:switch-new-face",
      "read-photo-after-database"
    ]);
  }

  // The database switch alone is not a success boundary. If the second exact
  // authenticated photo read fails after commit, UPSERT conditionally restores
  // the signed previous pointers before deleting only the new candidate.
  {
    const { command, state, upsert } = delegatedHarness("final-readback-fails");
    await assert.rejects(upsert({}), /disappeared after commit/);
    assert.equal(state.personId,
      "T-OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLD");
    assert.equal(state.photo, "pg://customer-photos/teachers/7/old.jpg");
    assert.deepEqual(state.order, [
      `create:${command.personId}`,
      "upload:new",
      "database:switch-new-face",
      "read-photo-after-database",
      "database:restore-old-face",
      "delete-photo:pg://customer-photos/teachers/7/profile-history/new.jpg",
      `delete-person:${command.personId}`
    ]);
  }

  // Re-submitting the same JPEG for the same teacher derives the already
  // enrolled PersonId and immutable photo reference. If a later proof fails,
  // rollback restores the exact metadata snapshot but must never delete that
  // pre-existing Person or photo as if they belonged to this invocation.
  {
    const { command, state, upsert } = delegatedHarness(
      "final-readback-fails", { sameCandidate: true }
    );
    await assert.rejects(upsert({}), /disappeared after commit/);
    assert.equal(state.personId, command.personId);
    assert.equal(state.photo,
      "pg://customer-photos/teachers/7/profile-history/new.jpg");
    assert.equal(state.consentAt, "2026-08-01T01:02:03.123456Z");
    assert.equal(state.enrolledAt, "2026-08-01T01:02:04.654321Z");
    assert.equal(state.enrolledBy, "901");
    assert.deepEqual(state.order, [
      `create:${command.personId}`,
      "upload:new",
      "database:switch-new-face",
      "read-photo-after-database",
      "database:restore-old-face"
    ]);
  }

  // If storage fails after Tencent created a new person, only that new person
  // is compensated.  The old face remains the database truth.
  {
    const { command, state, upsert } = delegatedHarness("upload-fails");
    await assert.rejects(upsert({}), /storage unavailable/);
    assert.equal(state.personId, "T-OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLD");
    assert.equal(state.photo, "pg://customer-photos/teachers/7/old.jpg");
    assert.deepEqual(state.order, [
      `create:${command.personId}`,
      "upload:new",
      `delete-person:${command.personId}`
    ]);
  }

  // The same upload failure for an already-enrolled same-JPEG Person is not
  // ownership proof for deletion. Duplicate recovery leaves both old remote
  // resources untouched.
  {
    const { command, state, upsert } = delegatedHarness(
      "upload-fails", { sameCandidate: true }
    );
    await assert.rejects(upsert({}), /storage unavailable/);
    assert.equal(state.personId, command.personId);
    assert.equal(state.photo,
      "pg://customer-photos/teachers/7/profile-history/new.jpg");
    assert.deepEqual(state.order, [
      `create:${command.personId}`,
      "upload:new"
    ]);
  }

  // If the optimistic pointer switch cannot be proven, compensation removes
  // the newly uploaded immutable photo and new person, not the old enrollment.
  {
    const { command, state, upsert } = delegatedHarness("database-fails");
    await assert.rejects(upsert({}), /database write interrupted/);
    assert.equal(state.personId, "T-OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLD");
    assert.equal(state.photo, "pg://customer-photos/teachers/7/old.jpg");
    assert.deepEqual(state.order, [
      `create:${command.personId}`,
      "upload:new",
      "database:switch-new-face",
      "delete-photo:pg://customer-photos/teachers/7/profile-history/new.jpg",
      `delete-person:${command.personId}`
    ]);
  }

  // A cross-function response can be lost after faceRecognition committed.
  // staffAccount must not turn a local DB row into a success response. The
  // exact command is retried by the readback helper; if that helper still
  // cannot obtain the remote proofs, existing teacher data remains unchanged
  // and the request fails closed.
  {
    const liveImage = imageData([0xff, 0xd8, 0xff, 0xd9]);
    const state = { delegateCalls: 0, stageCalls: 0, personId: "", sqlReads: 0 };
    const harness = {
      module: { exports: {} }, crypto, Buffer, TEACHER_FACE_MAX_BYTES: 3 * 1024 * 1024,
      fail: failure,
      sqlText,
      requireTeacherFaceSchema: async () => {},
      requireTeacherFaceOperationSchema: async () => {},
      requireTeacherOptionalFaceActivationSchema: async () => {},
      requireTeacherExperienceFaceSubjectSchema: async () => {},
      numericId: (value) => Number(value),
      validatePhone: (value) => String(value),
      acquireTeacherFaceOperation: async () => ({
        id: "51", ownerToken: "ab".repeat(32), leaseGeneration: 1,
        imageDigest: "12".repeat(32), imageBytes: 4, status: "RUNNING"
      }),
      bindTeacherFaceOperation: async () => {},
      teacherFaceDelegationLease: (operation) => ({
        operationId: operation.id, ownerToken: operation.ownerToken,
        leaseGeneration: operation.leaseGeneration,
        imageDigest: operation.imageDigest, imageBytes: operation.imageBytes
      }),
      transitionTeacherFaceOperation: async (operation, _expected, next) => {
        operation.status = next;
      },
      delegateTeacherFaceWithReadbackRetry: async () => {
        state.delegateCalls += 1;
        throw Object.assign(new Error("network response lost"), { code: "TEACHER_FACE_DELEGATION_FAILED" });
      },
      teacherFaceDelegationMayHaveCommitted: () => false,
      stageFail: () => { state.stageCalls += 1; failure("unproven response must not succeed", "TEACHER_FACE_ENROLLMENT_FAILED"); },
      executeSql: async (sql) => {
        state.sqlReads += 1;
        if (sql.includes("FROM public.teachers t") && sql.includes("JOIN public.staff_accounts a")) {
          return [{
            id: 7, staff_account_id: 41, teacher_code: "T007", teacher_name: "老师七",
            teacher_status: "ACTIVE", face_person_id: "T-OLD", face_enrollment_status: "ENROLLED",
            face_enrolled_at: null, profile_photo_file_id: "pg://customer-photos/teachers/7/old.jpg",
            phone: "13900000007", role_code: "teacher", account_status: "ACTIVE"
          }];
        }
        throw new Error(`unexpected local recovery SQL: ${sql.slice(0, 100)}`);
      }
    };
    vm.createContext(harness);
    vm.runInContext([
      teacherFaceImageSource,
      teacherFacePersonIdSource,
      teacherFaceRequestIdSource,
      staffFaceUpsertSource,
      "module.exports = { upsertTeacherFace, teacherFacePersonId };"
    ].join("\n"), harness, { filename: "staffAccount-teacher-face-recovery.js" });
    state.personId = harness.module.exports.teacherFacePersonId(
      Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 7, 41
    );
    await assert.rejects(
      harness.module.exports.upsertTeacherFace(
        { profile: { staffId: "900" } },
        { teacherId: "7", clientRequestId: "face_req_0001", consent: true, faceImageBase64: liveImage }
      ),
      (error) => error.code === "TEACHER_FACE_DELEGATION_FAILED"
    );
    assert.equal(state.delegateCalls, 1);
    assert.equal(state.stageCalls, 0);
    assert.equal(state.sqlReads, 1, "only the initial teacher lookup is allowed locally");
  }

  // The deterministic person id binds the concrete teacher/account and exact
  // image. A different image cannot be mistaken for the already enrolled
  // subject; the function rejects before delegate/write.
  {
    const firstImageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const secondImageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const firstImage = imageData(firstImageBytes);
    const secondImage = imageData(secondImageBytes);
    const state = { delegateCalls: 0, writes: 0 };
    const harness = {
      module: { exports: {} }, crypto, Buffer, TEACHER_FACE_MAX_BYTES: 3 * 1024 * 1024,
      fail: failure,
      sqlText,
      requireTeacherFaceSchema: async () => {},
      requireTeacherFaceOperationSchema: async () => {},
      requireTeacherExperienceFaceSubjectSchema: async () => {},
      validatePhone: (value) => String(value),
      validatePassword: (value) => String(value),
      numericId: (value) => Number(value),
      acquireTeacherFaceOperation: async () => ({
        id: "52", ownerToken: "cd".repeat(32), leaseGeneration: 1,
        imageDigest: "34".repeat(32), imageBytes: 4, status: "RUNNING"
      }),
      transitionTeacherFaceOperation: async (operation, _expected, next) => {
        operation.status = next;
      },
      delegateTeacherFace: async () => { state.delegateCalls += 1; return {}; },
      executeSql: async (sql) => {
        if (sql.includes("FROM public.staff_accounts a") && sql.includes("LEFT JOIN public.teachers t")) {
          return [{
            staff_id: 41, auth_uid: "teacher-auth", role_code: "teacher", account_status: "ACTIVE",
            teacher_id: 7, teacher_code: "T007", teacher_name: "老师七", teacher_status: "ACTIVE",
            face_person_id: harness.module.exports.teacherFacePersonId(firstImageBytes, 7, 41),
            face_enrollment_status: "ENROLLED", profile_photo_file_id: "pg://customer-photos/teachers/7/old.jpg"
          }];
        }
        state.writes += 1;
        throw new Error(`unexpected write after request/image conflict: ${sql.slice(0, 100)}`);
      }
    };
    vm.createContext(harness);
    vm.runInContext([
      teacherFaceImageSource,
      teacherFacePersonIdSource,
      teacherFaceRequestIdSource,
      staffFaceProvisionSource,
      "module.exports = { provisionTeacherWithFace, teacherFacePersonId };"
    ].join("\n"), harness, { filename: "staffAccount-teacher-face-idempotency.js" });
    assert.notEqual(
      harness.module.exports.teacherFacePersonId(firstImageBytes, 7, 41),
      harness.module.exports.teacherFacePersonId(secondImageBytes, 7, 41),
      "the same teacher must derive a distinct person id for a different image"
    );
    assert.notEqual(
      harness.module.exports.teacherFacePersonId(firstImageBytes, 7, 41),
      harness.module.exports.teacherFacePersonId(firstImageBytes, 8, 42),
      "the same face image must remain independently addressable for another teacher/account"
    );
    await assert.rejects(
      harness.module.exports.provisionTeacherWithFace(
        { profile: { staffId: "900" } },
        {
          staffName: "老师七", phone: "13900000007", initialPassword: "Abc!12345",
          clientRequestId: "face_req_0002", consent: true, faceImageBase64: secondImage
        }
      ),
      (error) => error.code === "TEACHER_FACE_ALREADY_ENROLLED"
    );
    assert.equal(state.delegateCalls, 0);
    assert.equal(state.writes, 0);
    assert.equal(firstImage.startsWith("data:image/jpeg;base64,"), true);
  }

  assert.match(delegatedUpsertSource, /AND \$\{runningLeaseSql\}/,
    "the pointer switch UPDATE must atomically fence owner, generation, RUNNING and expiry");
  assert.match(delegatedUpsertSource, /AND \$\{cleanupLeaseSql\}/,
    "failure restore must remain atomically fenced to the current cleanup owner");

  console.log("teacher face delegation runtime contract: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
