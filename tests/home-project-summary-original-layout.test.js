"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const read = (name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8");

test("home project summary retains its original five columns, totals and multi-page-only navigation", () => {
  const web = read("index.html").split('<section class="panel hq-project-summary-card"')[1].split("</section>")[0];
  assert.equal((web.match(/role="columnheader"/g) || []).length, 5);
  assert.match(web, /hq-project-summary-total/);
  assert.doesNotMatch(web, /序号|跳至第|productSummaryPageInput|productSummaryJump/);
  const home = read("miniprogram-app/miniprogram/pages/home/index.wxml");
  const mini = home.split('<view class="web-panel hq-project-summary-panel">')[1].split('<view class="web-panel ranking-panel">')[0];
  assert.match(mini, /<project-summary id="hq-project-summary"/);
  assert.doesNotMatch(mini, /list-row-number|跳至第|jumpHqProductSummaryPage/);
  const condition = mini.match(/wx:if="\{\{([^"\n]+)\}\}" class="table-pagination hq-project-summary-pagination"/)[1];
  for (const [totalPages, loading, error, visible] of [
    [1, false, "", false], [2, false, "", true], [3, false, "", true],
    [2, true, "", false], [2, false, "读取失败", false]
  ]) {
    assert.equal(vm.runInNewContext(condition, { hqProjectSummaryPage: { totalPages }, hqProjectSummaryLoading: loading, hqProjectSummaryError: error }), visible);
  }
  const component = read("miniprogram-app/miniprogram/components/project-summary/index.wxml");
  assert.doesNotMatch(component, /list-row-number|序号|跳至第/);
  assert.match(component, /summary-total/);
  assert.match(home, /businessPage\.total > 0/);
  assert.match(home, /class="list-row-number">序号/);
  assert.match(home, /jumpHqPage/);
});

test("Web summary hides single-page controls without changing displayed projects or totals", () => {
  const source = read("app.js");
  const start = source.indexOf("  function renderProductSummary()");
  const end = source.indexOf("\n  function limited(", start);
  assert.ok(start >= 0 && end > start);
  const render = source.slice(start, end);
  for (const total of [0, 1, 3, 10, 11, 21]) {
    const nodes = new Map();
    const $ = (id) => {
      if (!nodes.has(id)) nodes.set(id, {});
      return nodes.get(id);
    };
    const rows = Array.from({ length: Math.min(total, 10) }, (_, i) => ({ name: `样例项目${i + 1}`, verification: i, recharge: i, experience: i, refund: 0 }));
    const totals = { verification: 12, recharge: 24, experience: 6, refund: 0 };
    const totalPages = Math.max(1, Math.ceil(total / 10));
    vm.runInNewContext(render + ";renderProductSummary();", {
      $, state: { productSummary: { rows, total, totalPages, pageNumber: 1 }, data: { totals }, productSummaryLoading: false },
      fmt: new Intl.NumberFormat("zh-CN"), escapeHtml: String, finiteCount: Number, finiteNumber: Number
    });
    assert.equal($("productSummaryPager").hidden, total <= 10);
    assert.equal($("productSummaryPrevious").disabled, true);
    assert.equal($("productSummaryNext").disabled, totalPages === 1);
    assert.equal($("productSummaryRecharge").textContent, "24");
    assert.equal($("productSummaryVerification").textContent, "12");
    assert.equal(($("productSummaryBody").innerHTML.match(/role="row"/g) || []).length, rows.length);
    assert.equal(nodes.has("productSummaryPageInput"), false);
    assert.equal(nodes.has("productSummaryJump"), false);
  }
  assert.doesNotMatch(source, /jumpSummary|productSummaryJump|productSummaryPageInput/);
  assert.doesNotMatch(read("miniprogram-app/miniprogram/pages/home/index.js"), /hqProjectSummaryInput|jumpHqProductSummaryPage/);
  assert.match(source, /const RANKING_PAGE_SIZE = 10;/);
});
