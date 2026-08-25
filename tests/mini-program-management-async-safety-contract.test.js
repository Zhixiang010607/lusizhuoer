"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const mini = path.join(root, "miniprogram-app", "miniprogram");
const read = (...parts) => fs.readFileSync(path.join(mini, ...parts), "utf8");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function pageInstance(definition, data = {}) {
  return Object.assign({}, definition, {
    data: { ...clone(definition.data), ...data },
    setData(patch, complete) {
      Object.assign(this.data, patch);
      if (typeof complete === "function") complete.call(this);
    }
  });
}

function loadPage(pageName, dependencies) {
  let definition;
  vm.runInNewContext(read("pages", pageName, "index.js"), {
    Page(value) { definition = value; },
    require(id) {
      if (Object.prototype.hasOwnProperty.call(dependencies, id)) return dependencies[id];
      throw new Error(`unexpected ${pageName} dependency ${id}`);
    },
    wx: {
      setNavigationBarTitle() {}, stopPullDownRefresh() {}, redirectTo() {}, navigateTo() {}, navigateBack() {},
      showModal(options) { options.success({ confirm: true }); }
    },
    console, Date, Math, Promise, String, Number, Boolean, Object, Array, Set, Map,
    encodeURIComponent, decodeURIComponent
  }, { filename: `pages/${pageName}/index.js` });
  assert.ok(definition);
  return definition;
}

function dashboardStub() {
  return {
    RANGE_OPTIONS: [], EMPTY_TOTALS: { verification: 0, recharge: 0, experience: 0, refund: 0 },
    TYPE_CONFIG: {
      VERIFICATION: { recordType: "VERIFICATION", verificationType: "NORMAL" },
      RECHARGE: { recordType: "RECHARGE", rechargeType: "NEW" },
      EXPERIENCE: { recordType: "VERIFICATION", verificationType: "EXPERIENCE" },
      REFUND: { recordType: "RECHARGE", rechargeType: "REFUND" }
    },
    pageState(source = {}) {
      return { page: Number(source.page || 1), pageSize: Number(source.pageSize || 10), total: Number(source.total || 0), totalPages: Number(source.totalPages || 1) };
    },
    customerGroup(source = {}) {
      return { records: source.records || [], page: Number(source.page || 1), pageSize: Number(source.pageSize || 10), total: Number(source.total || 0), totalPages: Number(source.totalPages || 1) };
    },
    products(items = []) { return items; },
    totals(value = {}) { return { verification: 0, recharge: 0, experience: 0, refund: 0, ...value }; },
    tabs(totals, active) { return [{ type: active, count: totals && totals[active.toLowerCase()] || 0 }]; },
    scopedRange(preset, dates) { return { startDate: dates.startDate || "2026-08-01", endDate: dates.endDate || "2026-08-25" }; },
    rangeDays() { return 25; },
    payload(startDate, endDate) { return { startDate, endDate }; },
    storeCustomerGroups(store = {}) {
      return { active: this.customerGroup(store.activeCustomers), archived: this.customerGroup(store.archivedCustomers) };
    },
    storeFacts() { return []; },
    records(items = []) { return items; }
  };
}

test("directory and product list keep the newest refresh and ignore post-unload responses", async () => {
  const directoryOld = deferred();
  const directoryNew = deferred();
  let directoryCalls = 0;
  const directoryDefinition = loadPage("hq-directory", {
    "../../services/api": { callStaff: async (action, payload) => {
      assert.equal(action, "listStores");
      assert.ok(Object.isFrozen(payload));
      directoryCalls += 1;
      return directoryCalls === 1 ? directoryOld.promise : directoryNew.promise;
    } },
    "../../services/session": { requireSession: () => ({ role: "hq" }) }
  });
  const directory = pageInstance(directoryDefinition, { type: "store", noun: "门店" });
  const firstDirectory = directory.load();
  const secondDirectory = directory.load();
  directoryNew.resolve({ stores: [{ id: 2, store_name: "新门店" }] });
  await secondDirectory;
  directoryOld.resolve({ stores: [{ id: 1, store_name: "旧门店" }] });
  await firstDirectory;
  assert.equal(directory.data.rows[0].name, "新门店");

  const productOld = deferred();
  const productNew = deferred();
  const productAfterUnload = deferred();
  const productRequests = [productOld, productNew, productAfterUnload];
  let productCalls = 0;
  const productDefinition = loadPage("product-management", {
    "../../services/api": { callStaff: async () => {
      const request = productRequests[productCalls];
      productCalls += 1;
      return request.promise;
    } },
    "../../services/session": { requireSession: () => ({ role: "hq" }) }
  });
  const products = pageInstance(productDefinition);
  const firstProducts = products.load();
  const secondProducts = products.load();
  productNew.resolve({ products: [{ id: 2, product_name: "新产品" }] });
  await secondProducts;
  productOld.resolve({ products: [{ id: 1, product_name: "旧产品" }] });
  await firstProducts;
  assert.equal(products.data.products[0].name, "新产品");

  const unloadedProducts = products.load();
  products.onUnload();
  productAfterUnload.resolve({ products: [{ id: 3, product_name: "卸载后产品" }] });
  await unloadedProducts;
  assert.equal(products.data.products[0].name, "新产品");
});

