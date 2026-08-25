"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const mini = path.join(root, "miniprogram-app", "miniprogram");
const intentSource = fs.readFileSync(path.join(mini, "services", "teacher-experience-recharge.js"), "utf8");
const pageSource = fs.readFileSync(path.join(mini, "pages", "teacher-detail", "index.js"), "utf8");
const pageWxml = fs.readFileSync(path.join(mini, "pages", "teacher-detail", "index.wxml"), "utf8");

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function loadIntent(storage, uid = "hq-auth-uid") {
  const context = {
    module: { exports: {} }, exports: {},
    require(id) {
      if (id === "./session") return { readSession: () => ({ uid }) };
      throw new Error(`unexpected intent dependency ${id}`);
    },
    wx: {
      getStorageSync(key) { return storage.get(key); },
      setStorageSync(key, value) { storage.set(key, clone(value)); },
      removeStorageSync(key) { storage.delete(key); }
    },
    Date, Math, JSON, String, Number, Object, Array, Error
  };
  vm.runInNewContext(intentSource, context, { filename: "services/teacher-experience-recharge.js" });
  return context.module.exports;
}

function loadPage(intent, callStaff) {
  let definition;
  vm.runInNewContext(pageSource, {
    Page(value) { definition = value; },
    require(id) {
      if (id === "../../services/api") return { callStaff };
      if (id === "../../services/session") return { requireSession: () => ({ role: "hq", uid: "hq-auth-uid" }) };
      if (id === "../../services/teacher-experience-recharge") return intent;
      throw new Error(`unexpected teacher-detail dependency ${id}`);
    },
    wx: {
      setNavigationBarTitle() {}, stopPullDownRefresh() {}, navigateBack() {},
      showModal(options) { options.success({ confirm: true }); }
    },
    console, Date, Math, Promise, String, Number, Boolean, Object, Array, Set, Map,
    encodeURIComponent, decodeURIComponent
  }, { filename: "pages/teacher-detail/index.js" });
  assert.ok(definition);
  return definition;
}

function pageInstance(definition, data = {}) {
  return {
    ...definition,
    data: { ...clone(definition.data), ...data },
    _unloaded: false,
    setData(changes) { Object.assign(this.data, changes); }
  };
}

function successResult(intent, createdNow = false) {
  return {
    ok: true,
    createdNow,
    recharge: {
      id: "7001", unitCount: intent.unitCount,
      availableBeforeCount: 3, availableAfterCount: 3 + intent.unitCount
    },
    entitlement: { productId: intent.productId }
  };
}

function readback(intent) {
  return {
    ok: true,
    teacher: { id: intent.teacherId },
    entitlements: [{ productId: intent.productId, productName: "海洋之蕴", productStatus: "ACTIVE", availableCount: 8 }],
    history: [], experienceTotals: []
  };
}

test("quota recharge intent survives restart and only the exact request can clear it", () => {
  const storage = new Map();
  const firstModule = loadIntent(storage);
  const first = firstModule.begin({ teacherId: "9", productId: "2", unitCount: 5, note: "总部补充" });
  assert.equal(first.state, "SUBMITTING");
  assert.throws(
    () => firstModule.begin({ teacherId: "9", productId: "2", unitCount: 6, note: "总部补充" }),
    /上一笔体验充值结果尚未确认/
  );

  firstModule.markUncertain(first.clientRequestId);
  const reloadedModule = loadIntent(storage);
  assert.equal(reloadedModule.read().clientRequestId, first.clientRequestId);
  assert.equal(reloadedModule.read().state, "UNCERTAIN");
  assert.throws(() => reloadedModule.confirm("another-request", "7001"), /保持防重复提交锁/);
  assert.ok(reloadedModule.read());
  reloadedModule.confirm(first.clientRequestId, "7001");
  assert.equal(reloadedModule.acknowledge(first.clientRequestId, "wrong-order"), false);
  assert.ok(reloadedModule.read(), "another recharge result cannot clear the lock");
  assert.equal(reloadedModule.acknowledge(first.clientRequestId, "7001"), true);
  assert.equal(reloadedModule.read(), null);
});

