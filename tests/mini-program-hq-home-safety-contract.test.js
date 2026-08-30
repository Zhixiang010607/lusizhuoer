"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const mini = path.join(root, "miniprogram-app", "miniprogram");
const read = (...parts) => fs.readFileSync(path.join(mini, ...parts), "utf8");
const dashboard = require(path.join(mini, "services", "home-dashboard.js"));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function loadHome(callStaff) {
  let definition;
  vm.runInNewContext(read("pages", "home", "index.js"), {
    Page(value) { definition = value; },
    require(id) {
      if (id === "../../services/api") return { callFace: async () => ({}), callStaff };
      if (id === "../../services/session") {
        return { requireSession: () => null, getSelectedStore: () => null, setSelectedStore() {}, signOut: async () => {} };
      }
      if (id === "../../services/home-dashboard") return dashboard;
      if (id === "../../services/hq-dashboard-report") return { createReportPdf: () => ({ bytes: new Uint8Array(), pages: 1 }), safeFilename: () => "report" };
      throw new Error(`unexpected home dependency ${id}`);
    },
    wx: { navigateTo() {}, reLaunch() {}, getFileSystemManager: () => ({}) },
    console, Date, Math, Promise, String, Number, Boolean, Object, encodeURIComponent
  }, { filename: "pages/home/index.js" });
  assert.ok(definition);
  return Object.assign({}, definition, {
    data: clone(definition.data),
    setData(patch, complete) {
      Object.assign(this.data, patch);
      if (typeof complete === "function") complete.call(this);
    }
  });
}

test("HQ time periods exactly reuse the store and teacher range menu", () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-08-25T03:00:00.000Z");
  try {
    assert.deepEqual(dashboard.HQ_PERIOD_OPTIONS, dashboard.RANGE_OPTIONS);
    assert.deepEqual(dashboard.hqRange("QUARTER"), { startDate: "2026-07-01", endDate: "2026-08-25" });
    assert.deepEqual(dashboard.hqRange("ALL"), { startDate: "", endDate: "" });
  } finally {
    Date.now = originalNow;
  }
});

test("HQ overview and ranking clear stale scope data before requests and keep it clear after failure", async () => {
  const overview = deferred();
  const ranking = deferred();
  const page = loadHome(async (action, payload) => {
    assert.equal(action, "getHqDashboard");
    return payload.mode === "overview" ? overview.promise : ranking.promise;
  });
  Object.assign(page.data, {
    session: { role: "hq" }, hqPeriod: "MONTH", hqDimension: "store",
    hqMetrics: [{ label: "旧指标" }], hqCharts: [{ title: "旧图表" }], hqLoadedAt: "12:34:56",
    hqScopeDetailText: "旧范围", hqRanking: [{ entityId: "OLD" }],
    hqRankingPage: { page: 9, total: 900, totalPages: 9 }, hqRankingInput: "9", hqRankingScrollLeft: 640
  });

  const loading = page.loadHqHome(1);
  assert.equal(page.data.hqMetrics.length, 0);
  assert.equal(page.data.hqCharts.length, 0);
  assert.equal(page.data.hqRanking.length, 0);
  assert.equal(page.data.hqRankingPage.total, 0);
  assert.equal(page.data.hqRankingInput, "1");
  assert.equal(page.data.hqRankingScrollLeft, 0);
  assert.equal(page.data.hqLoadedAt, "—");

  overview.reject(new Error("overview failed"));
  ranking.reject(new Error("ranking failed"));
  await loading;
  assert.equal(page.data.hqMetrics.length, 0);
  assert.equal(page.data.hqCharts.length, 0);
  assert.equal(page.data.hqRanking.length, 0);
  assert.equal(page.data.hqRankingPage.total, 0);
  assert.equal(page.data.hqRankingError, "ranking failed");
  assert.equal(page.data.message, "overview failed");
});

