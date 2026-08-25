"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const recordQuery = read("query.js");
const customerQuery = read("customer-query.js");
const css = read("styles.css");

for (const page of ["recharge-query.html", "verification-query.html"]) {
  const html = read(page);
  assert.match(html, /id="recordPageJumpInput"[^>]*type="number"[^>]*min="1"[^>]*step="1"/, `${page} exposes a positive-integer page input`);
  assert.match(html, /id="recordPageJumpButton"[^>]*>跳转<\//, `${page} exposes an explicit page-jump action`);
  assert.match(html, /query\.js\?v=0\.15\.11/, `${page} busts the record-query script cache`);
  assert.match(html, /styles\.css\?v=0\.15\.48/, `${page} busts the pager-style cache`);
}

const customerPage = read("customer-query.html");
assert.match(customerPage, /id="customerPageJumpInput"[^>]*type="number"[^>]*min="1"[^>]*step="1"/, "customer query exposes a positive-integer page input");
assert.match(customerPage, /id="customerPageJumpButton"[^>]*>跳转<\//, "customer query exposes an explicit page-jump action");
assert.match(customerPage, /customer-query\.js\?v=0\.15\.4/, "customer query busts its script cache");
assert.match(customerPage, /styles\.css\?v=0\.15\.48/, "customer query busts the pager-style cache");

for (const [source, prefix] of [[recordQuery, "Record"], [customerQuery, "Customer"]]) {
  const lower = prefix.toLowerCase();
  assert.match(source, new RegExp(`async function jumpTo${prefix}Page\\(\\)`), `${prefix} query has a page-jump handler`);
  assert.match(source, /Math\.min\(Math\.max\(requestedPage, 1\), totalPages\)/, `${prefix} query clamps out-of-range page numbers`);
  assert.match(source, new RegExp(`furthestKnown${prefix}Page\\(\\)`), `${prefix} query locates the furthest cached cursor`);
  assert.match(source, /while \(pageIndex < targetIndex\) \{[\s\S]*?cursors\[pageIndex \+ 1\] = nextCursor;[\s\S]*?await load\(\{ resetPage: false \}\);/, `${prefix} query fetches cursor pages through to an arbitrary destination`);
  assert.match(source, new RegExp(`${lower}PageJumpInput"\\)\\.onkeydown = \\(event\\) => \\{[\\s\\S]*?event\\.key !== "Enter"`), `${prefix} query supports pressing Enter in the page input`);
  assert.match(source, /isPageJumping \|\| isPageLoading/, `${prefix} query locks pagination while a fetch-through jump is running`);
  assert.match(source, new RegExp(`set${prefix}PageJumpFiltersLocked\\(true\\)`), `${prefix} query locks its filters so a fetch-through jump keeps one query scope`);
}

assert.match(css, /record-page-jump[^}]*display: inline-flex/, "page-jump input has a compact inline layout");
assert.match(css, /record-page-jump input[^}]*width: 52px/, "page-jump input has a bounded width");

console.log("query page jump contract: ok");
