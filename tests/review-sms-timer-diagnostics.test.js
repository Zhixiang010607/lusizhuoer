"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createReviewSmsSender, TRIGGER_NAME } = require("../cloudfunctions/staffAccount/review-sms-sender");
const { recordTimerGuardDiagnostic } = require("../cloudfunctions/staffAccount/timer-guard-diagnostics");
const source = fs.readFileSync(path.join(__dirname, "../cloudfunctions/staffAccount/index.js"), "utf8");
const start = source.indexOf("function requireTeacherExperienceTimerControlPlaneCaller(");
const end = source.indexOf("async function handleTrustedTeacherExperienceResetTimer", start);
assert.ok(start > 0 && end > start);
const guardSource = source.slice(start, end);
const instant = Date.parse("2026-11-28T05:00:00Z");
const event = { Type: "Timer", TriggerName: TRIGGER_NAME, Time: new Date(instant).toISOString() };

function harness({ uid = "", authThrows = false, loggerThrows = false, environment = {}, context = {} } = {}) {
  const env = { TRIGGER_SRC: "timer", SCF_FUNCTIONNAME: "staffAccount", TCB_ENV: "isolated-env",
    TENCENTCLOUD_SECRETID: "private-id-sentinel", TENCENTCLOUD_SECRETKEY: "private-key-sentinel",
    TENCENTCLOUD_SESSIONTOKEN: "private-token-sentinel", ...environment };
  const logs = [], sql = [];
  let sends = 0, reads = 0;
  const logger = { info(marker, snapshot) {
    if (loggerThrows) throw Error("logging unavailable");
    logs.push({ marker, snapshot });
  } };
  const box = { FUNCTION_VERSION: "v108", module: { exports: {} },
    getAuth: () => ({ getUserInfo() { reads++; if (authThrows) throw Error("private-auth-error"); return { uid }; } }),
    require(name) {
      assert.equal(name, "./timer-guard-diagnostics");
      return { recordTimerGuardDiagnostic: options => recordTimerGuardDiagnostic({ ...options, env, logger, now: () => instant }) };
    },
    fail(message, code) { throw Object.assign(Error(message), { code }); }
  };
  vm.runInNewContext(`${guardSource}\nmodule.exports = requireTeacherExperienceTimerControlPlaneCaller;`, box);
  const sender = createReviewSmsSender({ env, sqlText: x => `'${x}'`,
    requireControlPlane: (e, c) => box.module.exports({ event: e, context: c }),
    executeSql: async query => { sql.push(query); return query.includes("delivery_state")
      ? [{ enabled: true, sdk_app_id: "1401179904" }] : [{ result: null }]; },
    clientFactory: () => ({ SendSms: async () => { sends++; throw Error("must not send"); } })
  });
  return { sender, logs, sql, context, counts: () => ({ reads, sends }) };
}

test("UID-bearing requests still fail before SQL/SMS despite apparently valid Timer context", async () => {
  const h = harness({ uid: "private-auth-uid", environment: { TCB_UUID: "private-runtime-uid", TCB_CONTEXT_KEYS: "TCB_UUID" } });
  const context = { function_name: "staffAccount", namespace: "isolated-env",
    environment: JSON.stringify({ TCB_UUID: "", TCB_CONTEXT_KEYS: "TCB_UUID", TRIGGER_SRC: "timer" }) };
  await assert.rejects(h.sender.handle(event, context), { code: "FORBIDDEN" });
  assert.equal(h.sql.length, 0);
  assert.equal(h.counts().sends, 0);
  assert.equal(h.logs.length, 1);
  assert.equal(h.logs[0].snapshot.decision, "uid-rejected");
  assert.equal(h.logs[0].snapshot.sdkUidPresent, true);
  assert.equal(h.logs[0].snapshot.runtimeUidPresent, true);
  assert.equal(h.logs[0].snapshot.contextUidPresent, false);
});

test("an identity-read failure remains fail closed and logs no raw auth error", async () => {
  const h = harness({ authThrows: true });
  await assert.rejects(h.sender.handle(event, {}), { code: "UNTRUSTED_TIMER_EVENT" });
  assert.equal(h.sql.length, 0);
  assert.equal(h.logs[0].snapshot.decision, "identity-unverified");
  assert.equal(h.logs[0].snapshot.sdkUidPresent, null);
  assert.doesNotMatch(JSON.stringify(h.logs), /private-auth-error/);
});

