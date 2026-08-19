const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const auth = fs.readFileSync(path.join(root, "auth-ui.js"), "utf8");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");

assert.match(auth, /className = "mobile-account-menu"/, "authenticated pages must create a compact account menu");
assert.match(auth, /id="logoutWorkspaceMobile"[^>]*>退出登录</, "mobile account menu must expose a visible logout action");
assert.match(auth, /mobileAccountPopover\.querySelector\("strong"\)\.textContent/, "detached mobile account card must show the current account safely");
assert.match(auth, /document\.body\.append\(mobileAccountPopover\)/, "logout card must live outside the horizontally scrolling rail so phone browsers cannot clip it");
assert.match(auth, /document\.querySelectorAll\("\.side-menu-group\[open\]"\)/, "opening one phone menu must close other expanded menus");
assert.match(auth, /if \(other !== group\) other\.removeAttribute\("open"\)/, "phone menu groups must be mutually exclusive");
assert.match(auth, /const logoutButtons = \[\$\("logoutWorkspace"\), \$\("logoutWorkspaceMobile"\)\]/, "desktop and mobile logout buttons must share one handler");
assert.match(auth, /logoutButtons\.forEach\(\(button\) => button\.addEventListener\("click", logoutWorkspace\)\)/, "both logout controls must invoke sign-out");

assert.match(css, /\.mobile-account-menu \{ display: none; \}/, "account menu must stay hidden on wide desktop layouts");
assert.match(css, /@media \(min-width: 761px\) and \(max-width: 1100px\)[\s\S]*?\.mobile-account-menu \{[^}]*display: block;/, "collapsed tablet sidebar must expose the account menu");
assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.mobile-account-menu \{[^}]*display: block;/, "phone project bar must expose the account menu");
assert.match(css, /\.mobile-account-popover button \{[^}]*width: 100%/, "logout action must fill the account popover width");
assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.side-project-bar \{[^}]*max-width: 100vw;/, "phone project bar must stay inside the viewport");
assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.side-project-bar \{[^}]*justify-content: flex-start;[^}]*overflow-x: auto;[^}]*overflow-y: hidden;/, "phone project bar must use a compact horizontally scrollable rail");
assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.side-brand,[^}]*display: none;/, "phone project bar must remove the space-consuming brand block");
assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.side-nav a span:last-child \{ display: none; \}/, "phone home navigation must use its compact icon label");
assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.side-menu-group summary::after \{ display: none; \}/, "phone menu icons must not reserve space for arrows");
assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.side-menu-group nav \{[^}]*position: fixed;[^}]*right: max\(8px, env\(safe-area-inset-right\)\);[^}]*left: max\(8px, env\(safe-area-inset-left\)\);/, "phone submenus must stay inside the viewport while the top rail scrolls");
assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.mobile-account-menu \{[^}]*position: sticky;[^}]*right: -1px;/, "phone logout trigger must remain visible at the right edge");
assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.mobile-account-popover \{[^}]*position: fixed;[^}]*right: max\(8px, env\(safe-area-inset-right\)\);[^}]*left: max\(8px, env\(safe-area-inset-left\)\);[^}]*max-width: 260px;/, "phone logout card must be sized against both viewport edges instead of its trigger");

for (const file of fs.readdirSync(root).filter((name) => name.endsWith(".html"))) {
  const html = fs.readFileSync(path.join(root, file), "utf8");
  if (!html.includes("auth-ui.js?v=")) continue;
  assert.ok(html.includes("auth-ui.js?v=0.18.7"), `${file} must load the mobile-logout auth UI`);
}

console.log("mobile logout contract: PASS");
