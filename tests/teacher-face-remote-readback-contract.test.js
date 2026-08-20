"use strict";

// A teacher photo reference is not proof that Storage retained the submitted
// bytes.  This test executes the real upload boundary and requires an
// authenticated read-after-write of the exact JPEG before the reference may
// participate in ENROLLED/ACTIVE provisioning.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(
  path.join(__dirname, "..", "cloudfunctions", "faceRecognition", "index.js"),
  "utf8"
);
const teacherCreateSource = fs.readFileSync(
  path.join(__dirname, "..", "teacher-create.js"),
  "utf8"
);

function functionSource(name, nextName) {
  const start = source.indexOf(`async function ${name}`);
  const end = source.indexOf(`\n${nextName}`, start + 1);
  assert.ok(start >= 0 && end > start, `missing source region ${name}`);
  return source.slice(start, end);
}

function jpeg(seed = 0x11) {
  // Minimal one-pixel baseline JPEG structure. The payload need not be
  // visually decoded here; production quality/liveness validation happens
  // before this storage boundary.
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x01, 0x00, 0x01, 0x03,
    0x01, seed, 0x00, 0x02, seed, 0x00, 0x03, seed, 0x00,
    0xff, 0xd9
  ]);
}

function bodyFor(buffer) {
  return {
    async *[Symbol.asyncIterator]() {
      yield buffer;
    },
    destroy() {}
  };
}

function uploadRuntime(mode) {
  const calls = [];
  let deleted = false;
  const submitted = jpeg();
  const retained = mode === "content-mismatch" ? jpeg(0x22) : submitted;
  const storage = {
    async uploadObject(options) {
      calls.push({ operation: "upload", options });
      if (mode === "metadata-mismatch") {
        throw new Error("上传成功但响应格式异常: missing Id and Key");
      }
      return { Id: options.bucketId, Key: options.objectName };
    },
    async getObjectInfoAuthenticated(options) {
      calls.push({ operation: "info", options });
      if (mode === "missing" || deleted) {
        const error = new Error("OBJECT NOT FOUND");
        error.code = "STORAGE_OBJECT_NOT_FOUND";
        throw error;
      }
      return {
        status: 200,
        headers: { "content-length": String(retained.length), "content-type": "image/jpeg" },
        data: { size: retained.length, content_type: "image/jpeg", name: options.objectName,
          bucket_id: options.bucketId }
      };
    },
    async downloadAuthenticatedObject(options) {
      calls.push({ operation: "download", options });
      if (mode === "missing" || deleted) {
        const error = new Error("OBJECT NOT FOUND");
        error.code = "STORAGE_OBJECT_NOT_FOUND";
        throw error;
      }
      return {
        status: 200,
        headers: { "content-length": String(retained.length), "content-type": "image/jpeg" },
        body: bodyFor(retained)
      };
    },
    async deleteObject(options) {
      calls.push({ operation: "delete", options });
      deleted = true;
      return {};
    }
  };
  const managerClient = {
    storage,
    database: {
      async executePGSql() {
        return { Columns: [], Rows: [] };
      }
    }
  };
  const context = {
    module: { exports: {} },
    exports: {},
    require(name) {
      if (name === "crypto") return crypto;
      if (name === "@cloudbase/node-sdk") return { init: () => ({}) };
      if (name === "@cloudbase/manager-node") return { init: () => managerClient };
      if (name === "tencentcloud-sdk-nodejs") return { iai: { v20200303: { Client: class {} } } };
      throw new Error(`unexpected require: ${name}`);
    },
    process: {
      env: {
        CLOUDBASE_ENV_ID: "test-env",
        CLOUDBASE_APIKEY: "test-service-key",
        CUSTOMER_PHOTO_BUCKET_ID: "customer-photos",
        FACE_GROUP_ID: "face-group"
      }
    },
    Buffer,
    URL,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    console: { log() {}, warn() {}, error() {} }
  };
  vm.createContext(context);
  vm.runInContext(
    `${source}\nmodule.exports = { uploadTeacherProfilePhoto, confirmRetainedTeacherProfilePhoto, verifyTeacherFaceDelegation, teacherFaceSubjectPersonId, teacherProfilePhotoObject };`,
    context,
    { filename: "faceRecognition-teacher-photo-readback.js" }
  );
  return {
    calls, submitted,
    upload: context.module.exports.uploadTeacherProfilePhoto,
    confirmRetained: context.module.exports.confirmRetainedTeacherProfilePhoto,
    verifyDelegation: context.module.exports.verifyTeacherFaceDelegation,
    subjectPersonId: context.module.exports.teacherFaceSubjectPersonId,
    profilePhotoObject: context.module.exports.teacherProfilePhotoObject
  };
}

