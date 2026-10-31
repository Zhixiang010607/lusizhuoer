"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = ext => fs.readFileSync(path.join(__dirname, `../miniprogram-app/miniprogram/pages/customer-detail/index.${ext}`), "utf8");
test("customer messages prioritize display over a compact composer without nested empty panels", () => {
  const css = read("wxss");
  assert.match(css, /\.message-list \{[^}]*min-height: 220rpx; max-height: 620rpx;/);
  assert.match(css, /\.message-empty \{[^}]*min-height: 220rpx;/);
  assert.match(css, /@media \(min-width: 700px\)[\s\S]*?\.message-list \{ min-height: 128px; max-height: 210px;/);
  assert.match(css, /\.message-empty \{ min-height: 128px;/);
  assert.match(css, /\.message-list\.has-messages \{ min-height: 300rpx; max-height: 840rpx;/);
  assert.match(css, /\.message-list\.has-messages \{ min-height: 160px; max-height: 300px;/);
  assert.match(css, /\.messages-card \.message-input \{[^}]*height: 96rpx; min-height: 96rpx;/);
  assert.match(css, /\.messages-card \.message-input \{ height: 60px; min-height: 60px;/,
    "two-class scope must outrank the global page .textarea tablet minimum");
  assert.match(css, /\.message-compose \{[^}]*padding: 0; background: transparent; border: 0;/);
  assert.match(css, /\.message-compose-footer \{[^}]*justify-content: space-between;/);
  assert.match(read("wxml"), /class="message-compose-footer">\s*<text class="character-count[^]*?<button class="primary submit-message-button"/);
  assert.ok(220 > 96 + 10 + 80, "phone display minimum exceeds composer height");
  assert.ok(128 > 60 + 8 + 40, "tablet display minimum exceeds composer height");
  assert.match(read("wxml"), /<scroll-view class="message-list \{\{messages.length \? 'has-messages' : ''\}\}" scroll-y/);
  assert.match(read("wxml"), /<textarea class="textarea message-input" maxlength="100"/);
  assert.match(read("js"), /const MESSAGE_LIMIT = 20;/);
  assert.match(read("js"), /const HISTORY_LIMIT = 20;/);
});

test("customer recent information remains a two-by-two grid even on narrow phones", () => {
  const css = read("wxss");
  const grids = [...css.matchAll(/\.recent-grid\s*\{([^}]*)\}/g)];
  assert.ok(grids.length >= 2);
  for (const [, declarations] of grids) {
    assert.match(declarations, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  }
  assert.match(css, /\.recent-item \{[^}]*min-width: 0;/);
  assert.match(css, /\.recent-item > text:last-child \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis; white-space: nowrap;/);
  for (const label of ["最近充值", "最近核销", "客户建立", "客户状态"]) assert.ok(read("wxml").includes(label));
});
