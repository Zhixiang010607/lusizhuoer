"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const dashboard = require("../miniprogram-app/miniprogram/services/home-dashboard");

function pageHarness(name) {
  let definition;
  vm.runInNewContext(read(`miniprogram-app/miniprogram/pages/${name}/index.js`), {
    Page(value) { definition = value; }, wx: {},
    require(id) {
      if (id === "../../services/review-notifications") return { subscribe: () => () => {} };
      if (id.endsWith("/home-dashboard")) return dashboard;
      if (id.endsWith("/session")) return {};
      if (id.endsWith("/api")) return { callFace() { throw Error("tab switch must not call the server"); }, callStaff() { throw Error("tab switch must not write accounts"); } };
      if (id.endsWith("/hq-dashboard-report")) return {};
      throw Error(id);
    }
  });
  const page = { ...definition, data: structuredClone(definition.data) };
  page.data.session = { role: "store" };
  page.setData = changes => Object.assign(page.data, changes);
  return page;
}

for (const name of ["home", "store-detail"]) {
  test(`${name} switches customer lists without changing independent pages, rows, inputs or server state`, () => {
    const page = pageHarness(name);
    assert.equal(page.data.customerStatus, "ACTIVE");
    page.data.activeCustomers = { page: 2, pageInput: "2", rows: [{ customerCode: "QA-A" }], total: 21 };
    page.data.archivedCustomers = { page: 3, pageInput: "3", rows: [{ customerCode: "QA-Z" }], total: 24 };
    const before = JSON.stringify([page.data.activeCustomers, page.data.archivedCustomers]);
    const select = status => page.selectCustomerStatus({ currentTarget: { dataset: { status } } });
    select("ARCHIVED"); assert.equal(page.data.customerStatus, "ARCHIVED");
    select("ACTIVE"); assert.equal(page.data.customerStatus, "ACTIVE");
    select("INVALID"); assert.equal(page.data.customerStatus, "ACTIVE");
    assert.equal(JSON.stringify([page.data.activeCustomers, page.data.archivedCustomers]), before);
    if (name === "home") { page.data.session.role = "teacher"; select("ARCHIVED"); assert.equal(page.data.customerStatus, "ACTIVE"); }
  });
  test(`${name} shows mutually exclusive customer panels and grouped centered page controls`, () => {
    const wxml = read(`miniprogram-app/miniprogram/pages/${name}/index.wxml`);
    assert.match(wxml, /class="customer-status-tabs"/);
    assert.match(wxml, /data-status="ACTIVE" bindtap="selectCustomerStatus">活跃用户/);
    assert.match(wxml, /data-status="ARCHIVED" bindtap="selectCustomerStatus">封存用户/);
    assert.match(wxml, /wx:if="\{\{customerStatus === 'ACTIVE'\}\}"/);
    assert.match(wxml, /wx:else/);
    assert.match(wxml, /class="customer-page-controls"/);
    assert.match(wxml, /bindconfirm="jumpCustomerPage" confirm-type="done"/);
    assert.match(wxml, /item.ageLabel/);
    assert.match(wxml, /list-row-number">\{\{index \+ 1\}\}/);
  });
}

test("store customer tabs and pagination stay bounded on phone and use a compact tablet row", () => {
  const css = read("miniprogram-app/miniprogram/pages/home/index.wxss");
  assert.match(css, /\.customer-status-tabs \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.customer-page-controls \{[^}]*grid-template-columns: 144rpx minmax\(0, 1fr\) 144rpx/);
  assert.match(css, /\.customer-page-controls > text \{[^}]*white-space: nowrap;/);
  assert.match(css, /\.customer-pagination button \{[^}]*height: 80rpx; min-height: 80rpx;[^}]*box-sizing: border-box/);
  assert.match(css, /\.customer-pagination \.customer-page-jump input \{[^}]*height: 80rpx; min-height: 80rpx;/);
  assert.match(css, /\.table-pagination\.customer-pagination \{ flex-direction: row;[^}]*font-size: 14px/);
  assert.match(css, /\.customer-pagination button \{ width: 80px; height: 42px; min-height: 42px;/);
  assert.match(css, /\.customer-pagination button\[disabled\] \{[^}]*opacity: 1/);
  assert.match(read("miniprogram-app/miniprogram/pages/store-detail/index.wxss"), /@import "\.\.\/home\/index.wxss"/);
});