function newPersonReadbackRuntime(delegated) {
  const personId = "T-REMOTE-PERSON-READBACK";
  const state = { confirmations: 0, order: [] };
  const current = {
    id: 7, staff_account_id: 41, teacher_code: "T007", teacher_name: "老师七",
    teacher_status: "ARCHIVED", face_person_id: null, face_enrollment_status: "PENDING",
    face_enrolled_at: null, profile_photo_file_id: null,
    role_code: "teacher", account_status: "ARCHIVED", actor_role: "hq", actor_status: "ACTIVE"
  };
  const saved = {
    id: 7, teacher_code: "T007", teacher_name: "老师七", teacher_status: "ARCHIVED",
    face_enrollment_status: "ENROLLED", face_enrolled_at: "2026-08-20T00:00:00Z",
    profile_photo_file_id: "pg://customer-photos/teachers/7/readback.jpg"
  };
  const context = {
    module: { exports: {} },
    console: { warn() {} },
    FACE_MODEL_VERSION: "3.0",
    verifyTeacherFaceDelegation: () => ({
      teacherId: 7, staffId: 41, actorStaffId: 900, personId, teacherName: "老师七",
      faceGroupId: "face-group",
      photoBucketId: "customer-photos",
      imageDigest: crypto.createHash("sha256").update(jpeg()).digest("hex"),
      previousPersonId: "", previousPhotoReference: "",
      previousFaceEnrollmentStatus: "PENDING", previousFaceConsentAt: "",
      previousFaceEnrolledAt: "", previousFaceEnrolledByAccountId: "",
      image: { base64: "/9j/2Q==", buffer: jpeg() }
    }),
    assertTeacherFaceOperationLease: async () => ({ operation_status: "RUNNING" }),
    bindTeacherFaceOperationFaceId: async () => ({ candidate_face_id: "face-id" }),
    teacherFaceOperationLeaseExistsSql: () => "TRUE",
    sqlText: (value) => `'${String(value).replace(/'/g, "''")}'`,
    fail(message, code = "BAD_REQUEST") {
      const error = new Error(message);
      error.code = code;
      throw error;
    },
    required: () => "face-group",
    faceClient: () => ({
      async CreatePerson() {
        state.order.push("create-person");
        return { FaceId: "face-id" };
      }
    }),
    inspectFaceImage: async () => ({ qualityScore: 99 }),
    inspectLiveness: async () => ({ checked: true, score: 99 }),
    duplicateTeacherFacePersonError: () => false,
    teacherProfilePhotoObject: () => ({
      bucketId: "customer-photos",
      objectName: "teachers/7/readback.jpg",
      reference: saved.profile_photo_file_id
    }),
    async confirmTeacherFacePerson(_api, confirmedGroupId, confirmedPersonId) {
      assert.equal(confirmedGroupId, "face-group");
      assert.equal(confirmedPersonId, personId);
      state.confirmations += 1;
      state.order.push("read-person");
      return { personId, faceId: "face-id", faceCount: 1, confirmed: true };
    },
    assertTeacherFacePersonSubjectReferences: async () => [],
    async uploadTeacherProfilePhoto() {
      state.order.push("upload-photo");
      return {
        bucketId: "customer-photos", objectName: "teachers/7/readback.jpg",
        reference: saved.profile_photo_file_id,
        bytes: jpeg().length,
        sha256: crypto.createHash("sha256").update(jpeg()).digest("hex"),
        contentType: "image/jpeg",
        authenticatedReadback: true
      };
    },
    async confirmTeacherProfilePhoto() {
      state.order.push("read-photo-after-database");
      return {
        bytes: jpeg().length,
        sha256: crypto.createHash("sha256").update(jpeg()).digest("hex"),
        contentType: "image/jpeg",
        authenticatedReadback: true
      };
    },
    deleteUploadedFile: async () => {},
    deleteTeacherFacePerson: async () => true,
    deleteTeacherProfilePhotoExact: async () => true,
    deleteTeacherFacePersonExact: async () => true,
    teacherFaceResult: () => ({
      ok: true,
      teacher: { facePhotoReady: true, faceEnrollmentStatus: "ENROLLED" }
    }),
    async executeSql(sql) {
      if (sql.includes("JOIN public.staff_accounts AS actor")) return [current];
      if (sql.includes("UPDATE public.teachers AS teacher")) {
        state.order.push("database-switch");
        return [saved];
      }
      if (sql.includes("face_person_id =") && sql.includes("profile_photo_file_id =")) return [saved];
      throw new Error(`unexpected SQL: ${sql.slice(0, 100)}`);
    }
  };
  vm.createContext(context);
  vm.runInContext(`${delegated}\nmodule.exports = upsertDelegatedTeacherFace;`, context, {
    filename: "faceRecognition-new-person-readback.js"
  });
  return { state, upsert: context.module.exports };
}

