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
  assert.match(wxss, /\.record-scroll\[data-visible-rows="5"\], \.customer-scroll\[data-visible-rows="5"\] \{ height: 308px !important; \}/,
    "long tablet lists must stop at five compact rows before internal scrolling");
  assert.match(wxss, /\.summary-table \{ width: 100%; min-width: 680px; \}/,
    "tablet project summaries should keep one font size and scroll inside the table when values are wide");
  assert.match(wxss, /\.record-table \{ width: 100%; min-width: 680px; \}/,
    "tablet business records should protect codes and times but compact all short columns");
  assert.match(wxss, /\.customer-table \{ width: 100%; min-width: 520px; \}/,
    "store customer tables should reveal all five short fields before horizontal scrolling");
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
  assert.match(reviewsWxss, /\.review-filter-grid \{[^}]*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/s,
    "review store, status, query, and reset must be four equal outer columns on tablets");
  assert.match(reviewsWxss, /\.filter-card \.review-type-tabs button, \.filter-card \.mode-tabs button \{[^}]*height: 36px;[^}]*min-height: 36px;[^}]*font-size: 13px;/s,
    "review switches must stop at one compact tablet height");
  assert.match(reviewsWxss, /\.review-filter-grid \.field > \.field-label \{[^}]*font-size: 22rpx;[^}]*font-weight: 700;/s,
    "phone review labels must use the same 22rpx query typography as customer and record queries");
  assert.match(reviewsWxss, /@media \(min-width: 700px\)[\s\S]*?\.review-filter-grid \.field > \.field-label \{[^}]*font-size: 13px;[^}]*font-weight: 700;/s,
    "tablet review labels must use the same 13px query typography as customer and record queries");
  assert.match(reviewsWxss, /\.field input, \.field textarea, \.picker,\s*\.review-filter-grid \.field input, \.review-filter-grid \.picker \{[^}]*min-height: 38px;[^}]*height: 38px;[^}]*font-size: 13px;/s,
    "the tablet override must match the earlier high-specificity review picker rule so fields really align on one compact physical baseline");
  assert.match(reviewsWxss, /\.review-action-cell \{ align-self: start; margin-top: 0; \}/,
    "each review action must occupy one direct tablet grid cell from the same top baseline");
  assert.match(reviewsWxss, /\.review-filter-grid \.field > \.field-label \{[^}]*font-size: 13px;[^}]*font-weight: 700;/s,
    "the tablet override must match the earlier high-specificity review label rule and reuse the established query label typography");
  assert.match(reviewsWxss, /\.review-action-cell::before \{[^}]*height: 16px;[^}]*margin-bottom: 5px;/s,
    "review actions must reserve the same label line so their controls align with the picker top edge");
  assert.match(reviewsWxss, /\.filter-card \.review-action-cell button \{[^}]*width: 100%;[^}]*height: 38px;[^}]*min-height: 38px;[^}]*font-size: 13px;/s,
    "review query actions must exactly match the adjacent filter field height");
  assert.doesNotMatch(reviewsWxml, /button-row review-query-actions/,
    "review query actions must not be nested into a separate two-column wrapper");
  assert.match(reviewsWxss, /@media \(min-width: 700px\)[\s\S]*?\.review-table \{ width: 100%; min-width: 992px; \}/s,
    "review columns should fill the tablet card while retaining an exact content-derived minimum");
  assert.match(reviewsWxss, /\.review-row \{[^}]*grid-template-columns: 170px 90px 82px 82px 72px 60px 170px 96px 170px;[^}]*padding: 0;/s,
    "short review fields must stay compact while the order code and complete timestamps keep enough width");
  assert.match(reviewsWxss, /\.review-row > text, \.review-row > view \{[^}]*padding: 6px 4px;[^}]*font-size: 14px;/s,
    "tablet review cells must keep readable text and independent horizontal gutters");
  assert.match(reviewsWxss, /\.review-type-tabs button \{[^}]*width: 100%;[^}]*min-width: 0;/s,
    "recharge and refund review tabs should fill their two balanced tablet columns");
  assert.match(directoryWxss, /\.search-fields \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/s);
  assert.match(directoryWxss, /@media \(min-width: 700px\)[\s\S]*?\.data-table \{ width: 100%; min-width: 0; \}/s,
    "tablet directories must start from the card width rather than a global oversized table minimum");
  assert.match(directoryWxss, /\.data-table\.store \{ width: 100%; min-width: 700px; \}/,
    "the five-column store directory should scroll only below its content-derived compact width");
  assert.match(directoryWxss, /\.table-row\.store \{ grid-template-columns: 150px 105px 140px minmax\(220px, 1fr\) 85px; \}/,
    "store name, contact, phone and status stay compact while the address absorbs spare tablet width");

  assert.match(customersWxml, /data-visible-rows="\{\{customers\.length > 5 \? 5 : customers\.length\}\}" scroll-y="\{\{customers\.length > 5\}\}"/);
  assert.match(recordsWxml, /data-visible-rows="\{\{records\.length > 5 \? 5 : records\.length\}\}" scroll-y="\{\{records\.length > 5\}\}"/);
  assert.match(reviewsWxml, /data-visible-rows="\{\{rows\.length > 5 \? 5 : rows\.length\}\}" scroll-y="\{\{rows\.length > 5\}\}"/);
  assert.equal((directoryWxml.match(/data-visible-rows=/g) || []).length, 3,
    "search, active and archived directory tables each own a five-row viewport");
  assert.match(customersWxss, /\.customer-table-scroll\[data-visible-rows="5"\] \{ height: 344px; \}/);
  assert.match(recordsWxss, /\.record-scroll\[data-visible-rows="5"\] \{ height: 344px; \}/);
  assert.match(reviewsWxss, /\.table-scroll\[data-visible-rows="5"\] \{ height: 308px; \}/);
  assert.match(directoryWxss, /\.table-scroll\[data-visible-rows="5"\] \{ height: 332px; \}/);
  assert.match(customersWxss, /@media \(min-width: 700px\)[\s\S]*?\.search-card \.query-modes button \{ min-height: 38px; font-size: 14px; \}/s,
    "customer query mode controls must use the same compact tablet density as the other query pages");
  assert.match(customersWxss, /@media \(min-width: 700px\)[\s\S]*?\.query-grid \.input, \.query-grid \.picker \{[^}]*min-height: 42px;[^}]*font-size: 14px;/s,
    "customer query filter controls must not retain magnified phone geometry on iPad");
  assert.match(customersWxss, /@media \(min-width: 700px\)[\s\S]*?\.summary-grid text \{[^}]*min-height: 16px;[^}]*font-size: 10px;/s,
    "customer query summary must stay compact instead of magnifying its labels on iPad");
  assert.match(customersWxss, /@media \(min-width: 700px\)[\s\S]*?\.customer-table \{ width: 100%; min-width: 744px; \}/s,
    "customer query should fill a wide tablet card and scroll only below its compact minimum width");
  assert.match(customersWxss, /\.customer-row \{[^}]*grid-template-columns: 82px 64px 64px 102px 94px minmax\(138px, 1fr\) 104px 96px;/s,
    "short customer fields must stay compact while the business-stage column absorbs spare tablet width");
  assert.match(customersWxss, /\.customer-row text \{[^}]*padding: 8px 5px;[^}]*font-size: 13px;/s,
    "customer result cells should not lose tablet space to phone-sized padding");
  assert.match(recordsWxss, /@media \(min-width: 700px\)[\s\S]*?\.summary-grid \.summary-value \{[^}]*font-size: 17px;/s,
    "record query totals must use a compact tablet numeral size");
  assert.match(recordsWxss, /@media \(min-width: 700px\)[\s\S]*?\.record-table \{ width: 100%; min-width: 981px; \}/s,
    "recharge and refund query columns should reveal more fields before tablet scrolling");
  assert.match(recordsWxss, /\.verification-table \{ width: 100%; min-width: 983px; \}/,
    "verification query columns should shrink after the redundant status column is removed");
  assert.match(recordsWxss, /\.product-purchase-table \{ width: 100%; min-width: 1063px; \}/,
    "product query columns should use their exact compact tablet width");
  assert.match(recordsWxss, /\.record-row \{[^}]*grid-template-columns: 175px 110px 92px 110px 100px 76px 58px 80px 180px;/s,
    "tablet query columns should reserve the most width for the full order code and timestamp");
  assert.match(recordsWxss, /\.verification-table \.record-row \{ grid-template-columns: 175px 110px 92px 110px 100px 76px 82px 58px 180px; \}/,
    "verification columns must omit status and keep the remaining fields aligned");
  assert.match(recordsWxss, /\.product-purchase-table \.record-row \{ grid-template-columns: 175px 110px 92px 110px 100px 76px 82px 58px 80px 180px; \}/,
    "product source, teacher, quantity, status, and time columns should stay compact and aligned");
  assert.match(recordsWxss, /\.record-row text \{[^}]*padding: 8px 4px;[^}]*font-size: 13px;/s,
    "tablet result cells should not waste horizontal space on oversized padding");
  assert.match(recordsWxml, /class="button-row query-actions \{\{mode === 'browse' && !customRange \? 'inline-query-actions' : ''\}\}"/);
  assert.match(recordsWxss, /@media \(min-width: 700px\)[\s\S]*?\.filter-card \{ padding: 16px 18px; \}/s,
    "record query cards should use compact tablet padding instead of magnifying the phone surface");
  assert.match(recordsWxss, /\.filter-card \.query-modes button \{ min-height: 38px;[^}]*font-size: 14px; \}/,
    "record query mode switches must stay compact while remaining tappable on tablets");
  assert.match(recordsWxss, /\.query-grid \.input, \.query-grid \.picker \{ min-height: 42px;[^}]*font-size: 14px; \}/,
    "recharge, verification, and product filter controls must share one compact tablet height");
  assert.match(recordsWxss, /\.query-actions button \{ min-height: 42px;[^}]*font-size: 14px; \}/,
    "record query and reset actions must align to the same compact control height");
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
  assert.match(customerWxss, /\.customer-communication-grid > \.card, \.customer-summary-grid > \.card \{ min-width: 0; height: 100%; margin: 0; \}/,
    "paired customer cards must be allowed to shrink inside either tablet column");
  assert.match(customerWxss, /@media \(min-width: 700px\)[\s\S]*?\.balance-table \{ width: 100%; min-width: 0; \}/s,
    "the five-column project summary must fit its half-width tablet card without horizontal clipping");
  assert.match(customerWxss, /\.balance-table-row \{[^}]*grid-template-columns: minmax\(0, 1\.25fr\) repeat\(4, minmax\(52px, \.72fr\)\);/s,
    "project name, gross recharge, refund, verification, and balance must all remain visible in the left summary card");
  assert.match(customerWxss, /\.customer-communication-grid > \.notes-card \{ display: flex; flex-direction: column; \}/,
    "the tablet note card must expose a vertical fill context beside the taller message card");
  assert.match(customerWxss, /\.customer-communication-grid > \.notes-card \.notes-read,[\s\S]*?\.customer-communication-grid > \.notes-card \.notes-input \{ height: auto; min-height: 178px; flex: 1; \}/,
    "read and edit note borders should both fill the remaining paired-card height");
  assert.match(customerWxss, /\.record-scroll\[data-visible-rows="5"\] \{ height: 308px; \}/);
  assert.match(customerWxss, /\.record-table\.recharge-history, \.record-table\.recharge-history \.record-row,[\s\S]*?\.record-table\.compact-history, \.record-table\.compact-history \.record-row \{ width: 100%; min-width: 650px; \}/,
    "all five customer-history tabs should share a compact adaptive tablet table width");
  assert.match(customerWxss, /\.recharge-history \.record-row, \.compact-history \.record-row \{ grid-template-columns: 150px minmax\(90px, 1fr\) minmax\(80px, \.85fr\) 56px 145px 90px; \}/,
    "history codes and full timestamps stay protected while short fields stop wasting tablet width");
  assert.match(customerWxss, /\.record-table\.product-history, \.record-table\.product-history \.record-row \{ min-width: 666px; \}/,
    "product purchase history reserves enough width to inset its full order code");
  assert.match(customerWxss, /\.product-history \.record-row > text:first-child \{ padding-right: 10px; padding-left: 10px; \}/,
    "product purchase order codes must not touch the tablet table border");
  assert.match(orderWxml, /class="order-secondary-grid"/);
  assert.match(orderWxss, /@media \(min-width: 700px\)[\s\S]*?\.order-hero \{[^}]*grid-template-columns: minmax\(0, 1fr\) auto;/s,
    "recharge, refund, normal verification, and experience verification must share a compact horizontal tablet header");
  assert.match(orderWxss, /@media \(min-width: 700px\)[\s\S]*?\.fact-grid \{ grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/s);
  assert.match(orderWxml, /class="detail-time"/);
  assert.match(orderWxml, /detail-grid-three/,
    "a three-field verification detail must not reserve an empty fourth tablet column");
  assert.match(orderWxml, /'detail-grid-three' : 'detail-grid-reviewed'/,
    "recharge, refund, and supplement details must use dedicated reviewed-order time columns");
  assert.match(orderWxss, /\.detail-grid\.detail-grid-reviewed\s*\{[^}]*grid-template-columns:\s*minmax\(96px, \.62fr\) minmax\(72px, \.5fr\) repeat\(2, minmax\(190px, 1\.44fr\)\);/s,
    "submitted and reviewed timestamps must receive wider tablet columns than type and count");
  assert.match(orderWxss, /\.detail-grid\.detail-grid-three\s*\{[^}]*grid-template-columns:\s*minmax\(0, \.8fr\) minmax\(0, \.65fr\) minmax\(260px, 2\.5fr\);/s,
    "the verification submission time must receive the remaining tablet width");
  assert.match(orderWxss, /\.detail-grid \.detail-time \.detail-value \{[^}]*width: max-content;[^}]*max-width: none;[^}]*overflow: visible;[^}]*text-overflow: clip;[^}]*white-space: nowrap;/s,
    "tablet work-order timestamps must remain complete instead of becoming an ellipsis");
  assert.match(orderWxss, /\.order-secondary-grid \{[^}]*grid-template-columns: repeat\(auto-fit, minmax\(300px, 1fr\)\);/s,
    "optional gifts and work-order notes should fill one or two tablet columns without an empty forced column");
  assert.match(orderWxss, /\.photo-grid \{ grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/,
    "the four visible work-order photos share one compact tablet row");
  assert.match(orderWxss, /\.photo-frame \{ height: clamp\(180px, 24vw, 230px\);/,
    "evidence photos should respond to the tablet width without becoming giant cards");
  assert.doesNotMatch(orderWxss, /\.photo-card:nth-child\(4\) \{[^}]*grid-column:\s*1\s*\/\s*-1;/,
    "the fourth and final visible work-order photo must not stretch into a giant full-width iPad card");
  assert.match(orderWxss, /\.export-card \{[^}]*grid-template-columns: minmax\(180px, \.42fr\) minmax\(0, 1fr\);/s,
    "export actions should use a compact horizontal tablet row");
});

