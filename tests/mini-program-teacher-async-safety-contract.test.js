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

function pageInstance(definition, overrides = {}) {
  return Object.assign({}, definition, {
    data: { ...clone(definition.data), ...(overrides.data || {}) },
    setData(patch, complete) {
      Object.assign(this.data, patch);
      if (typeof complete === "function") complete.call(this);
    },
    selectComponent: overrides.selectComponent || (() => null)
  }, overrides.methods || {});
}

function componentInstance(definition, overrides = {}) {
  const events = [];
  const instance = Object.assign({}, definition.methods, {
    properties: { storeId: "7", ...(overrides.properties || {}) },
    data: { ...clone(definition.data), ...(overrides.data || {}) },
    setData(patch) { Object.assign(this.data, patch); },
    triggerEvent(name, detail) { events.push({ name, detail }); }
  });
  return { instance, events };
}

function loadCustomerPicker(callFace) {
  let definition;
  vm.runInNewContext(read("components", "customer-picker", "index.js"), {
    Component(value) { definition = value; },
    require(id) {
      if (id === "../../services/api") return { callFace };
      if (id === "../../services/query-tools") return { businessToday: () => "2099-12-31" };
      throw new Error(`unexpected customer-picker dependency ${id}`);
    },
    console, Date, Math, Promise, String, Number
  }, { filename: "components/customer-picker/index.js" });
  assert.ok(definition);
  return definition;
}

function submissionStub() {
  return {
    read: () => null,
    begin: () => ({ clientRequestId: "request" }),
    confirm: () => ({ clientRequestId: "request" }),
    clear() {}, markUncertain() {}, recover: async () => ({ found: false, complete: false })
  };
}

function loadBusinessPage(file, callFace, wxOverrides = {}) {
  let definition;
  vm.runInNewContext(read("pages", file, "index.js"), {
    Page(value) { definition = value; },
    require(id) {
      if (id === "../../services/api") return { callFace };
      if (id === "../../services/session") return { requireSession: () => null, getSelectedStore: () => null };
      if (id === "../../services/submission") return submissionStub();
      if (id === "../../services/ble-verification") {
        return {
          BleVerificationSession: class {},
          readProgress: () => null,
          saveProgress() {}, clearProgress() {},
          retryFinalization: async () => null,
          errorFeedback: (error) => ({ message: String(error && error.message || "蓝牙连接失败"), recoverable: true })
        };
      }
      throw new Error(`unexpected ${file} dependency ${id}`);
    },
    wx: { redirectTo() {}, showModal() {}, reLaunch() {}, ...wxOverrides },
    console, Date, Math, Promise, String, Number, Boolean, encodeURIComponent
  }, { filename: `pages/${file}/index.js` });
  assert.ok(definition);
  return definition;
}

function dashboardStub() {
  return {
    RANGE_OPTIONS: [], HQ_PERIOD_OPTIONS: [], EMPTY_TOTALS: { verification: 0, recharge: 0, experience: 0, refund: 0 },
    TYPE_CONFIG: {
      VERIFICATION: { recordType: "VERIFICATION", verificationType: "NORMAL" },
      RECHARGE: { recordType: "RECHARGE", rechargeType: "NEW" },
      EXPERIENCE: { recordType: "VERIFICATION", verificationType: "EXPERIENCE" },
      REFUND: { recordType: "RECHARGE", rechargeType: "REFUND" }
    },
    tabs: () => [], products: (items = []) => items, totals: (value = {}) => value,
    pageState: (value = {}) => ({ page: Number(value.page || 1), pageSize: Number(value.pageSize || 10), total: Number(value.total || 0), totalPages: Number(value.totalPages || 1) }),
    customerGroup: (value = {}) => ({ records: value.records || [], page: Number(value.page || 1), pageSize: Number(value.pageSize || 10), total: Number(value.total || 0), totalPages: Number(value.totalPages || 1) }),
    count: (value) => Number(value || 0), records: (items = [], type = "VERIFICATION") => items.map((item) => ({ ...item, category: type })), teacherFacts: () => [], scopedRange: () => ({ startDate: "", endDate: "" }),
    payload: () => ({}), periodLabel: () => "", rangeDays: () => 1,
    hqRange: () => ({ startDate: "2026-08-01", endDate: "2026-08-25" }),
    hqChart: () => ({ rows: [], axis: {} }), hqRows: (items = []) => items,
    storeCustomerGroups: () => ({ active: {}, archived: {} }), storeFacts: () => []
  };
}

