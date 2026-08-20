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
    image: { base64: "/9j/2Q==", buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) }
  };
}

function delegatedHarness(mode = "success") {
  const command = commandFor();
  const state = {
    personId: "T-OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLD",
    photo: "pg://customer-photos/teachers/7/old.jpg",
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
    face_enrollment_status: state.photo ? "ENROLLED" : "PENDING",
    face_enrolled_at: "2026-08-20T00:00:00Z",
    profile_photo_file_id: state.photo,
    role_code: "teacher",
    account_status: "ACTIVE",
    actor_role: "hq",
    actor_status: "ACTIVE"
  });
  const storedPhoto = {
    bucketId: "customer-photos",
    objectName: "teachers/7/profile-history/new.jpg",
    reference: "pg://customer-photos/teachers/7/profile-history/new.jpg"
  };
  const harness = {
    module: { exports: {} },
    console: { warn() {} },
    FACE_MODEL_VERSION: "3.0",
    verifyTeacherFaceDelegation: () => command,
    sqlText,
    fail: failure,
    required: () => "face-group",
    faceClient: () => ({
      CreatePerson: async ({ PersonId }) => {
        state.order.push(`create:${PersonId}`);
        return { FaceId: "face-new" };
      }
    }),
    inspectFaceImage: async () => ({ qualityScore: 99 }),
    inspectLiveness: async () => ({ checked: true, score: 99 }),
    duplicateTeacherFacePersonError: () => false,
    confirmTeacherFacePerson: async () => {},
    uploadTeacherProfilePhoto: async () => {
      state.order.push("upload:new");
      if (mode === "upload-fails") throw Object.assign(new Error("storage unavailable"), { code: "STORAGE_FAILED" });
      return storedPhoto;
    },
    deleteUploadedFile: async (photo) => {
      state.order.push(`delete-photo:${photo?.reference || "none"}`);
    },
    deleteTeacherFacePerson: async (_api, _groupId, personId) => {
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
        state.order.push("database:switch-new-face");
        if (mode === "database-fails") throw Object.assign(new Error("database write interrupted"), { code: "DATABASE_ERROR" });
        state.personId = command.personId;
        state.photo = storedPhoto.reference;
        state.saved = true;
        return [current()];
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
  // database switch -> old-person cleanup.  The old identity is never deleted
  // before a new usable face is committed.
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
      "delete-person:T-OLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLDOLD"
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
      `delete-photo:none`,
      `delete-person:${command.personId}`
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
  // staffAccount accepts recovery only after it independently reads the exact
  // image-bound person and retained photo; it does not claim success merely
  // because the delegate threw.
  {
    const liveImage = imageData([0xff, 0xd8, 0xff, 0xd9]);
    const state = { delegateCalls: 0, stageCalls: 0, personId: "", sqlReads: 0 };
    const harness = {
      module: { exports: {} }, crypto, Buffer, TEACHER_FACE_MAX_BYTES: 3 * 1024 * 1024,
      fail: failure,
      sqlText,
      requireTeacherFaceSchema: async () => {},
      requireTeacherOptionalFaceActivationSchema: async () => {},
      requireTeacherExperienceFaceSubjectSchema: async () => {},
      numericId: (value) => Number(value),
      delegateTeacherFace: async () => {
        state.delegateCalls += 1;
        throw Object.assign(new Error("network response lost"), { code: "TEACHER_FACE_DELEGATION_FAILED" });
      },
      stageFail: () => { state.stageCalls += 1; failure("unproven response must not succeed", "TEACHER_FACE_ENROLLMENT_FAILED"); },
      executeSql: async (sql) => {
        state.sqlReads += 1;
        if (sql.includes("FROM public.teachers t") && sql.includes("JOIN public.staff_accounts a")) {
          return [{
            id: 7, staff_account_id: 41, teacher_code: "T007", teacher_name: "老师七",
            teacher_status: "ACTIVE", face_person_id: "T-OLD", face_enrollment_status: "ENROLLED",
            face_enrolled_at: null, profile_photo_file_id: "pg://customer-photos/teachers/7/old.jpg",
            role_code: "teacher", account_status: "ACTIVE"
          }];
        }
        if (sql.includes("face_person_id =") && sql.includes("face_enrollment_status = 'ENROLLED'")) {
          return [{
            id: 7, teacher_code: "T007", teacher_name: "老师七", teacher_status: "ACTIVE",
            face_enrollment_status: "ENROLLED", face_enrolled_at: "2026-08-20T00:00:00Z",
            profile_photo_file_id: "pg://customer-photos/teachers/7/profile-history/recovered.jpg"
          }];
        }
        throw new Error(`unexpected staff face recovery SQL: ${sql.slice(0, 100)}`);
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
    state.personId = harness.module.exports.teacherFacePersonId("face_req_0001", Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const result = await harness.module.exports.upsertTeacherFace(
      { profile: { staffId: "900" } },
      { teacherId: "7", clientRequestId: "face_req_0001", consent: true, faceImageBase64: liveImage }
    );
    assert.equal(result.ok, true);
    assert.match(result.warning, /响应丢失后已自动恢复/);
    assert.equal(result.teacher.faceEnrollmentStatus, "ENROLLED");
    assert.equal(state.delegateCalls, 1);
    assert.equal(state.stageCalls, 0);
  }

  // The deterministic person id binds the request id to the exact image.  A
  // caller cannot reuse a completed request id with another image to replace
  // an already-enrolled teacher; the function rejects before delegate/write.
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
      requireTeacherExperienceFaceSubjectSchema: async () => {},
      validatePhone: (value) => String(value),
      validatePassword: (value) => String(value),
      delegateTeacherFace: async () => { state.delegateCalls += 1; return {}; },
      executeSql: async (sql) => {
        if (sql.includes("FROM public.staff_accounts a") && sql.includes("LEFT JOIN public.teachers t")) {
          return [{
            staff_id: 41, auth_uid: "teacher-auth", role_code: "teacher", account_status: "ACTIVE",
            teacher_id: 7, teacher_code: "T007", teacher_name: "老师七", teacher_status: "ACTIVE",
            face_person_id: harness.module.exports.teacherFacePersonId("face_req_0002", firstImageBytes),
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
      harness.module.exports.teacherFacePersonId("face_req_0002", firstImageBytes),
      harness.module.exports.teacherFacePersonId("face_req_0002", secondImageBytes),
      "same request id must derive a distinct person id for a different image"
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

  console.log("teacher face delegation runtime contract: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
