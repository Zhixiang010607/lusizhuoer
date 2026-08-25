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

  for (const token of ["#6f532e", "#a98243", "#607c6a", "#302a22", "#7c7062", "#dfcfb4", "#f3ede2"]) {
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
  const backgroundPath = path.join(root, "miniprogram-app", "miniprogram", "images", "login", "lusizhuoer-login-bg-v3.jpg");

  assert.equal(json.navigationStyle, "custom");
  assert.equal((wxml.match(/<image\b/g) || []).length, 1, "login must use one background image and no portrait image");
  assert.match(wxml, /class="login-background" src="\/images\/login\/lusizhuoer-login-bg-v3\.jpg" mode="aspectFill"/);
  assert.doesNotMatch(wxml, /login-brand-image|brand-team\.jpg|海洋之韵|OCEAN\s+WONDER/i,
    "the login page must not restore a portrait or the combined Ocean Wonder artwork");
  assert.ok(fs.existsSync(backgroundPath), "generated Lusizhuoer login background is missing");
  assert.ok(fs.statSync(backgroundPath).size < 250 * 1024, "login background must stay below 250 KB for the mini-program package");
  assert.match(wxml, /class="login-brand"><text>露思卓儿<\/text><\/view>/,
    "the exact four-character wordmark must remain native WXML text");
  assert.match(wxml, /class="login-card">[\s\S]*id="login-phone"[\s\S]*id="login-password"[\s\S]*id="login-submit"[\s\S]*id="login-wechat-phone"[\s\S]*id="login-message"/,
    "all login text and controls must remain inside the centered curved frame");
  assert.doesNotMatch(wxml, /brand-rule|login-divider|登录系统|快捷登录/,
    "the login must not restore decorative or explanatory template copy");
  assert.doesNotMatch(wxml, /login-system-mark|海洋之韵/);
  assert.match(wxml, /open-type="getPhoneNumber"/);
  assert.match(wxml, />\s*<text>微信手机号登录<\/text>\s*<\/button>/);
  assert.match(wxml, /class="password-reset-row"><text class="password-reset-link" role="button" bindtap="openPasswordReset">修改密码<\/text><\/view>/);
  assert.match(wxml, /class="eye-icon \{\{passwordVisible \? 'visible' : ''\}\}"/);
  assert.doesNotMatch(wxml, /\{\{passwordVisible \? '隐藏' : '显示'\}\}/,
    "password visibility must use the eye icon instead of awkward text");
  assert.match(wxml, /id="login-phone"/);
  assert.match(wxml, /id="login-password"/);
  assert.match(wxml, /aria-label="\{\{passwordVisible \? '隐藏密码' : '显示密码'\}\}"/);
  assert.doesNotMatch(wxml, /安全工作台|统一入口|登录说明|温馨提示/,
    "login page should not reintroduce explanatory filler");
  assert.match(wxss, /\.login-page\s*\{[^}]*align-items:\s*center[^}]*background:\s*#f3ede2/s);
  assert.match(wxss, /\.login-card\s*\{[^}]*background:\s*rgba\(255, 252, 246, \.9\)[^}]*border-radius:\s*104rpx 104rpx 38rpx 38rpx/s,
    "the login form must be a centered warm curved frame");
  assert.match(wxss, /\.login-brand text\s*\{[^}]*color:\s*#87662f[^}]*letter-spacing:\s*18rpx/s);
  for (const color of ["#f3ede2", "#87662f", "#675b4b", "#302a22", "#a98243"]) {
    assert.match(wxss, new RegExp(color, "i"), `login palette is missing ${color}`);
  }
  assert.match(wxss, /\.wechat-login\s*\{[^}]*display:\s*flex[^}]*align-items:\s*center[^}]*justify-content:\s*center/s,
    "the exact WeChat phone login wording must be centered in both axes");
  assert.match(wxss, /\.wechat-login\s*\{[^}]*width:\s*420rpx\s*!important[^}]*min-width:\s*0[^}]*height:\s*76rpx[^}]*border-radius:\s*38rpx/s,
    "WeChat phone login must remain a deliberately sized rounded secondary button instead of a divider label");
  assert.doesNotMatch(wxml, /alternate-line/, "WeChat phone login must not be squeezed between decorative divider lines");
  assert.match(wxml, /<view class="password-toggle" role="button"[^>]*bindtap="togglePassword">/,
    "the eye icon control must avoid the native button minimum width");
  assert.match(wxss, /\.password-toggle\s*\{[^}]*display:\s*flex[^}]*align-items:\s*center[^}]*justify-content:\s*center[^}]*width:\s*96rpx[^}]*height:\s*82rpx/s,
    "the eye icon must stay vertically centered at the right edge");
  assert.match(wxss, /\.password-reset-row\s*\{[^}]*justify-content:\s*flex-end/s,
    "the password reset entry belongs below the password field at the right edge");
  assert.doesNotMatch(wxss, /#16845b/i, "login must not reintroduce a saturated green button");
  assert.match(context, /暖象牙白、浅香槟金竖屏品牌图/);
  assert.match(context, /清晰可辨的标志轮廓/);
  assert.match(context, /整体颜色不能压得过深/);
});

test("mini-program keeps the company brand in native navigation without duplicating the HQ content title", () => {
  const json = JSON.parse(read("miniprogram-app", "miniprogram", "pages", "home", "index.json"));
  const wxml = read("miniprogram-app", "miniprogram", "pages", "home", "index.wxml");
  const context = read("PROJECT_CONTEXT.md");

  assert.equal(json.navigationBarTitleText, "露思卓儿", "the native mini-program title keeps the brand visible above every role home");
  assert.match(wxml, /class="workspace-topbar"/);
  assert.match(wxml, /<view wx:if="\{\{session\.role === 'hq'\}\}"><text class="topbar-role hq-page-title">\{\{roleTitle\}\}<\/text><\/view>/,
    "HQ content must match the web page title without a duplicate brand heading");
  assert.match(wxml, /<view wx:else><text class="topbar-eyebrow">[\s\S]*class="topbar-title">露思卓儿<\/text>/,
    "teacher/store content keeps the brand structure while their web parity is retained");
  assert.match(wxml, /class="topbar-role">\{\{roleTitle\}\}<\/text>/,
    "the role-specific home title must remain a subtitle of the brand");
  assert.match(context, /小程序登录页不显示人物照/);
  assert.match(context, /微信原生导航栏统一显示文字品牌名“露思卓儿”/);
  assert.match(context, /小程序不得再叠加一遍品牌大标题/);
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