function loadHome(signOut = async () => {}, callFace = async () => ({}), callStaff = async () => ({})) {
  let definition;
  const launches = [];
  const navigations = [];
  vm.runInNewContext(read("pages", "home", "index.js"), {
    Page(value) { definition = value; },
    require(id) {
      if (id === "../../services/api") return { callFace, callStaff };
      if (id === "../../services/session") {
        return { requireSession: () => null, getSelectedStore: () => ({ id: "stale" }), setSelectedStore() {}, signOut };
      }
      if (id === "../../services/home-dashboard") return dashboardStub();
      if (id === "../../services/hq-dashboard-report") return { createReportPdf: () => ({ bytes: new Uint8Array(), pages: 1 }), safeFilename: () => "report" };
      throw new Error(`unexpected home dependency ${id}`);
    },
    wx: { reLaunch(options) { launches.push(options.url); }, navigateTo(options) { navigations.push(options.url); }, getFileSystemManager: () => ({}) },
    console, Date, Math, Promise, String, Number, Boolean, Object, encodeURIComponent
  }, { filename: "pages/home/index.js" });
  assert.ok(definition);
  return { definition, launches, navigations };
}

test("teacher home enters each business page directly and still returns to login when sign-out fails", async () => {
  const failure = new Error("network failed");
  const { definition, launches, navigations } = loadHome(async () => { throw failure; });
  const page = pageInstance(definition, { data: { session: { role: "teacher" }, businessMenuOpen: true } });
  assert.equal(page.ensureBusinessStore(), true, "teacher chooses the store inside the destination business page");
  page.openCustomerCreate();
  page.openRecharge({ currentTarget: { dataset: { mode: "NEW" } } });
  page.openVerification({ currentTarget: { dataset: { mode: "EXPERIENCE" } } });
  assert.deepEqual(navigations, [
    "/pages/customer-create/index",
    "/pages/recharge/index?mode=NEW",
    "/pages/verification/index?mode=EXPERIENCE"
  ]);
  assert.equal(page.data.businessMenuOpen, false);
  await assert.rejects(page.logout(), failure);
  assert.deepEqual(launches, ["/pages/login/index"]);

  const source = read("pages", "home", "index.js");
  assert.match(source, /_businessRequestEpoch/);
  assert.match(source, /_customerRequestEpoch/);
  assert.doesNotMatch(source, /getTeacherBusinessContext|setSelectedStore|loadingStores|businessContextReady|selectedStore|storeLabels/);
});

test("teacher home loads only workspace and related customers, not the business-store context", async () => {
  const actions = [];
  const { definition } = loadHome(async () => {}, async (action) => {
    actions.push(action);
    if (action === "getTeacherBusinessContext") throw new Error("teacher home must not request business stores");
    if (action === "getTeacherWorkspace") return { profile: {}, summary: { totals: {}, products: [] }, experienceBalances: [], page: { records: [], page: 1, totalPages: 1 } };
    if (action === "getTeacherBusinessCustomers") return { active: {}, archived: {} };
    throw new Error(`unexpected teacher-home action ${action}`);
  });
  const page = pageInstance(definition, { data: { session: { role: "teacher", teacherId: "T-1" } } });
  await page.loadTeacherHome();
  assert.deepEqual(actions.sort(), ["getTeacherBusinessCustomers", "getTeacherWorkspace"]);
  assert.equal(page.data.error, false);
  assert.equal(Object.hasOwn(page.data, "businessContextReady"), false);
});

