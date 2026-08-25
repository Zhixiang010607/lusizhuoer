"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, "miniprogram-app", "miniprogram", "pages", "home", file), "utf8");

test("teacher profile uses one warm two-column row without login identity or changing the store grid", () => {
  const wxml = read("index.wxml");
  const wxss = read("index.wxss");
  const dashboard = fs.readFileSync(path.join(root, "miniprogram-app", "miniprogram", "services", "home-dashboard.js"), "utf8");

  assert.match(wxml, /session\.role === 'teacher'[\s\S]*class="web-panel detail-section teacher-profile-panel"[\s\S]*class="detail-info-grid teacher-profile-row"/);
  assert.match(wxml, /session\.role === 'store'[\s\S]*class="detail-info-grid">/);
  assert.match(wxss, /\.teacher-profile-panel\s*\{[^}]*#d7ba85[^}]*linear-gradient\(180deg, #fffaf3 0%, #f9edd9 100%\)/s);
  assert.match(wxss, /\.teacher-profile-row\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)[^}]*#d7ba85/s);
  assert.match(wxss, /\.teacher-profile-row \.detail-info-item\s*\{[^}]*align-items:\s*center[^}]*justify-content:\s*center[^}]*text-align:\s*center[^}]*linear-gradient\(180deg, #fff8ec 0%, #f5e4c6 100%\)/s);
  assert.match(wxss, /\.detail-info-item text\s*\{[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s);
  assert.match(dashboard, /老师姓名[\s\S]{0,180}老师短编号/);
  assert.doesNotMatch(dashboard, /登录身份|老师本人/);
  assert.doesNotMatch(wxml, /身份由当前登录账号|>老师本人<\/text>/);
});

test("each teacher quota is one compact horizontal row with protected single-line cells", () => {
  const wxml = read("index.wxml");
  const wxss = read("index.wxss");

  assert.match(wxml, /class="quota-identity">\{\{item\.productName\}\} · \{\{item\.productCode \|\| '—'\}\}<\/text>/);
  for (const label of ["可用", "每月基础", "本月已用"]) assert.match(wxml, new RegExp(`>${label}<\\/text>`));
  assert.match(wxss, /\.teacher-quota-card\s*\{[^}]*min-height:\s*96rpx[^}]*display:\s*grid[^}]*grid-template-columns:\s*minmax\(0, 1\.75fr\) repeat\(3, minmax\(92rpx, \.72fr\)\)/s);
  assert.match(wxss, /\.quota-identity\s*\{[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s);
  assert.match(wxss, /\.quota-metric text\s*\{[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s);
  assert.doesNotMatch(wxml, /quota-name|quota-code|quota-facts/);
});

test("teacher home popover delegates store selection to business pages", () => {
  const js = read("index.js");
  const wxml = read("index.wxml");

  assert.doesNotMatch(wxml, /popover-store|bindchange="selectStore"|storeLabels|loadingStores|selectedStore/);
  assert.doesNotMatch(js, /getTeacherBusinessContext|setSelectedStore|loadingStores|businessContextReady|selectedStore|storeLabels|selectStore\s*\(/);
  assert.match(js, /ensureBusinessStore\(\)\s*\{\s*if \(this\.data\.session\.role === "teacher"\) return true;/s);
  assert.match(js, /openCustomerCreate\(\)\s*\{\s*this\.closeMenus\(\);\s*if \(this\.ensureBusinessStore\(\)\) wx\.navigateTo\(\{ url: "\/pages\/customer-create\/index" \}\);\s*\}/s);
  assert.match(js, /openRecharge\(event\)\s*\{\s*this\.closeMenus\(\);\s*if \(this\.ensureBusinessStore\(\)\) wx\.navigateTo/s);
  assert.match(js, /openVerification\(event\)\s*\{\s*this\.closeMenus\(\);\s*if \(this\.ensureBusinessStore\(\)\) wx\.navigateTo/s);
  assert.match(js, /const store = getSelectedStore\(this\.data\.session\);[\s\S]*当前登录门店读取失败/,
    "store role must retain its fixed-session-store fail-closed guard");
});
