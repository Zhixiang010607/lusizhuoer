"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const mini = path.join(root, "miniprogram-app", "miniprogram");

function pageSource(relativeFile) {
  return fs.readFileSync(path.join(mini, relativeFile), "utf8");
}

function instantiate(relativeFile, dependencies = {}) {
  let definition = null;
  const sandbox = {
    Page(value) { definition = value; },
    require(id) {
      if (Object.prototype.hasOwnProperty.call(dependencies, id)) return dependencies[id];
      throw new Error(`unexpected dependency ${id}`);
    },
    wx: dependencies.wx || {},
    console, Date, Math, Promise, String, Number, Boolean, encodeURIComponent, decodeURIComponent
  };
  vm.runInNewContext(pageSource(relativeFile), sandbox, { filename: relativeFile });
  assert.ok(definition, `${relativeFile} must register a Page`);
  const page = Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { Object.assign(this.data, patch); },
    selectComponent: dependencies.selectComponent || (() => null)
  });
  return page;
}

function submissionStub() {
  return {
    read: () => null,
    begin: () => ({ clientRequestId: "request_12345678" }),
    confirm: () => ({ clientRequestId: "request_12345678" }),
    markUncertain() {}, clear() {},
    recover: async () => ({ found: false, complete: false })
  };
}

function businessPage(relativeFile) {
  return instantiate(relativeFile, {
    "../../services/api": { callFace: async () => ({}) },
    "../../services/session": { requireSession: () => null, getSelectedStore: () => null },
    "../../services/submission": submissionStub(),
    "../../services/ble-verification": {
      BleVerificationSession: class {},
      readProgress: () => null,
      saveProgress() {}, clearProgress() {},
      retryFinalization: async () => null,
      errorFeedback: (error) => ({ message: String(error && error.message || "蓝牙连接失败"), recoverable: true })
    },
    wx: { reLaunch() {}, redirectTo() {}, showModal() {} }
  });
}

test("recharge and refund customer changes clear all customer-specific form state", async () => {
  for (const refund of [false, true]) {
    const page = businessPage("pages/recharge/index.js");
    const oldProduct = { productId: "P1", purchasedCount: 20 };
    page.data = {
      ...page.data,
      session: { role: "store" }, refund,
      customer: { customerCode: "OLD", customerName: "旧客户" },
      products: [oldProduct], productLabels: ["旧项目"], selectedProduct: oldProduct, productIndex: 0,
      selectedTeacher: { teacherId: "", teacherName: "不指定业务老师" },
      unitCount: "9", note: "只属于旧客户", ready: true, message: "旧提示", error: true,
      loadingOptions: false
    };

    page.customerChanged();

    assert.equal(page.data.customer, null);
    assert.equal(page.data.selectedProduct, null);
    assert.equal(page.data.productIndex, -1);
    assert.equal(page.data.unitCount, "");
    assert.equal(page.data.note, "");
    assert.equal(page.data.ready, false);
    assert.equal(page.data.message, "");
    assert.equal(page.data.error, false);
    if (refund) assert.equal(page.data.products.length, 0, "refund products belong to the previous customer");
  }

  const confirmed = businessPage("pages/recharge/index.js");
  confirmed.data = {
    ...confirmed.data,
    session: { role: "store" }, refund: false,
    products: [{ productId: "P1" }], productLabels: ["项目"],
    selectedProduct: { productId: "P1" }, productIndex: 0,
    selectedTeacher: { teacherId: "", teacherName: "不指定业务老师" },
    unitCount: "11", note: "旧客户留言", ready: true
  };
  await confirmed.customerConfirmed({ detail: { customer: { customerCode: "NEW", customerName: "新客户" } } });
  assert.equal(confirmed.data.customer.customerCode, "NEW");
  assert.equal(confirmed.data.selectedProduct, null);
  assert.equal(confirmed.data.unitCount, "");
  assert.equal(confirmed.data.note, "");
  assert.equal(confirmed.data.ready, false);
});

