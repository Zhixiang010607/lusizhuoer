"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "cloudfunctions", "teacherCreate", "index.js"), "utf8");
const createSource = source.slice(source.indexOf("async function createTeacher"), source.indexOf("function health"));
const remoteSource = source.slice(source.indexOf("async function createRemoteAssets"), source.indexOf("async function deletePhoto"));

assert.match(source, /const FUNCTION_VERSION = "teacher-create-v5"/);
assert.match(source, /if \(action === "createTeacher"\) return await createTeacher\(event\)/);
assert.doesNotMatch(source, /\.callFunction\s*\(|\boperationId\b|\bworker\b|\bpoll(?:ing)?\b|setInterval\s*\(|setTimeout\s*\(|\bTimer\b|\b051\b/i,
  "teacherCreate must remain a single synchronous service");
assert.equal((createSource.match(/await inspectFace\(/g) || []).length, 1);
assert.equal((createSource.match(/await inspectLiveness\(/g) || []).length, 1);
assert.match(remoteSource, /UniquePersonControl:\s*0/,
  "the same physical face must be accepted for independently identified phone accounts");
assert.doesNotMatch(remoteSource, /FaceModelVersion/,
  "CreatePerson must keep the customer-enrollment request shape");
assert.doesNotMatch(source,
  /GetPersonBaseInfo|GetPersonGroupInfo|getObjectInfoAuthenticated|downloadAuthenticatedObject|finalReadback|createBlockedAuthentication/,
  "v5 must not perform delayed remote readback or create a temporary BLOCKED identity");
assert.match(source, /createUser\([\s\S]{0,260}userStatus: "ACTIVE"/,
  "the Auth identity must be created ACTIVE like the store-account flow");
assert.match(source, /'teacher', 'ACTIVE'/,
  "the staff row must be created ACTIVE");
assert.match(source, /account\.id, 'ACTIVE'/,
  "the staff and teacher rows must be created ACTIVE in one SQL statement");

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
    detectFace: 0, liveness: 0, createPerson: 0, deletePerson: 0,
    upload: 0, deletePhoto: 0, createUser: 0, deleteUsers: 0, sql: []
  };
  const state = {
    auth: new Map(), business: new Map(), persons: new Map(), objects: new Map(),
    nextStaffId: 100, nextTeacherId: 700
  };
  const quoted = (sql, label) => {
    const match = new RegExp(`${label}\\s*=\\s*'([^']*)'`).exec(sql);
    return match ? match[1].replace(/''/g, "'") : "";
  };

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
          if (options.failDatabase) throw Object.assign(new Error("database unavailable"), { code: "DATABASE_ERROR" });
          const values = /VALUES \('([^']*)', '([^']*)', '([^']*)', 'teacher', 'ACTIVE'\)/.exec(sql);
          const faceValues = /account\.id, 'ACTIVE',\s*'([^']+)', NOW\(\), 'ENROLLED', NOW\(\),[\s\S]*?'([^']+)'\s*FROM account/.exec(sql);
          assert.ok(values && faceValues, `unparsed active teacher insert: ${sql}`);
          const [, uid, phone, name] = values;
          const staffId = String(state.nextStaffId++);
          state.business.set(phone, {
            staff_id: staffId, auth_uid: uid, phone, staff_name: name,
            role_code: "teacher", account_status: "ACTIVE",
            teacher_id: String(state.nextTeacherId++), teacher_code: `TCHF${staffId}`,
            teacher_name: name, teacher_status: "ACTIVE",
            face_person_id: faceValues[1], face_enrollment_status: "ENROLLED",
            profile_photo_file_id: faceValues[2]
          });
          return resultRows([]);
        }
        if (/WITH deleted_teacher AS/.test(sql)) {
          const phone = quoted(sql, "account\\.phone");
          state.business.delete(phone);
          return resultRows([]);
        }
        throw new Error(`unhandled SQL: ${sql}`);
      }
    },
    user: {
      describeUserList: async (input) => {
        let users = [...state.auth.values()];
        if (input.phone) users = users.filter((user) => normalizePhone(user.Phone) === normalizePhone(input.phone));
        return { Data: { UserList: users.map((user) => ({ ...user })) } };
      },
      createUser: async (input) => {
        calls.createUser += 1;
        if (options.failAuth) throw Object.assign(new Error("create user failed"), { code: "AUTH_CREATE_FAILED" });
        const uid = `teacher-auth-${input.phone}`;
        state.auth.set(uid, {
          Uid: uid, Phone: input.phone, Name: input.name, UserStatus: input.userStatus,
          Description: input.description, PasswordSentinel: input.password
        });
        return { Data: { Uid: options.missingAuthUid ? "" : uid }, RequestId: "auth-create" };
      },
      deleteUsers: async ({ uids }) => {
        calls.deleteUsers += 1;
        let deleted = 0;
        for (const uid of uids) if (state.auth.delete(uid)) deleted += 1;
        return { Data: { SuccessCount: deleted, FailedCount: uids.length - deleted } };
      }
    },
    storage: {
      uploadObject: async ({ objectName, body }) => {
        calls.upload += 1;
        state.objects.set(objectName, Buffer.from(body));
        if (options.failUpload) throw Object.assign(new Error("upload response lost"), { code: "FUNCTION_TIMEOUT" });
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
      return { Score: 98, RequestId: "detect-live" };
    }
    async CreatePerson(input) {
      calls.createPerson += 1;
      const faceId = `face-${input.PersonId.slice(-8)}`;
      state.persons.set(input.PersonId, { FaceId: faceId, GroupId: input.GroupId });
      if (options.failFace) throw Object.assign(new Error("face response lost"), { code: "FUNCTION_TIMEOUT" });
      return { FaceId: options.missingFaceId ? "" : faceId, RequestId: "create-person" };
    }
    async DeletePersonFromGroup({ PersonId }) {
      calls.deletePerson += 1;
      state.persons.delete(PersonId);
      return { RequestId: "delete-person" };
    }
  }

  const cloudApp = { auth: () => ({ getUserInfo: () => ({ uid: "hq-auth" }) }) };
  const sandbox = {
    exports: {}, Buffer, console: { error: () => {} },
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
  return { main: sandbox.exports.main, state, calls };
}

const bytes = Buffer.from([0xff, 0xd8, 0xff, 0x11, 0xff, 0xd9]);
const jpeg = `data:image/jpeg;base64,${bytes.toString("base64")}`;
const eventFor = (phone, requestId) => ({
  action: "createTeacher", staffName: `老师${phone.slice(-2)}`, phone,
  initialPassword: "Aa1!aaaa", imageBase64: jpeg, clientRequestId: requestId, consent: true
});

(async () => {
  {
    const subject = harness();
    const result = await subject.main({ action: "validateCapture", imageBase64: jpeg });
    assert.equal(result.ok, true);
    assert.equal(subject.calls.createPerson + subject.calls.upload + subject.calls.createUser, 0);
  }
  {
    const subject = harness();
    const result = await subject.main(eventFor("13900000007", "simple_success_0001"));
    assert.equal(result.ok, true);
    assert.equal(result.completed, true);
    assert.equal(result.proof.complete, true);
    assert.equal(result.proof.authStatus, "ACTIVE");
    assert.equal(result.proof.faceStatus, "ENROLLED");
    assert.equal(result.proof.photoBytes, bytes.length);
    assert.equal(result.proof.photoSha256, crypto.createHash("sha256").update(bytes).digest("hex"));
    assert.equal(subject.state.auth.get(result.uid)?.UserStatus, "ACTIVE");
    assert.equal(subject.state.business.get("13900000007")?.teacher_status, "ACTIVE");
    assert.deepEqual([subject.calls.createPerson, subject.calls.upload, subject.calls.createUser, subject.calls.deleteUsers], [1, 1, 1, 0]);
  }
  {
    const subject = harness();
    const first = await subject.main(eventFor("13900000011", "same_face_phone_01"));
    const second = await subject.main(eventFor("13900000012", "same_face_phone_02"));
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.notEqual(first.uid, second.uid);
    assert.notEqual(first.proof.personId, second.proof.personId);
    assert.equal(subject.state.persons.size, 2);
  }
  {
    const subject = harness();
    subject.state.auth.set("existing", {
      Uid: "existing", Phone: "13900000013", Name: "staff_13900000013",
      UserStatus: "ACTIVE", PasswordSentinel: "do-not-overwrite"
    });
    const result = await subject.main(eventFor("13900000013", "existing_phone_01"));
    assert.equal(result.ok, false);
    assert.equal(result.code, "PHONE_ALREADY_PROVISIONED");
    assert.equal(subject.calls.createPerson + subject.calls.upload + subject.calls.createUser, 0);
    assert.equal(subject.state.auth.get("existing")?.PasswordSentinel, "do-not-overwrite");
  }
  for (const scenario of [
    { name: "missing FaceId", options: { missingFaceId: true }, code: "FACE_ENROLLMENT_INCOMPLETE" },
    { name: "upload response lost", options: { failUpload: true }, code: "FUNCTION_TIMEOUT" },
    { name: "Auth failure", options: { failAuth: true }, code: "AUTH_CREATE_FAILED" },
    { name: "Auth missing UID", options: { missingAuthUid: true }, code: "AUTH_CREATE_INCOMPLETE" },
    { name: "database failure", options: { failDatabase: true }, code: "DATABASE_ERROR" }
  ]) {
    const subject = harness(scenario.options);
    const result = await subject.main(eventFor("13900000020", `failure_${scenario.name.replace(/\W/g, "_")}`));
    assert.equal(result.ok, false, scenario.name);
    assert.equal(result.code, scenario.code, scenario.name);
    assert.equal(subject.state.business.size, 0, `${scenario.name}: database cleanup`);
    assert.equal(subject.state.auth.size, 0, `${scenario.name}: Auth cleanup`);
    assert.equal(subject.state.persons.size, 0, `${scenario.name}: face cleanup`);
    assert.equal(subject.state.objects.size, 0, `${scenario.name}: photo cleanup`);
  }
  console.log("teacherCreate v5 direct-write runtime contract: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
