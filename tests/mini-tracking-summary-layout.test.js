"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

for (const route of ["attendance-tracking", "daily-report-tracking"]) {
  test(`${route}: date stays complete and counts cannot force a phone-wide row`, () => {
    const css = fs.readFileSync(path.join(__dirname, "..", "miniprogram-app/miniprogram/pages", route, "index.wxss"), "utf8");
    assert.match(css, /\.result-summary \{[^}]*display: grid;[^}]*grid-template-columns: minmax\(0, 1fr\);[^}]*box-sizing: border-box;/);
    assert.match(css, /\.result-summary \.section-title \{ white-space: nowrap; \}/);
    assert.match(css, /\.summary-counts \{[^}]*display: grid;[^}]*repeat\(2, minmax\(0, 1fr\)\)[^}]*min-width: 0;[^}]*max-width: 100%;/);
    assert.match(css, /\.summary-counts text \{[^}]*box-sizing: border-box;[^}]*align-items: center;[^}]*justify-content: center;/);
    assert.match(css, /@media \(min-width: 700px\)[\s\S]*\.result-summary \{[^}]*flex-wrap: wrap;/);
    assert.match(css, /@media \(min-width: 700px\)[\s\S]*\.summary-counts \{[^}]*flex-wrap: wrap;/);
    assert.doesNotMatch(css, /\.result-summary[^}]*overflow:\s*hidden/);
  });
}
