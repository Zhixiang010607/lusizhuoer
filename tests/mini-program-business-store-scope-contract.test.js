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
const scopedLoadActions = new Set([
  "listActiveTeachers",
  "listActiveProducts",
  "getCustomerProductBalances",
  "getTeacherExperienceEntitlements"
]);

function responseFor(action) {
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

function loadPage(relativeFile) {
  const source = fs.readFileSync(path.join(mini, relativeFile), "utf8");
  const calls = [];
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
          requireSession: () => teacherSession,
          getSelectedStore: () => selectedStore
        };
      }
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
    selectComponent() { return null; }
  });
  return { page, calls };
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

test("teacher recharge option loads carry the selected storeId", async () => {
  const { page, calls } = loadPage("pages/recharge/index.js");
  page.onLoad({ mode: "NEW" });
  await settlePageTasks();
  assertScopedCalls(calls, ["listActiveTeachers", "listActiveProducts"], "recharge");
});

test("teacher refund option loads carry the selected storeId", async () => {
  const { page, calls } = loadPage("pages/recharge/index.js");
  page.onLoad({ mode: "REFUND" });
  await settlePageTasks();
  await page.customerConfirmed({ detail: { customer: { customerCode: "C0001", customerName: "测试客户" } } });
  assertScopedCalls(calls, ["listActiveTeachers", "getCustomerProductBalances"], "refund");
});

test("teacher NORMAL verification option loads carry the selected storeId", async () => {
  const { page, calls } = loadPage("pages/verification/index.js");
  page.onLoad({ mode: "NORMAL" });
  await settlePageTasks();
  await page.customerConfirmed({ detail: { customer: { customerCode: "C0001", customerName: "测试客户" } } });
  assertScopedCalls(calls, ["listActiveTeachers", "getCustomerProductBalances"], "NORMAL verification");
});

test("teacher EXPERIENCE verification option loads carry the selected storeId", async () => {
  const { page, calls } = loadPage("pages/verification/index.js");
  page.onLoad({ mode: "EXPERIENCE" });
  await settlePageTasks();
  await page.customerConfirmed({ detail: { customer: { customerCode: "C0001", customerName: "测试客户" } } });
  assertScopedCalls(calls, ["listActiveTeachers", "getTeacherExperienceEntitlements"], "EXPERIENCE verification");
});
