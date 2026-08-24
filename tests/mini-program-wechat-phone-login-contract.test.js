"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const sessionSource = fs.readFileSync(
  path.join(root, "miniprogram-app", "miniprogram", "services", "session.js"),
  "utf8"
);
const sessionKey = /const SESSION_KEY = "([^"]+)"/.exec(sessionSource)?.[1];
assert.ok(sessionKey, "session.js must declare a local session cache key");

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function loadSession({ authError, authResult, staffResult, storedSession } = {}) {
  const storage = new Map();
  if (storedSession) storage.set(sessionKey, storedSession);
  const app = { globalData: { session: storedSession || null } };
  const state = {
    app,
    callStaffArgs: [],
    removedKeys: [],
    signInArgs: [],
    signOutCalls: 0,
    storageWrites: []
  };
  const auth = {
    async signInWithPhoneAuth(args) {
      state.signInArgs.push(plain(args));
      if (authError) throw authError;
      return authResult || { data: { user: { uid: "staff-auth-uid" } } };
    },
    async signOut() {
      state.signOutCalls += 1;
    }
  };
  const sandbox = {
    Date,
    console,
    getApp: () => app,
    module: { exports: {} },
    exports: {},
    require(id) {
      if (id === "./cloudbase") return { getAuth: () => auth };
      if (id === "./api") {
        return {
          callStaff: async (...args) => {
            state.callStaffArgs.push(plain(args));
            return staffResult;
          }
        };
      }
      throw new Error(`unexpected require: ${id}`);
    },
    wx: {
      getStorageSync: (key) => storage.get(key),
      removeStorageSync(key) {
        state.removedKeys.push(key);
        storage.delete(key);
      },
      setStorageSync(key, value) {
        storage.set(key, value);
        state.storageWrites.push({ key, value: plain(value) });
      },
      reLaunch() {},
      showToast() {}
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(sessionSource, sandbox, { filename: "mini-program-session.js" });
  return { api: sandbox.module.exports, state, storage };
}

const activeStaff = {
  ok: true,
  uid: "staff-auth-uid",
  profile: {
    role: "teacher",
    staffId: "41",
    staffCode: "TCH041",
    staffName: "测试老师",
    teacherId: "17",
    phone: "13900000000",
    storeId: "",
    storeCode: "",
    storeName: ""
  }
};

test("WeChat phone login exchanges only phoneCode and resolves staff session by authenticated UID", async () => {
  const { api, state, storage } = loadSession({ staffResult: activeStaff });
  assert.equal(typeof api.wechatPhoneLogin, "function", "session.js must export wechatPhoneLogin(phoneCode)");

  const session = await api.wechatPhoneLogin("one-time-phone-code");

  assert.deepEqual(state.signInArgs, [{ phoneCode: "one-time-phone-code" }]);
  assert.deepEqual(state.callStaffArgs, [["session"]],
    "the public session action must not receive a client-supplied phone");
  assert.equal(session.uid, activeStaff.uid, "the staff service UID is the cached identity authority");
  assert.equal(session.teacherId, activeStaff.profile.teacherId,
    "teacher sessions must preserve the server-authoritative teacher binding");
  assert.equal(Object.hasOwn(session, "phone"), false, "the returned local session must omit phone");

  const cached = storage.get(sessionKey);
  assert.ok(cached, "successful login must cache the non-secret business session");
  assert.equal(Object.hasOwn(cached, "phone"), false, "the persistent session must omit phone");
  assert.equal(JSON.stringify(cached).includes("13900000000"), false,
    "a phone returned by staffAccount must not leak into persistent storage");
  assert.equal(state.signOutCalls, 0);
});

test("a rejected business identity signs out and clears any local session", async () => {
  const staleSession = { uid: "stale-uid", role: "teacher", staffName: "旧会话" };
  const rejectedStaff = { ok: true, uid: "staff-auth-uid", profile: { role: "unassigned" } };
  const { api, state, storage } = loadSession({ staffResult: rejectedStaff, storedSession: staleSession });

  await assert.rejects(api.wechatPhoneLogin("rejected-one-time-code"));

  assert.deepEqual(state.callStaffArgs, [["session"]]);
  assert.equal(state.signOutCalls, 1,
    "a CloudBase identity without an allowed business profile must be signed out");
  assert.equal(storage.has(sessionKey), false, "failed login must clear the cached session");
  assert.equal(state.app.globalData.session, null, "failed login must clear the in-memory session");
});

test("an authentication error signs out, clears local state, and skips the staff session", async () => {
  const staleSession = { uid: "stale-uid", role: "teacher", staffName: "旧会话" };
  const authResult = { data: {}, error: { code: "INVALID_CREDENTIALS", message: "认证失败" } };
  const { api, state, storage } = loadSession({ authResult, storedSession: staleSession });

  await assert.rejects(api.wechatPhoneLogin("invalid-one-time-code"), /认证失败/);

  assert.deepEqual(state.callStaffArgs, [], "an authentication error must not reach staffAccount");
  assert.equal(state.signOutCalls, 1, "an authentication error must clear any SDK login state");
  assert.equal(storage.has(sessionKey), false, "an authentication error must clear the cached business session");
  assert.equal(state.app.globalData.session, null, "an authentication error must clear the in-memory session");
});

test("a blank CloudBase UNKNOWN error reports transport configuration instead of bad credentials", async () => {
  const authResult = {
    data: {},
    error: { category: "UNKNOWN", message: "", requestId: "request-id-is-diagnostic-only" }
  };
  const { api, state } = loadSession({ authResult });

  await assert.rejects(
    api.wechatPhoneLogin("blocked-before-authentication"),
    /登录服务暂不可用.*网络.*request 合法域名配置/
  );

  assert.deepEqual(state.callStaffArgs, [], "a blocked Auth request must not reach staffAccount");
  assert.equal(state.signOutCalls, 1, "a blocked Auth request must clear the SDK login state");
});

test("a rejected authentication promise also signs out and clears local state", async () => {
  const staleSession = { uid: "stale-uid", role: "teacher", staffName: "旧会话" };
  const { api, state, storage } = loadSession({ authError: new Error("网络认证失败"), storedSession: staleSession });

  await assert.rejects(api.wechatPhoneLogin("rejected-one-time-code"), /网络认证失败/);

  assert.deepEqual(state.callStaffArgs, [], "a rejected SDK promise must not reach staffAccount");
  assert.equal(state.signOutCalls, 1, "a rejected SDK promise must clear any SDK login state");
  assert.equal(storage.has(sessionKey), false, "a rejected SDK promise must clear the cached business session");
  assert.equal(state.app.globalData.session, null, "a rejected SDK promise must clear the in-memory session");
});

test("a phone-free cached session can be restored without sending phone to staffAccount", async () => {
  const storedSession = {
    uid: activeStaff.uid,
    role: "teacher",
    staffId: "41",
    staffCode: "TCH041",
    staffName: "测试老师",
    teacherId: "17",
    storeId: "",
    storeCode: "",
    storeName: "",
    loginAt: "2026-08-24T00:00:00.000Z"
  };
  const { api, state } = loadSession({ staffResult: activeStaff, storedSession });

  const restored = await api.restoreAndValidateSession();

  assert.ok(restored, "a valid UID/role cache must restore without a phone field");
  assert.deepEqual(state.callStaffArgs, [["session"]]);
  assert.equal(Object.hasOwn(restored, "phone"), false);
  assert.equal(restored.teacherId, activeStaff.profile.teacherId);
});
