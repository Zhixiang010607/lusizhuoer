"use strict";
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const assert = require("node:assert/strict"), test = require("node:test");
const read = p => fs.readFileSync(path.resolve(__dirname, "..", p), "utf8");
const cloud = read("cloudfunctions/faceRecognition/index.js");
function segment(start, end) { const a = cloud.indexOf(start), b = cloud.indexOf(end, a); assert(a >= 0 && b > a); return cloud.slice(a, b); }
test("actual UID role guards reject teacher store-home reads and cross-store targets despite forged client roles", async () => {
  for (const role of ["teacher", "store"]) {
    const sql = [], scope = {
      app: () => ({ auth: () => ({ getUserInfo: () => ({ uid: "actual-" + role }) }) }),
      fail: (message, code) => { throw Object.assign(Error(message), { code }); },
      sqlText: value => `'${value}'`, businessQueryDatabaseId: value => String(value),
      activeStoreCaller: async () => ({ role: "store", storeId: "7" }),
      executeSql: async query => { sql.push(query); return [{ staff_id: "11", role_code: role, account_status: "ACTIVE" }]; }
    };
    vm.runInNewContext(segment("async function activeCustomerStatusCaller(", "// Customer and business-record") + segment("async function activeScopedQueryCaller(", "\nfunction scopedStoreClause") + "\nthis.query=activeScopedQueryCaller;", scope);
    for (const storeId of ["8", "ALL"]) await assert.rejects(scope.query({ storeId, role: "hq", teacherId: "99", uid: "forged-hq" }), { code: "FORBIDDEN" });
    if (role === "teacher") await assert.rejects(scope.query({ storeId: "7", role: "store" }), { code: "FORBIDDEN" });
    else assert.equal((await scope.query({ role: "hq" })).storeId, "7");
    assert(sql.every(query => /FROM public.staff_accounts/.test(query) && query.includes("actual-" + role)));
  }
  for (const action of ["getStoreDashboard", "getStoreBusinessAnalytics"]) assert.match(cloud, new RegExp(`async function ${action}\\(event = \\{\\}\\) \\{\\s*const caller = await activeScopedQueryCaller\\(event\\)`));
});
test("teacher/store visible names remain plain while headquarters alone owns ranked profile links", () => {
  const home = read("miniprogram-app/miniprogram/pages/home/index.wxml");
  const hq = home.indexOf('<block wx:if="{{session.role === \'hq\'}}">');
  assert(hq >= 0);
  assert.doesNotMatch(home.slice(0, hq), /bindtap="openHqRankedProfile"|hq-ranking-link/);
  assert(home.indexOf('bindtap="openHqRankedProfile"') > hq);
  assert.match(home.slice(0, hq), /bindtap="openCustomer"/);
  assert.match(home, /<view>\{\{item.storeName\}\}<\/view>/);
  const customers = read("miniprogram-app/miniprogram/pages/teacher-customers/index.wxml");
  assert.match(customers, /bindtap="openCustomer"/);
  assert.match(customers, /<view>\{\{item.storeName\}\}<\/view>/);
  for (const page of ["teacher-detail", "store-detail", "hq-directory"]) assert.match(read(`miniprogram-app/miniprogram/pages/${page}/index.js`), /requireSession\(\["hq"\]\)/);
  const staff = read("cloudfunctions/staffAccount/index.js");
  for (const action of ["listStaff", "listStores", "getHqDashboard"]) assert.match(staff, new RegExp(`if \\(action === "${action}"\\) \\{\\s*requireHq\\(caller\\)`));
});
