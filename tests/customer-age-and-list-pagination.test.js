"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");
const miniAge = require("../miniprogram-app/miniprogram/services/customer-age").formatCustomerAge;
const browser = { window: {}, Intl, Date };
vm.runInNewContext(read("customer-age.js"), browser);
const webAge = (birth, today) => browser.window.CustomerAge.format(birth, new Date(`${today}T04:00:00Z`));

test("customer age is display-only full years on the Shanghai business day in both clients", () => {
  for (const [birth, today, expected] of [
    ["2000-11-01", "2026-10-31", "25 岁"], ["2000-10-31", "2026-10-31", "26 岁"],
    ["2000-01-01", "2026-01-01", "26 岁"], ["2026-10-31", "2026-10-31", "0 岁"],
    ["2000-02-29", "2025-02-28", "24 岁"], ["2000-02-29", "2025-03-01", "25 岁"],
    ["2000-02-29", "2024-02-29", "24 岁"], ["1900-02-29", "2026-10-31", "—"],
    ["2026-11-01", "2026-10-31", "—"], ["2027-01-01", "2026-10-31", "—"],
    ["2000-02-30", "2026-10-31", "—"], ["2000-13-01", "2026-10-31", "—"],
    ["", "2026-10-31", "—"], [null, "2026-10-31", "—"], ["unknown", "2026-10-31", "—"]
  ]) {
    assert.equal(miniAge(birth, today), expected, `Mini ${birth}/${today}`);
    assert.equal(webAge(birth, today), expected, `Web ${birth}/${today}`);
  }
  assert.equal(browser.window.CustomerAge.format("2000-11-01", new Date("2026-10-31T15:59:59Z")), "25 岁");
  assert.equal(browser.window.CustomerAge.format("2000-11-01", new Date("2026-10-31T16:00:00Z")), "26 岁");
});

test("customer list page size is bounded and backwards compatible, without changing write actions", () => {
  const source = read("cloudfunctions/faceRecognition/index.js");
  const start = source.indexOf("function customerListPageSize(");
  const end = source.indexOf("async function getStoreDashboard", start);
  const scope = { fail(message, code) { throw Object.assign(new Error(message), { code }); } };
  vm.runInNewContext(source.slice(start, end) + ";this.size = customerListPageSize;", scope);
  assert.equal(scope.size({}), 20, "old clients retain their default");
  assert.equal(scope.size({ customerPageSize: 10 }), 10);
  assert.equal(scope.size({ customerPageSize: "10" }), 10);
  for (const value of [0, -1, 101, 1.5, "bad", null]) assert.throws(() => scope.size({ customerPageSize: value }), /1 至 100/);
  assert.match(source, /const customerPageSize = customerListPageSize\(event\)/);
  assert.match(source, /const pageSize = customerListPageSize\(event\)/);
});

test("Web query results keep one footer pager and all numbered wrappers expand to their contents", () => {
  for (const file of ["customer-query.html", "recharge-query.html", "verification-query.html"]) {
    const html = read(file);
    assert.equal((html.match(/class="record-query-pager"/g) || []).length, 1, file);
    assert.ok(html.indexOf('class="record-query-pager"') > html.indexOf('id="' + (file === "customer-query.html" ? "customerQueryBody" : "recordQueryBody") + '"'), file);
    assert.ok(html.indexOf("customer-age.js") < html.indexOf(file === "customer-query.html" ? "customer-query.js?" : "query.js?"));
  }
  const numbered = read("list-row-numbers.js");
  for (const wrapper of [".table-scroll", ".operations-table-scroll", ".teacher-directory-window", ".store-directory-window"]) assert.ok(numbered.includes(wrapper));
  assert.match(read("list-row-numbers.css"), /height: auto !important; min-height: 0 !important; max-height: none !important/);
  assert.match(numbered, /String\(index \+ 1\)/);
});