test("teacher business and customer page epochs reject late older responses", async () => {
  const recharge = deferred();
  const refund = deferred();
  const customers2 = deferred();
  const customers3 = deferred();
  const { definition } = loadHome(async () => {}, async (action, payload) => {
    if (action === "getTeacherWorkspace") return payload.recordType === "RECHARGE" ? recharge.promise : refund.promise;
    if (action === "getTeacherBusinessCustomers") return payload.activePage === 2 ? customers2.promise : customers3.promise;
    throw new Error(`unexpected epoch action ${action}`);
  });
  const page = pageInstance(definition, { data: {
    session: { role: "teacher" }, businessType: "RECHARGE", rangeStart: "", rangeEnd: "",
    businessPage: { page: 1 }, activeCustomers: { page: 1 }, archivedCustomers: { page: 1 }
  } });
  const oldBusiness = page.loadBusinessType(1);
  page.setData({ businessType: "REFUND" });
  const newBusiness = page.loadBusinessType(1);
  refund.resolve({ page: { records: [{ recordCode: "NEW" }], page: 1, totalPages: 1 } });
  await newBusiness;
  recharge.resolve({ page: { records: [{ recordCode: "OLD" }], page: 1, totalPages: 1 } });
  await oldBusiness;
  assert.equal(page.data.businessRecords[0].recordCode, "NEW");

  const oldCustomers = page.loadCustomerPage("ACTIVE", 2);
  const newCustomers = page.loadCustomerPage("ACTIVE", 3);
  customers3.resolve({ active: { records: [{ customerCode: "C-NEW" }], page: 3, totalPages: 3 }, archived: { page: 1, totalPages: 1 } });
  await newCustomers;
  customers2.resolve({ active: { records: [{ customerCode: "C-OLD" }], page: 2, totalPages: 3 }, archived: { page: 1, totalPages: 1 } });
  await oldCustomers;
  assert.equal(page.data.activeCustomers.page, 3);
  assert.equal(page.data.activeCustomers.records[0].customerCode, "C-NEW");
});

test("teacher and store failures clear rows, summaries, pages, and scroll positions from the previous scope", async () => {
  const { definition } = loadHome(async () => {}, async (action) => {
    if (action === "getTeacherBusinessContext") return { stores: [] };
    throw new Error(`${action} unavailable`);
  });
  const page = pageInstance(definition, { data: {
    session: { role: "teacher" }, businessType: "REFUND", profileFacts: [{ label: "旧资料" }],
    experienceBalances: [{ productId: "old" }], summaryRows: [{ productId: "old" }],
    totals: { verification: 9, recharge: 9, experience: 9, refund: 9 },
    businessRecords: [{ id: "old", category: "RECHARGE" }],
    businessPage: { page: 8, total: 80, totalPages: 8 }, businessPageInput: "8", businessScrollLeft: 600,
    activeCustomers: { records: [{ customerCode: "old-active" }], page: 3, totalPages: 3 },
    archivedCustomers: { records: [{ customerCode: "old-archived" }], page: 2, totalPages: 2 },
    activeCustomerScrollLeft: 90, archivedCustomerScrollLeft: 120
  } });
  await page.loadTeacherHome();
  assert.deepEqual(Array.from(page.data.profileFacts), []);
  assert.deepEqual(Array.from(page.data.experienceBalances), []);
  assert.deepEqual(Array.from(page.data.summaryRows), []);
  assert.deepEqual(Array.from(page.data.businessRecords), []);
  assert.equal(page.data.businessPage.page, 1);
  assert.equal(page.data.businessPageInput, "1");
  assert.equal(page.data.businessScrollLeft, 0);
  assert.deepEqual(Array.from(page.data.activeCustomers.records), []);
  assert.deepEqual(Array.from(page.data.archivedCustomers.records), []);
  assert.equal(page.data.activeCustomerScrollLeft, 0);
  assert.equal(page.data.archivedCustomerScrollLeft, 0);

  page.setData({
    session: { role: "store" }, businessType: "REFUND",
    businessRecords: [{ id: "old-store" }], businessPage: { page: 4, totalPages: 4 },
    businessPageInput: "4", businessScrollLeft: 400
  });
  await page.loadBusinessType(4);
  assert.deepEqual(Array.from(page.data.businessRecords), []);
  assert.equal(page.data.businessPage.page, 1);
  assert.equal(page.data.businessPageInput, "1");
  assert.equal(page.data.businessScrollLeft, 0);
  assert.equal(page.data.error, true);
});

