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

function pageInstance(definition) {
  return Object.assign({}, definition, {
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch, complete) {
      Object.assign(this.data, patch);
      if (typeof complete === "function") complete.call(this);
    }
  });
}

test("app exposes one startup promise and marks validation ready even when a stale session is rejected", async () => {
  const validation = deferred();
  let definition;
  vm.runInNewContext(read("app.js"), {
    App(value) { definition = value; },
    require(id) {
      if (id === "./services/session") return { restoreAndValidateSession: () => validation.promise };
      throw new Error(`unexpected app dependency ${id}`);
    },
    Promise
  }, { filename: "app.js" });

  const app = Object.assign({}, definition, { globalData: { ...definition.globalData } });
  const started = app.onLaunch();
  assert.equal(app.globalData.startupReady, false);
  assert.equal(app.globalData.startupPromise, started);
  assert.equal(typeof started.then, "function");

  validation.reject(new Error("cached business identity was revoked"));
  const session = await started;
  assert.equal(session, null);
  assert.equal(app.globalData.session, null);
  assert.equal(app.globalData.startupReady, true);
});

function loadLogin(waitForStartupSession) {
  let definition;
  const launches = [];
  let passwordLogins = 0;
  vm.runInNewContext(read("pages", "login", "index.js"), {
    Page(value) { definition = value; },
    require(id) {
      if (id === "../../services/session") return {
        waitForStartupSession,
        passwordLogin: async () => { passwordLogins += 1; return {}; },
        wechatPhoneLogin: async () => ({})
      };
      if (id === "../../services/wechat-phone") return {
        authorizationFailureMessage: () => "微信手机号授权失败",
        loginFailureMessage: () => "微信手机号登录失败"
      };
      throw new Error(`unexpected login dependency ${id}`);
    },
    wx: { reLaunch({ url }) { launches.push(url); }, navigateTo() {} },
    Promise, Number, String, encodeURIComponent
  }, { filename: "pages/login/index.js" });
  return { page: pageInstance(definition), launches, passwordLoginCount: () => passwordLogins };
}

test("login never routes a stale cached identity before authoritative startup validation", async () => {
  const validation = deferred();
  const { page, launches, passwordLoginCount } = loadLogin(() => validation.promise);

  const showing = page.onShow();
  assert.equal(page.data.startupChecking, true);
  assert.deepEqual(launches, [], "the stale cache must not briefly open home while validation is pending");
  await page.submit();
  assert.equal(passwordLoginCount(), 0, "a second login must not race the startup restore");

  validation.resolve(null);
  await showing;
  assert.equal(page.data.startupChecking, false);
  assert.deepEqual(launches, [], "a rejected cached identity must remain on login");

  const valid = loadLogin(async () => ({ uid: "valid", role: "store", storeId: "7" }));
  await valid.page.onShow();
  assert.deepEqual(valid.launches, ["/pages/home/index"]);
});

function loadHome(waitForStartupSession, requireSession) {
  let definition;
  const scrolls = [];
  const dashboard = require(path.join(mini, "services", "home-dashboard.js"));
  vm.runInNewContext(read("pages", "home", "index.js"), {
    Page(value) { definition = value; },
    require(id) {
      if (id === "../../services/api") return { callFace: async () => ({}), callStaff: async () => ({}) };
      if (id === "../../services/session") return {
        waitForStartupSession, requireSession, getSelectedStore: () => null,
        setSelectedStore() {}, signOut: async () => {}
      };
      if (id === "../../services/home-dashboard") return dashboard;
      if (id === "../../services/hq-dashboard-report") return { createReportPdf: () => ({ bytes: new Uint8Array(), pages: 1 }), safeFilename: () => "report" };
      throw new Error(`unexpected home dependency ${id}`);
    },
    wx: {
      pageScrollTo(options) { scrolls.push(options); },
      navigateTo() {}, reLaunch() {}, getFileSystemManager: () => ({})
    },
    console, Date, Math, Promise, String, Number, Boolean, Object, encodeURIComponent
  }, { filename: "pages/home/index.js" });
  return { page: pageInstance(definition), scrolls };
}

test("home waits for startup validation and store section links perform real page scrolling", async () => {
  const validation = deferred();
  let guardCalls = 0;
  const { page, scrolls } = loadHome(
    () => validation.promise,
    () => { guardCalls += 1; return null; }
  );

  const showing = page.onShow();
  assert.equal(guardCalls, 0, "home must not trust cached role/store data before validation finishes");
  validation.resolve(null);
  await showing;
  assert.equal(guardCalls, 1);

  page.jumpToSection({ currentTarget: { dataset: { target: "#business-records" } } });
  assert.deepEqual(JSON.parse(JSON.stringify(scrolls)), [{ selector: "#business-records", duration: 220 }]);
  page.jumpToSection({ currentTarget: { dataset: { target: "not-a-selector" } } });
  assert.equal(scrolls.length, 1, "only declared page selectors may be scrolled to");

  const wxml = read("pages", "home", "index.wxml");
  for (const id of ["business-summary", "business-records", "active-customers", "archived-customers"]) {
    assert.match(wxml, new RegExp(`id="${id}"`));
    assert.match(wxml, new RegExp(`data-target="#${id}"[^>]*bindtap="jumpToSection"`));
  }
  const wxss = read("pages", "home", "index.wxss");
  assert.match(wxss, /\.summary-table, \.record-table, \.customer-table \{ width: auto; min-width: 100%; display: inline-table; table-layout: auto;/,
    "home tables must fit the viewport first and expand only for real content");
});

test("synchronous deep-link guards fail closed until startup and never fall back to stale storage when app state exists", () => {
  const stale = { uid: "stale", role: "store", storeId: "old-store" };
  const app = { globalData: { startupReady: false, session: null } };
  const launches = [];
  const sandbox = {
    module: { exports: {} },
    exports: {},
    getApp: () => app,
    require(id) {
      if (id === "./cloudbase") return { getAuth: () => ({}) };
      if (id === "./api") return { callStaff: async () => ({}) };
      throw new Error(`unexpected session dependency ${id}`);
    },
    wx: {
      getStorageSync: () => stale,
      setStorageSync() {}, removeStorageSync() {},
      reLaunch({ url }) { launches.push(url); }, showToast() {}
    },
    console, Date, Promise, Set, String, Number, Math
  };
  vm.runInNewContext(read("services", "session.js"), sandbox, { filename: "services/session.js" });
  const api = sandbox.module.exports;

  assert.equal(api.requireSession(["store"]), null);
  assert.deepEqual(launches, ["/pages/login/index"], "a pending restore must reject a stale deep-link cache");

  app.globalData.startupReady = true;
  assert.equal(api.requireSession(["store"]), null);
  assert.equal(launches.length, 2, "validated app state must stay authoritative over stale storage");

  const validated = { uid: "valid", role: "store", storeId: "current-store" };
  app.globalData.session = validated;
  assert.equal(api.requireSession(["store"]), validated);
  assert.equal(launches.length, 2);
});