test("store verification customer changes clear teacher, project, note, camera, and face evidence", async () => {
  let cameraResetCount = 0;
  const page = instantiate("pages/verification/index.js", {
    "../../services/api": { callFace: async () => ({}) },
    "../../services/session": { requireSession: () => null, getSelectedStore: () => null },
    "../../services/submission": submissionStub(),
    "../../services/ble-verification": {
      BleVerificationSession: class {},
      readProgress: () => null,
      saveProgress() {}, clearProgress() {},
      retryFinalization: async () => null,
      errorFeedback: (error) => ({ message: String(error && error.message || "蓝牙连接失败"), recoverable: true })
    },
    selectComponent: () => ({ reset() { cameraResetCount += 1; } }),
    wx: { reLaunch() {}, redirectTo() {}, showModal() {} }
  });
  page.data = {
    ...page.data,
    session: { role: "store" },
    customer: { customerCode: "OLD", customerName: "旧客户" },
    teachers: [{ teacherId: "T1" }], teacherLabels: ["老师"], teacherIndex: 0, selectedTeacher: { teacherId: "T1" },
    products: [{ productId: "P1" }], productLabels: ["项目"], productIndex: 0, selectedProduct: { productId: "P1" },
    note: "旧客户核销留言", captureReady: true, faceVerified: true,
    faceRequestId: "face_old", faceEvidenceToken: "a".repeat(48), faceMessage: "已通过", faceError: false,
    verifying: true, ready: true, loadingOptions: true, message: "旧提示", error: true
  };

  page.customerChanged();

  assert.equal(page.data.customer, null);
  assert.equal(page.data.selectedTeacher, null);
  assert.equal(page.data.teacherIndex, -1);
  assert.equal(page.data.selectedProduct, null);
  assert.equal(page.data.productIndex, -1);
  assert.equal(page.data.note, "");
  assert.equal(page.data.captureReady, false);
  assert.equal(page.data.faceVerified, false);
  assert.equal(page.data.faceRequestId, "");
  assert.equal(page.data.faceEvidenceToken, "");
  assert.equal(page.data.verifying, false);
  assert.equal(page.data.ready, false);
  assert.equal(page.data.loadingOptions, false);
  assert.equal(page.data.message, "");
  assert.equal(page.data.error, false);
  assert.equal(cameraResetCount, 1);

  page.loadProducts = async () => {};
  page.data.selectedTeacher = { teacherId: "T2" };
  page.data.teacherIndex = 0;
  page.data.selectedProduct = { productId: "P2" };
  page.data.productIndex = 0;
  page.data.note = "仍不应继承";
  page.data.captureReady = true;
  page.data.faceVerified = true;
  page.data.faceRequestId = "face_again";
  page.data.faceEvidenceToken = "b".repeat(48);
  page.data.ready = true;
  await page.customerConfirmed({ detail: { customer: { customerCode: "NEW", customerName: "新客户" } } });
  assert.equal(page.data.customer.customerCode, "NEW");
  assert.equal(page.data.selectedTeacher, null);
  assert.equal(page.data.selectedProduct, null);
  assert.equal(page.data.note, "");
  assert.equal(page.data.captureReady, false);
  assert.equal(page.data.faceEvidenceToken, "");
  assert.equal(page.data.ready, false);

  const source = pageSource("pages/verification/index.js");
  assert.doesNotMatch(source, /已审核核销/, "normal and experience verification complete immediately without review");
  assert.match(source, /设备已进入工作状态/,
    "verification completion must be gated by the device entering working state");
});