test("business page jumps are strict and order links use the row category snapshot", async () => {
  const { definition } = loadHome();
  const page = pageInstance(definition, { methods: {
    loadBusinessType(target) { this.loadedPage = target; return target; }
  }, data: {
    businessPage: { page: 1, totalPages: 5 }, businessPageInput: "6", businessType: "REFUND"
  } });
  page.jumpBusinessPage();
  assert.equal(page.loadedPage, undefined);
  assert.match(page.data.message, /1 至 5/);
  page.setData({ businessPageInput: "4", message: "", error: false });
  assert.equal(page.jumpBusinessPage(), 4);
  assert.equal(page.loadedPage, 4);

  const source = read("pages", "home", "index.js");
  const markup = read("pages", "home", "index.wxml");
  assert.match(source, /const category = String\(event\.currentTarget\.dataset\.category \|\| ""\)\.toUpperCase\(\)/);
  assert.doesNotMatch(source, /dataset\.category \|\| this\.data\.businessType/,
    "an old row must never be reinterpreted using the newly selected tab");
  assert.match(markup, /data-category="\{\{item\.category\}\}"/);
  assert.match(markup, /scroll-left="\{\{businessScrollLeft\}\}"[^>]*bindscroll="rememberBusinessScroll"/);
  assert.match(markup, /bindtap="jumpBusinessPage"/);
});

test("store initial home and HQ ranking reject late responses after a tab or dimension change", async () => {
  const oldStoreRecords = deferred();
  const newStoreRecords = deferred();
  const storeHome = loadHome(async () => {}, async (action, payload) => {
    if (action === "getStoreDashboard") return { store: {} };
    if (action === "getStoreBusinessAnalytics") return { totals: {}, products: [] };
    if (action === "queryStoreBusinessRecords") {
      return payload.recordType === "VERIFICATION" ? oldStoreRecords.promise : newStoreRecords.promise;
    }
    throw new Error(`unexpected store action ${action}`);
  });
  const storePage = pageInstance(storeHome.definition, { data: {
    session: { role: "store" }, businessType: "VERIFICATION",
    activeCustomers: { page: 1 }, archivedCustomers: { page: 1 }, businessPage: { page: 1 }
  } });
  const initialStoreLoad = storePage.loadStoreHome();
  storePage.setData({ businessType: "RECHARGE" });
  const currentStoreLoad = storePage.loadBusinessType(1);
  newStoreRecords.resolve({ records: [{ recordCode: "STORE-NEW" }], page: 1, totalPages: 1 });
  await currentStoreLoad;
  oldStoreRecords.resolve({ records: [{ recordCode: "STORE-OLD" }], page: 1, totalPages: 1 });
  await initialStoreLoad;
  assert.equal(storePage.data.businessRecords[0].recordCode, "STORE-NEW");

  const oldRanking = deferred();
  const newRanking = deferred();
  const hqHome = loadHome(async () => {}, async () => ({}), async (action, payload) => {
    assert.equal(action, "getHqDashboard");
    if (payload.dimension === "store") return oldRanking.promise;
    if (payload.dimension === "teacher") return newRanking.promise;
    throw new Error(`unexpected ranking dimension ${payload.dimension}`);
  });
  const hqPage = pageInstance(hqHome.definition, { data: {
    session: { role: "hq" }, hqDimension: "store", hqPeriod: "MONTH",
    hqRankingPage: { page: 1, totalPages: 1 }
  } });
  const staleRankingLoad = hqPage.loadHqRanking(1);
  hqPage.setData({ hqDimension: "teacher" });
  const currentRankingLoad = hqPage.loadHqRanking(1);
  newRanking.resolve({ ranking: {
    rows: [{ entityId: "T-NEW", name: "新老师", recharge: 1, verification: 2, experience: 0, refund: 0, businessTotal: 3 }],
    dimension: "teacher", rankingMetric: "recharge", productId: "",
    total: 1, pageNumber: 1, pageSize: 100, totalPages: 1, businessTotal: 3, rankingTotal: 1
  } });
  await currentRankingLoad;
  oldRanking.resolve({ ranking: {
    rows: [{ entityId: "S-OLD", name: "旧门店", recharge: 9, verification: 0, experience: 0, refund: 0, businessTotal: 9 }],
    dimension: "store", rankingMetric: "recharge", productId: "",
    total: 1, pageNumber: 1, pageSize: 100, totalPages: 1, businessTotal: 9, rankingTotal: 9
  } });
  await staleRankingLoad;
  assert.equal(hqPage.data.hqRanking[0].entityId, "T-NEW");
});

