const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const html = fs.readFileSync(path.join(root, "customer-detail.html"), "utf8");

const desktopBlock = css.match(/@media \(min-width: 900px\) and \(min-height: 760px\) \{([\s\S]*?)\n\}/)?.[1] || "";
const desktopBodyRule = desktopBlock.match(/body\[data-customer-profile\] \{([^}]*)\}/)?.[1] || "";

assert.ok(desktopBlock, "customer profile desktop media block should exist");
assert.match(desktopBlock, /body\[data-customer-profile\] \{[^}]*height: auto;[^}]*overflow-y: auto;/, "desktop customer profile must use page scrolling");
assert.doesNotMatch(desktopBodyRule, /(?:^|;\s*)height:\s*100dvh/, "desktop customer profile must not lock the page to one viewport");
assert.match(desktopBlock, /\.customer-profile-main \{[^}]*grid-auto-rows: auto;[^}]*overflow: visible;/, "profile sections must grow to their natural height");
assert.doesNotMatch(desktopBlock, /grid-template-rows:\s*178px/, "customer header must not be compressed into the old fixed row");
assert.match(desktopBlock, /\.customer-project-panel \.customer-record-scroll \{[^}]*height: 166px;[^}]*max-height: 166px;/, "project records should keep their own bounded scroll area");
assert.match(desktopBlock, /\.customer-record-panel \.customer-record-scroll \{[^}]*height: 158px;[^}]*max-height: 158px;/, "order records should keep their own bounded scroll area");
assert.match(html, /styles\.css\?v=0\.14\.32/, "customer page should bust the stylesheet cache");

console.log("customer profile layout contract: ok");
