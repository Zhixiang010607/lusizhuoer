"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const root = path.resolve(__dirname, "../miniprogram-app/miniprogram/pages/login");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

function loginPage(width, height) {
  let definition;
  const calls = [];
  vm.runInNewContext(read("index.js"), {
    Page(value) { definition = value; },
    require(id) {
      if (id.endsWith("/session")) return {
        waitForStartupSession: async () => null,
        passwordLogin: async () => calls.push("password"),
        wechatPhoneLogin: async () => calls.push("phone")
      };
      if (id.endsWith("/wechat-phone")) return {};
      throw new Error(id);
    },
    wx: { getWindowInfo: () => ({ windowWidth: width, windowHeight: height }) },
    Number, String, Math
  });
  const page = { ...definition, data: { ...definition.data }, setData(value) { Object.assign(this.data, value); } };
  page.onLoad();
  return { page, calls };
}

test("tablet login bounds both the root and the artwork instead of using 49vh plus a tall form", () => {
  const css = read("index.wxss");
  assert.doesNotMatch(css, /49vh/);
  assert.match(css, /@media \(min-width: 600px\)\s*\{\s*\.login-page\s*\{[^}]*height: 100vh;[^}]*min-height: 0;[^}]*box-sizing: border-box;[^}]*overflow: hidden;/s);
  assert.match(css, /\.login-background\s*\{[^}]*left: 0;[^}]*width: 100%;[^}]*height: 100%;/s);
  assert.match(read("index.wxml"), /^<page-meta page-style="\{\{tabletLayout \? 'height: 100%; overflow: hidden;' : ''\}\}">/);
  assert.match(read("index.wxml"), /tabletLayout \? 'aspectFit' : 'widthFix'/);
  assert.equal(JSON.parse(read("index.json")).disableScroll, undefined,
    "tablet-only page-meta must not globally disable phone keyboard positioning");
});

test("target iPads select portrait login while short tablets and rotations select the bounded side layout", () => {
  for (const [width, height] of [[768, 1024], [834, 1112], [1024, 1366]]) {
    const { page, calls } = loginPage(width, height);
    assert.equal(page.data.tabletLayout, true);
    assert.equal(page.data.tabletLandscape, false);
    page.onResize({ size: { windowWidth: height, windowHeight: width } });
    assert.equal(page.data.tabletLandscape, true);
    assert.deepEqual(calls, []);
  }
  assert.equal(loginPage(600, 800).page.data.tabletLandscape, true);
  for (const width of [320, 390, 430]) {
    const { page } = loginPage(width, 844);
    assert.equal(page.data.tabletLayout, false);
    assert.equal(page.data.tabletLandscape, false);
  }
});

test("portrait tablet login masks the fitted artwork edges without cropping the logo", () => {
  const css = read("index.wxss");
  assert.match(css, /\.login-shade\s*\{ background: linear-gradient\(90deg, #ead1a1 0%, #f5e5ca 22%, rgba\(255,248,238,\.12\) 38%, rgba\(255,248,238,\.12\) 62%, #f5e5ca 78%, #ead1a1 100%\); \}/);
  assert.match(read("index.wxml"), /tabletLayout \? 'aspectFit' : 'widthFix'/,
    "seam blending must not revert to cropping the brand image");
});

test("keyboard avoidance restores the initial one-screen state without starting authentication", () => {
  const { page, calls } = loginPage(768, 1024);
  page.keyboardHeightChange({ detail: { height: 320 } });
  assert.equal(page.data.keyboardHeight, 320);
  page.keyboardHeightChange({ detail: { height: 0 } });
  assert.equal(page.data.keyboardHeight, 0);
  page.keyboardHeightChange({ detail: { height: -1 } });
  assert.equal(page.data.keyboardHeight, 0);
  assert.deepEqual(calls, []);
  assert.equal((read("index.wxml").match(/bindkeyboardheightchange="keyboardHeightChange"/g) || []).length, 2);
  assert.match(read("index.wxss"), /\.login-page\.tablet-keyboard-open\s*\{[^}]*align-items: flex-start;/s);
});
