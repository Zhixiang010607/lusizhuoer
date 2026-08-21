const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const login = fs.readFileSync(path.join(root, "login.js"), "utf8");
const phoneAuth = fs.readFileSync(path.join(root, "cloudbase-phone-auth.js"), "utf8");
const loginHtml = fs.readFileSync(path.join(root, "login.html"), "utf8");

const resetHandler = login.slice(
  login.indexOf('$("passwordResetForm").addEventListener("submit"'),
  login.indexOf('$("sendSmsCode").addEventListener("click"')
);

assert.match(resetHandler, /const form = event\.currentTarget;/, "password reset must retain the form before awaiting");
assert.match(resetHandler, /const button = form\.querySelector\('\[type="submit"\]'\);/, "submit button must be read from the retained form");
assert.match(resetHandler, /await window\.CloudBasePhoneAuth\.signInWithCode\(code\);[\s\S]*?form\.reset\(\);/, "successful async reset must use the retained form");
assert.doesNotMatch(resetHandler, /event\.currentTarget\.reset\(\)/, "async reset must never dereference a cleared Event.currentTarget");

assert.match(login, /const SMS_BRAND = "露思卓儿";/, "visible SMS status must use the company brand");
assert.match(login, /SMS_BRAND\}验证码已发送/, "login and password-reset SMS confirmations must include the company brand");
assert.match(login, /\$\("loginWelcomeHeading"\)\.hidden = show;/, "password-reset mode must hide the normal login heading");
assert.match(loginHtml, /id="loginWelcomeHeading"/, "normal login heading must be independently hideable");
assert.match(phoneAuth, /function authResponseData\(result, fallback\)/, "authentication responses must be validated centrally");
assert.match(phoneAuth, /if \(!result \|\| typeof result !== "object"\)/, "null SDK responses must become readable errors");
assert.match(phoneAuth, /return authResponseData\(result, "验证码无效或已过期"\);/, "OTP verification must reject an empty SDK response");

assert.ok(loginHtml.includes("cloudbase-phone-auth.js?v=0.18.0"), "login must load the guarded phone-auth client");
assert.ok(loginHtml.includes("login.js?v=0.17.3"), "login must load the mobile password-reset fix");

for (const file of fs.readdirSync(root).filter((name) => name.endsWith(".html"))) {
  const html = fs.readFileSync(path.join(root, file), "utf8");
  if (!html.includes("cloudbase-phone-auth.js?v=")) continue;
  const expectedVersion = file === "staff-detail.html"
    ? "0.19.1"
    : file === "teacher-create.html"
    ? "0.19.0"
    : [
    "index.html", "recharge-review.html", "refund-review.html", "verification-review.html",
    "teacher-management.html"
  ].includes(file)
    ? "0.18.1"
    : "0.18.0";
  assert.ok(html.includes(`cloudbase-phone-auth.js?v=${expectedVersion}`), `${file} must load the guarded phone-auth client`);
}

console.log("password reset contract: PASS");
