"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

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
});

test("mini-program keeps the company brand visible after login", () => {
  const json = JSON.parse(read("miniprogram-app", "miniprogram", "pages", "home", "index.json"));
  const wxml = read("miniprogram-app", "miniprogram", "pages", "home", "index.wxml");
  const context = read("PROJECT_CONTEXT.md");

  assert.equal(json.navigationBarTitleText, "露思卓儿");
  assert.match(wxml, /class="identity-brand">露思卓儿<\/text>/);
  assert.match(wxml, /class="identity-name">\{\{roleName\}\}工作台/);
  assert.match(context, /人物图只用于小程序登录页/);
  assert.match(context, /登录后各角色工作台顶部必须明确显示文字品牌名“露思卓儿”/);
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
  assert.match(isolation, /miniprogram-app/);
  assert.match(isolation, /native-app/);
});
