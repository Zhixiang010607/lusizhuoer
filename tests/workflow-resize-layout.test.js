const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const script = fs.readFileSync(path.join(root, "store-business.js"), "utf8");
const workflowPages = ["recharge-create.html", "verification-create.html", "verification-experience.html"];

for (const page of workflowPages) {
  const html = fs.readFileSync(path.join(root, page), "utf8");
  assert.match(html, /id="workflowResizeHandle"[^>]*role="separator"/, `${page} should expose the workflow resize handle`);
  assert.match(html, /styles\.css\?v=0\.15\.32/, `${page} should load the current responsive stylesheet`);
  assert.match(html, /store-business\.js\?v=0\.14\.50/, `${page} should load the current workflow script`);
}

const customerHtml = fs.readFileSync(path.join(root, "customer-create.html"), "utf8");
assert.match(customerHtml, /id="customerCreateResizeHandle"[^>]*role="separator"/, "customer creation should retain its own resize handle");
assert.match(css, /\.store-workflow-main \{[^}]*--workflow-lookup-width:\s*39%;[^}]*grid-template-columns:[^}]*14px[^}]*minmax\(0, 1fr\)/, "desktop workflow should use a three-track resizable grid");
assert.match(css, /@media \(max-width: 980px\)[\s\S]*?body\[data-store-business\] \.workflow-resize-handle \{\s*display:\s*none;/, "tablet workflow should stack and hide the resize handle");
assert.match(script, /function setupWorkflowResize\(\)/, "workflow resize setup should exist");
assert.match(script, /resizeHandle\.addEventListener\("pointerdown"/, "workflow resizing should support pointer input");
assert.match(script, /\["ArrowLeft", "ArrowRight", "Home"\]/, "workflow resizing should support keyboard input");
assert.match(script, /setupWorkflowResize\(\);\s*if \(teacherMode\)/, "workflow resizing should initialize before role-specific business setup");

console.log("workflow resize layout contract: ok");
