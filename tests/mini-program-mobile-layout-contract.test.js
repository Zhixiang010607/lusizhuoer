"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const dashboard = require(path.join(root, "miniprogram-app", "miniprogram", "services", "home-dashboard.js"));

test("mini-program uses the shared mobile visual tokens and touch-sized controls", () => {
  const wxss = read("miniprogram-app", "miniprogram", "app.wxss");

  for (const token of ["#132642", "#1f5eff", "#00a884", "#172033", "#667085", "#e4e8ef", "#f3f6f9"]) {
    assert.match(wxss, new RegExp(token, "i"), `missing shared mobile color token ${token}`);
  }
  assert.match(wxss, /\.input,\s*\.picker,\s*\.textarea\s*\{[^}]*min-height:\s*88rpx/s);
  assert.match(wxss, /\.primary,\s*\.secondary,\s*\.danger,\s*\.ghost\s*\{[^}]*min-height:\s*88rpx/s);
  assert.match(wxss, /\.action-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,/s,
    "mobile business actions should follow the compact two-column web layout");
  assert.match(wxss, /\.action\s+\.action-note\s*\{\s*display:\s*none;/,
    "redundant action explanations should stay hidden");
});

test("mini-program login is concise and keeps both WeChat phone and password entry", () => {
  const json = JSON.parse(read("miniprogram-app", "miniprogram", "pages", "login", "index.json"));
  const wxml = read("miniprogram-app", "miniprogram", "pages", "login", "index.wxml");
  const wxss = read("miniprogram-app", "miniprogram", "pages", "login", "index.wxss");
  const context = read("PROJECT_CONTEXT.md");

  assert.equal(json.navigationStyle, "custom");
  assert.match(wxml, /id="login-brand-image"[^>]*src="\/images\/login\/brand-team\.jpg"[^>]*mode="widthFix"/);
  assert.doesNotMatch(wxml, /login-system-mark|>露<\/view>/,
    "the co-branded login image must not receive a second standalone 露 mark");
  assert.match(wxml, /open-type="getPhoneNumber"/);
  assert.match(wxml, /id="login-phone"/);
  assert.match(wxml, /id="login-password"/);
  assert.match(wxml, /passwordVisible\s*\?\s*'隐藏'\s*:\s*'显示'/);
  assert.doesNotMatch(wxml, /安全工作台|统一入口|登录说明|温馨提示/,
    "login page should not reintroduce explanatory filler");
  assert.match(wxss, /\.login-hero\s*\{[^}]*width:\s*100%[^}]*border-radius:/s);
  for (const color of ["#0d0b09", "#c8a566", "#f8f3eb", "#087f52", "#8c682f"]) {
    assert.match(wxss, new RegExp(color, "i"), `login palette is missing ${color}`);
  }
  assert.match(wxss, /\.wechat-login\s*\{[^}]*#087f52/s,
    "WeChat phone authorization must remain visually green");
  assert.match(context, /登录页配色从人物图提取黑、金、暖白层级/);
});

test("mini-program keeps the company brand visible after login", () => {
  const json = JSON.parse(read("miniprogram-app", "miniprogram", "pages", "home", "index.json"));
  const wxml = read("miniprogram-app", "miniprogram", "pages", "home", "index.wxml");
  const context = read("PROJECT_CONTEXT.md");

  assert.equal(json.navigationBarTitleText, "露思卓儿", "the native mini-program title keeps the brand visible above every role home");
  assert.match(wxml, /class="workspace-topbar"/);
  assert.match(wxml, /\{\{roleTitle\}\}/);
  assert.match(context, /人物图只用于小程序登录页/);
  assert.match(context, /登录后各角色工作台顶部必须明确显示文字品牌名“露思卓儿”/);
});

