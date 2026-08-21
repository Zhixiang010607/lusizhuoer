"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "cloudfunctions", "teacherCreate", "index.js"), "utf8");
const createSource = source.slice(source.indexOf("async function createTeacher"), source.indexOf("function health"));

assert.match(source, /const FUNCTION_VERSION = "teacher-create-v6"/);
assert.match(source, /actions: \["health", "createTeacher"\]/);
assert.doesNotMatch(source,
  /tencentcloud|FaceClient|inspectFace|inspectLiveness|imageBase64|photo_file|face_person|face_id|createRemoteAssets|validateCapture/i,
  "teacherCreate v6 must contain no photo, face service or capture action");
assert.doesNotMatch(source, /\.callFunction\s*\(|\boperationId\b|\bworker\b|\bpoll(?:ing)?\b|setInterval\s*\(|setTimeout\s*\(|\bTimer\b/i,
  "teacherCreate must remain one synchronous account-and-profile service");
assert.match(createSource, /createActiveAuthentication\([\s\S]{0,800}insertTeacherRecord\(/,
  "teacher creation writes Auth and then the atomic business records");
assert.match(source, /createUser\([\s\S]{0,260}userStatus: "ACTIVE"/);
assert.match(source, /'teacher', 'ACTIVE'/);
assert.match(source, /account\.id, 'ACTIVE'\s*\n\s*FROM account/,
  "the teacher master is written ACTIVE without a face column");

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
  const calls = { createUser: 0, deleteUsers: 0, sql: [] };
  const state = { auth: new Map(), business: new Map(), nextStaffId: 100, nextTeacherId: 700 };
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
          assert.ok(values, `unparsed active teacher insert: ${sql}`);
          const [, uid, phone, name] = values;
          const staffId = String(state.nextStaffId++);
          state.business.set(phone, {
            staff_id: staffId, auth_uid: uid, phone, staff_name: name,
            role_code: "teacher", account_status: "ACTIVE",
            teacher_id: String(state.nextTeacherId++), teacher_code: `TCHF${staffId}`,
            teacher_name: name, teacher_status: "ACTIVE"
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
        return { Data: { Uid: options.missingAuthUid ? "" : uid } };
      },
      deleteUsers: async ({ uids }) => {
        calls.deleteUsers += 1;
        let deleted = 0;
        for (const uid of uids) if (state.auth.delete(uid)) deleted += 1;
        return { Data: { SuccessCount: deleted, FailedCount: uids.length - deleted } };
      }
    }
  };
  const cloudApp = { auth: () => ({ getUserInfo: () => ({ uid: "hq-auth" }) }) };
  const sandbox = {
    exports: {}, Buffer, console: { error: () => {} }, process: { env: { CLOUDBASE_ENV_ID: "env-test" } },
    require: (name) => {
      if (name === "node:crypto") return crypto;
      if (name === "@cloudbase/node-sdk") return { init: () => cloudApp };
      if (name === "@cloudbase/manager-node") return { init: () => manager };
      throw new Error(`unexpected require ${name}`);
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "teacherCreate-runtime.js" });
  return { main: sandbox.exports.main, state, calls };
}

const eventFor = (phone, requestId) => ({
  action: "createTeacher", staffName: `老师${phone.slice(-2)}`, phone,
  initialPassword: "Aa1!aaaa", clientRequestId: requestId
});

(async () => {
  {
    const subject = harness();
    const health = await subject.main({ action: "health" });
    assert.deepEqual(Array.from(health.actions), ["health", "createTeacher"]);
    const result = await subject.main(eventFor("13900000007", "simple_success_0001"));
    assert.equal(result.ok, true);
    assert.equal(result.completed, true);
    assert.equal(result.proof.complete, true);
    assert.equal(result.proof.authStatus, "ACTIVE");
    assert.equal(result.proof.accountStatus, "ACTIVE");
    assert.equal(result.proof.teacherStatus, "ACTIVE");
    assert.equal(subject.state.auth.get(result.uid)?.UserStatus, "ACTIVE");
    assert.equal(subject.state.business.get("13900000007")?.teacher_status, "ACTIVE");
    assert.deepEqual([subject.calls.createUser, subject.calls.deleteUsers], [1, 0]);
    assert.doesNotMatch(JSON.stringify(result), /face|photo|person/i);
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
    assert.equal(subject.calls.createUser, 0);
    assert.equal(subject.state.auth.get("existing")?.PasswordSentinel, "do-not-overwrite");
  }
  for (const scenario of [
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
  }
  console.log("teacherCreate v6 no-photo direct-write runtime contract: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
