"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const staffSource = fs.readFileSync(
  path.join(root, "cloudfunctions", "staffAccount", "index.js"),
  "utf8"
);
const browserAuthSource = fs.readFileSync(path.join(root, "cloudbase-phone-auth.js"), "utf8");
const browserLoginSource = fs.readFileSync(path.join(root, "login.js"), "utf8");

function functionSource(source, name) {
  const marker = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = marker.exec(source);
  assert.ok(match, `function ${name} must exist`);
  const signatureEnd = source.indexOf(") {", match.index + match[0].length);
  assert.ok(signatureEnd >= 0, `function ${name} signature must be complete`);
  const bodyStart = signatureEnd + 2;
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, index + 1);
    }
  }
  throw new Error(`function ${name} body is incomplete`);
}

function asyncMethodSource(source, name) {
  const marker = new RegExp(`async\\s+${name}\\s*\\(`);
  const match = marker.exec(source);
  assert.ok(match, `async method ${name} must exist`);
  const signatureEnd = source.indexOf(") {", match.index + match[0].length);
  assert.ok(signatureEnd >= 0, `async method ${name} signature must be complete`);
  const bodyStart = signatureEnd + 2;
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, index + 1);
    }
  }
  throw new Error(`async method ${name} body is incomplete`);
}

const dispatcher = functionSource(staffSource, "main");
const sessionStart = dispatcher.indexOf('if (action === "session")');
const sessionEnd = dispatcher.indexOf('\n  if (action === "', sessionStart + 1);
assert.ok(sessionStart >= 0 && sessionEnd > sessionStart, "main must expose a bounded public session branch");
const publicSessionBranch = dispatcher.slice(sessionStart, sessionEnd);

test("public staff session never accepts a phone recovery or auth_uid rebind path", () => {
  assert.doesNotMatch(publicSessionBranch, /event\.phone/,
    "a client-supplied phone must not influence session lookup");
  assert.doesNotMatch(publicSessionBranch, /recoverStaffProfileByVerifiedPhone/,
    "public session must not invoke legacy phone recovery");
  assert.doesNotMatch(dispatcher, /recoverStaffProfileByVerifiedPhone/,
    "no public staffAccount action may expose legacy phone recovery");
  assert.doesNotMatch(publicSessionBranch, /UPDATE\s+public\.staff_accounts[\s\S]*?auth_uid/i,
    "session lookup must never rewrite the credential binding");

  const currentUser = functionSource(staffSource, "currentUser");
  assert.match(currentUser, /findStaffProfile\(uid\)/,
    "the authenticated CloudBase UID must be the only public session lookup key");
});

test("browser clients request staff session without resending the login phone", () => {
  const getStaffSession = asyncMethodSource(browserAuthSource, "getStaffSession");
  assert.match(getStaffSession, /async getStaffSession\(\)/,
    "the browser staff-session API must not accept a phone argument");
  assert.match(getStaffSession, /\{\s*action:\s*"session"\s*\}/,
    "the browser must send only the public session action");
  assert.doesNotMatch(getStaffSession, /\bphone\b|normalizePhone/);

  const validateWorkspaceSession = asyncMethodSource(browserAuthSource, "validateWorkspaceSession");
  assert.match(validateWorkspaceSession, /this\.getStaffSession\(\)/);
  assert.doesNotMatch(validateWorkspaceSession, /expected\.(?:phone|account)|getStaffSession\([^)]/,
    "workspace revalidation must use the current CloudBase UID, not cached account text");

  assert.match(browserLoginSource, /CloudBasePhoneAuth\.getStaffSession\(\)/);
  assert.doesNotMatch(browserLoginSource, /CloudBasePhoneAuth\.getStaffSession\(\s*phone\s*\)/);
});

test("an unknown authenticated UID fails even when the caller supplies an existing-looking phone", async () => {
  const state = { recoveryCalls: 0, sqlCalls: 0, bootstrapCalls: 0 };
  const sandbox = {
    FUNCTION_VERSION: "v77",
    console,
    module: { exports: {} },
    exports: {},
    process: { env: { BOOTSTRAP_HQ_UID: "" } },
    async handleTrustedTeacherExperienceResetTimer() { return null; },
    async currentUser() { return { uid: "unknown-authenticated-uid", profile: null }; },
    async ensureBootstrapHq() {
      state.bootstrapCalls += 1;
      return null;
    },
    async recoverStaffProfileByVerifiedPhone() {
      state.recoveryCalls += 1;
      return { role: "teacher" };
    },
    async executeSql() {
      state.sqlCalls += 1;
      return [];
    },
    fail(message, code) {
      const error = new Error(message);
      error.code = code;
      throw error;
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(`${dispatcher}\nmodule.exports = main;`, sandbox, {
    filename: "staff-session-dispatcher.js"
  });

  await assert.rejects(
    // `phone` is deliberately hostile legacy input here, not a supported
    // client contract. The dispatcher must ignore it and fail by UID.
    sandbox.module.exports({ action: "session", phone: "13900000000" }),
    (error) => /^UNASSIGNED_(?:PHONE|IDENTITY)$/.test(String(error?.code || ""))
  );
  assert.equal(state.recoveryCalls, 0, "unknown UID must not trigger phone recovery");
  assert.equal(state.sqlCalls, 0, "public session must not write an auth_uid binding");
  assert.equal(state.bootstrapCalls, 0, "an unrelated UID must not enter HQ bootstrap");
});
