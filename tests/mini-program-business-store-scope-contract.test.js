"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const mini = path.join(root, "miniprogram-app", "miniprogram");
const selectedStore = Object.freeze({ id: "42", code: "S0042", name: "测试门店" });
const teacherSession = Object.freeze({ role: "teacher", teacherId: "9", uid: "uid-teacher" });
const storeSession = Object.freeze({ role: "store", storeId: "42", storeCode: "S0042", storeName: "测试门店", uid: "uid-store" });
const scopedLoadActions = new Set([
  "listActiveTeachers",
  "listActiveProducts",
  "getCustomerProductBalances",
  "getTeacherExperienceEntitlements"
]);

function responseFor(action) {
  if (action === "getTeacherBusinessContext") {
    return { stores: [
      { storeId: "42", storeCode: "S0042", storeName: "测试门店" },
      { storeId: "84", storeCode: "S0084", storeName: "第二门店" }
    ] };
  }
  if (action === "listActiveTeachers") {
    return { teachers: [{ teacherId: "9", teacherCode: "T0009", teacherName: "测试老师" }] };
  }
  if (action === "listActiveProducts") {
    return { products: [{ productId: "6", productCode: "P0006", productName: "测试项目" }] };
  }
  if (action === "getCustomerProductBalances") {
    return {
      balances: [{
        productId: "6", productCode: "P0006", productName: "测试项目",
        purchasedCount: 3, remainingCount: 3
      }]
    };
  }
  if (action === "getTeacherExperienceEntitlements") {
    return {
      entitlements: [{
        productId: "6", productCode: "P0006", productName: "测试项目",
        availableCount: 3
      }]
    };
  }
  throw new Error(`unexpected face action ${action}`);
}

function loadPage(relativeFile, session = teacherSession) {
  const source = fs.readFileSync(path.join(mini, relativeFile), "utf8");
  const calls = [];
  const persistedStores = [];
  let cameraResetCount = 0;
  let definition = null;
  const sandbox = {
    module: { exports: {} }, exports: {}, console, Date, Math, Promise,
    Page(value) { definition = value; },
    wx: {
      reLaunch() {},
      showModal() {}
    },
    require(id) {
      if (id === "../../services/api") {
        return {
          async callFace(action, payload) {
            calls.push({ action, payload });
            return responseFor(action);
          }
        };
      }
      if (id === "../../services/session") {
        return {
          requireSession: () => session,
          getSelectedStore: () => session.role === "store" ? selectedStore : null,
          setSelectedStore(store) { persistedStores.push({ ...store }); }
        };
      }
      if (id === "../../services/query-tools") return { businessToday: () => "2026-08-25" };
      if (id === "../../services/submission") {
        return {
          read: () => null,
          begin: () => ({ clientRequestId: "unused" }),
          clear() {},
          markUncertain() {},
          recover: async () => ({ found: false, complete: false })
        };
      }
      throw new Error(`unexpected require ${id}`);
    }
  };
  vm.runInNewContext(source, sandbox, { filename: relativeFile });
  assert.ok(definition, `${relativeFile} must register a Page`);
  const page = Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { Object.assign(this.data, patch); },
    selectComponent() { return { reset() { cameraResetCount += 1; } }; }
  });
  return { page, calls, persistedStores, getCameraResetCount: () => cameraResetCount };
}

async function settlePageTasks() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

function assertScopedCalls(calls, expectedActions, label) {
  for (const action of expectedActions) {
    assert.ok(calls.some((call) => call.action === action), `${label} must load ${action}`);
  }
  const scopedCalls = calls.filter((call) => scopedLoadActions.has(call.action));
  assert.ok(scopedCalls.length, `${label} must make scoped option-loading calls`);
  for (const call of scopedCalls) {
    assert.equal(call.payload?.storeId, selectedStore.id,
      `${label} ${call.action} must carry the teacher-selected storeId`);
  }
}

async function selectFirstTeacherStore(page, calls) {
  await settlePageTasks();
  assert.ok(calls.some((call) => call.action === "getTeacherBusinessContext"), "the business page must load the teacher's active stores");
  assert.equal(page.data.store.id, undefined, "a saved homepage store must not be reused on entry");
  assert.equal(page.data.storeIndex, 0);
  assert.equal(page.data.storeLabels[0], "请选择门店", "the picker must own a real placeholder so choosing its first store always emits a change");
  assert.equal(calls.some((call) => scopedLoadActions.has(call.action)), false, "store-scoped options stay unloaded before the page selection");
  page.selectStore({ detail: { value: 1 } });
  await settlePageTasks();
  assert.equal(page.data.store.id, selectedStore.id);
}

test("teacher recharge selects its store inside the page before loading scoped options", async () => {
  const { page, calls } = loadPage("pages/recharge/index.js");
  page.onLoad({ mode: "NEW" });
  await selectFirstTeacherStore(page, calls);
  assertScopedCalls(calls, ["listActiveTeachers", "listActiveProducts"], "recharge");
});

test("teacher refund selects its store inside the page before loading scoped options", async () => {
  const { page, calls } = loadPage("pages/recharge/index.js");
  page.onLoad({ mode: "REFUND" });
  await selectFirstTeacherStore(page, calls);
  await page.customerConfirmed({ detail: { customer: { customerCode: "C0001", customerName: "测试客户" } } });
  assertScopedCalls(calls, ["listActiveTeachers", "getCustomerProductBalances"], "refund");
});

