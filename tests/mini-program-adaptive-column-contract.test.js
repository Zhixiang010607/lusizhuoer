"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const mini = path.join(root, "miniprogram-app", "miniprogram");
const readMini = (...parts) => fs.readFileSync(path.join(mini, ...parts), "utf8");

function assertAutoTableContract(wxss) {
  assert.match(wxss, /width:\s*auto;\s*min-width:\s*100%;\s*display:\s*inline-table;\s*table-layout:\s*auto;/);
  assert.match(wxss, /display:\s*table-cell;/);
  assert.match(wxss, /padding:\s*10rpx 18rpx;/);
  assert.match(wxss, /font-size:\s*21rpx;/);
  assert.match(wxss, /white-space:\s*nowrap;/);
  assert.match(wxss, /font-size:\s*14px;/);
}

const nativeTablePages = [
  ["home", "summary-table"],
  ["records", "record-table"],
  ["reviews", "review-table"],
  ["customers", "customer-table"],
  ["hq-directory", "data-table"],
  ["customer-detail", "balance-table"],
];

for (const [page, marker] of nativeTablePages) {
  test(`${page} tables use content-driven widths and local scrolling`, () => {
    const wxml = readMini("pages", page, "index.wxml");
    const wxss = readMini("pages", page, "index.wxss");

    assert.match(wxml, /scroll-x(?:="true")?/);
    assert.match(wxss, new RegExp(`\\.${marker}`));
    assertAutoTableContract(wxss);
  });
}

test("store detail inherits the shared home table contract", () => {
  const wxml = readMini("pages", "store-detail", "index.wxml");
  const wxss = readMini("pages", "store-detail", "index.wxss");

  assert.match(wxml, /scroll-x(?:="true")?/);
  assert.match(wxss, /@import\s+["']\.\.\/home\/index\.wxss["'];/);
});

test("summary values do not use dynamic compact font classes", () => {
  const wxml = readMini("pages", "home", "index.wxml");
  const wxss = readMini("pages", "home", "index.wxss");

  assert.doesNotMatch(wxml, /metric-number--(?:compact|dense|micro)/);
  assert.doesNotMatch(wxss, /\.metric-number--(?:compact|dense|micro)/);
});

test("ranking names use the same calm data typography as other values", () => {
  const wxml = readMini("pages", "home", "index.wxml");
  const wxss = readMini("pages", "home", "index.wxss");

  assert.doesNotMatch(wxml, /hq-ranking-value[^>]*hqRankingMetric/);
  assert.doesNotMatch(wxss, /\.hq-ranking-value\.active|\.hq-ranking-table-head\s*>\s*text\.active/);
  assert.match(
    wxss,
    /\.hq-ranking-name\s*\{[^}]*color:\s*#5f564b;[^}]*font-size:\s*inherit\s*!important;[^}]*font-weight:\s*600;/s
  );
});

test("cross-device baseline records the global adaptive-column contract", () => {
  const context = fs.readFileSync(path.join(root, "PROJECT_CONTEXT.md"), "utf8");

  assert.match(context, /内容驱动的自适应列宽/);
  assert.match(context, /最长的表头或单元格内容/);
  assert.match(context, /相同字号和相同水平内边距/);
  assert.match(context, /只允许表格自身横向滑动/);
});