(async () => {
  // The real readback helper fails closed unless Tencent returns the exact
  // deterministic PersonId and the newly returned FaceId is present.
  {
    const confirmSource = functionSource(
      "confirmTeacherFacePerson", "function teacherFacePersonMissingError"
    );
    const context = {
      module: { exports: {} },
      fail(message, code) {
        const error = new Error(message);
        error.code = code;
        throw error;
      }
    };
    vm.createContext(context);
    vm.runInContext(`${confirmSource}\nmodule.exports = confirmTeacherFacePerson;`, context);
    const confirm = context.module.exports;
    const exact = await confirm({
      GetPersonBaseInfo: async () => ({
        PersonId: "T-EXACT", PersonName: "老师七", FaceIds: ["face-new"]
      }),
      GetPersonGroupInfo: async () => ({ PersonGroupInfos: [{ GroupId: "face-group" }] })
    }, "face-group", "T-EXACT", "face-new", "老师七");
    assert.equal(exact.confirmed, true);
    assert.equal(exact.personId, "T-EXACT");
    await assert.rejects(
      confirm({
        GetPersonBaseInfo: async () => ({
          PersonId: "T-OTHER", PersonName: "老师七", FaceIds: ["face-new"]
        }),
        GetPersonGroupInfo: async () => ({ PersonGroupInfos: [{ GroupId: "face-group" }] })
      }, "face-group", "T-EXACT", "face-new", "老师七"),
      (error) => error.code === "TEACHER_FACE_PERSON_CONFLICT"
    );
    await assert.rejects(
      confirm({
        GetPersonBaseInfo: async () => ({
          PersonId: "T-EXACT", PersonName: "老师七", FaceIds: ["face-old"]
        }),
        GetPersonGroupInfo: async () => ({ PersonGroupInfos: [{ GroupId: "face-group" }] })
      }, "face-group", "T-EXACT", "face-new", "老师七"),
      (error) => error.code === "TEACHER_FACE_PERSON_CONFLICT"
    );
    await assert.rejects(
      confirm({
        GetPersonBaseInfo: async () => ({
          PersonId: "T-EXACT", PersonName: "另一个老师", FaceIds: ["face-new"]
        }),
        GetPersonGroupInfo: async () => ({ PersonGroupInfos: [{ GroupId: "other-group" }] })
      }, "face-group", "T-EXACT", "face-new", "老师七"),
      (error) => error.code === "TEACHER_FACE_PERSON_CONFLICT"
    );
  }

  // Tencent returning a FaceId proves only the write response. Read the exact
  // deterministic PersonId back before proceeding to private-photo storage.
  const delegated = functionSource("upsertDelegatedTeacherFace", "async function getCustomerPhotoUrl");
  const createStart = delegated.indexOf("api.CreatePerson(");
  const uploadStart = delegated.indexOf("uploadTeacherProfilePhoto(", createStart);
  assert.ok(createStart >= 0 && uploadStart > createStart, "teacher face creation order must remain explicit");
  assert.match(delegated.slice(createStart, uploadStart), /confirmTeacherFacePerson\s*\(|GetPersonBaseInfo\s*\(/,
    "the Tencent person readback must remain inside the create-before-photo boundary");
  {
    const subject = newPersonReadbackRuntime(delegated);
    const result = await subject.upsert({});
    assert.equal(result.ok, true);
    assert.equal(subject.state.confirmations, 1,
      "a successful CreatePerson response is not enough; the new PersonId must be read back exactly once");
    assert.deepEqual(subject.state.order.slice(0, 3), ["create-person", "read-person", "upload-photo"],
      "remote person readback must complete before the private original photo is uploaded");
    assert.equal(result.readback.person.confirmed, true);
    assert.equal(result.readback.person.personId, "T-REMOTE-PERSON-READBACK");
    assert.equal(result.readback.photo.authenticated, true);
    assert.equal(result.readback.photo.contentType, "image/jpeg");
    assert.equal(result.readback.database.confirmed, true);
    assert.equal(result.readback.database.faceEnrollmentStatus, "ENROLLED");
  }

  // A lost UPSERT response is recovered by a signed, read-only probe after
  // staffAccount's writer-lifetime fence. The probe must perform all three
  // authoritative reads and must not create, upload, update or delete data.
  {
    const readbackSource = functionSource(
      "readbackDelegatedTeacherFace", "async function rollbackDelegatedTeacherFace"
    );
    const image = jpeg();
    const imageDigest = crypto.createHash("sha256").update(image).digest("hex");
    const expectedPhoto = {
      bucketId: "bound-original-bucket",
      objectName: "teachers/7/profile-history/candidate.jpg",
      reference: "pg://bound-original-bucket/teachers/7/profile-history/candidate.jpg"
    };
    const operations = [];
    const context = {
      module: { exports: {} },
      verifyTeacherFaceDelegation: () => ({
        operation: "READBACK", teacherId: 7, staffId: 41, actorStaffId: 900,
        personId: "T-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        teacherName: "老师七", imageDigest, imageBytes: image.length,
        faceGroupId: "bound-original-group",
        photoBucketId: "bound-original-bucket",
        previousPersonId: "T-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        previousPhotoReference: "pg://customer-photos/teachers/7/old.jpg"
      }),
      teacherProfilePhotoObject: () => expectedPhoto,
      assertTeacherFaceOperationLease: async () => ({
        operation_status: "RUNNING", candidate_face_id: "face-candidate"
      }),
      confirmTeacherProfilePhotoDigest: async (photo, digest, bytes) => {
        operations.push("photo-read");
        assert.equal(photo.reference, expectedPhoto.reference);
        assert.equal(digest, imageDigest);
        assert.equal(bytes, image.length);
        return {
          bytes: image.length, sha256: imageDigest, contentType: "image/jpeg",
          authenticatedReadback: true
        };
      },
      sqlText: (value) => `'${String(value).replace(/'/g, "''")}'`,
      fail(message, code) {
        const error = new Error(message);
        error.code = code;
        throw error;
      },
      executeSql: async (sql) => {
        operations.push("database-read");
        assert.match(sql, /^\s*SELECT\s/i);
        return [{
          id: 7, staff_account_id: 41, teacher_code: "T007", teacher_name: "老师七",
          teacher_status: "ACTIVE", face_person_id: "T-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          face_enrollment_status: "ENROLLED", face_enrolled_at: "2026-08-20T00:00:00Z",
          profile_photo_file_id: expectedPhoto.reference, account_status: "ACTIVE",
          actor_role: "hq", actor_status: "ACTIVE"
        }];
      },
      faceClient: () => ({}),
      confirmTeacherFacePerson: async (_api, groupId, personId, faceId, personName) => {
        operations.push("person-read");
        assert.equal(groupId, "bound-original-group",
          "readback must use the operation's original group after config drift");
        assert.equal(faceId, "face-candidate");
        return { personId, personName, groupId, faceId, faceCount: 1 };
      },
      teacherFaceResult: (row) => ({
        ok: true,
        teacher: {
          teacherId: String(row.id), faceEnrollmentStatus: row.face_enrollment_status,
          facePhotoReady: Boolean(row.profile_photo_file_id),
          profilePhotoFileId: row.profile_photo_file_id
        }
      })
    };
    vm.createContext(context);
    vm.runInContext(`${readbackSource}\nmodule.exports = readbackDelegatedTeacherFace;`, context, {
      filename: "faceRecognition-teacher-face-readback-probe.js"
    });
    const result = await context.module.exports({});
    assert.deepEqual(operations.sort(), [
      "database-read", "database-read", "person-read", "photo-read"
    ], "the probe must re-read the exact DB pointers after both remote proofs");
    assert.equal(result.readback.person.confirmed, true);
    assert.equal(result.readback.photo.authenticated, true);
    assert.equal(result.readback.photo.sha256, imageDigest);
    assert.equal(result.readback.photo.bucketId, "bound-original-bucket");
    assert.equal(result.readback.database.confirmed, true);
    assert.equal(result.readback.database.photoReference, expectedPhoto.reference);
  }

  // Reconciliation actions are image-less: the signed SHA-256 and byte count
  // are checked against migration 051 and authenticated Storage. Mutating
  // PROVISION/UPSERT commands still cannot omit the actual JPEG.
  {
    const subject = uploadRuntime("success");
    const image = subject.submitted;
    const imageDigest = crypto.createHash("sha256").update(image).digest("hex");
    const fields = {
      issuedAt: Date.now(), nonce: "ab".repeat(16), operation: "READBACK",
      teacherId: 7, staffId: 41, actorStaffId: 900,
      personId: subject.subjectPersonId(7, 41, imageDigest), teacherName: "老师七",
      imageDigest, imageBytes: image.length, faceGroupId: "face-group",
      photoBucketId: "customer-photos",
      previousPersonId: "", previousPhotoReference: "",
      previousFaceEnrollmentStatus: "PENDING", previousFaceConsentAt: "",
      previousFaceEnrolledAt: "", previousFaceEnrolledByAccountId: "",
      operationId: 51, ownerToken: "cd".repeat(32), leaseGeneration: 3
    };
    const signingKey = crypto.createHash("sha256")
      .update("cloudbase:teacher-face-delegation:\0", "utf8")
      .update("test-service-key", "utf8")
      .digest();
    const sign = (value) => crypto.createHmac("sha256", signingKey).update(JSON.stringify([
      "teacher-face-v3", String(value.issuedAt), String(value.nonce), String(value.operation),
      String(value.teacherId), String(value.staffId), String(value.actorStaffId),
      String(value.personId), String(value.teacherName), String(value.imageDigest),
      String(value.imageBytes), String(value.faceGroupId), String(value.photoBucketId),
      String(value.previousPersonId),
      String(value.previousPhotoReference), String(value.previousFaceEnrollmentStatus),
      String(value.previousFaceConsentAt), String(value.previousFaceEnrolledAt),
      String(value.previousFaceEnrolledByAccountId), String(value.operationId),
      String(value.ownerToken), String(value.leaseGeneration)
    ]), "utf8").digest("hex");
    const readback = subject.verifyDelegation({ ...fields, signature: sign(fields) });
    assert.equal(readback.operation, "READBACK");
    assert.equal(readback.image.buffer, null);
    assert.equal(readback.imageDigest, imageDigest);
    assert.equal(readback.imageBytes, image.length);
    const writeFields = { ...fields, operation: "UPSERT" };
    await assert.rejects(
      async () => subject.verifyDelegation({ ...writeFields, signature: sign(writeFields) }),
      (error) => error.code === "TEACHER_FACE_DELEGATION_INVALID"
    );
    const imageBase64 = `data:image/jpeg;base64,${image.toString("base64")}`;
    const wrongGroup = { ...writeFields, faceGroupId: "wrong-face-group" };
    assert.throws(
      () => subject.verifyDelegation({
        ...wrongGroup, imageBase64, signature: sign(wrongGroup)
      }),
      (error) => error.code === "TEACHER_FACE_GROUP_CONFIGURATION_MISMATCH",
      "a signed write must not create a Person in a group different from the current configuration"
    );
    const wrongBucket = { ...writeFields, photoBucketId: "wrong-private-bucket" };
    assert.throws(
      () => subject.verifyDelegation({
        ...wrongBucket, imageBase64, signature: sign(wrongBucket)
      }),
      (error) => error.code === "TEACHER_FACE_PHOTO_BUCKET_CONFIGURATION_MISMATCH",
      "a signed write must not upload into a bucket different from the current configuration"
    );

    const boundPhoto = subject.profilePhotoObject(
      7, fields.personId, imageDigest, "bound-original-bucket"
    );
    assert.equal(boundPhoto.bucketId, "bound-original-bucket");
    assert.match(boundPhoto.reference, /^pg:\/\/bound-original-bucket\/teachers\/7\//,
      "image-less recovery must derive the candidate object from the operation's original bucket");
  }

  // Ordinary success is not enough: the exact private object must be fetched
  // through the authenticated channel before the function returns a reference.
  {
    const subject = uploadRuntime("success");
    const result = await subject.upload(7, "T-REMOTE-READBACK", subject.submitted, async () => {});
    assert.match(String(result.reference), /^pg:\/\/customer-photos\/teachers\/7\//);
    assert.equal(subject.calls.filter((call) => call.operation === "upload").length, 1);
    assert.ok(subject.calls.some((call) => call.operation === "download"),
      "successful upload must be followed by authenticated byte readback");
  }

  // Existing-face rollback reads the exact signed historical reference. A
  // later CUSTOMER_PHOTO_BUCKET_ID change must not redirect that proof to the
  // current bucket or make the old valid JPEG unreadable.
  {
    const subject = uploadRuntime("success");
    const retained = await subject.confirmRetained(
      "pg://historical-teacher-photos/teachers/7/profile-history/old.jpg"
    );
    assert.equal(retained.bucketId, "historical-teacher-photos");
    const download = subject.calls.find((call) => call.operation === "download");
    assert.equal(download.options.bucketId, "historical-teacher-photos");
  }

  // The manager SDK can throw a response-shape error after Storage committed.
  // It is safe to recover only by reading and matching the exact bytes.
  {
    const subject = uploadRuntime("metadata-mismatch");
    const result = await subject.upload(7, "T-METADATA-RECOVERY", subject.submitted, async () => {});
    assert.match(String(result.reference), /^pg:\/\/customer-photos\/teachers\/7\//);
    assert.ok(subject.calls.some((call) => call.operation === "download"),
      "metadata-mismatch recovery must still prove the retained bytes");
  }

  // A nominal upload response followed by a missing object must fail closed.
  // The caller may archive/block and retry, but may never set ENROLLED/ACTIVE.
  {
    const subject = uploadRuntime("missing");
    await assert.rejects(
      subject.upload(7, "T-MISSING-OBJECT", subject.submitted, async () => {}),
      (error) => /PHOTO|STORAGE|OBJECT|UPLOAD/i.test(`${error?.code || ""} ${error?.message || ""}`)
    );
    assert.ok(subject.calls.some((call) => call.operation === "download"
        || call.operation === "info"),
    "missing-object failure must come from an authoritative storage read");
    assert.ok(subject.calls.some((call) => call.operation === "delete"),
      "an unverified just-uploaded object must be compensated best-effort");
  }

  // Equal length is insufficient. The exact bytes/digest must round-trip; a
  // different JPEG under the expected path is a hard failure and is cleaned.
  {
    const subject = uploadRuntime("content-mismatch");
    await assert.rejects(
      subject.upload(7, "T-CONTENT-CONFLICT", subject.submitted, async () => {}),
      (error) => /CONTENT|HASH|DIGEST|MISMATCH|不一致|不匹配/i.test(`${error?.code || ""} ${error?.message || ""}`)
    );
    assert.ok(subject.calls.some((call) => call.operation === "download"),
      "content integrity must be checked from downloaded bytes");
    assert.ok(subject.calls.some((call) => call.operation === "delete"),
      "a mismatched just-uploaded object must be compensated best-effort");
  }

  // The page is the final human-visible boundary. ENROLLED alone must not
  // produce a success message: it also needs the backend's explicit success,
  // retained-photo proof, and final active teacher/account states.
  {
    const proofStart = teacherCreateSource.indexOf("function teacherProvisionProof");
    const proofEnd = teacherCreateSource.indexOf("function showTeacherProvisionProgress", proofStart);
    const proofGuard = teacherCreateSource.slice(proofStart, proofEnd);
    const provisionCall = teacherCreateSource.indexOf("provisionTeacherWithBackgroundPolling(Object.freeze(provisionInput), metadata)");
    const successMessage = teacherCreateSource.indexOf("setMessage(`创建成功", provisionCall);
    assert.ok(proofStart >= 0 && proofEnd > proofStart && provisionCall >= 0 && successMessage > provisionCall,
      "teacher-create success boundary must remain auditable");
    assert.match(proofGuard, /result\?\.ok|result\.ok/,
      "teacher-create must require the backend's explicit ok=true proof");
    assert.match(proofGuard, /result\?\.resultReadOnly === true/,
      "teacher-create must require proof from the non-mutating result endpoint");
    assert.match(proofGuard, /readbackConfirmed === true[\s\S]*verification\.complete === true/,
      "teacher-create must require the server's complete authoritative readback");
    assert.match(proofGuard, /facePhotoReady|face_photo_ready/,
      "teacher-create must require the retained private-photo proof");
    assert.match(proofGuard, /teacherStatus|teacher_status/,
      "teacher-create must require the final ACTIVE teacher master state");
    assert.match(proofGuard, /accountStatus|account_status|credentialStatus/,
      "teacher-create must require the final ACTIVE business/login account state");
    const successGuard = teacherCreateSource.slice(provisionCall, successMessage);
    assert.match(successGuard, /const proof = teacherProvisionProof\(result\)[\s\S]*if \(!proof\)[\s\S]*不能视为创建成功/,
      "the visible success message must remain after the strict proof predicate");
  }

  console.log("teacher face remote readback contract: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
