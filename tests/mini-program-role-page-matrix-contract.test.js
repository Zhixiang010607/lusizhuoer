"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const mini = path.join(root, "miniprogram-app", "miniprogram");
const read = (...parts) => fs.readFileSync(path.join(mini, ...parts), "utf8");
const app = JSON.parse(read("app.json"));
const routes = [
  ...app.pages,
  ...(app.subPackages || []).flatMap((subpackage) =>
    subpackage.pages.map((page) => `${subpackage.root}/${page}`))
];

const ROLE_MATRIX = Object.freeze({
  "pages/login/index": [],
  "pages/password-reset/index": [],
  "pages/home/index": ["hq", "store", "teacher"],
  "pages/product-management/index": ["hq"],
  "pages/product-create/index": ["hq"],
  "pages/product-detail/index": ["hq"],
  "pages/retail-product-management/index": ["hq"],
  "pages/retail-product-create/index": ["hq"],
  "pages/hq-directory/index": ["hq"],
  "pages/store-create/index": ["hq"],
  "pages/store-detail/index": ["hq"],
  "pages/teacher-create/index": ["hq"],
  "pages/teacher-detail/index": ["hq"],
  "pages/reviews/index": ["hq"],
  "pages/customers/index": ["hq", "store"],
  "pages/records/index": ["hq", "store"],
  "pages/customer-detail/index": ["hq", "store", "teacher"],
  "pages/order-detail/index": ["hq", "store", "teacher"],
  "pages/customer-create/index": ["store", "teacher"],
  "pages/recharge/index": ["store", "teacher"],
  "pages/product-purchase/index": ["store", "teacher"],
  "pages/product-purchase-detail/index": ["hq"],
  "pages/verification/index": ["store", "teacher"]
});

function boundHandlers(wxml) {
  return [...wxml.matchAll(/\b(?:bind|catch)(?::?[a-zA-Z-]+)\s*=\s*"([A-Za-z_$][\w$]*)"/g)]
    .map((match) => match[1]);
}

function declaredHandler(source, handler) {
  const escaped = handler.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[,\\{\\s])${escaped}\\s*\\(`, "m").test(source);
}

function guardedRoles(source) {
  const calls = [...source.matchAll(/requireSession\((\[[^\]]*\])?\)/g)];
  if (!calls.length) return null;
  const explicit = calls.filter((match) => match[1]);
  if (!explicit.length) return ["hq", "store", "teacher"];
  const sets = explicit.map((match) => [...match[1].matchAll(/"(hq|store|teacher)"/g)].map((role) => role[1]).sort());
  sets.slice(1).forEach((roles) => assert.deepEqual(roles, sets[0], "all guards in one page must enforce the same role set"));
  return sets[0];
}

test("every registered page and reusable component wires each visible interaction to a real handler", () => {
  assert.deepEqual([...routes].sort(), Object.keys(ROLE_MATRIX).sort(), "the role matrix must cover every registered page exactly once");
  const targets = routes.map((route) => path.join(mini, route));
  const componentRoot = path.join(mini, "components");
  if (fs.existsSync(componentRoot)) {
    for (const name of fs.readdirSync(componentRoot)) targets.push(path.join(componentRoot, name, "index"));
  }

  for (const target of targets) {
    const jsPath = `${target}.js`;
    const wxmlPath = `${target}.wxml`;
    if (!fs.existsSync(jsPath) || !fs.existsSync(wxmlPath)) continue;
    const source = fs.readFileSync(jsPath, "utf8");
    const wxml = fs.readFileSync(wxmlPath, "utf8");
    for (const handler of new Set(boundHandlers(wxml))) {
      assert.ok(declaredHandler(source, handler), `${path.relative(mini, wxmlPath)} binds missing handler ${handler}`);
    }
  }
});

test("every page enforces the exact headquarters, store, and teacher permission matrix", () => {
  for (const route of routes) {
    const expected = [...ROLE_MATRIX[route]].sort();
    const actual = guardedRoles(read(`${route}.js`));
    if (!expected.length) {
      assert.equal(actual, null, `${route} is public and must not depend on a stale business session`);
    } else {
      assert.deepEqual(actual, expected, `${route} exposes the wrong roles`);
    }
  }

  const home = read("pages/home/index.wxml");
  assert.match(home, /businessMenuOpen && session\.role !== 'hq'/, "only store and teacher may open business handling");
  assert.match(home, /queryMenuOpen && session\.role !== 'teacher'/, "only headquarters and store may open general queries");
  assert.match(home, /managementMenuOpen && session\.role === 'hq'/, "only headquarters may open management");
  assert.match(home, /reviewMenuOpen && session\.role === 'hq'/, "only headquarters may open reviews");
  assert.match(home, /wx:if="\{\{session\.role === 'teacher'\}\}" bindtap="openVerification" data-mode="EXPERIENCE"/,
    "experience handling must remain teacher-only");
});

test("all authenticated pages keep the native navigation title on the company brand", () => {
  assert.equal(app.window.navigationBarTitleText, "露思卓儿");
  for (const route of routes) {
    if (!ROLE_MATRIX[route].length) continue;
    const page = JSON.parse(read(`${route}.json`));
    assert.equal(page.navigationBarTitleText, "露思卓儿", `${route} must keep the native title on the brand`);
    const source = read(`${route}.js`);
    const titleCalls = source.match(/setNavigationBarTitle\([^)]*\)/g) || [];
    for (const call of titleCalls) {
      assert.match(call, /setNavigationBarTitle\(\{\s*title:\s*"露思卓儿"\s*\}\)/,
        `${route} must not replace the native brand with a page title`);
    }
  }
});
