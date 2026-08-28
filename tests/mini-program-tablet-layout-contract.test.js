"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

test("mini-program shared controls stop scaling after the tablet breakpoint", () => {
  const wxss = read("miniprogram-app", "miniprogram", "app.wxss");
  assert.match(wxss, /@media \(min-width: 700px\) \{/);
  assert.match(wxss, /page \.page \{[^}]*max-width: 1120px;[^}]*padding: 20px 0 36px;/s);
  assert.match(wxss, /page \.input, page \.picker, page \.textarea \{[^}]*min-height: 48px;[^}]*font-size: 16px;/s);
  assert.match(wxss, /page \.primary, page \.secondary, page \.danger, page \.ghost \{[^}]*min-height: 48px;[^}]*font-size: 16px;/s);
  assert.match(wxss, /page \.button-row \{ gap: 12px; \}/,
    "tablet action rows must retain a physical gap between controls");
  assert.match(wxss, /page \.facts \{[^}]*grid-template-columns: repeat\(auto-fit, minmax\(180px, 1fr\)\);/s,
    "compact facts should fill available tablet columns without leaving a forced empty half");
});

test("login and password reset use bounded tablet forms", () => {
  const login = read("miniprogram-app", "miniprogram", "pages", "login", "index.wxss");
  const reset = read("miniprogram-app", "miniprogram", "pages", "password-reset", "index.wxss");

  assert.match(login, /@media \(min-width: 700px\) \{/);
  assert.match(login, /\.login-shell \{ max-width: 500px; \}/);
  assert.match(login, /\.login-card \{[^}]*padding: 46px 44px 38px;[^}]*border-radius: 56px 56px 26px 26px;/s);
  assert.match(login, /\.login-card \.input \{[^}]*min-height: 54px;[^}]*font-size: 17px;/s);
  assert.match(login, /\.wechat-login \{[^}]*width: 320px !important;[^}]*height: 48px;/s);
  assert.match(reset, /@media \(min-width: 700px\) \{/);
  assert.match(reset, /\.reset-card \{[^}]*max-width: 540px;[^}]*padding: 42px 44px 36px;/s);
});

test("role homes use a bounded tablet dashboard instead of a magnified phone", () => {
  const js = read("miniprogram-app", "miniprogram", "pages", "home", "index.js");
  const wxml = read("miniprogram-app", "miniprogram", "pages", "home", "index.wxml");
  const wxss = read("miniprogram-app", "miniprogram", "pages", "home", "index.wxss");
  const context = read("PROJECT_CONTEXT.md");

  assert.match(wxss, /@media \(min-width: 700px\) \{/);
  assert.match(wxss, /\.workspace-main, \.role-teacher \.workspace-main \{[^}]*max-width: 1120px;[^}]*margin: 20px auto 0;/s);
  assert.match(wxss, /\.role-store \.workspace-main \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);[^}]*gap: 16px;/s);
  assert.match(wxss, /\.role-teacher \.workspace-main \{[^}]*grid-template-columns: minmax\(240px, \.72fr\) minmax\(0, 1\.28fr\);[^}]*gap: 16px;/s,
    "teacher profile and quota cards should use the available tablet width");
  assert.match(wxss, /\.role-store \.workspace-main > \.overview-panel,[\s\S]*?\.role-store \.workspace-main > \.customer-panel,[\s\S]*?grid-column: 1 \/ -1;/,
    "wide data tables stay full width while compact profile cards may use two columns");
  assert.match(wxss, /\.range-presets \{[^}]*grid-template-columns: repeat\(7, minmax\(0, 1fr\)\);[^}]*gap: 8px;/s);
  assert.match(wxss, /\.record-tabs \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);[^}]*gap: 8px;/s,
    "business tabs must not overlap or float over one another on iPad");
  assert.match(wxss, /\.summary-scroll \{ height: auto !important; \}/,
    "project summary height must follow its real tablet rows");
  assert.match(wxss, /\.record-scroll\[data-visible-rows="5"\], \.customer-scroll\[data-visible-rows="5"\] \{ height: 328px !important; \}/,
    "long tablet lists must stop at five compact rows before internal scrolling");
  assert.match(wxss, /\.archived-section \{ border-color: #e1cfaf; background: #fffaf3; \}/,
    "the archived section must share the warm ivory card palette");
  assert.match(wxml, /class="table-scroll record-scroll" data-visible-rows="\{\{businessTabletVisibleRows\}\}"/);
  assert.match(wxml, /class="table-scroll customer-scroll" data-visible-rows="\{\{activeCustomers\.tabletVisibleRows\}\}"/);
  assert.match(js, /businessTabletVisibleRows: visibleRows/);
  assert.match(js, /tabletVisibleRows: Math\.min\(5, rows\.length\)/);
  assert.match(context, /小程序在平板（含 iPad）上不得把手机 `rpx` 版面按屏宽整体放大/);
});