test("HQ ranking resets horizontal position for page and retry requests and rejects out-of-range jumps", async () => {
  const calls = [];
  let active = deferred();
  const page = loadHome(async (action, payload) => {
    calls.push({ action, payload });
    return active.promise;
  });
  Object.assign(page.data, {
    session: { role: "hq" }, hqPeriod: "MONTH", hqDimension: "store",
    hqRanking: [{ entityId: "OLD" }], hqRankingPage: { page: 1, total: 300, totalPages: 3 },
    hqRankingInput: "4", hqRankingScrollLeft: 0
  });

  page.rememberHqRankingScroll({ detail: { scrollLeft: 480 } });
  const secondPage = page.loadHqRanking(2);
  assert.equal(page.data.hqRankingScrollLeft, 0);
  assert.equal(page.data.hqRanking.length, 0);
  assert.equal(page.data.hqRankingPage.total, 0);
  active.reject(new Error("page failed"));
  await secondPage;
  assert.equal(page.data.hqRanking.length, 0);
  assert.equal(page.data.hqRankingPage.page, 1);

  page.data.hqRankingPage = { page: 1, total: 300, totalPages: 3 };
  page.data.hqRankingInput = "4";
  const callCount = calls.length;
  page.jumpHqPage();
  assert.equal(calls.length, callCount);
  assert.equal(page.data.message, "请输入 1 至 3 之间的页码");

  active = deferred();
  page.rememberHqRankingScroll({ detail: { scrollLeft: 320 } });
  const retry = page.retryHqRanking();
  assert.equal(page.data.hqRankingScrollLeft, 0);
  assert.equal(calls.at(-1).payload.pageNumber, 2);
  active.resolve({ ranking: { rows: [], total: 0, pageNumber: 1, pageSize: 100, totalPages: 1, businessTotal: 0 } });
  await retry;
});

test("HQ ranking keeps uniform columns and scrolls only inside its table", () => {
  const wxml = read("pages", "home", "index.wxml");
  const wxss = read("pages", "home", "index.wxss");
  assert.match(wxml, /class="hq-ranking-scroll"[^>]*scroll-x="true"/);
  assert.match(wxml, /class="hq-ranking-list"/);
  assert.match(wxml, /class="hq-ranking-row hq-ranking-table-head"/);
  assert.match(wxss, /\.hq-ranking-list\s*\{[^}]*width:\s*auto;[^}]*min-width:\s*100%;[^}]*display:\s*inline-table;[^}]*table-layout:\s*auto;[^}]*overflow:\s*visible;[^}]*border:[^}]*border-radius:/s);
  assert.match(wxss, /\.hq-ranking-row\s*\{[^}]*display:\s*table-row;/s);
  assert.match(wxss, /\.hq-ranking-row > text\s*\{[^}]*display:\s*table-cell;[^}]*white-space:\s*nowrap;/s);
});

test("HQ invalid custom range cancels pending work and clears the previous scope", () => {
  const page = loadHome(async () => ({}));
  Object.assign(page.data, {
    hqStart: "2026-08-30", hqEnd: "2026-08-25",
    hqMetrics: [{ label: "旧指标" }], hqCharts: [{ title: "旧图表" }],
    hqRanking: [{ entityId: "OLD" }], hqRankingPage: { page: 4, total: 400, totalPages: 4 },
    hqRankingInput: "4", hqRankingScrollLeft: 520
  });
  page._hqHomeRequestEpoch = 7;
  page._hqRankingRequestEpoch = 9;

  page.applyHqRange();

  assert.equal(page._hqHomeRequestEpoch, 8);
  assert.equal(page._hqRankingRequestEpoch, 10);
  assert.equal(page.data.hqMetrics.length, 0);
  assert.equal(page.data.hqCharts.length, 0);
  assert.equal(page.data.hqRanking.length, 0);
  assert.equal(page.data.hqRankingPage.total, 0);
  assert.equal(page.data.hqRankingScrollLeft, 0);
  assert.equal(page.data.error, true);
});
