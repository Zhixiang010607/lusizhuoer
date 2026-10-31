"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const read = ext => fs.readFileSync(path.join(__dirname, `../miniprogram-app/miniprogram/pages/hq-directory/index.${ext}`), "utf8");

test("directory pagination groups phone controls and uses a compact physical-pixel tablet row", () => {
  const html = read("wxml"), css = read("wxss");
  assert.equal((html.match(/<template name="directoryPager">/g) || []).length, 1);
  assert.match(html, /class="directory-page-controls"/);
  assert.match(html, /class="directory-page-status"/);
  assert.match(html, /bindinput="inputDirectoryPage" bindconfirm="directoryPage"/);
  assert.equal((html.match(/is="directoryPager"/g) || []).length, 3);
  assert.match(css, /\.directory-pagination\s*\{[^}]*flex-direction: column/);
  assert.match(css, /\.directory-page-controls\s*\{[^}]*grid-template-columns: 144rpx minmax\(0, 1fr\) 144rpx/);
  assert.match(css, /\.directory-pagination button\s*\{[^}]*height: 80rpx;[^}]*justify-content: center;[^}]*line-height: 1;/);
  assert.match(css, /\.directory-page-jump input\s*\{[^}]*height: 80rpx;[^}]*box-sizing: border-box/);
  assert.match(css, /@media \(min-width: 700px\)\s*\{\s*\.directory-pagination\s*\{[^}]*flex-direction: row/);
  assert.match(css, /\.directory-pagination button\s*\{[^}]*width: 80px; height: 42px;/);
  assert.match(css, /\.directory-page-jump input\s*\{[^}]*width: 72px; height: 42px;/);
  assert.match(css, /\.directory-pagination button\[disabled\]\s*\{[^}]*opacity: 1/);
  assert.doesNotMatch(css, /\.directory-page-jump\s*\{[^}]*grid-column/);
});

for (const type of ["teacher", "store"]) test(`${type} directory pagination stays independent, expands the last page and rejects invalid jumps`, async () => {
  let page;
  const rows = Array.from({ length: 42 }, (_, i) => ({ id: String(i+1), auth_uid: `QA-${i}`, staff_name: `测试老师${i+1}`, store_name: `测试门店${i+1}`, account_status: i<21?"ACTIVE":"ARCHIVED", store_status: i<21?"ACTIVE":"ARCHIVED" }));
  vm.runInNewContext(read("js"), {
    Page(value) { page = value; }, wx: { setNavigationBarTitle() {} },
    require(id) { return id.endsWith("/session") ? { requireSession: () => ({ role: "hq" }) } : { callStaff: async (action, payload) => {
      assert.equal(action, type === "teacher" ? "listStaff" : "listStores");
      if (type === "teacher") assert.equal(payload.role, "teacher");
      return type === "teacher" ? { staff: rows } : { stores: rows };
    } }; }
  });
  page.setData = (patch, done) => { Object.assign(page.data, patch); done?.(); };
  page.onLoad({ type }); await page.load();
  const input = (kind, value) => page.inputDirectoryPage({ currentTarget: { dataset: { kind } }, detail: { value } });
  const jump = (kind, direction) => page.directoryPage({ currentTarget: { dataset: { kind, direction } } });
  jump("active", "1"); assert.equal(page.data.activePage, 2); assert.equal(page.data.activePageRows[0].id, "11");
  assert.equal(page.data.archivedPage, 1);
  input("active", "3"); jump("active"); assert.equal(page.data.activePageRows.length, 1); assert.equal(page.data.activePageRows[0].id, "21");
  for (const invalid of ["", "0", "-1", "1.5", "4", "bad"]) { input("active", invalid); jump("active"); assert.equal(page.data.activePage, 3); }
  page.inputSearchName({ detail: { value: "测试" } }); page.runSearch();
  assert.equal(page.data.searchPages, 5); input("search", "5"); jump("search"); assert.equal(page.data.searchPageRows.length, 2);
  input("archived", "2"); jump("archived"); assert.equal(page.data.archivedPage, 2); assert.equal(page.data.searchPage, 5);
  page.data.loading = true; jump("active", "-1"); assert.equal(page.data.activePage, 1, "search reset preserved existing behavior; loading prevents new moves");
});
