"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const crypto = require("node:crypto");

const root = path.resolve(__dirname, "..");
const createSource = fs.readFileSync(path.join(root, "cloudfunctions/teacherCreate/index.js"), "utf8");
const sessionSource = fs.readFileSync(path.join(root, "miniprogram-app/miniprogram/services/session.js"), "utf8");
const fixture = { phone: "13900000007", password: "Aa1!fixture", staffName: "示例老师" };
const uid = "fixture-created-teacher";

function rowsResult(rows) {
  const columns = rows.length ? Object.keys(rows[0]) : [];
  return { Columns: columns, Rows: rows.map((row) => columns.map((column) => row[column])) };
}

function harness({ tokenLag = false, sessionFailures = 0, currentUid = uid, emptyAuth = false, staffError = null } = {}) {
  let authRecord = null;
  let staffRecord = null;
  let functionUid = "";
  const events = [];
  const storage = new Map();
  const app = { globalData: { session: null } };
  const manager = {
    user: {
      async describeUserList() { return { Data: { UserList: authRecord ? [authRecord] : [] } }; },
      async createUser(input) {
        events.push("createAuth");
        authRecord = { Uid: uid, Phone: input.phone, UserStatus: input.userStatus, password: input.password };
        return { Data: { Uid: uid } };
      },
      async deleteUsers() { throw new Error("Unexpected rollback in successful creation fixture"); }
    },
    database: {
      async executePGSql({ Sql }) {
        if (Sql.includes("SELECT id, role_code, account_status")) {
          return rowsResult([{ id: "1", role_code: "hq", account_status: "ACTIVE" }]);
        }
        if (Sql.includes("LEFT JOIN public.teachers")) return rowsResult(staffRecord ? [staffRecord] : []);
        if (Sql.includes("INSERT INTO public.staff_accounts")) {
          assert.ok(authRecord, "business records must follow Auth creation");
          events.push("createBusiness");
          staffRecord = {
            staff_id: "501", auth_uid: uid, phone: fixture.phone, role_code: "teacher", account_status: "ACTIVE",
            teacher_id: "701", teacher_code: "TCHF501", teacher_status: "ACTIVE"
          };
          return rowsResult([]);
        }
        throw new Error("Unexpected SQL in creation fixture");
      }
    }
  };
  const createSandbox = {
    exports: {}, Buffer, console: { error() {} }, process: { env: { CLOUDBASE_ENV_ID: "fixture-env" } },
    require(name) {
      if (name === "node:crypto") return crypto;
      if (name === "@cloudbase/node-sdk") return { init: () => ({ auth: () => ({ getUserInfo: () => ({ uid: "fixture-hq" }) }) }) };
      if (name === "@cloudbase/manager-node") return { init: () => manager };
      throw new Error(`Unexpected creation dependency: ${name}`);
    }
  };
  vm.runInNewContext(createSource, createSandbox);
  const auth = {
    async signOut() { events.push("signOut"); functionUid = ""; },
    async signInWithPassword(input) {
      events.push("passwordLogin");
      if (emptyAuth) return { data: {} };
      if (!authRecord || input.phone !== authRecord.Phone || input.password !== authRecord.password) {
        return { error: { code: "INVALID_CREDENTIALS", message: "手机号或密码错误" } };
      }
      if (!tokenLag) functionUid = authRecord.Uid;
      return { data: { user: { uid: authRecord.Uid } } };
    },
    async refreshSession() { events.push("refresh"); functionUid = currentUid; },
    async getAccessToken() { return { accessToken: "fixture-token" }; },
    async getCurrentUser() { return { uid: currentUid }; }
  };
  const sessionSandbox = {
    module: { exports: {} }, exports: {}, Date, setTimeout,
    getApp: () => app,
    wx: {
      getStorageSync: (key) => storage.get(key),
      setStorageSync: (key, value) => storage.set(key, value),
      removeStorageSync: (key) => storage.delete(key)
    },
    require(name) {
      if (name === "./cloudbase") return { getAuth: () => auth };
      if (name === "./api") return { callStaff: async (action, ...args) => {
        events.push("staffSession");
        assert.equal(action, "session");
        assert.deepEqual(args, [], "session must never receive a phone or desired role");
        if (staffError) throw staffError;
        if (!functionUid || sessionFailures-- > 0) {
          throw Object.assign(new Error("认证会话尚未同步"), { code: "UNAUTHENTICATED" });
        }
        return { uid: functionUid, profile: {
          role: staffRecord.role_code, staffId: staffRecord.staff_id, teacherId: staffRecord.teacher_id,
          staffName: fixture.staffName
        } };
      } };
      throw new Error(`Unexpected session dependency: ${name}`);
    }
  };
  vm.runInNewContext(sessionSource, sessionSandbox);
  return {
    session: sessionSandbox.module.exports, events, app, storage,
    create: () => createSandbox.exports.main({ action: "createTeacher", ...fixture, initialPassword: fixture.password, clientRequestId: "fixture_create_login_01" })
  };
}

