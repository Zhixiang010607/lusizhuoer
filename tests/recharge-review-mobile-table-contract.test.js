"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const html = fs.readFileSync(path.join(root, "recharge-review.html"), "utf8");

assert.match(html, /<body data-review="recharge">/, "recharge review must expose a page-specific responsive scope");
assert.match(html, /styles\.css\?v=0\.15\.49/, "recharge review must refresh the responsive stylesheet");

const phoneCss = css.slice(css.indexOf("@media (max-width: 760px)"));
assert.match(phoneCss, /body\[data-review="recharge"\] \.review-table \.table-scroll \{[^}]*overflow-x:\s*auto;[^}]*overscroll-behavior-x:\s*contain;/,
  "the phone review table must own horizontal scrolling");
assert.match(phoneCss, /body\[data-review="recharge"\] \.review-table table \{[^}]*width:\s*max-content;[^}]*min-width:\s*1040px;[^}]*table-layout:\s*auto;/,
  "phone recharge records must remain horizontal rows");
assert.match(phoneCss, /body\[data-review="recharge"\] \.review-table tr \{[^}]*display:\s*table-row;/,
  "each recharge review record must remain one table row");
assert.match(phoneCss, /body\[data-review="recharge"\] \.review-table th,[\s\S]*?\.review-table td \{[^}]*display:\s*table-cell;[^}]*white-space:\s*nowrap;/,
  "review fields must remain horizontal cells rather than stacked cards");
assert.match(phoneCss, /body\[data-review="recharge"\] \.review-table td::before \{[^}]*display:\s*none;[^}]*content:\s*none;/,
  "phone recharge cells must not inject stacked-card labels");

console.log("recharge review mobile horizontal table contract: PASS");