test("unknown quota recharge replays the same payload and key after page restart without a second top-up", async () => {
  const storage = new Map();
  const intent = loadIntent(storage);
  const firstMutationCalls = [];
  const firstDefinition = loadPage(intent, async (action, payload) => {
    assert.equal(action, "rechargeTeacherExperienceEntitlement");
    firstMutationCalls.push(clone(payload));
    const error = new Error("network timeout");
    error.submissionUncertain = true;
    throw error;
  });
  const firstPage = pageInstance(firstDefinition, {
    teacherId: "9", rechargeProductId: "2", rechargeCount: "5", rechargeNote: "总部补充",
    rechargeProducts: [{ productId: "2" }], profile: { archived: false }
  });
  await firstPage.recharge();
  const pending = intent.read();
  assert.equal(pending.state, "UNCERTAIN");
  assert.equal(firstPage.data.rechargePending, true);

  const replayCalls = [];
  const reloadedDefinition = loadPage(intent, async (action, payload) => {
    replayCalls.push({ action, payload: clone(payload) });
    if (action === "rechargeTeacherExperienceEntitlement") return successResult(pending, false);
    if (action === "getTeacherExperienceEntitlements") return readback(pending);
    throw new Error(`unexpected action ${action}`);
  });
  const reloadedPage = pageInstance(reloadedDefinition, {
    teacherId: "9", products: [{ id: "2", product_name: "海洋之蕴", product_status: "ACTIVE" }],
    profile: { archived: false }
  });
  reloadedPage.syncRechargePending();
  assert.equal(reloadedPage.data.rechargePending, true, "a restarted page is locked before any new top-up can begin");
  await reloadedPage.recoverRecharge();

  assert.equal(replayCalls[0].action, "rechargeTeacherExperienceEntitlement");
  assert.deepEqual(replayCalls[0].payload, firstMutationCalls[0], "recovery replays the exact original payload and idempotency key");
  assert.equal(replayCalls[1].action, "getTeacherExperienceEntitlements");
  assert.equal(intent.read(), null, "the lock clears only after an exact server proof and authoritative readback");
  assert.equal(reloadedPage.data.rechargePending, false);
  assert.match(reloadedPage.data.message, /未重复增加次数/);
});

test("mismatched recharge proof keeps the persistent lock and blocks fresh input", async () => {
  const storage = new Map();
  const intent = loadIntent(storage);
  const pending = intent.begin({ teacherId: "9", productId: "2", unitCount: 5, note: "" });
  const definition = loadPage(intent, async (action) => {
    assert.equal(action, "rechargeTeacherExperienceEntitlement");
    return { ...successResult(pending), entitlement: { productId: "99" } };
  });
  const page = pageInstance(definition, { teacherId: "9", profile: { archived: false }, rechargePending: true });
  await page.recoverRecharge();
  assert.ok(intent.read());
  assert.equal(intent.read().state, "UNCERTAIN");
  assert.equal(page.data.rechargePending, true);
  assert.match(page.data.message, /完全一致的体验充值证明/);
  assert.match(pageWxml, /wx:if="\{\{rechargePending\}\}"[\s\S]*bindtap="recoverRecharge"/);
  assert.match(pageWxml, /disabled="\{\{mutating \|\| rechargePending \|\| profile\.archived/,
    "pending persistence disables the fields and new recharge action");
});

test("a readback rejection after a confirmed write cannot release the lock", async () => {
  const storage = new Map();
  const intent = loadIntent(storage);
  const pending = intent.begin({ teacherId: "9", productId: "2", unitCount: 5, note: "" });
  let calls = 0;
  const definition = loadPage(intent, async (action) => {
    calls += 1;
    if (action === "rechargeTeacherExperienceEntitlement") return successResult(pending);
    const error = new Error("session expired during readback");
    error.code = "UNAUTHENTICATED";
    throw error;
  });
  const page = pageInstance(definition, { teacherId: "9", profile: { archived: false }, rechargePending: true });
  await page.recoverRecharge();
  assert.equal(calls, 2);
  assert.equal(intent.read().state, "CONFIRMED", "an exact write proof is never downgraded or discarded by a later read failure");
  assert.equal(page.data.rechargePending, true);
});

test("a definitive pre-write rejection safely releases the pending intent", async () => {
  const storage = new Map();
  const intent = loadIntent(storage);
  intent.begin({ teacherId: "9", productId: "2", unitCount: 5, note: "" });
  const definition = loadPage(intent, async () => {
    const error = new Error("quota not configured");
    error.code = "TEACHER_EXPERIENCE_QUOTA_NOT_CONFIGURED";
    throw error;
  });
  const page = pageInstance(definition, { teacherId: "9", profile: { archived: false }, rechargePending: true });
  await page.recoverRecharge();
  assert.equal(intent.read(), null);
  assert.equal(page.data.rechargePending, false);
});