test("logger failure cannot suppress the UID veto or authorize any send", async () => {
  const h = harness({ uid: "private-auth-uid", loggerThrows: true });
  await assert.rejects(h.sender.handle(event, {}), { code: "FORBIDDEN" });
  assert.equal(h.sql.length, 0);
  assert.equal(h.counts().sends, 0);
});

test("successful empty-queue Timer preserves its response and passes the actual context to diagnostics", async () => {
  const h = harness();
  const result = await h.sender.handle(event, { function_name: "staffAccount", namespace: "isolated-env",
    environment: JSON.stringify({ TRIGGER_SRC: "timer" }) });
  assert.deepEqual(result, { ok: true, timer: true, deliveryReady: true, processed: 0, accepted: 0, rejected: 0, unknown: 0 });
  assert.equal(h.counts().reads, 1);
  assert.equal(h.counts().sends, 0);
  const s = h.logs[0].snapshot;
  assert.equal(s.contextEnvironmentState, "json");
  assert.equal(s.contextSourceTimer, true);
  assert.equal(s.contextNamespaceMatches, true);
  assert.equal(s.eventTimeWithinTwoMinutes, true);
});

test("context is observation only and cannot change the existing SDK identity decision", async () => {
  const h = harness();
  const result = await h.sender.handle(event, {
    function_name: "staffAccount", environment: JSON.stringify({ TCB_UUID: "private-context-uid" })
  });
  assert.equal(result.deliveryReady, true);
  assert.equal(result.processed, 0);
  assert.equal(h.logs[0].snapshot.sdkUidPresent, false);
  assert.equal(h.logs[0].snapshot.contextUidPresent, true);
  assert.equal(h.logs[0].snapshot.decision, "allowed");
  assert.equal(h.counts().sends, 0);
});

test("forged/malformed Timer envelopes still fail before identity diagnostics", async () => {
  for (const change of [{ TRIGGER_SRC: "api" }, { SCF_FUNCTIONNAME: "other" }]) {
    const h = harness({ environment: change });
    await assert.rejects(h.sender.handle(event, {}), { code: "UNTRUSTED_TIMER_EVENT" });
    assert.equal(h.counts().reads, 0);
    assert.equal(h.logs.length, 0);
    assert.equal(h.sql.length, 0);
  }
  const h = harness();
  await assert.rejects(h.sender.handle({ ...event, Time: "invalid" }), { code: "UNTRUSTED_TIMER_EVENT" });
  assert.equal(await h.sender.handle({ action: "health", environment: { TRIGGER_SRC: "timer" } }), null);
  assert.equal(h.logs.length, 0);
});

test("only whitelisted scalar diagnostics escape, even when event/context/env contain private material", () => {
  const logs = [];
  const input = { event: { ...event, action: "private-action", phone: "private-phone" },
    context: { function_name: "private-function", namespace: "private-namespace", request_id: "private-request",
      environment: JSON.stringify({ TCB_UUID: "private-uid", TRIGGER_SRC: "private-source", TOKEN: "private-context-token" }) },
    env: { TCB_UUID: "private-env-uid", TENCENTCLOUD_SECRETKEY: "private-key" },
    identity: { uid: "private-sdk-uid", openId: "private-openid" }, identityReadOk: true, version: "v108",
    logger: { info: (marker, snapshot) => logs.push({ marker, snapshot }) }, now: () => instant };
  recordTimerGuardDiagnostic(input);
  assert.equal(logs.length, 1);
  assert.doesNotMatch(JSON.stringify(logs), /private-|TCB_UUID|SECRETKEY|request_id/);
  for (const value of Object.values(logs[0].snapshot)) {
    assert.ok(value === null || ["boolean", "number", "string"].includes(typeof value));
  }
  for (const environment of ["not-json", "[]", "null"]) {
    recordTimerGuardDiagnostic({ ...input, context: { environment } });
    assert.equal(logs.at(-1).snapshot.contextEnvironmentState, "invalid");
  }
});
