"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const file = path.join(root, "cloudfunctions", "teacherCreate", "index.js");
const source = fs.readFileSync(file, "utf8");
const createSource = source.slice(
  source.indexOf("async function createTeacher"),
  source.indexOf("function health", source.indexOf("async function createTeacher"))
);
const rollbackSource = source.slice(
  source.indexOf("async function rollbackDatabase"),
  source.indexOf("async function deleteCreatedAuth", source.indexOf("async function rollbackDatabase"))
);
const remoteCreateSource = source.slice(
  source.indexOf("async function createAndProveRemote"),
  source.indexOf("async function activateDatabase", source.indexOf("async function createAndProveRemote"))
);

assert.match(source, /const FUNCTION_VERSION = "teacher-create-v4"/);
assert.match(source, /if \(action === "createTeacher"\) return await createTeacher\(event\)/);
assert.doesNotMatch(source, /\.callFunction\s*\(|\boperationId\b|\bworker\b|\bpoll(?:ing)?\b|setInterval\s*\(|setTimeout\s*\(|\bTimer\b|\b051\b/i,
  "the dedicated create service must not nest functions or retain the old operation/worker/timer protocol");
assert.equal((createSource.match(/await inspectFace\(/g) || []).length, 1,
  "one formal create request must perform quality detection exactly once");
assert.equal((createSource.match(/await inspectLiveness\(/g) || []).length, 1,
  "one formal create request must perform liveness detection exactly once");
assert.match(source, /UniquePersonControl:\s*0/,
  "the same physical face must be allowed for independently identified phone accounts");
assert.doesNotMatch(remoteCreateSource, /FaceModelVersion/,
  "CreatePerson must use the proven customer request shape without the unsupported FaceModelVersion input");
assert.match(source, /confirmPerson\([\s\S]{0,240}confirmPhoto\(/,
  "success must prove Person, Group, FaceId and the private original photo");
assert.match(source, /downloaded\.length !== image\.bytes[\s\S]{0,500}digest !== image\.sha256/,
  "the retained original must be downloaded and matched by JPEG bytes and SHA-256");
assert.match(source, /context\.photoAttempted[\s\S]{0,300}context\.personAttempted[\s\S]{0,500}context\.authAttempted/,
  "compensation must clean only deterministic resources attempted by this request");
assert.doesNotMatch(createSource, /password\s*:/,
  "an existing Auth identity must never have its password overwritten during recovery");
assert.match(rollbackSource,
  /WITH\s+deleted_teacher\s+AS\s*\([\s\S]*?DELETE\s+FROM\s+public\.teachers[\s\S]*?\)\s*DELETE\s+FROM\s+public\.staff_accounts(?:\s+AS\s+\w+)?\s+USING\s+deleted_teacher\b/i,
  "created-shell rollback must delete the staff account from the rows actually deleted by the same CTE statement");
assert.doesNotMatch(rollbackSource,
  /NOT\s+EXISTS\s*\(\s*SELECT[\s\S]{0,600}?FROM\s+public\.teachers\b/i,
  "rollback must not observe its data-changing CTE through a same-statement NOT EXISTS snapshot");

function deterministicUid(phone) {
  return `teacher-${crypto.createHash("sha256").update(`teacher-auth:${phone}`, "utf8").digest("hex").slice(0, 48)}`;
}

function resultRows(rows) {
  if (!rows.length) return { Columns: [], Rows: [] };
  const columns = Object.keys(rows[0]);
  return { Columns: columns, Rows: rows.map((row) => columns.map((column) => row[column])) };
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 13 && digits.startsWith("86") ? digits.slice(2) : digits;
}

function harness(options = {}) {
  const calls = {
    sql: [], detectFace: 0, liveness: 0, createPerson: 0, deletePerson: 0,
    getPersonGroupInfo: 0, upload: 0, download: 0, deletePhoto: 0,
    createUser: 0, modifyUser: [], deleteUsers: 0
  };
  const state = {
    nextStaffId: 100,
    nextTeacherId: 700,
    auth: new Map(),
    business: new Map(),
    persons: new Map(),
    objects: new Map()
  };

  function businessByStaffId(staffId) {
    return [...state.business.values()].find((row) => String(row.staff_id) === String(staffId)) || null;
  }

  function quoted(sql, label) {
    const match = new RegExp(`${label}\\s*=\\s*'([^']*)'`).exec(sql);
    return match ? match[1].replace(/''/g, "'") : "";
  }

  const manager = {
    database: {
      executePGSql: async ({ Sql: sql }) => {
        calls.sql.push(sql);
        if (/SELECT id, role_code, account_status FROM public\.staff_accounts/.test(sql)) {
          return resultRows([{ id: "1", role_code: "hq", account_status: "ACTIVE" }]);
        }
        if (/LEFT JOIN public\.teachers/.test(sql)) {
          const phone = quoted(sql, "account\\.phone");
          const row = state.business.get(phone);
          return resultRows(row ? [{ ...row }] : []);
        }
        if (/WITH account AS \([\s\S]*INSERT INTO public\.staff_accounts/.test(sql)) {
          const values = /VALUES \('([^']*)', '([^']*)', '([^']*)', 'teacher', 'ARCHIVED'\)/.exec(sql);
          assert.ok(values, `unparsed teacher-shell insert: ${sql}`);
          const [, uid, phone, name] = values;
          const faceValues = /account\.id, 'ARCHIVED',\s*'([^']+)', NOW\(\), 'ENROLLED', NOW\(\),[\s\S]*?'([^']+)'\s*FROM account/.exec(sql);
          assert.ok(faceValues, `unparsed teacher face insert: ${sql}`);
          const staffId = String(state.nextStaffId++);
          const teacherId = String(state.nextTeacherId++);
          state.business.set(phone, {
            staff_id: staffId, auth_uid: uid, phone, staff_name: name,
            role_code: "teacher", account_status: "ARCHIVED",
            teacher_id: teacherId, teacher_code: `TCHF${staffId}`,
            teacher_name: name, teacher_status: "ARCHIVED",
            face_person_id: options.failFaceDatabaseWrite ? null : faceValues[1],
            face_enrollment_status: options.failFaceDatabaseWrite ? "PENDING" : "ENROLLED",
            profile_photo_file_id: options.failFaceDatabaseWrite ? null : faceValues[2]
          });
          return resultRows([]);
        }
        if (/INSERT INTO public\.teachers/.test(sql) && !/WITH account AS/.test(sql)) {
          const staff = /staff_account_id\)[\s\S]*?(\d+)::bigint/.exec(sql);
          const row = staff ? businessByStaffId(staff[1]) : null;
          if (row && !row.teacher_id) {
            row.teacher_id = String(state.nextTeacherId++);
            row.teacher_code = `TCHF${row.staff_id}`;
            row.teacher_status = "ARCHIVED";
            row.face_enrollment_status = "PENDING";
          }
          return resultRows([]);
        }
        if (/SET teacher_status = 'ARCHIVED', face_person_id =/.test(sql) && !/face_person_id = NULL/.test(sql)) {
          const row = businessByStaffId((/staff_account_id = (\d+)::bigint/.exec(sql) || [])[1]);
          if (row && !options.failFaceDatabaseWrite) {
            row.teacher_status = "ARCHIVED";
            row.face_person_id = quoted(sql, "face_person_id");
            row.profile_photo_file_id = quoted(sql, "profile_photo_file_id");
            row.face_enrollment_status = "ENROLLED";
          }
          return resultRows([]);
        }
        if (/UPDATE public\.teachers SET teacher_status = 'ACTIVE'/.test(sql)) {
          const row = businessByStaffId((/staff_account_id = (\d+)::bigint/.exec(sql) || [])[1]);
          if (row) {
            row.teacher_status = "ACTIVE";
            row.account_status = "ACTIVE";
          }
          return resultRows([]);
        }
        if (/JOIN public\.teachers AS teacher/.test(sql)) {
          const phone = quoted(sql, "account\\.phone");
          const row = state.business.get(phone);
          const complete = row && row.account_status === "ACTIVE" && row.teacher_status === "ACTIVE"
            && row.face_enrollment_status === "ENROLLED"
            && row.face_person_id === quoted(sql, "teacher\\.face_person_id")
            && row.profile_photo_file_id === quoted(sql, "teacher\\.profile_photo_file_id");
          return resultRows(complete && !options.failFinalDatabaseRead ? [{ ...row }] : []);
        }
        if (/WITH deleted_teacher AS/.test(sql)) {
          const staffId = (/staff_account_id = (\d+)::bigint/.exec(sql) || [])[1];
          const row = businessByStaffId(staffId);
          if (row) state.business.delete(row.phone);
          return resultRows([]);
        }
        if (/face_person_id = NULL/.test(sql)) {
          const row = businessByStaffId((/staff_account_id = (\d+)::bigint/.exec(sql) || [])[1]);
          if (row) {
            row.account_status = "ARCHIVED";
            row.teacher_status = "ARCHIVED";
            row.face_person_id = null;
            row.profile_photo_file_id = null;
            row.face_enrollment_status = "PENDING";
          }
          return resultRows([]);
        }
        if (/UPDATE public\.teachers SET teacher_status = 'ARCHIVED', updated_at/.test(sql)) {
          const row = businessByStaffId((/staff_account_id = (\d+)::bigint/.exec(sql) || [])[1]);
          if (row) { row.account_status = "ARCHIVED"; row.teacher_status = "ARCHIVED"; }
          return resultRows([]);
        }
        throw new Error(`unhandled SQL in teacherCreate test: ${sql}`);
      }
    },
    user: {
      describeUserList: async (input) => {
        let users = [...state.auth.values()];
        if (Array.isArray(input.uidList)) users = users.filter((user) => input.uidList.includes(user.Uid));
        if (input.phone) users = users.filter((user) => normalizePhone(user.Phone) === normalizePhone(input.phone));
        return { Data: { UserList: users.map((user) => ({ ...user })) } };
      },
      createUser: async (input) => {
        calls.createUser += 1;
        if (options.createUserForeignOnError) {
          state.auth.set(input.uid, {
            Uid: input.uid, Phone: input.phone, Name: input.name, NickName: "concurrent",
            UserStatus: "BLOCKED", PasswordSentinel: "foreign-password",
            Description: "teacher-create:another-request"
          });
          throw Object.assign(new Error("ambiguous concurrent create"), { code: "AUTH_CREATE_FAILED" });
        }
        if (options.failCreateUser) throw Object.assign(new Error("create user failed"), { code: "AUTH_CREATE_FAILED" });
        state.auth.set(input.uid, {
          Uid: input.uid, Phone: input.phone, Name: input.name, NickName: input.nickName,
          UserStatus: input.userStatus, PasswordSentinel: input.password,
          Description: input.description
        });
        return { Data: { Uid: input.uid }, RequestId: "auth-create" };
      },
      modifyUser: async (input) => {
        calls.modifyUser.push({ ...input });
        if (input.userStatus === "ACTIVE" && options.failAuthActivation) {
          throw Object.assign(new Error("activation failed"), { code: "AUTH_ACTIVATION_FAILED" });
        }
        const user = state.auth.get(input.uid);
        if (user) {
          user.UserStatus = input.userStatus || user.UserStatus;
          if (input.nickName) user.NickName = input.nickName;
        }
        return { Data: { Uid: input.uid } };
      },
      deleteUsers: async ({ uids }) => {
        calls.deleteUsers += 1;
        let deleted = 0;
        for (const uid of uids) if (state.auth.delete(uid)) deleted += 1;
        return { Data: { SuccessCount: deleted, FailedCount: uids.length - deleted } };
      }
    },
    storage: {
      uploadObject: async ({ objectName, body, contentType }) => {
        calls.upload += 1;
        const stored = Buffer.from(body);
        if (options.photoContentMismatch && stored.length > 3) stored[3] ^= 1;
        state.objects.set(objectName, { body: stored, contentType });
        if (options.uploadResponseLost) {
          throw Object.assign(new Error("photo response lost"), { code: "FUNCTION_TIMEOUT" });
        }
      },
      getObjectInfoAuthenticated: async ({ objectName }) => {
        const item = state.objects.get(objectName);
        if (!item) throw Object.assign(new Error("object not found"), { code: "STORAGE_OBJECT_NOT_FOUND" });
        return { data: { size: item.body.length, content_type: item.contentType, bucket_id: "teacher-private" } };
      },
      downloadAuthenticatedObject: async ({ objectName }) => {
        calls.download += 1;
        const item = state.objects.get(objectName);
        if (!item) throw Object.assign(new Error("object not found"), { code: "STORAGE_OBJECT_NOT_FOUND" });
        return {
          status: 200,
          body: { async *[Symbol.asyncIterator]() { yield Buffer.from(item.body); } }
        };
      },
      deleteObject: async ({ objectName }) => {
        calls.deletePhoto += 1;
        state.objects.delete(objectName);
      }
    }
  };

  class FaceClient {
    async DetectFace() {
      calls.detectFace += 1;
      return {
        RequestId: "detect-face",
        FaceInfos: [{
          Width: 360, Height: 480,
          FaceQualityInfo: { Score: options.lowQuality ? 10 : 95 },
          FaceAttributesInfo: { Mask: false, EyeOpen: true, Yaw: 0, Pitch: 0, Roll: 0 }
        }]
      };
    }
    async DetectLiveFaceAccurate() {
      calls.liveness += 1;
      return { Score: options.lowLiveness ? 10 : 98, RequestId: "detect-live" };
    }
    async CreatePerson(input) {
      calls.createPerson += 1;
      const faceId = `face-${input.PersonId.slice(-8)}`;
      state.persons.set(input.PersonId, {
        PersonId: input.PersonId, PersonName: input.PersonName,
        FaceIds: [faceId], GroupId: input.GroupId
      });
      if (options.createPersonResponseLost) {
        throw Object.assign(new Error("face response lost"), { code: "FUNCTION_TIMEOUT" });
      }
      return { FaceId: options.missingFaceId ? "" : faceId, RequestId: "create-person" };
    }
    async GetPersonBaseInfo({ PersonId }) {
      const person = state.persons.get(PersonId);
      if (!person) throw Object.assign(new Error("person not found"), { code: "ResourceNotFound" });
      return { PersonId, PersonName: person.PersonName, FaceIds: [...person.FaceIds] };
    }
    async GetPersonGroupInfo({ PersonId }) {
      calls.getPersonGroupInfo += 1;
      if (options.groupReadTransientMissingOnce && calls.getPersonGroupInfo === 1) {
        throw Object.assign(new Error("人员ID暂时不存在"), {
          code: "InvalidParameterValue.PersonIdNotExist"
        });
      }
      if (options.groupReadPersonMissing) {
        // Tencent IAI can report that the Person disappeared between the
        // successful CreatePerson receipt and the exact group readback. Model
        // the remote truth as already absent so cleanup must be idempotent.
        state.persons.delete(PersonId);
        throw Object.assign(new Error("人员ID不存在"), {
          code: "InvalidParameterValue.PersonIdNotExist"
        });
      }
      const person = state.persons.get(PersonId);
      if (!person) throw Object.assign(new Error("person not found"), { code: "ResourceNotFound" });
      return { PersonGroupInfos: [{ GroupId: person.GroupId }] };
    }
    async DeletePersonFromGroup({ PersonId }) {
      calls.deletePerson += 1;
      if (options.deletePersonNotFound) {
        state.persons.delete(PersonId);
        throw Object.assign(new Error("人员ID不存在"), {
          code: "InvalidParameterValue.PersonIdNotExist"
        });
      }
      if (options.deletePersonFailure) {
        if (options.deletePersonFailure.remoteAbsent) state.persons.delete(PersonId);
        throw Object.assign(new Error(options.deletePersonFailure.message), {
          code: options.deletePersonFailure.code
        });
      }
      state.persons.delete(PersonId);
      return { RequestId: "delete-person" };
    }
  }

  const cloudApp = { auth: () => ({ getUserInfo: () => ({ uid: "hq-auth" }) }) };
  const sandbox = {
    exports: {},
    Buffer,
    console: { error: () => {} },
    process: { env: {
      CLOUDBASE_ENV_ID: "env-test", CLOUDBASE_APIKEY: "service-key",
      FACE_SECRET_ID: "face-id", FACE_SECRET_KEY: "face-key",
      FACE_GROUP_ID: "teacher-group", CUSTOMER_PHOTO_BUCKET_ID: "teacher-private",
      FACE_LIVENESS_ENABLED: "true"
    } },
    require: (name) => {
      if (name === "node:crypto") return crypto;
      if (name === "@cloudbase/node-sdk") return { init: () => cloudApp };
      if (name === "@cloudbase/manager-node") return { init: () => manager };
      if (name === "tencentcloud-sdk-nodejs") return { iai: { v20200303: { Client: FaceClient } } };
      throw new Error(`unexpected require ${name}`);
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "teacherCreate-runtime.js" });

  function seedBlockedAuth(phone, passwordSentinel = "original-password", description = "foreign-request") {
    const uid = deterministicUid(phone);
    state.auth.set(uid, {
      Uid: uid, Phone: phone, Name: `staff_${phone}`, NickName: "旧名称",
      UserStatus: "BLOCKED", PasswordSentinel: passwordSentinel, Description: description
    });
    return uid;
  }

  return { main: sandbox.exports.main, state, calls, seedBlockedAuth };
}

const jpeg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0x11, 0xff, 0xd9]).toString("base64")}`;
const eventFor = (phone, clientRequestId) => ({
  action: "createTeacher", staffName: `老师${phone.slice(-2)}`, phone,
  initialPassword: "Aa1!aaaa", imageBase64: jpeg,
  clientRequestId, consent: true
});

(async () => {
  {
    const subject = harness();
    const result = await subject.main({ action: "validateCapture", imageBase64: jpeg });
    assert.equal(result.ok, true);
    assert.equal(result.accepted, true);
    assert.equal(subject.calls.detectFace, 1);
    assert.equal(subject.calls.liveness, 1);
    assert.equal(subject.calls.createPerson + subject.calls.upload + subject.calls.createUser, 0,
      "prevalidation must perform no persistent write");
  }

  {
    const subject = harness();
    const result = await subject.main(eventFor("13900000007", "simple_success_0001"));
    assert.equal(result.ok, true);
    assert.equal(result.completed, true);
    assert.equal(result.proof.complete, true);
    assert.equal(result.proof.teacherStatus, "ACTIVE");
    assert.equal(result.proof.accountStatus, "ACTIVE");
    assert.equal(result.proof.authStatus, "ACTIVE");
    assert.equal(result.proof.faceStatus, "ENROLLED");
    assert.ok(result.proof.faceId && result.proof.personId && result.proof.photoRef);
    assert.equal(result.proof.photoBytes, 6);
    assert.equal(result.proof.photoSha256, crypto.createHash("sha256").update(Buffer.from([0xff, 0xd8, 0xff, 0x11, 0xff, 0xd9])).digest("hex"));
    assert.equal(subject.calls.detectFace, 1);
    assert.equal(subject.calls.liveness, 1);
    assert.equal(subject.calls.createUser, 1);
    assert.equal(subject.calls.createPerson, 1);
    assert.equal(subject.calls.upload, 1);
    assert.equal(subject.calls.deleteUsers, 0);
  }

  {
    const subject = harness({ groupReadTransientMissingOnce: true });
    const result = await subject.main(eventFor("13900000022", "simple_transient_person_read_01"));
    assert.equal(result.ok, true,
      "one transient PersonIdNotExist during exact readback must receive one short retry");
    assert.equal(result.completed, true);
    assert.equal(result.proof.complete, true);
    assert.equal(subject.calls.getPersonGroupInfo, 3,
      "creation performs the failed read, its one retry, and the final post-activation proof");
    assert.equal(subject.calls.createPerson, 1,
      "readback retry must never create a second Person");
    assert.equal(subject.calls.deletePerson, 0);
  }

  {
    const subject = harness({ lowQuality: true });
    const result = await subject.main(eventFor("13900000008", "simple_quality_0001"));
    assert.equal(result.ok, false);
    assert.equal(result.code, "FACE_QUALITY_LOW");
    assert.equal(subject.calls.detectFace, 1);
    assert.equal(subject.calls.liveness, 0);
    assert.equal(subject.calls.createUser + subject.calls.createPerson + subject.calls.upload, 0,
      "quality rejection must occur before every persistent write");
  }

  for (const scenario of [
    { name: "missing FaceId", options: { missingFaceId: true }, code: "FACE_ENROLLMENT_INCOMPLETE", authDeleted: 0 },
    { name: "photo digest mismatch", options: { photoContentMismatch: true }, code: "PHOTO_CONTENT_MISMATCH", authDeleted: 0 },
    { name: "database face reference missing", options: { failFaceDatabaseWrite: true }, code: "FACE_DATABASE_READBACK_FAILED", authDeleted: 1 },
    { name: "Auth activation failure", options: { failAuthActivation: true }, code: "AUTH_ACTIVATION_FAILED", authDeleted: 1 }
  ]) {
    const subject = harness(scenario.options);
    const result = await subject.main(eventFor("13900000009", `simple_fail_${scenario.name.replace(/\W/g, "_")}_01`));
    assert.equal(result.ok, false, `${scenario.name} must fail`);
    assert.equal(result.code, scenario.code, JSON.stringify({ result, calls: subject.calls }, null, 2));
    assert.equal(subject.state.business.size, 0, `${scenario.name} must remove this request's new DB shell`);
    assert.equal(subject.state.auth.size, 0, `${scenario.name} must remove this request's new Auth identity`);
    assert.equal(subject.state.persons.size, 0, `${scenario.name} must remove this request's known-created Person`);
    assert.equal(subject.state.objects.size, 0, `${scenario.name} must remove this request's known-created photo`);
    assert.equal(subject.calls.deleteUsers, scenario.authDeleted);
  }

  {
    const subject = harness();
    const phone = "13900000010";
    const uid = subject.seedBlockedAuth(phone, "do-not-overwrite");
    const result = await subject.main(eventFor(phone, "simple_existing_auth_01"));
    assert.equal(result.ok, false);
    assert.equal(result.code, "PHONE_ALREADY_PROVISIONED");
    assert.equal(subject.calls.createUser, 0, "an exact existing Auth identity must be reused");
    assert.equal(subject.calls.deleteUsers, 0, "a pre-existing Auth identity must never be deleted on failure");
    assert.equal(subject.state.auth.get(uid)?.PasswordSentinel, "do-not-overwrite",
      "recovery must not overwrite the pre-existing password");
    assert.equal(subject.state.auth.get(uid)?.UserStatus, "BLOCKED");
    assert.equal(subject.state.business.size, 0, "only this request's DB shell is removed");
  }

  {
    const subject = harness();
    const phone = "13900000014";
    const requestId = "simple_owned_auth_01";
    const uid = subject.seedBlockedAuth(phone, "same-request-password", `teacher-create:${requestId}`);
    const result = await subject.main(eventFor(phone, requestId));
    assert.equal(result.ok, false, "the direct creator must not resume any earlier Auth remnant");
    assert.equal(result.code, "PHONE_ALREADY_PROVISIONED");
    assert.equal(subject.calls.createUser, 0);
    assert.equal(subject.calls.deleteUsers, 0);
    assert.equal(subject.state.auth.get(uid)?.PasswordSentinel, "same-request-password",
      "the direct creator must not rewrite the stored password");
    assert.equal(subject.state.auth.get(uid)?.UserStatus, "BLOCKED");
  }

  {
    const subject = harness({ createUserForeignOnError: true });
    const phone = "13900000015";
    const uid = deterministicUid(phone);
    const result = await subject.main(eventFor(phone, "simple_concurrent_auth_01"));
    assert.equal(result.ok, false);
    assert.equal(result.code, "AUTH_CREATE_FAILED");
    assert.equal(subject.calls.deleteUsers, 0,
      "a foreign Auth identity discovered after an ambiguous create response must not be deleted");
    assert.equal(subject.calls.modifyUser.length, 0,
      "a foreign Auth identity must not be blocked, activated or otherwise modified");
    assert.equal(subject.state.auth.get(uid)?.PasswordSentinel, "foreign-password");
    assert.equal(subject.state.business.size, 0);
  }

  {
    const subject = harness();
    const first = await subject.main(eventFor("13900000011", "simple_same_face_phone_1"));
    const second = await subject.main(eventFor("13900000012", "simple_same_face_phone_2"));
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.notEqual(first.uid, second.uid);
    assert.notEqual(first.proof.personId, second.proof.personId);
    assert.equal(subject.state.business.size, 2);
    assert.equal(subject.state.persons.size, 2,
      "the same photo must be accepted for two phone-identified teacher accounts");
  }

  {
    const subject = harness();
    const phone = "13900000016";
    const input = eventFor(phone, "simple_idempotent_read_01");
    const first = await subject.main(input);
    assert.equal(first.ok, true);
    const createUsers = subject.calls.createUser;
    const createPersons = subject.calls.createPerson;
    const uploads = subject.calls.upload;
    const second = await subject.main(input);
    assert.equal(second.ok, false);
    assert.equal(second.code, "PHONE_ALREADY_PROVISIONED",
      "the new direct flow does not resume or reinterpret a completed teacher");
    assert.equal(subject.calls.createUser, createUsers);
    assert.equal(subject.calls.createPerson, createPersons);
    assert.equal(subject.calls.upload, uploads,
      "a rejected duplicate must not issue another write");

    const modifiesBeforeForeignRequest = subject.calls.modifyUser.length;
    const differentRequest = await subject.main({ ...input, clientRequestId: "simple_idempotent_other_01" });
    assert.equal(differentRequest.ok, false);
    assert.equal(differentRequest.code, "PHONE_ALREADY_PROVISIONED",
      "an active account cannot make a new initial password appear accepted under a different request id");
    assert.equal(subject.calls.modifyUser.length, modifiesBeforeForeignRequest);
    assert.equal(subject.calls.createUser, createUsers);
    assert.equal(subject.calls.createPerson, createPersons);
    assert.equal(subject.calls.upload, uploads);
    assert.equal(subject.calls.deleteUsers, 0);

    const objectName = first.proof.photoRef.replace(/^pg:\/\/[^/]+\//, "");
    subject.state.objects.delete(objectName);
    const modifiesBefore = subject.calls.modifyUser.length;
    const deletesBefore = subject.calls.deleteUsers;
    const failedRead = await subject.main(input);
    assert.equal(failedRead.ok, false,
      "missing retained evidence on a complete teacher must fail instead of claiming idempotent success");
    assert.equal(subject.calls.modifyUser.length, modifiesBefore,
      "pure idempotent read failure must not block or reactivate the existing Auth identity");
    assert.equal(subject.calls.deleteUsers, deletesBefore);
    assert.equal(subject.state.business.get(phone)?.teacher_status, "ACTIVE");
    assert.equal(subject.state.auth.get(first.uid)?.UserStatus, "ACTIVE");
  }

  {
    const subject = harness();
    const phone = "13900000017";
    const input = eventFor(phone, "simple_archived_enrolled_01");
    const created = await subject.main(input);
    assert.equal(created.ok, true);
    subject.state.business.get(phone).teacher_status = "ARCHIVED";
    subject.state.business.get(phone).account_status = "ARCHIVED";
    subject.state.auth.get(created.uid).UserStatus = "BLOCKED";
    const modifiesBefore = subject.calls.modifyUser.length;
    const result = await subject.main(input);
    assert.equal(result.ok, false);
    assert.equal(result.code, "PHONE_ALREADY_PROVISIONED");
    assert.equal(subject.calls.modifyUser.length, modifiesBefore,
      "the creation page must not reactivate an archived enrolled teacher");
    assert.equal(subject.calls.deleteUsers, 0);
    assert.equal(subject.state.business.get(phone)?.teacher_status, "ARCHIVED");
  }

  for (const [suffix, options] of [
    ["face", { createPersonResponseLost: true, failAuthActivation: true }],
    ["photo", { uploadResponseLost: true, failAuthActivation: true }]
  ]) {
    const subject = harness(options);
    const phone = suffix === "face" ? "13900000013" : "13900000018";
    const result = await subject.main(eventFor(phone, `simple_uncertain_${suffix}_01`));
    assert.equal(result.ok, false);
    assert.equal(subject.calls.deletePerson, 1,
      "the request-specific PersonId makes an ambiguous face response safe to clean directly");
    assert.equal(subject.calls.deletePhoto, suffix === "photo" ? 1 : 0,
      "an attempted request-specific photo upload must be cleaned even when its response is lost");
    assert.equal(subject.state.business.size, 0);
    assert.equal(subject.state.persons.size, 0);
    assert.equal(subject.state.objects.size, 0);
    assert.equal(subject.state.auth.size, 0,
      `the independently known-created Auth identity is still cleaned precisely: ${JSON.stringify({ result, calls: subject.calls })}`);
  }

  {
    const subject = harness({
      groupReadPersonMissing: true,
      deletePersonNotFound: true
    });
    const result = await subject.main(eventFor("13900000019", "simple_missing_person_cleanup_01"));
    assert.equal(result.ok, false);
    assert.equal(result.code, "InvalidParameterValue.PersonIdNotExist",
      "a Person missing during exact group readback remains the original failure, not cleanup-incomplete");
    assert.notEqual(result.code, "TEACHER_CREATE_CLEANUP_INCOMPLETE");
    assert.equal(subject.calls.getPersonGroupInfo, 2,
      "a persistent PersonIdNotExist receives only the single bounded readback retry");
    assert.equal(subject.calls.deletePerson, 1,
      "cleanup still attempts the precisely owned Person after the failed group readback");
    assert.equal(subject.state.business.size, 0);
    assert.equal(subject.state.auth.size, 0);
    assert.equal(subject.state.persons.size, 0,
      "DeletePersonFromGroup reporting PersonIdNotExist proves the remote Person is already clean");
    assert.equal(subject.state.objects.size, 0);
  }

  for (const [suffix, deletePersonFailure] of [
    ["permission", { code: "AuthFailure.UnauthorizedOperation", message: "permission denied" }],
    ["timeout", { code: "FUNCTION_TIMEOUT", message: "delete request timed out" }],
    ["group-id-missing", {
      code: "InvalidParameterValue.GroupIdNotExist", message: "group id not exist"
    }],
    ["resource-unavailable", {
      code: "ResourceUnavailable.NotExist", message: "remote resource does not exist"
    }]
  ]) {
    const subject = harness({ failAuthActivation: true, deletePersonFailure });
    const result = await subject.main(eventFor(
      ({
        permission: "13900000020",
        timeout: "13900000021",
        "group-id-missing": "13900000023",
        "resource-unavailable": "13900000024"
      })[suffix],
      `simple_unknown_face_cleanup_${suffix}_01`
    ));
    assert.equal(result.ok, false);
    assert.equal(result.code, "TEACHER_CREATE_CLEANUP_INCOMPLETE",
      `${suffix} while deleting a Person is unknown, so creation must remain fail-closed`);
    assert.equal(subject.calls.deletePerson, 1);
    assert.equal(subject.state.business.size, 0);
    assert.equal(subject.state.auth.size, 0);
    assert.equal(subject.state.objects.size, 0);
    assert.equal(subject.state.persons.size, 1,
      `${suffix} does not prove deletion and must not be treated as already clean`);
  }

  for (const [suffix, code] of [
    ["person-id-missing", "InvalidParameterValue.PersonIdNotExist"],
    ["group-person-map-missing", "FailedOperation.GroupPersonMapNotExist"]
  ]) {
    const subject = harness({
      failAuthActivation: true,
      deletePersonFailure: { code, message: "precisely owned Person mapping does not exist", remoteAbsent: true }
    });
    const result = await subject.main(eventFor(
      suffix === "person-id-missing" ? "13900000025" : "13900000026",
      `simple_idempotent_face_cleanup_${suffix}_01`
    ));
    assert.equal(result.ok, false);
    assert.equal(result.code, "AUTH_ACTIVATION_FAILED",
      `${code} is an exact idempotent-delete result and must preserve the original creation failure`);
    assert.notEqual(result.code, "TEACHER_CREATE_CLEANUP_INCOMPLETE");
    assert.equal(subject.calls.deletePerson, 1);
    assert.equal(subject.state.business.size, 0);
    assert.equal(subject.state.auth.size, 0);
    assert.equal(subject.state.objects.size, 0);
    assert.equal(subject.state.persons.size, 0);
  }

  console.log("teacherCreate simple synchronous runtime contract: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
