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
});

test("role homes use a bounded tablet dashboard instead of a magnified phone", () => {
  const js = read("miniprogram-app", "miniprogram", "pages", "home", "index.js");
  const wxml = read("miniprogram-app", "miniprogram", "pages", "home", "index.wxml");
  const wxss = read("miniprogram-app", "miniprogram", "pages", "home", "index.wxss");
  const context = read("PROJECT_CONTEXT.md");

  assert.match(wxss, /@media \(min-width: 700px\) \{/);
  assert.match(wxss, /\.workspace-main, \.role-teacher \.workspace-main \{[^}]*max-width: 1120px;[^}]*margin: 20px auto 0;/s);
  assert.match(wxss, /\.role-store \.workspace-main \{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);[^}]*gap: 16px;/s);
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