function customerCreatePage(registerResult, redirects) {
  const camera = {
    getCapture: () => ({ imageBase64: "data:image/jpeg;base64,ZmFrZQ==" }),
    reset() {}
  };
  return instantiate("pages/customer-create/index.js", {
    "../../services/api": {
      async callFace(action) {
        if (action === "validateCapture") return { ok: true };
        if (action === "registerCustomer") return registerResult;
        throw new Error(`unexpected action ${action}`);
      }
    },
    "../../services/session": { requireSession: () => null, getSelectedStore: () => null },
    "../../services/query-tools": { businessToday: () => "2026-08-25" },
    selectComponent: () => camera,
    wx: { redirectTo({ url }) { redirects.push(url); }, reLaunch() {} }
  });
}

test("customer creation never redirects without all three persisted readback fields", async () => {
  for (const customer of [
    { customerCode: "", facePersonId: "FACE1", photoFileId: "pg://bucket/photo.jpg" },
    { customerCode: "C1", facePersonId: "", photoFileId: "pg://bucket/photo.jpg" },
    { customerCode: "C1", facePersonId: "FACE1", photoFileId: "" }
  ]) {
    const redirects = [];
    const page = customerCreatePage({ ok: true, customer }, redirects);
    page.data = {
      ...page.data,
      store: { id: "7" }, name: "测试客户", birthDate: "2001-06-07",
      notes: "", consent: true, captureReady: true
    };
    await page.submit();
    assert.deepEqual(redirects, [], "an incomplete persistence proof must not open the customer profile");
    assert.equal(page.data.error, true);
    assert.match(page.data.message, /客户编号、人脸标识和照片引用/);
  }

  const redirects = [];
  const page = customerCreatePage({
    ok: true,
    customer: { customerCode: "C1", facePersonId: "FACE1", photoFileId: "pg://bucket/photo.jpg" }
  }, redirects);
  page.data = {
    ...page.data,
    store: { id: "7" }, name: "测试客户", birthDate: "2001-06-07",
    notes: "", consent: true, captureReady: true
  };
  await page.submit();
  assert.deepEqual(redirects, ["/pages/customer-detail/index?customerCode=C1"]);
});

test("record queries reset horizontal scroll and keep order codes inside their own cells", async () => {
  const queryTools = require(path.join(mini, "services", "query-tools.js"));
  const page = instantiate("pages/records/index.js", {
    "../../services/api": {
      callStaff: async () => ({ stores: [] }),
      callFace: async () => ({
        records: [{ id: "1", recordCode: "RC202608250001", originalType: "NEW", recordStatus: "PENDING" }],
        products: [], summary: { total: 1, pending: 1, approved: 0, rejected: 0 },
        page: 2, total: 21, totalPages: 2
      })
    },
    "../../services/session": { requireSession: () => null },
    "../../services/query-tools": queryTools,
    wx: { navigateTo() {} }
  });
  page.data = { ...page.data, session: { role: "store" }, tableScrollLeft: 720, page: 1, totalPages: 2 };

  await page.load(2);
  assert.equal(page.data.tableScrollLeft, 0);
  assert.equal(page.data.page, 2);

  page.data.tableScrollLeft = 640;
  page.resetQuery();
  assert.equal(page.data.tableScrollLeft, 0, "reset must return the table to its first column immediately");
  assert.equal(page.data.timeValues[page.data.timeIndex], "TODAY");
  assert.equal(page.data.startDate, queryTools.businessToday());
  assert.equal(page.data.endDate, queryTools.businessToday());

  const wxml = pageSource("pages/records/index.wxml");
  const wxss = pageSource("pages/records/index.wxss");
  assert.match(wxml, /scroll-left="\{\{tableScrollLeft\}\}"/);
  assert.match(wxss, /\.record-table, \.verification-table, \.product-purchase-table \{ width: auto; min-width: 100%; display: inline-table; table-layout: auto;/,
    "business result columns must adapt to their content instead of using a fixed clipped width");
  assert.match(wxss, /\.record-row text \{[^}]*display:\s*table-cell;[^}]*white-space:\s*nowrap;/,
    "business result values must stay readable on one line and use horizontal scrolling when needed");
});
