const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const auth = fs.readFileSync(path.join(root, "auth-ui.js"), "utf8");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");

assert.match(auth, /className = "mobile-account-menu"/, "authenticated pages must create a compact account menu");
assert.match(auth, /id="logoutWorkspaceMobile"[^>]*>退出登录</, "mobile account menu must expose a visible logout action");
assert.match(auth, /mobileAccountMenu\.querySelector\("strong"\)\.textContent/, "mobile account menu must show the current account safely");
assert.match(auth, /const logoutButtons = \[\$\("logoutWorkspace"\), \$\("logoutWorkspaceMobile"\)\]/, "desktop and mobile logout buttons must share one handler");
assert.match(auth, /logoutButtons\.forEach\(\(button\) => button\.addEventListener\("click", logoutWorkspace\)\)/, "both logout controls must invoke sign-out");

assert.match(css, /\.mobile-account-menu \{ display: none; \}/, "account menu must stay hidden on wide desktop layouts");
assert.match(css, /@media \(min-width: 761px\) and \(max-width: 1100px\)[\s\S]*?\.mobile-account-menu \{[^}]*display: block;/, "collapsed tablet sidebar must expose the account menu");
assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.mobile-account-menu \{[^}]*display: block;/, "phone project bar must expose the account menu");
assert.match(css, /\.mobile-account-popover button \{[^}]*width: 100%/, "logout action must fill the account popover width");

for (const file of fs.readdirSync(root).filter((name) => name.endsWith(".html"))) {
  const html = fs.readFileSync(path.join(root, file), "utf8");
  if (!html.includes("auth-ui.js?v=")) continue;
  assert.ok(html.includes("auth-ui.js?v=0.18.4"), `${file} must load the mobile-logout auth UI`);
}

console.log("mobile logout contract: PASS");