test("teacher NORMAL verification selects its store inside the page", async () => {
  const { page, calls } = loadPage("pages/verification/index.js");
  page.onLoad({ mode: "NORMAL" });
  await selectFirstTeacherStore(page, calls);
  await page.customerConfirmed({ detail: { customer: { customerCode: "C0001", customerName: "测试客户" } } });
  assertScopedCalls(calls, ["listActiveTeachers", "getCustomerProductBalances"], "NORMAL verification");
});

test("teacher EXPERIENCE verification selects its store inside the page", async () => {
  const { page, calls } = loadPage("pages/verification/index.js");
  page.onLoad({ mode: "EXPERIENCE" });
  await selectFirstTeacherStore(page, calls);
  await page.customerConfirmed({ detail: { customer: { customerCode: "C0001", customerName: "测试客户" } } });
  assertScopedCalls(calls, ["listActiveTeachers", "getTeacherExperienceEntitlements"], "EXPERIENCE verification");
});

test("teacher customer creation selects and persists its store inside the page and clears old form state", async () => {
  const { page, calls, persistedStores, getCameraResetCount } = loadPage("pages/customer-create/index.js");
  page.onLoad();
  await settlePageTasks();
  assert.ok(calls.some((call) => call.action === "getTeacherBusinessContext"));
  page.setData({ name: "旧客户", birthDate: "2001-01-01", notes: "旧门店资料", consent: true, captureReady: true });
  page.selectStore({ detail: { value: 1 } });
  assert.equal(page.data.store.id, "42");
  assert.equal(page.data.name, "");
  assert.equal(page.data.birthDate, "");
  assert.equal(page.data.notes, "");
  assert.equal(page.data.consent, false);
  assert.equal(page.data.captureReady, false);
  assert.equal(getCameraResetCount(), 1);
  assert.equal(persistedStores.length, 1);
  assert.equal(persistedStores[0].id, "42");
});

test("switching a teacher business page store clears every old-store customer, option, face, and form value", async () => {
  const rechargeHarness = loadPage("pages/recharge/index.js");
  rechargeHarness.page.onLoad({ mode: "NEW" });
  await selectFirstTeacherStore(rechargeHarness.page, rechargeHarness.calls);
  rechargeHarness.page.setData({
    customer: { customerCode: "OLD" }, selectedTeacher: { teacherId: "9" }, teacherOptionsReady: true,
    selectedProduct: { productId: "6" }, productIndex: 0, unitCount: "9", note: "旧门店留言", ready: true
  });
  rechargeHarness.page.selectStore({ detail: { value: 2 } });
  assert.equal(rechargeHarness.page.data.store.id, "84");
  assert.equal(rechargeHarness.page.data.customer, null);
  assert.equal(rechargeHarness.page.data.selectedTeacher, null);
  assert.equal(rechargeHarness.page.data.selectedProduct, null);
  assert.equal(rechargeHarness.page.data.unitCount, "");
  assert.equal(rechargeHarness.page.data.note, "");
  assert.equal(rechargeHarness.page.data.ready, false);

  const verificationHarness = loadPage("pages/verification/index.js");
  verificationHarness.page.onLoad({ mode: "NORMAL" });
  await selectFirstTeacherStore(verificationHarness.page, verificationHarness.calls);
  verificationHarness.page.setData({
    customer: { customerCode: "OLD" }, selectedTeacher: { teacherId: "9" }, selectedProduct: { productId: "6" },
    note: "旧门店留言", captureReady: true, faceVerified: true, faceRequestId: "old-face",
    faceEvidenceToken: "a".repeat(48), faceMessage: "旧验证", ready: true
  });
  verificationHarness.page.selectStore({ detail: { value: 2 } });
  assert.equal(verificationHarness.page.data.store.id, "84");
  assert.equal(verificationHarness.page.data.customer, null);
  assert.equal(verificationHarness.page.data.selectedTeacher, null);
  assert.equal(verificationHarness.page.data.selectedProduct, null);
  assert.equal(verificationHarness.page.data.note, "");
  assert.equal(verificationHarness.page.data.captureReady, false);
  assert.equal(verificationHarness.page.data.faceVerified, false);
  assert.equal(verificationHarness.page.data.faceEvidenceToken, "");
  assert.equal(verificationHarness.page.data.ready, false);
});

test("store accounts use only their bound store and never render the teacher store selector", async () => {
  for (const [pageName, options] of [["recharge", { mode: "NEW" }], ["verification", { mode: "NORMAL" }], ["customer-create", undefined]]) {
    const { page, calls } = loadPage(`pages/${pageName}/index.js`, storeSession);
    page.onLoad(options);
    await settlePageTasks();
    assert.equal(page.data.store.id, selectedStore.id);
    assert.equal(calls.some((call) => call.action === "getTeacherBusinessContext"), false);
  }
  for (const pageName of ["recharge", "verification", "customer-create"]) {
    const markup = fs.readFileSync(path.join(mini, "pages", pageName, "index.wxml"), "utf8");
    assert.match(markup, /wx:if="\{\{session\.role === 'teacher'\}\}" class="card store-picker-card"/);
    assert.match(markup, /第一步：选择办理门店/);
  }
});