test("Mini result lists show a page-local sequence, ten full rows and only horizontal table scrolling", () => {
  for (const page of ["customers", "records", "reviews", "home", "store-detail", "teacher-customers", "hq-directory", "inactive-customers", "low-balance-customers", "rating-analysis"]) {
    const wxml = read(`miniprogram-app/miniprogram/pages/${page}/index.wxml`);
    assert.match(wxml, /class="list-row-number">序号/);
    assert.match(wxml, /class="list-row-number">\{\{index \+ 1\}\}/);
    const tables = [...wxml.matchAll(/<scroll-view\b(?:[^>"']|"[^"]*"|'[^']*')*>/g)].map((match) => match[0]).filter((tag) => /class="[^"]*(?:table|record-scroll|customer-scroll|low-balance|inactive|hq-ranking)/.test(tag));
    assert.ok(tables.length, page);
    for (const table of tables) assert.doesNotMatch(table, /\bscroll-y(?:=|\s|>)/, page);
    assert.doesNotMatch(wxml, /超过 5 条|可在表格内上下滑动/);
    assert.match(wxml, /上一页/); assert.match(wxml, /下一页/); assert.match(wxml, /跳转/);
  }
  for (const page of ["customers", "records", "reviews", "home", "store-detail", "inactive-customers", "low-balance-customers", "rating-analysis"]) {
    assert.match(read(`miniprogram-app/miniprogram/pages/${page}/index.js`), /const PAGE_SIZE = 10;/, page);
  }
});

test("birthdays remain in business identity selection while customer lists render age", () => {
  for (const page of ["customers", "records", "home", "store-detail", "teacher-customers"]) {
    const wxml = read(`miniprogram-app/miniprogram/pages/${page}/index.wxml`);
    assert.match(wxml, />年龄</); assert.match(wxml, /item\.ageLabel/);
    assert.doesNotMatch(wxml, />生日<|\{\{item\.birthDate\}\}/);
  }
  assert.match(read("miniprogram-app/miniprogram/pages/customers/index.js"), /payload\.birthDate = this\.data\.birthDate/);
  assert.match(read("store-business.js"), /formatBirthday\(customer\.birthday\)/);
  assert.doesNotMatch(read("verification-create.html"), /list-row-numbers|customer-age/);
  assert.doesNotMatch(read("miniprogram-app/miniprogram/pages/verification/index.js"), /formatCustomerAge|list-row-number/);
  assert.match(read("miniprogram-app/miniprogram/pages/customer-detail/index.wxml"), /profile\.birthDateLabel/);
  assert.match(read("customer-profile.js"), /infoCard\("生日", birthdayText\(profile\.birthDate\)\)/);
  for (const page of ["recharge-query", "verification-query", "customer-query"]) {
    assert.match(read(`${page}.html`), /<th>年龄<\/th>/);
    assert.doesNotMatch(read(`${page}.html`), /<th>生日<\/th>/);
    assert.match(read(`${page}.html`), /customer-age\.js/);
  }
});

test("ten-row viewports grow monotonically using matching physical-pixel and rpx row metrics", () => {
  for (const page of ["customers", "records", "reviews", "home", "teacher-customers", "inactive-customers", "low-balance-customers", "rating-analysis"]) {
    const css = read(`miniprogram-app/miniprogram/pages/${page}/index.wxss`);
    const groups = new Map();
    for (const match of css.matchAll(/([^{}]+\[data-(?:visible|tablet-visible)-rows="(\d+)"\])\s*\{\s*height:\s*([\d.]+)(rpx|px)(?:\s*!important)?;\s*\}/g)) {
      const key = match[1].trim().replace(/="\d+"/, '="N"') + match[4];
      if (!groups.has(key)) groups.set(key, new Map());
      groups.get(key).set(Number(match[2]), Number(match[3]));
    }
    if (page === "teacher-customers") { assert.match(css, /\.customer-scroll[^}]*overflow: hidden/); continue; }
    assert.ok(groups.size, page);
    for (const [key, heights] of groups) {
      if (!heights.has(10)) continue;
      let previous = 0;
      for (const [count, height] of [...heights].sort((a, b) => a[0] - b[0])) {
        if (count === 0) continue;
        assert.ok(height > previous, `${page} ${key} row ${count} must expand`);
        previous = height;
      }
      if (heights.has(1) && heights.has(2)) assert.equal(heights.get(10), heights.get(1) + 9 * (heights.get(2) - heights.get(1)), `${page} ${key}`);
    }
  }
});

test("management search, active and archived lists page independently in tens and reject invalid jumps", async () => {
  let page;
  const source = Array.from({ length: 42 }, (_, index) => ({ id: String(index + 1), store_name: `样例门店${index + 1}`, store_status: index < 21 ? "ACTIVE" : "ARCHIVED" }));
  vm.runInNewContext(read("miniprogram-app/miniprogram/pages/hq-directory/index.js"), {
    Page(definition) { page = definition; },
    wx: { setNavigationBarTitle() {} },
    require(id) { return id.endsWith("/api") ? { callStaff: async () => ({ stores: source }) } : { requireSession: () => ({ role: "hq" }) }; }
  });
  page.setData = (patch, done) => { Object.assign(page.data, patch); done?.(); };
  page.onLoad({ type: "store" }); await page.load();
  assert.equal(page.data.activePageRows.length, 10);
  assert.equal(page.data.archivedPageRows.length, 10);
  page.inputDirectoryPage({ currentTarget: { dataset: { kind: "active" } }, detail: { value: "3" } });
  page.directoryPage({ currentTarget: { dataset: { kind: "active" } } });
  assert.equal(page.data.activePageRows.length, 1);
  assert.equal(page.data.activePageRows[0].name, "样例门店21");
  assert.equal(page.data.archivedPage, 1);
  assert.equal(page.data.archivedPageRows.length, 10);
  page.inputSearchName({ detail: { value: "样例门店" } }); page.runSearch();
  assert.equal(page.data.searchPageRows.length, 10);
  for (const value of ["0", "-1", "1.5", "bad", "99"]) {
    page.inputDirectoryPage({ currentTarget: { dataset: { kind: "search" } }, detail: { value } });
    page.directoryPage({ currentTarget: { dataset: { kind: "search" } } });
    assert.equal(page.data.searchPage, 1);
  }
});