test("headquarters creation and project-template forms use compact tablet grids", () => {
  const storeCreateWxml = read("miniprogram-app", "miniprogram", "pages", "store-create", "index.wxml");
  const storeCreateWxss = read("miniprogram-app", "miniprogram", "pages", "store-create", "index.wxss");
  const productCreateWxml = read("miniprogram-app", "miniprogram", "pages", "product-create", "index.wxml");
  const productCreateWxss = read("miniprogram-app", "miniprogram", "pages", "product-create", "index.wxss");
  const retailCreateWxss = read("miniprogram-app", "miniprogram", "pages", "retail-product-create", "index.wxss");
  const teacherCreateWxml = read("miniprogram-app", "miniprogram", "pages", "teacher-create", "index.wxml");
  const teacherCreateWxss = read("miniprogram-app", "miniprogram", "pages", "teacher-create", "index.wxss");
  const productDetailWxml = read("miniprogram-app", "miniprogram", "pages", "product-detail", "index.wxml");
  const productDetailWxss = read("miniprogram-app", "miniprogram", "pages", "product-detail", "index.wxss");

  assert.match(storeCreateWxml, /class="store-create-grid"/);
  assert.match(storeCreateWxml, /class="store-fields"/);
  assert.match(storeCreateWxss, /@media \(min-width: 700px\)[\s\S]*?\.store-create-grid \{[^}]*padding: 18px;[^}]*background: #fffaf3;[^}]*border: 1px solid #dfcfb4;/s,
    "the tablet store form should use one compact shared surface instead of two stretched half-width cards");
  assert.match(storeCreateWxss, /\.store-create-grid \.panel \{[^}]*padding: 0;[^}]*background: transparent;[^}]*border: 0;/s);
  assert.match(storeCreateWxss, /\.store-data-panel \.store-fields \{[^}]*grid-template-columns: minmax\(130px, \.65fr\) minmax\(230px, 1\.25fr\) minmax\(230px, 1\.2fr\);/s,
    "store name, full region, and address should occupy one content-weighted tablet row");
  assert.match(storeCreateWxss, /\.contact-data-panel \.store-fields \{[^}]*grid-template-columns: minmax\(140px, \.7fr\) minmax\(190px, \.95fr\) minmax\(260px, 1\.35fr\);/s,
    "contact name, phone, and password should occupy one content-weighted tablet row");
  assert.match(storeCreateWxss, /\.field-wide \{ grid-column: auto; \}/,
    "address and password must join their respective tablet row instead of forcing empty second rows");

  assert.match(productCreateWxml, /class="project-fields"/);
  assert.match(productCreateWxml, /class="field field-description"/);
  assert.match(productCreateWxss, /@media \(min-width: 700px\)[\s\S]*?\.project-fields \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/s,
    "project name and category should share a compact tablet row");
  assert.match(productCreateWxss, /\.field-description \{ grid-column: 1 \/ -1; \}/);
  assert.match(productCreateWxss, /\.field textarea \{ min-height: 128px;/,
    "the optional project description must not retain the magnified phone height");

  assert.match(retailCreateWxss, /@media \(min-width: 700px\)[\s\S]*?\.page \{[^}]*max-width: 900px;/s,
    "the one-field retail-product form must use a bounded tablet workspace");
  assert.match(retailCreateWxss, /\.panel \{[^}]*grid-template-columns: minmax\(150px, \.32fr\) minmax\(0, 1fr\);/s,
    "the retail product heading and its sole field should share one compact row");

  assert.match(teacherCreateWxml, /class="teacher-fields"/);
  assert.match(teacherCreateWxss, /@media \(min-width: 700px\)[\s\S]*?\.teacher-fields \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/s,
    "name, phone, and initial password should occupy one readable tablet row");
  assert.match(teacherCreateWxss, /\.rule-panel \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/,
    "teacher creation rules should use three equal tablet cards");

  assert.match(productDetailWxml, /class="instruction-grid"/);
  assert.match(productDetailWxss, /@media \(min-width: 700px\)[\s\S]*?\.instruction-grid \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/s,
    "verification and recharge receipt instructions should share the tablet width");
  assert.match(productDetailWxss, /\.logo-editor \{ grid-template-columns: 110px minmax\(0, 1fr\);/,
    "the shared receipt logo must stay compact instead of scaling with the iPad");
  assert.match(productDetailWxss, /\.instruction-field textarea \{ min-height: 190px;/);
});

test("HQ teacher detail uses a real tablet workspace instead of a magnified stack", () => {
  const wxml = read("miniprogram-app", "miniprogram", "pages", "teacher-detail", "index.wxml");
  const wxss = read("miniprogram-app", "miniprogram", "pages", "teacher-detail", "index.wxss");

  assert.match(wxml, /class="teacher-detail-grid"/);
  assert.match(wxml, /class="teacher-detail-sidebar"/);
  assert.match(wxml, /experience-overview-panel/);
  assert.match(wxml, /experience-project-panel/);
  assert.match(wxml, /experience-operations-panel/);
  assert.match(wxss, /@media \(min-width: 700px\)[\s\S]*?\.teacher-detail-grid \{[^}]*grid-template-columns: minmax\(280px, \.76fr\) minmax\(0, 1\.24fr\);/s,
    "profile/account and the quota overview should use two purposeful tablet columns");
  assert.match(wxss, /\.experience-project-panel, \.experience-operations-panel \{ grid-column: 1 \/ -1; \}/,
    "project configuration, forms, and audit history should retain full tablet width");
  assert.match(wxss, /\.experience-project-panel \{[^}]*grid-template-columns: minmax\(0, \.74fr\) minmax\(0, 1\.26fr\);/s);
  assert.match(wxss, /\.quota-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(wxss, /\.forms-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
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

test("HQ ranking uses one compact table and shows all four business metrics", () => {
  const homeWxml = read("miniprogram-app", "miniprogram", "pages", "home", "index.wxml");
  const homeWxss = read("miniprogram-app", "miniprogram", "pages", "home", "index.wxss");
  const homeJs = read("miniprogram-app", "miniprogram", "pages", "home", "index.js");
  const context = read("PROJECT_CONTEXT.md");

  assert.match(homeWxml, /class="hq-ranking-row hq-ranking-table-head"[\s\S]*充值[\s\S]*核销[\s\S]*体验[\s\S]*退费/);
  for (const metric of ["recharge", "verification", "experience", "refund"]) {
    assert.match(homeWxml, new RegExp(`\\{\\{item\\.${metric}\\}\\} 次`));
  }
  assert.doesNotMatch(homeWxml, /class="hq-ranking-selected-metric"|\{\{item\.share\}\}/,
    "ranking rows must not repeat a selected-only card or percentage");
  assert.doesNotMatch(homeJs, /selectedMetricLabel|selectedMetricValue|share:\s*`/,
    "the obsolete selected-only ranking card mapping must remain retired");
  assert.match(homeWxss, /\.hq-ranking-row \{[^}]*grid-template-columns:[^}]*repeat\(4,/s);
  assert.match(homeWxss, /\.summary-product \{[^}]*align-items: center !important;[^}]*text-align: center;/s,
    "project names and the global total label must share the centered summary alignment");
  assert.doesNotMatch(homeWxss, /\.hq-ranking-name \{[^}]*justify-content: flex-start|\.hq-ranking-name \{[^}]*text-align: left/s,
    "ranking entity names must align with the shared centered table columns");
  assert.doesNotMatch(homeWxss, /\.hq-ranking-list \{[^}]*grid-template-columns:\s*repeat\(2,/s,
    "the complete ranking must not split into two tablet columns");
  assert.match(context, /门店和老师编号只作为内部识别数据保留/,
    "complete ranking must show entity names without repeating internal store or teacher codes");
  assert.match(context, /小程序完整排名使用单列紧凑表格/);
});

test("HQ tablet filters use a balanced two-by-two control grid", () => {
  const homeWxml = read("miniprogram-app", "miniprogram", "pages", "home", "index.wxml");
  const homeWxss = read("miniprogram-app", "miniprogram", "pages", "home", "index.wxss");

  assert.match(homeWxml, /class="hq-filter-grid hq-ranking-control-grid"/);
  assert.match(homeWxml, /class="hq-control-field"/);
  assert.match(homeWxml, /class="hq-control-field hq-product-filter"[\s\S]*项目范围[\s\S]*class="hq-inline-reset" bindtap="resetHqRange">恢复默认<\/button>/);
  assert.doesNotMatch(homeWxml, /排序指标<\/text><button class="hq-inline-reset"/);
  assert.doesNotMatch(homeWxml, /class="hq-filter-actions"/);
  assert.match(homeWxss, /\.hq-ranking-control-grid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
  assert.match(homeWxss, /\.hq-ranking-control-grid \.hq-dimension-tabs \{[^}]*height: 46px;[^}]*min-height: 46px;[^}]*padding: 4px;/s);
  assert.match(homeWxss, /\.hq-ranking-control-grid \.hq-dimension-tabs button \{[^}]*height: 38px;[^}]*min-height: 0;/s);
  assert.match(homeWxss, /\.hq-inline-reset \{[^}]*min-width: 0;[^}]*min-height: 26px;[^}]*border-width: 0;/s);
});
