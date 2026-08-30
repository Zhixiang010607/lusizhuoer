"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const mini = path.join(root, "miniprogram-app", "miniprogram");
const readMini = (...parts) => fs.readFileSync(path.join(mini, ...parts), "utf8");

test("summary values shrink by length without squeezing their unit", () => {
  const wxml = readMini("pages", "home", "index.wxml");
  const wxss = readMini("pages", "home", "index.wxss");

  assert.match(wxml, /metric-number--compact/);
  assert.match(wxml, /metric-number--dense/);
  assert.match(wxml, /metric-number--micro/);
  assert.match(wxml, /class="metric-unit">次<\/text>/);
  assert.match(wxss, /\.summary-table\s*\{\s*width:\s*100%;\s*min-width:\s*0;/);
  assert.match(wxss, /grid-template-columns:\s*minmax\(148rpx,\s*1\.35fr\)\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(wxss, /\.summary-metric\s*\{[^}]*display:\s*flex;/s);
  assert.match(wxss, /\.summary-metric\s*\{[^}]*min-width:\s*0;/s);
  assert.match(wxss, /\.metric-number--compact\s*\{\s*font-size:\s*20rpx/);
  assert.match(wxss, /\.metric-number--dense\s*\{\s*font-size:\s*17rpx/);
  assert.match(wxss, /\.metric-number--micro\s*\{\s*font-size:\s*14rpx/);
  assert.match(wxss, /\.metric-unit\s*\{[^}]*flex:\s*0\s+0\s+auto;/s);
});

test("query records use semantic columns and table-local horizontal scrolling", () => {
  const wxml = readMini("pages", "records", "index.wxml");
  const wxss = readMini("pages", "records", "index.wxss");

  assert.match(wxml, /scroll-x="true"/);
  assert.match(wxml, /record-cell--order/);
  assert.match(wxml, /record-cell--customer/);
  assert.match(wxml, /record-cell--time/);
  assert.match(wxss, /\.record-table\s*\{[^}]*width:\s*1760rpx;/s);
  assert.match(wxss, /\.verification-table\s*\{[^}]*width:\s*1780rpx;/s);
  assert.match(wxss, /\.product-purchase-table\s*\{[^}]*width:\s*1920rpx;/s);
  assert.match(wxss, /\.record-cell--order\s*\{/);
  assert.match(wxss, /\.record-cell--time\s*\{/);
});

test("review records preserve order numbers and full times before short fields", () => {
  const wxml = readMini("pages", "reviews", "index.wxml");
  const wxss = readMini("pages", "reviews", "index.wxss");

  assert.match(wxml, /scroll-x="true"/);
  assert.match(wxml, /review-cell--order/);
  assert.match(wxml, /review-cell--customer/);
  assert.match(wxml, /review-cell--time/);
  assert.match(wxss, /\.review-table\s*\{[^}]*width:\s*1750rpx;/s);
  assert.match(wxss, /grid-template-columns:\s*340rpx\s+150rpx\s+150rpx\s+150rpx\s+130rpx\s+100rpx\s+280rpx\s+170rpx\s+280rpx/);
  assert.match(wxss, /\.review-cell--order\s*\{/);
  assert.match(wxss, /\.review-cell--time\s*\{/);
});

test("cross-device baseline records the long-value layout contract", () => {
  const context = fs.readFileSync(path.join(root, "PROJECT_CONTEXT.md"), "utf8");
  assert.match(context, /按数值长度分级缩放字号/);
  assert.match(context, /按字段语义分配列宽/);
  assert.match(context, /只允许表格自身横向滑动/);
});
