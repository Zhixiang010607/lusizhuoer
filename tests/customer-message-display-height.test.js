"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const read = ext => fs.readFileSync(path.join(__dirname, `../miniprogram-app/miniprogram/pages/customer-detail/index.${ext}`), "utf8");
test("customer message display is modestly taller on phone and preserves original tablet height and composer", () => {
  const css = read("wxss");
  assert.match(css, /\.message-list \{[^}]*min-height: 180rpx; max-height: 620rpx;/);
  assert.match(css, /\.message-empty \{[^}]*min-height: 180rpx;/);
  assert.match(css, /@media \(min-width: 700px\)[\s\S]*?\.message-list \{ min-height: 0; max-height: 210px;/);
  assert.match(css, /\.message-empty \{ min-height: 90px;/);
  assert.match(css, /\.message-input \{ height: 126rpx; min-height: 126rpx;/);
  assert.match(css, /\.message-input \{ height: 92px; min-height: 92px;/);
  assert.match(read("wxml"), /<scroll-view class="message-list" scroll-y/);
  assert.match(read("wxml"), /<textarea class="textarea message-input" maxlength="100"/);
  assert.match(read("js"), /const MESSAGE_LIMIT = 20;/);
  assert.match(read("js"), /const HISTORY_LIMIT = 20;/);
});