test("query and review pages use compact tablet filters and five-row result viewports", () => {
  const customersWxml = read("miniprogram-app", "miniprogram", "pages", "customers", "index.wxml");
  const customersWxss = read("miniprogram-app", "miniprogram", "pages", "customers", "index.wxss");
  const recordsWxml = read("miniprogram-app", "miniprogram", "pages", "records", "index.wxml");
  const recordsWxss = read("miniprogram-app", "miniprogram", "pages", "records", "index.wxss");
  const reviewsWxml = read("miniprogram-app", "miniprogram", "pages", "reviews", "index.wxml");
  const reviewsWxss = read("miniprogram-app", "miniprogram", "pages", "reviews", "index.wxss");
  const directoryWxml = read("miniprogram-app", "miniprogram", "pages", "hq-directory", "index.wxml");
  const directoryWxss = read("miniprogram-app", "miniprogram", "pages", "hq-directory", "index.wxss");

  for (const wxss of [customersWxss, recordsWxss, reviewsWxss, directoryWxss]) {
    assert.match(wxss, /@media \(min-width: 700px\) \{/,
      "every query surface must stop scaling its phone rpx layout on an iPad");
  }
  for (const wxss of [customersWxss, recordsWxss]) {
    assert.match(wxss, /@media \(min-width: 700px\)[\s\S]*?\.query-grid \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/s,
      "tablet query conditions should use four compact columns before wrapping");
    assert.match(wxss, /@media \(min-width: 700px\)[\s\S]*?\.query-grid \.query-wide \{ grid-column: auto; \}/,
      "phone-wide fields should share compact columns only on tablets");
  }
  assert.match(reviewsWxml, /class="filter-switches \{\{recordType === 'RECHARGE' \? 'has-review-types' : ''\}\}"/,
    "review type and query mode switches must belong to one filter workbench");
  assert.doesNotMatch(reviewsWxml, /class="fixed-type"/,
    "review type already comes from the active review tab and must not be repeated as an odd filter tile");
  assert.match(reviewsWxss, /\.filter-switches\.has-review-types \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/s);
  assert.match(reviewsWxss, /\.review-filter-grid \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/s);
  assert.match(reviewsWxss, /\.review-query-actions \{ grid-column: span 2; margin-top: 0; \}/,
    "store, status, query, and reset must form one balanced tablet row");
  assert.match(reviewsWxss, /@media \(min-width: 700px\)[\s\S]*?\.review-table \{ width: 100%; min-width: 0; \}/s,
    "review columns must share the full tablet card width without a fixed-width overflow");
  assert.match(reviewsWxss, /\.review-type-tabs button \{[^}]*width: 100%;[^}]*min-width: 0;/s,
    "recharge and refund review tabs should fill their two balanced tablet columns");
  assert.match(directoryWxss, /\.search-fields \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/s);

  assert.match(customersWxml, /data-visible-rows="\{\{customers\.length > 5 \? 5 : customers\.length\}\}" scroll-y="\{\{customers\.length > 5\}\}"/);
  assert.match(recordsWxml, /data-visible-rows="\{\{records\.length > 5 \? 5 : records\.length\}\}" scroll-y="\{\{records\.length > 5\}\}"/);
  assert.match(reviewsWxml, /data-visible-rows="\{\{rows\.length > 5 \? 5 : rows\.length\}\}" scroll-y="\{\{rows\.length > 5\}\}"/);
  assert.equal((directoryWxml.match(/data-visible-rows=/g) || []).length, 3,
    "search, active and archived directory tables each own a five-row viewport");
  assert.match(customersWxss, /\.customer-table-scroll\[data-visible-rows="5"\] \{ height: 344px; \}/);
  assert.match(recordsWxss, /\.record-scroll\[data-visible-rows="5"\] \{ height: 344px; \}/);
  assert.match(reviewsWxss, /\.table-scroll\[data-visible-rows="5"\] \{ height: 344px; \}/);
  assert.match(directoryWxss, /\.table-scroll\[data-visible-rows="5"\] \{ height: 332px; \}/);
  assert.match(customersWxss, /@media \(min-width: 700px\)[\s\S]*?\.summary-grid text \{[^}]*min-height: 24px;[^}]*font-size: 11px;/s,
    "customer query summary must stay compact instead of magnifying its labels on iPad");
  assert.match(recordsWxss, /@media \(min-width: 700px\)[\s\S]*?\.summary-grid \.summary-value \{[^}]*font-size: 17px;/s,
    "record query totals must use a compact tablet numeral size");
  assert.match(recordsWxml, /class="button-row query-actions \{\{mode === 'browse' && !customRange \? 'inline-query-actions' : ''\}\}"/);
  assert.match(recordsWxss, /\.query-grid \.query-time \{ grid-column: 1; \}/);
  assert.match(recordsWxss, /\.query-actions\.inline-query-actions \{ grid-column: 2 \/ -1; align-self: end; \}/,
    "recharge, verification, and product searches should share the time-range row on tablets");
});

