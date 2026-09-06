const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const dashboard = require("../miniprogram-app/miniprogram/services/home-dashboard");
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function response(activePage = 1, archivedPage = 1, total = 61) {
  return {
    active: { records: [{ customerCode: `A-${activePage}`, customerName: "示例客户" }], total, page: activePage, pageSize: 20 },
    archived: { records: [{ customerCode: `B-${archivedPage}`, customerName: "示例客户" }], total, page: archivedPage, pageSize: 20 }
  };
}
function fixture(callFace, startup = Promise.resolve(), session = { uid: "fixture-teacher", role: "teacher" }) {
  let page;
  const navigations = [];
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../miniprogram-app/miniprogram/pages/teacher-customers/index.js"), "utf8"), {
    Page(value) { page = value; },
    wx: { nextTick() {}, navigateTo({ url }) { navigations.push(url); } },
    require(id) {
      if (id.endsWith("/api")) return { callFace };
      if (id.endsWith("/session")) return { waitForStartupSession: () => startup, requireSession: roles => session && roles.includes(session.role) ? session : null };
      return dashboard;
    }
  });
  page.setData = (changes, done) => { Object.assign(page.data, changes); if (done) done(); };
  return { page, navigations };
}
test("teacher customer page waits for startup and only loads for the teacher role", async () => {
  const gate = deferred(); let calls = 0;
  const { page } = fixture(async () => { calls++; return response(); }, gate.promise);
  const showing = page.onShow();
  assert.equal(calls, 0); assert.equal(page.data.authorized, false);
  gate.resolve(); await showing;
  assert.equal(calls, 1); assert.equal(page.data.authorized, true);
  for (const role of ["store", "hq"]) {
    const denied = fixture(async () => { throw new Error("must not query"); }, Promise.resolve(), { uid: "fixture", role }).page;
    await denied.onShow(); assert.equal(denied.data.authorized, false);
  }
});
test("teacher customer tabs keep separate page positions and customer links", async () => {
  const calls = [];
  const { page, navigations } = fixture(async (action, payload) => { calls.push({ action, ...payload }); return response(payload.activePage, payload.archivedPage); });
  await page.onShow(); await page.loadPage(3);
  await page.chooseStatus({ currentTarget: { dataset: { status: "ARCHIVED" } } });
  await page.loadPage(2);
  await page.chooseStatus({ currentTarget: { dataset: { status: "ACTIVE" } } });
  assert.equal(page.data.group.page, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(page.data.pages)), { ACTIVE: 3, ARCHIVED: 2 });
  assert.deepEqual(calls.at(-1), { action: "getTeacherBusinessCustomers", activePage: 3, archivedPage: 2 });
  page.openCustomer({ currentTarget: { dataset: { code: "A-3" } } });
  assert.deepEqual(navigations, ["/pages/customer-detail/index?code=A-3"]);
});
test("switching customer status discards an older response and unloading discards pending work", async () => {
  const old = deferred(); const newer = deferred();
  let index = 0;
  const { page } = fixture(() => ++index === 1 ? old.promise : newer.promise);
  page.data.authorized = true;
  const first = page.loadPage(2);
  const second = page.chooseStatus({ currentTarget: { dataset: { status: "ARCHIVED" } } });
  newer.resolve(response(1, 1)); await second;
  old.resolve(response(2, 1)); await first;
  assert.equal(page.data.status, "ARCHIVED"); assert.equal(page.data.group.rows[0].customerCode, "B-1");
  const pending = deferred();
  const other = fixture(() => pending.promise).page; other.data.authorized = true;
  const request = other.loadPage(); other.onUnload(); pending.resolve(response()); await request;
  assert.equal(other.data.group.rows.length, 0);
});
test("customer read failures and malformed results clear old rows and retry the same page", async () => {
  let fail = true; const requested = [];
  const { page } = fixture(async (action, payload) => { requested.push(payload.activePage); if (fail) return { active: {}, archived: {} }; return response(payload.activePage, 1); });
  page.data.authorized = true;
  await page.loadPage(3);
  assert.equal(page.data.error, true); assert.equal(page.data.group.rows.length, 0); assert.equal(page.data.counts.ACTIVE, null);
  fail = false; await page.retry();
  assert.deepEqual(requested, [3, 3]); assert.equal(page.data.group.page, 3); assert.equal(page.data.error, false);
});
test("valid empty customer results stay empty and invalid page input does not query", async () => {
  let calls = 0;
  const { page } = fixture(async () => { calls++; return { active: { records: [], total: 0, page: 1, pageSize: 20 }, archived: { records: [], total: 0, page: 1, pageSize: 20 } }; });
  await page.onShow(); assert.equal(page.data.error, false); assert.equal(page.data.group.rows.length, 0);
  page.inputPage({ detail: { value: "0" } }); page.jumpPage(); assert.equal(calls, 1);
});
