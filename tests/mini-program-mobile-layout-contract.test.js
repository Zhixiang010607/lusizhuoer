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
  assert.match(wxss, /\.picker\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s,
    "picker values must remain inside their rounded field on one line");
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
  const storeDetailWxml = read("miniprogram-app", "miniprogram", "pages", "store-detail", "index.wxml");
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
  assert.match(wxml, /<view class="detail-anchor-nav"><view class="anchor-inner">/,
    "the four store anchors must use a content-height view instead of a real-device default-height scroll-view");
  assert.doesNotMatch(wxml, /<scroll-view class="detail-anchor-nav"/,
    "the store anchor bar must not inherit WeChat scroll-view's device-only default height");
  assert.match(wxml, /class="table-scroll summary-scroll" style="height: \{\{summaryRows\.length \? 76 \+ summaryRows\.length \* 94 : 186\}\}rpx;"/,
    "the store/teacher project summary viewport must grow and shrink with its actual row count");
  assert.match(wxml, /class="table-scroll summary-scroll" style="height: \{\{76 \+ \(hqProjectSummaryRows\.length \+ 1\) \* 94 \+ \(!hqProjectSummaryRows\.length \? 110 : 0\)\}\}rpx;"/,
    "the HQ project summary viewport must also use a data-driven real-device height");
  assert.match(wxml, /session\.role === 'teacher'/);
  assert.match(wxml, /session\.role === 'store'/);
  assert.match(wxml, /session\.role === 'hq'/);
  assert.match(wxss, /\.record-tabs\s*\{[^}]*grid-template-columns:\s*repeat\(2,/s);
  assert.match(wxss, /\.hq-ranking-control-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*\.85fr\)\s+minmax\(0,\s*1\.15fr\)[^}]*align-items:\s*end/s,
    "the standard-phone HQ filter card must use a compact two-by-two grid instead of four tall rows");
  assert.match(wxss, /\.hq-ranking-control-grid \.hq-dimension-tabs,\s*\.hq-ranking-control-grid \.hq-product-filter\s*\{\s*margin-bottom:\s*0;/,
    "the two-by-two HQ controls must not carry desktop-only bottom gaps");
  assert.match(wxss, /\.hq-ranking-control-grid \.filter-picker\s*\{[^}]*color:\s*#5f4a2f;[^}]*background:\s*#f5ead8;[^}]*border-color:\s*#d8c5a3;/s,
    "the time and project pickers must share the warm champagne filter palette");
  assert.match(wxss, /\.hq-ranking-control-grid \.hq-dimension-tabs\s*\{[^}]*height:\s*64rpx;[^}]*min-height:\s*64rpx;[^}]*padding:\s*6rpx;/s,
    "the mobile segmented controls must have the exact same outer height as the pickers");
  assert.match(wxss, /\.hq-ranking-control-grid \.hq-dimension-tabs button\s*\{[^}]*height:\s*52rpx;[^}]*min-height:\s*0;/s,
    "the inner buttons must fit inside the shared 64rpx control height instead of enlarging it");
  assert.match(wxss, /\.hq-custom-dates\s*\{[^}]*grid-column:\s*1 \/ -1;/s,
    "a custom HQ date range must remain full width below the compact controls");
  assert.match(wxml, /class="hq-control-field hq-product-filter"[\s\S]*class="hq-control-heading"[\s\S]*项目范围[\s\S]*class="hq-inline-reset" bindtap="resetHqRange">恢复默认<\/button>/,
    "the mobile HQ default action must stay in the project-scope half of the grid");
  assert.match(wxss, /\.hq-inline-reset\s*\{[^}]*min-width:\s*0;[^}]*min-height:\s*34rpx;[^}]*background:\s*transparent;[^}]*border:\s*0;/s,
    "the inline default action must remain a low-emphasis text control on a standard phone");
  assert.doesNotMatch(wxml, /排序指标<\/text><button class="hq-inline-reset"/,
    "the sorting metric heading must not contain the reset action");
  assert.doesNotMatch(wxml, /class="hq-filter-actions"/,
    "the HQ reset action must not occupy a standalone row");
  assert.doesNotMatch(wxml, /class="metric-grid"|hq-analysis-card|分类统计|前 10 名/,
    "the compact HQ home must not restore the redundant six metrics or duplicate Top 10 card");
  assert.match(wxss, /\.range-presets\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)[^}]*overflow:\s*hidden[^}]*background:\s*#eee3d2/s);
  assert.match(wxss, /\.range-button\s*\{[^}]*width:\s*100%\s*!important[^}]*max-width:\s*100%[^}]*align-items:\s*center[^}]*justify-content:\s*center/s);
  assert.match(wxss, /\.range-button\.active\s*\{[^}]*background:\s*#fffaf3[^}]*border-color:\s*#d9bd8c/s);
  assert.doesNotMatch(wxss, /\.range-presets\s*\{[^}]*background:\s*#edf2f8/s);
  assert.match(wxss, /\.summary-table\s*\{\s*width:\s*100%;\s*min-width:\s*960rpx;/);
  assert.match(wxss, /\.detail-anchor-nav\s*\{[^}]*height:\s*84rpx;[^}]*overflow:\s*hidden/s);
  assert.match(wxss, /\.anchor-inner\s*\{[^}]*width:\s*100%;[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(wxss, /\.anchor-inner text\s*\{[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*font-size:\s*23rpx/s);
  assert.match(wxss, /\.summary-scroll\s*\{[^}]*box-sizing:\s*border-box/s);
  assert.match(wxss, /\.record-table\s*\{\s*width:\s*100%;\s*min-width:\s*950rpx;/);
  assert.match(js, /function businessRecordsView\(items, type\)[\s\S]*businessViewportHeight:\s*64 \+ \(visibleRows \? visibleRows \* 72 : 104\)[\s\S]*businessScrollable:\s*businessRecords\.length > 5/,
    "business detail must grow for one to five rows and become internally scrollable only after five rows");
  assert.match(wxml, /class="table-scroll record-scroll"[^>]*scroll-x[^>]*scroll-y="\{\{businessScrollable\}\}"[^>]*show-scrollbar="\{\{businessScrollable\}\}"[^>]*style="height: \{\{businessViewportHeight\}\}rpx"/,
    "the calculated business-detail viewport must drive the real-device scroll-view height");
  assert.match(wxml, /wx:if="\{\{businessScrollable\}\}" class="record-scroll-hint">超过 5 条，可在表格内上下滑动<\/text>/,
    "a long business list must visibly explain its internal vertical scrolling");
  assert.match(wxss, /\.record-scroll\s*\{[^}]*box-sizing:\s*border-box;[^}]*overflow:\s*auto;/s,
    "business detail scrolling must stay clipped inside its rounded table card");
  assert.match(wxss, /\.customer-table\s*\{\s*width:\s*100%;\s*min-width:\s*620rpx;/,
    "the five-column customer table must fit the standard card before horizontal scrolling is needed");
  assert.doesNotMatch(wxss, /\.customer-table\s*\{[^}]*min-width:\s*700rpx/s,
    "a fixed 700rpx minimum creates a meaningless sliver of horizontal scrolling on standard phones");
  assert.match(wxss, /\.summary-table \.table-row\s*\{[^}]*minmax\(180rpx,\s*1\.25fr\)[^}]*repeat\(4,\s*minmax\(195rpx,\s*1fr\)\)/s);
  assert.match(wxss, /\.summary-table \.table-row\s*\{[^}]*height:\s*82rpx;[^}]*min-height:\s*82rpx/s);
  assert.match(wxss, /\.summary-table \.table-head\s*\{[^}]*height:\s*64rpx;[^}]*min-height:\s*64rpx/s);
  assert.match(wxss, /\.table-row > view\s*\{[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s);
  assert.match(wxss, /\.detail-info-item text\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s,
    "profile facts must not split identifiers and phone numbers across lines");
  assert.match(wxss, /\.hq-ranking-list\s*\{[^}]*overflow:\s*hidden[^}]*border-radius:/s,
    "the mobile HQ ranking stays inside one bounded table card");
  assert.match(wxss, /\.hq-ranking-row\s*\{[^}]*grid-template-columns:[^}]*repeat\(4,/s,
    "rank, name, and all four metrics must share one bounded row");
  assert.match(wxss, /\.summary-table \.table-head \.summary-product\s*\{[^}]*align-items:\s*center\s*!important;[^}]*text-align:\s*center;/s,
    "the project summary header must be centered while project rows remain left aligned");
  assert.equal((wxml.match(/class="summary-product">项目<\/view>/g) || []).length, 2,
    "store/teacher and HQ service summaries must use 项目 rather than the separate retail 产品 concept");
  assert.match(wxss, /\.table-pagination > text\s*\{[^}]*text-align:\s*center;[^}]*white-space:\s*nowrap;/s,
    "previous, page summary, and next must stay on one centered row");
  assert.match(storeDetailWxml, /data-code="\{\{item\.customerCode\}\}" bindtap="openCustomer">\{\{item\.customerName\}\}<\/view>/);
  assert.doesNotMatch(storeDetailWxml, /\{\{item\.customerName\}\}\s*·\s*\{\{item\.customerCode\}\}/);
  assert.match(context, /模块顺序、文案、字号、间距、颜色、卡片边框与圆角、按钮排列、表格列宽/);
  assert.match(context, /微信原生状态栏、右上角胶囊、导航栏与浏览器自身地址栏属于平台边界/);
});

test("mobile management controls stay centered without breaking data into characters", () => {
  const customers = read("miniprogram-app", "miniprogram", "pages", "customers", "index.wxss");
  const reviews = read("miniprogram-app", "miniprogram", "pages", "reviews", "index.wxss");
  const teacher = read("miniprogram-app", "miniprogram", "pages", "teacher-detail", "index.wxss");

  assert.match(customers, /\.pager text\s*\{[^}]*text-align:\s*center;[^}]*white-space:\s*nowrap;/s);
  for (const selector of ["review-type-tabs button", "mode-tabs button", "review-action button"]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(reviews, new RegExp(`\\.${escaped}\\s*\\{[^}]*display:\\s*flex;[^}]*align-items:\\s*center;[^}]*justify-content:\\s*center;[^}]*white-space:\\s*nowrap;`, "s"),
      `${selector} must center its label in both axes`);
  }
  assert.match(teacher, /\.quota-facts\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);[^}]*gap:\s*12rpx;/s,
    "each configured product must use a real two-by-two fact grid");
  assert.match(teacher, /\.quota-facts view\s*\{[^}]*min-height:\s*104rpx;[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*text-align:\s*center;/s,
    "configured-product facts must be centered inside equal cells");
  assert.match(teacher, /\.quota-facts text:first-child\s*\{[^}]*font-size:\s*19rpx;/s);
  assert.match(teacher, /\.quota-facts text:last-child\s*\{[^}]*font-size:\s*24rpx;[^}]*white-space:\s*nowrap;/s);
  assert.match(teacher, /\.history-row text\s*\{[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s);
  assert.match(teacher, /\.history-row > view:first-child text:nth-child\(3\)\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*white-space:\s*normal;/s,
    "only a free-form history note may wrap; dates, counts, names, and codes stay intact");
  assert.match(teacher, /\.teacher-profile-hero, \.security-panel, \.experience-panel\s*\{[^}]*border-color:\s*#e1cfaf;[^}]*background:\s*#fffaf3/s,
    "HQ teacher profile, account, and quota panels must use the same card palette as other pages");
  assert.match(teacher, /\.overview-card\s*\{[^}]*background:\s*#fff8ec;[^}]*border:\s*1rpx solid #dfcfb4/s);
  assert.match(teacher, /\.overview-card\.primary-card\s*\{[^}]*background:\s*#f6ead7;[^}]*border-color:\s*#d9bd8c/s);
  assert.doesNotMatch(teacher, /#f4dfba|#eef3e9|#f2ebf0|#f8ead7/,
    "teacher detail must not mix several unrelated card background colors");
  assert.doesNotMatch(teacher, /\.overview-card\s*\{[^}]*background:\s*#fff;/s);
  assert.doesNotMatch(teacher, /\.summary-item\s*\{[^}]*background:\s*#fff;/s);
  assert.doesNotMatch(teacher, /\.quota-card\s*\{[^}]*background:\s*#fff;/s);
  const teacherWxml = read("miniprogram-app", "miniprogram", "pages", "teacher-detail", "index.wxml");
  const teacherJs = read("miniprogram-app", "miniprogram", "pages", "teacher-detail", "index.js");
  assert.match(teacherWxml, /class="teacher-profile-meta"><text>编号 \{\{profile\.code\}\}<\/text><text>电话 \{\{profile\.phone\}\}<\/text>/,
    "teacher code and phone move into the compact top profile hero");
  assert.doesNotMatch(teacherWxml, /class="web-panel teacher-record-panel"|<text class="panel-title">老师档案<\/text>/,
    "the redundant standalone teacher profile panel must be removed");
  assert.doesNotMatch(`${teacherWxml}\n${teacherJs}`, /密码状态|passwordStatus/,
    "HQ teacher profile must not repeat a derived password status above the password-management form");
  assert.match(teacherWxml, /class="quota-facts"><view><text>每月基础<\/text>[\s\S]*<view><text>本月已体验<\/text>/);
  assert.doesNotMatch(teacherWxml, /<text>单独充值<\/text>|<text>最近更新<\/text>|manualRechargeCount|monthlyResetText/,
    "configured product cards show only the monthly base and current-month usage");
  assert.match(teacherWxml, /<text class="subsection-title">单独充值体验次数<\/text>/,
    "removing summary facts must not remove the actual top-up workflow");
  assert.match(teacherWxml, /class="history-list"[^>]*scroll-y[^>]*>[\s\S]*wx:for="\{\{history\}\}"/,
    "quota ledger stays inside its own vertical scrolling region");
  assert.match(teacher, /\.history-list\s*\{[^}]*max-height:\s*680rpx;[^}]*box-sizing:\s*border-box;[^}]*overflow-y:\s*auto;/s);
  assert.doesNotMatch(teacherWxml, /查看全部|收起记录|bindtap="toggleHistory"/);
  assert.doesNotMatch(teacherJs, /historyExpanded|visibleHistory|toggleHistory/,
    "the page must not expand the entire quota ledger into the document");
});

test("home dashboard mapper preserves web metric and profile column semantics", () => {
  const js = read("miniprogram-app", "miniprogram", "pages", "home", "index.js");
  const wxss = read("miniprogram-app", "miniprogram", "pages", "home", "index.wxss");
  const storeDetailWxml = read("miniprogram-app", "miniprogram", "pages", "store-detail", "index.wxml");
  const rows = dashboard.hqRows([{ entityId: "1", entityName: "中心店", entityCode: "S001",
    recharge: 12, verification: 9, experience: 3, refund: 2 }], "store");
  assert.deepEqual(rows[0].bars.map((bar) => bar.metric), ["recharge", "verification", "experience", "refund"]);
  assert.equal(rows[0].businessTotal, 26);
  assert.equal(rows[0].name, "中心店");
  assert.equal(rows[0].entityCode, "S001");
  const teacherRows = dashboard.hqRows([{ entityId: "2", entityName: "苗苗", entityCode: "TCHF420",
    recharge: 1, verification: 2, experience: 3, refund: 4 }], "teacher");
  assert.equal(teacherRows[0].name, "苗苗", "teacher ranking keeps the code internally but displays only the teacher name");
  assert.equal(teacherRows[0].entityCode, "TCHF420");
  const storeFacts = dashboard.storeFacts({
    auth_uid: "uid-demo", store_code: "S001", store_name: "中心店", province: "江西省",
    city: "南昌市", district: "红谷滩区", address_detail: "测试路", store_status: "ACTIVE",
    contact_name: "联系人", contact_phone: "13900000000"
  });
  assert.deepEqual(storeFacts.map((fact) => fact.label), ["地区", "详细地址", "联系人", "联系电话"]);
  assert.deepEqual(storeFacts.map((fact) => Boolean(fact.wide)), [true, true, false, false],
    "region and detailed address must use safe full-width cards while contact facts remain compact");
  assert.match(js, /rangePreset:\s*"TODAY", rangeOptions:\s*readyRangeOptions\("TODAY"\)/,
    "teacher and store role homes must default to today");
  assert.match(storeDetailWxml, /<text class="profile-type">门店<\/text>[\s\S]*业务编号 \{\{storeHero\.code\}\}/,
    "the store hero must show the useful business code instead of the long Auth UID");
  assert.match(storeDetailWxml, /class="panel-title">联系与地址<\/text>[\s\S]*class="detail-info-grid store-profile-facts"/,
    "the store profile must not repeat identity facts already present in the hero");
  assert.match(wxss, /\.store-profile-facts\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)[^}]*background:\s*transparent/s,
    "the four store contact facts use the shared compact warm layout");
  assert.match(wxss, /\.store-profile-facts \.store-address-fact\s*\{[^}]*grid-column:\s*1\s*\/\s*-1[^}]*\}/s,
    "store addresses must span the full contact grid instead of being truncated in a half-width card");
  assert.match(wxss, /\.store-profile-facts \.store-address-fact text:last-child\s*\{[^}]*white-space:\s*normal[^}]*word-break:\s*break-all/s,
    "long store addresses must remain completely readable");
  assert.match(storeDetailWxml, /class="detail-info-item \{\{item\.wide \? 'store-address-fact' : ''\}\}"/,
    "store detail must apply the safe address layout marker from the shared mapper");
  assert.equal(dashboard.storeCustomerGroups({ store_name: "中心店", customers: [{ customer_code: "C001" }], customer_total: 1 }).active.rows[0].storeName, "中心店");
  assert.equal(dashboard.records([{ submitted_at: "2026-08-27 12:34:56+00" }])[0].submittedAt, "2026-08-27 20:34",
    "business detail accepts PostgreSQL snake-case timestamps and renders Shanghai wall time");
  assert.equal(dashboard.records([{ application_time: { $date: "2026-08-27T12:34:56.000Z" } }])[0].submittedAt, "2026-08-27 20:34",
    "business detail accepts wrapped CloudBase timestamps from alternate query paths");
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