test("customer picker uses Shanghai date, disambiguates duplicates by code, and ignores stale detail/photo responses", async () => {
  const detailA = deferred();
  const detailB = deferred();
  const definition = loadCustomerPicker(async (action, payload) => {
    if (action === "listActiveStoreCustomers") {
      return { customers: [
        { customerCode: "C-A", customerName: "同名", birthDate: "2000-01-01", storeId: "7" },
        { customerCode: "C-B", customerName: "同名", birthDate: "2000-01-01", storeId: "7" }
      ] };
    }
    if (action === "getActiveStoreCustomerDetail") return payload.customerCode === "C-A" ? detailA.promise : detailB.promise;
    throw new Error(`unexpected picker action ${action}`);
  });
  assert.equal(definition.data.today, "2099-12-31");
  const { instance } = componentInstance(definition, { data: { manualName: "同名", manualBirthday: "2000-01-01" } });
  await instance.manualSearch();
  assert.equal(instance.data.duplicateMatches.length, 2);
  assert.equal(instance.data.candidate, null);

  const [candidateA, candidateB] = instance.data.duplicateMatches;
  const first = instance.loadCandidate(candidateA);
  const second = instance.loadCandidate(candidateB);
  detailB.resolve({ customer: { customerCode: "C-B", customerName: "同名", birthDate: "2000-01-01", storeId: "7" }, photoUrl: "https://example.test/b.jpg" });
  await second;
  detailA.resolve({ customer: { customerCode: "C-A", customerName: "同名", birthDate: "2000-01-01", storeId: "7" }, photoUrl: "https://example.test/a.jpg" });
  await first;
  assert.equal(instance.data.candidate.customerCode, "C-B");
  assert.equal(instance.data.photoUrl, "https://example.test/b.jpg");
  instance.photoLoaded({ currentTarget: { dataset: { customerCode: "C-A", photoUrl: "https://example.test/a.jpg" } } });
  assert.equal(instance.data.photoReady, false, "an old image load event must be ignored");
  instance.photoLoaded({ currentTarget: { dataset: { customerCode: "C-B", photoUrl: "https://example.test/b.jpg" } } });
  assert.equal(instance.data.photoReady, true);

  const markup = read("components", "customer-picker", "index.wxml");
  assert.match(markup, /duplicateMatches/);
  assert.match(markup, /data-code="\{\{item\.customerCode\}\}"/);
});

test("customer picker preserves a failed candidate so its photo can be retried", async () => {
  let attempts = 0;
  const definition = loadCustomerPicker(async (action, payload) => {
    assert.equal(action, "getActiveStoreCustomerDetail");
    attempts += 1;
    if (attempts === 1) throw new Error("temporary URL failed");
    return { customer: { customerCode: payload.customerCode, customerName: "客户", birthDate: "2001-01-01", storeId: "7" }, photoUrl: "https://example.test/retry.jpg" };
  });
  const { instance } = componentInstance(definition);
  await instance.loadCandidate({ customerCode: "C-1", customerName: "客户", birthDate: "2001-01-01", storeId: "7" });
  assert.equal(instance.data.candidate.customerCode, "C-1");
  assert.equal(instance.data.error, true);
  await instance.retryPhoto();
  assert.equal(attempts, 2);
  assert.equal(instance.data.candidate.customerCode, "C-1");
  assert.equal(instance.data.photoUrl, "https://example.test/retry.jpg");
});

test("refund balance requests cannot overwrite the newly selected customer", async () => {
  const balancesA = deferred();
  const balancesB = deferred();
  const definition = loadBusinessPage("recharge", async (action, payload) => {
    assert.equal(action, "getCustomerProductBalances");
    return payload.customerCode === "C-A" ? balancesA.promise : balancesB.promise;
  });
  const page = pageInstance(definition, { data: {
    refund: true, store: { id: "7" }, session: { role: "teacher" }, selectedTeacher: { teacherId: "T-1" },
    customer: { customerCode: "C-A", customerName: "甲" }
  } });
  const first = page.loadProducts("C-A");
  page.setData({ customer: { customerCode: "C-B", customerName: "乙" } });
  const second = page.loadProducts("C-B");
  balancesB.resolve({ balances: [{ productId: "P-B", productCode: "PB", productName: "乙项目", purchasedCount: 2, remainingCount: 2 }] });
  await second;
  balancesA.resolve({ balances: [{ productId: "P-A", productCode: "PA", productName: "甲项目", purchasedCount: 9, remainingCount: 9 }] });
  await first;
  assert.deepEqual(Array.from(page.data.products, (item) => item.productId), ["P-B"]);

  page.openSubmittedOrder({}, {});
  assert.match(page.data.message, /我的工作台/);
  assert.match(page.data.message, /退费/);
  assert.doesNotMatch(page.data.message, /请从充值查询进入/);
});

