"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const mini = path.resolve(__dirname, "../miniprogram-app/miniprogram");
const read = (file) => fs.readFileSync(path.join(mini, file), "utf8");
const publicPages = new Set(["company-intro", "project-intro", "login", "password-reset"]);

function styles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? styles(file) : file.endsWith(".wxss") ? [file] : [];
  });
}

test("internal business typography is never smaller than the unchanged query result baseline", () => {
  assert.match(read("pages/records/index.wxss"), /\.record-row text\s*\{[^}]*font-size:\s*24rpx;/s);
  assert.match(read("pages/records/index.wxss"), /@media \(min-width: 700px\)[\s\S]*?\.record-row text\s*\{[^}]*font-size:\s*14px;/s);
  for (const file of styles(mini)) {
    const relative = path.relative(mini, file);
    if (relative.startsWith("pages/") && publicPages.has(relative.split(path.sep)[1])) continue;
    for (const match of fs.readFileSync(file, "utf8").matchAll(/font-size:\s*(\d+(?:\.\d+)?)(rpx|px)\b/g)) {
      assert.ok(Number(match[1]) >= (match[2] === "rpx" ? 24 : 14), `${relative}: ${match[0]}`);
    }
  }
});

test("project code is hidden in quota rows, selectors, detail facts and save feedback, not deleted from identity checks", () => {
  for (const page of ["home", "teacher-detail", "customer-detail"]) {
    assert.doesNotMatch(read(`pages/${page}/index.wxml`), /\{\{[^}]*productCode/);
  }
  const teacher = read("pages/teacher-detail/index.js");
  assert.match(teacher, /configureLabels: configureProducts\.map\(\(item\) => item\.name\)/);
  assert.match(teacher, /rechargeLabels: rechargeProducts\.map\(\(item\) => item\.productName\)/);
  assert.match(teacher, /productId: request\.productId/);
  assert.match(read("pages/records/index.js"), /recordType === "PRODUCT_PURCHASE" \? product\.productCode \|\| product\.product_code \|\| "" : ""/);
  const order = read("pages/order-detail/index.js");
  assert.match(order, /\{ label: "项目", value: order\.productName \}/);
  assert.doesNotMatch(order, /label: "项目"[^\n]*note: order\.productCode/);
  const project = read("pages/product-detail/index.js");
  assert.match(project, /result\.productCode\.toUpperCase\(\) === ref\.toUpperCase\(\)/);
  assert.doesNotMatch(project, /throw new Error\(`页面项目[^\n]*result\.productCode/);
  assert.doesNotMatch(project, /message:[^\n]*expected\.productCode/);
});

test("alignment remains semantic instead of centering every business paragraph", () => {
  const customer = read("pages/customer-detail/index.wxss");
  assert.match(customer, /\.balance-table-row text, \.record-row text\s*\{[^}]*text-align:\s*center;[^}]*vertical-align:\s*middle;[^}]*white-space:\s*nowrap;/s);
  assert.match(customer, /\.history-tabs button\s*\{[^}]*align-items:\s*center;[^}]*justify-content:\s*center;/s);
  assert.match(read("pages/training-materials/index.wxss"), /\.material-title\s*\{[^}]*font-size:\s*30rpx;/s);
  assert.doesNotMatch(read("app.wxss"), /(?:page|text|view)\s*\{[^}]*text-align:\s*center;/s);
});