test("store detail isolates a full refresh, business tab changes, and each customer pager", async () => {
  const dashboard = dashboardStub();
  const oldRecords = deferred();
  const newRecords = deferred();
  const activePage2 = deferred();
  const activePage3 = deferred();
  const definition = loadPage("store-detail", {
    "../../services/api": {
      callStaff: async () => ({ stores: [] }),
      callFace: async (action, payload) => {
        assert.ok(Object.isFrozen(payload));
        if (action === "getStoreBusinessAnalytics") return { totals: {}, products: [] };
        if (action === "queryStoreBusinessRecords") return payload.recordType === "VERIFICATION" ? oldRecords.promise : newRecords.promise;
        if (action === "getStoreDashboard") {
          if (payload.activeCustomerPage === 2) return activePage2.promise;
          if (payload.activeCustomerPage === 3) return activePage3.promise;
          return { store: { id: "7", store_name: "门店", activeCustomers: {}, archivedCustomers: {} } };
        }
        throw new Error(`unexpected store action ${action}`);
      }
    },
    "../../services/session": { requireSession: () => ({ role: "hq" }) },
    "../../services/home-dashboard": dashboard
  });
  const page = pageInstance(definition, {
    storeRef: "7", storeId: "7", account: { id: "7", store_name: "门店" }, businessType: "VERIFICATION",
    businessPage: { page: 1, totalPages: 1 }, activeCustomers: { page: 1, totalPages: 3 }, archivedCustomers: { page: 1, totalPages: 1 }
  });

  const fullRefresh = page.load();
  page.setData({ businessType: "RECHARGE" });
  const currentBusiness = page.loadBusinessPage(1);
  newRecords.resolve({ records: [{ recordCode: "NEW" }], page: 1, totalPages: 1 });
  await currentBusiness;
  oldRecords.reject(new Error("stale record failure"));
  await fullRefresh;
  assert.equal(page.data.businessRecords[0].recordCode, "NEW");
  assert.equal(page.data.error, false, "a stale record failure must not poison the current tab");

  const oldCustomers = page.loadCustomerPage("ACTIVE", 2);
  const newCustomers = page.loadCustomerPage("ACTIVE", 3);
  activePage3.resolve({ store: { activeCustomers: { records: [{ customerCode: "C-NEW" }], page: 3, totalPages: 3 }, archivedCustomers: {} } });
  await newCustomers;
  activePage2.resolve({ store: { activeCustomers: { records: [{ customerCode: "C-OLD" }], page: 2, totalPages: 3 }, archivedCustomers: {} } });
  await oldCustomers;
  assert.equal(page.data.activeCustomers.page, 3);
  assert.equal(page.data.activeCustomers.records[0].customerCode, "C-NEW");
});

test("teacher experience reads reject late data, clear a current failure, and stop after unload", async () => {
  const oldExperience = deferred();
  const newExperience = deferred();
  const failedExperience = deferred();
  const unloadedExperience = deferred();
  let calls = 0;
  const definition = loadPage("teacher-detail", {
    "../../services/api": { callStaff: async (action, payload) => {
      assert.equal(action, "getTeacherExperienceEntitlements");
      assert.ok(Object.isFrozen(payload));
      calls += 1;
      return [oldExperience, newExperience, failedExperience, unloadedExperience][calls - 1].promise;
    } },
    "../../services/session": { requireSession: () => ({ role: "hq" }) }
  });
  const page = pageInstance(definition, {
    teacherId: "9", products: [
      { id: "1", product_name: "旧产品", product_status: "ACTIVE" },
      { id: "2", product_name: "新产品", product_status: "ACTIVE" }
    ]
  });

  const first = page.loadExperience();
  const second = page.loadExperience();
  newExperience.resolve({ entitlements: [{ product_id: "2", product_name: "新产品", available_count: 8 }] });
  await second;
  oldExperience.resolve({ entitlements: [{ product_id: "1", product_name: "旧产品", available_count: 1 }] });
  await first;
  assert.equal(page.data.entitlements[0].productId, "2");
  assert.equal(page.data.entitlements[0].availableCount, 8);

  const failed = page.loadExperience();
  failedExperience.reject(new Error("temporary failure"));
  await assert.rejects(failed, /temporary failure/);
  assert.equal(page.data.entitlements.length, 0, "a current failed query must not leave the previous teacher quota visible");

  page.setData({ entitlements: [{ productId: "sentinel" }] });
  const afterUnload = page.loadExperience();
  page.onUnload();
  unloadedExperience.resolve({ entitlements: [{ product_id: "1", product_name: "卸载后数据" }] });
  await afterUnload;
  assert.equal(page.data.entitlements[0].productId, "sentinel");
});

test("all four management pages declare unload invalidation and immutable request snapshots", () => {
  for (const page of ["hq-directory", "product-management", "store-detail", "teacher-detail"]) {
    const source = read("pages", page, "index.js");
    assert.match(source, /onUnload\(\)/, `${page} must invalidate requests on unload`);
    assert.match(source, /Object\.freeze\(/, `${page} must capture immutable request data`);
    assert.match(source, /RequestEpoch|_requestEpoch/, `${page} must use request epochs`);
  }
});