for (const tokenLag of [false, true]) {
  test(`a newly created teacher can log in with its original password (token lag: ${tokenLag})`, async () => {
    const h = harness({ tokenLag });
    const created = await h.create();
    assert.equal(created.ok, true);
    assert.equal(created.proof.complete, true);
    const session = await h.session.passwordLogin(fixture.phone, fixture.password);
    assert.equal(session.uid, created.uid);
    assert.equal(session.teacherId, created.teacherId);
    assert.equal(session.role, "teacher");
    assert.equal(h.events.filter((event) => event === "createAuth").length, 1);
    assert.equal(h.events.filter((event) => event === "passwordLogin").length, 1);
    assert.equal(JSON.stringify([...h.storage.values()]).includes(fixture.password), false);
  });
}

test("password login retries only the staff read after a transient token-switch response", async () => {
  const h = harness({ tokenLag: true, sessionFailures: 1 });
  await h.create();
  const session = await h.session.passwordLogin(fixture.phone, fixture.password);
  assert.equal(session.uid, uid);
  assert.equal(h.events.filter((event) => event === "passwordLogin").length, 1);
  assert.equal(h.events.filter((event) => event === "staffSession").length, 2);
});

test("wrong initial password never reaches the staff profile or caches a session", async () => {
  const h = harness();
  await h.create();
  await assert.rejects(h.session.passwordLogin(fixture.phone, "Wrong1!password"), /手机号或密码错误/);
  assert.equal(h.events.includes("staffSession"), false);
  assert.equal(h.app.globalData.session, null);
});

test("an incomplete password-auth response must not request a staff identity", async () => {
  const h = harness({ emptyAuth: true });
  await h.create();
  await assert.rejects(h.session.passwordLogin(fixture.phone, fixture.password));
  assert.equal(h.events.includes("staffSession"), false);
  assert.equal(h.app.globalData.session, null);
});

test("an SDK identity mismatch must fail before any staff profile request", async () => {
  const h = harness({ tokenLag: true, currentUid: "fixture-other-account" });
  await h.create();
  await assert.rejects(h.session.passwordLogin(fixture.phone, fixture.password));
  assert.equal(h.events.includes("staffSession"), false);
  assert.equal(h.app.globalData.session, null);
});

test("persistent session failure stops after three reads and clears the new login", async () => {
  const h = harness({ sessionFailures: 10 });
  await h.create();
  await assert.rejects(h.session.passwordLogin(fixture.phone, fixture.password));
  assert.equal(h.events.filter((event) => event === "staffSession").length, 3);
  assert.equal(h.events.filter((event) => event === "passwordLogin").length, 1);
  assert.equal(h.app.globalData.session, null);
});

test("an archived teacher is rejected without retrying or storing a session", async () => {
  const h = harness({ staffError: Object.assign(new Error("账号已封存"), { code: "ARCHIVED_ACCOUNT" }) });
  await h.create();
  await assert.rejects(h.session.passwordLogin(fixture.phone, fixture.password), /账号已封存/);
  assert.equal(h.events.filter((event) => event === "staffSession").length, 1);
  assert.equal(h.app.globalData.session, null);
});