test("all three mini-program homes reproduce the mobile web content layout", () => {
  const js = read("miniprogram-app", "miniprogram", "pages", "home", "index.js");
  const wxml = read("miniprogram-app", "miniprogram", "pages", "home", "index.wxml");
  const wxss = read("miniprogram-app", "miniprogram", "pages", "home", "index.wxss");
  const context = read("PROJECT_CONTEXT.md");

  for (const action of ["getTeacherWorkspace", "getTeacherBusinessCustomers", "getStoreDashboard",
    "getStoreBusinessAnalytics", "queryStoreBusinessRecords", "getHqDashboard"]) {
    assert.match(js, new RegExp(action), `home must load ${action}`);
  }
  for (const heading of ["我的工作台", "门店全局视图", "总部数据看板", "时间范围与业务汇总",
    "本人业务明细", "本门店业务明细", "活跃用户", "封存用户", "完整排名"]) {
    assert.match(`${js}\n${wxml}`, new RegExp(heading), `missing mobile-web heading ${heading}`);
  }
  assert.match(wxml, /class="workspace-rail"[^>]*scroll-x/);
  assert.match(wxml, /class="table-scroll summary-scroll"[^>]*scroll-x/);
  assert.match(wxml, /session\.role === 'teacher'/);
  assert.match(wxml, /session\.role === 'store'/);
  assert.match(wxml, /session\.role === 'hq'/);
  assert.match(wxss, /\.record-tabs\s*\{[^}]*grid-template-columns:\s*repeat\(2,/s);
  assert.match(wxss, /\.metric-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s,
    "the 390px web breakpoint renders HQ metrics in one column");
  assert.match(wxss, /\.summary-table\s*\{\s*width:\s*1300rpx;/);
  assert.match(wxss, /\.record-table\s*\{\s*width:\s*1360rpx;/);
  assert.match(wxss, /\.customer-table\s*\{\s*width:\s*1240rpx;/);
  assert.match(context, /模块顺序、文案、字号、间距、颜色、卡片边框与圆角、按钮排列、表格列宽/);
  assert.match(context, /微信原生状态栏、右上角胶囊、导航栏与浏览器自身地址栏属于平台边界/);
});

test("home dashboard mapper preserves web metric and profile column semantics", () => {
  const rows = dashboard.hqRows([{ entityId: "1", entityName: "中心店", entityCode: "S001",
    recharge: 12, verification: 9, experience: 3, refund: 2 }], "store");
  assert.deepEqual(rows[0].bars.map((bar) => bar.metric), ["recharge", "verification", "experience", "refund"]);
  assert.equal(rows[0].businessTotal, 26);
  assert.equal(rows[0].name, "中心店 · S001");
  assert.deepEqual(dashboard.storeFacts({
    auth_uid: "uid-demo", store_code: "S001", store_name: "中心店", province: "江西省",
    city: "南昌市", district: "红谷滩区", address_detail: "测试路", store_status: "ACTIVE",
    contact_name: "联系人", contact_phone: "13900000000"
  }).map((fact) => fact.label), ["唯一身份 ID", "业务编号", "门店名称", "地区", "详细地址", "门店状态", "联系人", "联系电话"]);
  assert.equal(dashboard.storeCustomerGroups({ store_name: "中心店", customers: [{ customer_code: "C001" }], customer_total: 1 }).active.rows[0].storeName, "中心店");
});

test("customer data views use deliberate horizontal tables on narrow screens", () => {
  for (const page of ["customers", "customer-detail"]) {
    const wxml = read("miniprogram-app", "miniprogram", "pages", page, "index.wxml");
    const wxss = read("miniprogram-app", "miniprogram", "pages", page, "index.wxss");
    assert.match(wxml, /<scroll-view\b[^>]*\bscroll-x\b/,
      `${page} must expose horizontal scrolling instead of crushing table columns`);
    assert.match(wxss, /(?:min-)?width:\s*\d+rpx/,
      `${page} must retain an explicit table width for predictable mobile columns`);
  }
});

test("cross-client context records visual parity without coupling source trees", () => {
  const context = read("PROJECT_CONTEXT.md");
  const isolation = read("tests", "client-isolation-contract.test.js");

  assert.match(context, /小程序.*网页版.*手机端|网页版.*手机端.*小程序/);
  assert.match(context, /小程序继续使用原生 WXML／WXSS／小程序会话和微信能力/);
  assert.match(isolation, /miniprogram-app/);
  assert.match(isolation, /native-app/);
});