test("store and teacher workflows use bounded two-column tablet surfaces", () => {
  const createWxml = read("miniprogram-app", "miniprogram", "pages", "customer-create", "index.wxml");
  const createWxss = read("miniprogram-app", "miniprogram", "pages", "customer-create", "index.wxss");
  const rechargeWxml = read("miniprogram-app", "miniprogram", "pages", "recharge", "index.wxml");
  const rechargeWxss = read("miniprogram-app", "miniprogram", "pages", "recharge", "index.wxss");
  const purchaseWxml = read("miniprogram-app", "miniprogram", "pages", "product-purchase", "index.wxml");
  const purchaseWxss = read("miniprogram-app", "miniprogram", "pages", "product-purchase", "index.wxss");
  const verificationWxml = read("miniprogram-app", "miniprogram", "pages", "verification", "index.wxml");
  const verificationWxss = read("miniprogram-app", "miniprogram", "pages", "verification", "index.wxss");
  const pickerWxss = read("miniprogram-app", "miniprogram", "components", "customer-picker", "index.wxss");
  const cameraWxss = read("miniprogram-app", "miniprogram", "components", "camera-capture", "index.wxss");

  for (const wxss of [createWxss, rechargeWxss, purchaseWxss, verificationWxss, pickerWxss, cameraWxss]) {
    assert.match(wxss, /@media \(min-width: 700px\) \{/,
      "every store/teacher workflow surface must stop scaling rpx at the tablet breakpoint");
  }
  assert.match(createWxml, /class="create-workspace"/);
  assert.match(createWxss, /\.create-workspace \{[^}]*grid-template-columns: minmax\(0, \.82fr\) minmax\(0, 1\.18fr\);/s);
  for (const wxml of [rechargeWxml, purchaseWxml, verificationWxml]) {
    assert.match(wxml, /class="workflow-grid"/);
    assert.match(wxml, /workflow-wide/);
  }
  for (const wxss of [rechargeWxss, purchaseWxss, verificationWxss]) {
    assert.match(wxss, /\.workflow-grid \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/s);
  }
  assert.match(pickerWxss, /\.manual-fields \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/s);
  assert.match(cameraWxss, /\.preview, \.placeholder \{ height: 300px;/,
    "the shared camera preview must not become a giant rpx panel on iPad");
});

test("store and teacher customer/order details use compact adaptive tablet workspaces", () => {
  const customerWxml = read("miniprogram-app", "miniprogram", "pages", "customer-detail", "index.wxml");
  const customerWxss = read("miniprogram-app", "miniprogram", "pages", "customer-detail", "index.wxss");
  const orderWxml = read("miniprogram-app", "miniprogram", "pages", "order-detail", "index.wxml");
  const orderWxss = read("miniprogram-app", "miniprogram", "pages", "order-detail", "index.wxss");

  assert.match(customerWxml, /class="customer-communication-grid"/);
  assert.match(customerWxml, /class="customer-summary-grid"/);
  assert.match(customerWxml, /class="table-scroll balance-scroll"[^>]*data-visible-rows="\{\{balances\.length > 5 \? 5 : balances\.length\}\}"[^>]*scroll-y="\{\{balances\.length > 5\}\}"/);
  assert.match(customerWxml, /class="retail-summary-scroll" data-visible-rows="\{\{retailProductSummary\.length > 5 \? 5 : retailProductSummary\.length\}\}"/);
  assert.match(customerWxml, /class="table-scroll record-scroll"[^>]*data-visible-rows="\{\{visibleHistory\.length > 5 \? 5 : visibleHistory\.length\}\}"[^>]*scroll-y="\{\{visibleHistory\.length > 5\}\}"/);
  assert.match(customerWxss, /@media \(min-width: 700px\)[\s\S]*?\.customer-communication-grid, \.customer-summary-grid \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/s);
  assert.match(customerWxss, /\.record-scroll\[data-visible-rows="5"\] \{ height: 308px; \}/);
  assert.match(orderWxml, /class="order-secondary-grid"/);
  assert.match(orderWxss, /@media \(min-width: 700px\)[\s\S]*?\.order-hero \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/s,
    "recharge, refund, normal verification, and experience verification must share a compact horizontal tablet header");
  assert.match(orderWxss, /@media \(min-width: 700px\)[\s\S]*?\.fact-grid \{ grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/s);
  assert.match(orderWxml, /class="detail-time"/);
  assert.match(orderWxss, /\.detail-grid \.detail-time \.detail-value \{[^}]*overflow: visible;[^}]*text-overflow: clip;/s,
    "tablet work-order timestamps must remain complete instead of becoming an ellipsis");
  assert.match(orderWxss, /\.order-secondary-grid \{[^}]*grid-template-columns: repeat\(auto-fit, minmax\(300px, 1fr\)\);/s,
    "optional gifts and work-order notes should fill one or two tablet columns without an empty forced column");
  assert.match(orderWxss, /\.photo-grid \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  assert.match(orderWxss, /\.photo-frame \{ height: clamp\(180px, 24vw, 230px\);/,
    "evidence photos should respond to the tablet width without becoming giant cards");
  assert.match(orderWxss, /\.photo-card:nth-child\(5\) \{ grid-column: auto; \}/,
    "the fifth evidence photo must not stretch into a giant full-width iPad card");
  assert.match(orderWxss, /\.export-card \{[^}]*grid-template-columns: minmax\(180px, \.42fr\) minmax\(0, 1fr\);/s,
    "export actions should use a compact horizontal tablet row");
});

test("product purchase detail uses a compact tablet information layout", () => {
  const wxml = read("miniprogram-app", "miniprogram", "pages", "product-purchase-detail", "index.wxml");
  const wxss = read("miniprogram-app", "miniprogram", "pages", "product-purchase-detail", "index.wxss");
  const context = read("PROJECT_CONTEXT.md");

  assert.match(wxml, /class="detail-layout"[\s\S]*class="card purchase-card"[\s\S]*class="card notes"/s);
  assert.match(wxss, /@media \(min-width: 700px\)[\s\S]*?\.hero \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/s,
    "the work-order hero must become a compact horizontal tablet header");
  assert.match(wxss, /@media \(min-width: 700px\)[\s\S]*?\.page \.facts \{ grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/s,
    "customer, product, store, and teacher should share one tablet row");
  assert.match(wxss, /\.detail-layout \{ display: grid; grid-template-columns: minmax\(0, 1\.35fr\) minmax\(260px, \.75fr\);/,
    "purchase facts and notes should use the tablet width instead of stacking oversized cards");
  assert.match(context, /全部工单详情在平板上必须使用紧凑横向工单头/);
});

test("HQ project management uses compact adaptive tablet cards", () => {
  const wxss = read("miniprogram-app", "miniprogram", "pages", "product-management", "index.wxss");
  const context = read("PROJECT_CONTEXT.md");

  assert.match(wxss, /@media \(min-width: 700px\)[\s\S]*?\.page \{[^}]*max-width: 1040px;/s,
    "project management must stay inside a bounded tablet workspace");
  assert.match(wxss, /\.product-list \{[^}]*grid-template-columns: repeat\(auto-fit, minmax\(220px, 1fr\)\);/s,
    "tablet width should automatically choose two or three compact project cards per row");
  assert.match(context, /项目按可用宽度自动使用两列或三列独立卡片/);
});

test("HQ retail product management uses compact adaptive tablet cards", () => {
  const wxml = read("miniprogram-app", "miniprogram", "pages", "retail-product-management", "index.wxml");
  const wxss = read("miniprogram-app", "miniprogram", "pages", "retail-product-management", "index.wxss");
  const context = read("PROJECT_CONTEXT.md");

  assert.match(wxml, /wx:elif="\{\{products\.length\}\}" class="product-list"/);
  assert.match(wxss, /@media \(min-width: 700px\)[\s\S]*?\.page \{[^}]*max-width: 1040px;/s,
    "retail product management must stay inside a bounded tablet workspace");
  assert.match(wxss, /\.product-list \{[^}]*grid-template-columns: repeat\(auto-fill, minmax\(260px, 1fr\)\);/s,
    "tablet width should automatically choose two or three compact retail product cards per row");
  assert.match(wxss, /\.product-head \{ display: none; \}/,
    "the magnified four-column phone header must retire on tablets");
  assert.match(wxss, /\.status-button \{[^}]*width: 82px;[^}]*height: 38px;/s,
    "product status actions must remain compact and separate from card text");
  assert.match(context, /产品按可用宽度自动使用两列或三列卡片展示名称、编号、状态和操作/);
});

test("HQ ranking cards show only the selected business metric", () => {
  const homeWxml = read("miniprogram-app", "miniprogram", "pages", "home", "index.wxml");
  const homeJs = read("miniprogram-app", "miniprogram", "pages", "home", "index.js");

  assert.match(homeWxml, /class="hq-ranking-selected-metric"/);
  assert.match(homeWxml, /\{\{item\.selectedMetricLabel\}\}/);
  assert.match(homeWxml, /\{\{item\.selectedMetricValue\}\} 次/);
  assert.doesNotMatch(homeWxml, /class="hq-ranking-metrics"/,
    "each store or teacher must not repeat all four metrics after a sort metric is already selected");
  assert.match(homeJs, /selectedMetricLabel, selectedMetricValue: row\[rankingMetric\]/);
});

test("HQ tablet filters use a balanced two-by-two control grid", () => {
  const homeWxml = read("miniprogram-app", "miniprogram", "pages", "home", "index.wxml");
  const homeWxss = read("miniprogram-app", "miniprogram", "pages", "home", "index.wxss");

  assert.match(homeWxml, /class="hq-filter-grid hq-ranking-control-grid"/);
  assert.match(homeWxml, /class="hq-control-field"/);
  assert.match(homeWxss, /\.hq-ranking-control-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
  assert.match(homeWxss, /\.hq-filter-actions \{[^}]*grid-column: 1 \/ -1;[^}]*justify-content: flex-end;/s);
});