test("recharge and verification explain when the signed-in teacher is not eligible at the store", async () => {
  for (const file of ["recharge", "verification"]) {
    const definition = loadBusinessPage(file, async (action) => {
      assert.equal(action, "listActiveTeachers");
      return { teachers: [] };
    });
    const page = pageInstance(definition, { data: {
      store: { id: "7" }, session: { role: "teacher", teacherId: "T-MISSING" }
    } });
    await page.loadTeachers();
    assert.equal(page.data.teacherOptionsReady, true);
    assert.equal(page.data.selectedTeacher, null);
    assert.equal(page.data.error, true);
    assert.match(page.data.message, /当前老师不在该门店/);
    assert.match(page.data.message, /禁止/);
  }
});

test("verification balance and face requests cannot cross customer selections", async () => {
  const balancesA = deferred();
  const balancesB = deferred();
  const facesA = deferred();
  const facesB = deferred();
  const definition = loadBusinessPage("verification", async (action, payload) => {
    if (action === "getCustomerProductBalances") return payload.customerCode === "C-A" ? balancesA.promise : balancesB.promise;
    if (action === "verifyCustomerFace") return payload.customerCode === "C-A" ? facesA.promise : facesB.promise;
    throw new Error(`unexpected verification action ${action}`);
  });
  const camera = { reset() {}, getCapture: () => ({ imageBase64: "image", thumbnailBase64: "thumb", imageWidth: 10, imageHeight: 10 }) };
  const page = pageInstance(definition, {
    data: {
      experience: false, store: { id: "7" }, session: { role: "teacher" },
      selectedTeacher: { teacherId: "T-1" }, customer: { customerCode: "C-A", customerName: "甲" }
    },
    selectComponent: () => camera
  });
  const firstBalance = page.loadProducts();
  page.setData({ customer: { customerCode: "C-B", customerName: "乙" } });
  const secondBalance = page.loadProducts();
  balancesB.resolve({ balances: [{ productId: "P-B", productCode: "PB", productName: "乙项目", remainingCount: 2 }] });
  await secondBalance;
  balancesA.resolve({ balances: [{ productId: "P-A", productCode: "PA", productName: "甲项目", remainingCount: 9 }] });
  await firstBalance;
  assert.deepEqual(Array.from(page.data.products, (item) => item.productId), ["P-B"]);

  page.setData({ selectedProduct: page.data.products[0], unitCount: "1", unitCountMax: 2, unitCountValid: true, captureReady: true });
  const firstFace = page.verifyFace();
  page.setData({ customer: { customerCode: "C-A", customerName: "甲" } });
  page.resetFace(false);
  page.setData({ selectedProduct: { productId: "P-A", productName: "甲项目" }, unitCount: "1", unitCountMax: 9, unitCountValid: true, captureReady: true });
  const secondFace = page.verifyFace();
  facesA.resolve({ matched: true, requestId: "request-a", faceEvidenceToken: "a".repeat(48), score: 90 });
  await secondFace;
  facesB.resolve({ matched: true, requestId: "request-b", faceEvidenceToken: "b".repeat(48), score: 99 });
  await firstFace;
  assert.equal(page.data.faceRequestId, "request-a");
  assert.equal(page.data.faceEvidenceToken, "a".repeat(48));

  page.openSubmittedOrder({}, {});
  assert.match(page.data.message, /我的工作台/);
  assert.match(page.data.message, /核销/);
  assert.doesNotMatch(page.data.message, /请从核销查询进入/);
});

test("customer creation limits match the Web form and use Shanghai business date", () => {
  const script = read("pages", "customer-create", "index.js");
  const markup = read("pages", "customer-create", "index.wxml");
  assert.match(script, /businessToday\(\)/);
  assert.match(markup, /maxlength="40"/);
  assert.match(markup, /maxlength="500"/);
  assert.doesNotMatch(markup, /maxlength="(?:100|1000)"/);
});
