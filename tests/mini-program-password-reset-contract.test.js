"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const mini = path.join(root, "miniprogram-app", "miniprogram");
const read = (...parts) => fs.readFileSync(path.join(mini, ...parts), "utf8");

test("mini-program keeps a safe self-service password reset from the login frame", () => {
  const app = JSON.parse(read("app.json"));
  const loginJs = read("pages", "login", "index.js");
  const loginWxml = read("pages", "login", "index.wxml");
  const resetJs = read("pages", "password-reset", "index.js");
  const resetWxml = read("pages", "password-reset", "index.wxml");
  const resetWxss = read("pages", "password-reset", "index.wxss");
  const session = read("services", "session.js");

  assert.ok(app.pages.includes("pages/password-reset/index"));
  assert.match(loginJs, /openPasswordReset\(\)[\s\S]*?pages\/password-reset\/index/);
  assert.match(loginJs, /\?phone=\$\{encodeURIComponent\(phone\)\}/,
    "a valid phone entered on login should be carried into the reset page");
  assert.match(loginWxml, /class="password-reset-row"><text class="password-reset-link" role="button" bindtap="openPasswordReset">修改密码<\/text><\/view>/);
  assert.match(loginWxml, />\s*<text>微信手机号登录<\/text>\s*<\/button>/);
  assert.match(resetWxml, /获取验证码/);
  assert.match(resetWxml, /class="reset-submit"[^>]*>\s*<text>保存新密码<\/text>\s*<\/button>/);
  assert.match(resetWxss, /\.code-field button\s*\{[^}]*width:\s*100%\s*!important[^}]*min-width:\s*0/s,
    "the SMS button must fit its grid column instead of inheriting the native button width");
  assert.match(resetWxss, /\.reset-submit\s*\{[^}]*display:\s*flex[^}]*align-items:\s*center[^}]*justify-content:\s*center[^}]*text-align:\s*center/s,
    "save-password wording must be centered in both axes");
  assert.match(resetJs, /password\.length >= 8 && password\.length <= 32 && groups >= 3/);
  assert.match(resetJs, /newPassword !== this\.data\.confirmation/);
  assert.match(resetJs, /露思卓儿验证码已发送。60 秒内不能重复发送，请尽快完成修改。/,
    "mini-program SMS status must match the branded web flow");
  assert.match(session, /signInWithOtp\(\{ phone, options: \{ shouldCreateUser: false \} \}\)/,
    "password reset must never create a stranger Auth user");
  assert.match(session, /SMS_COOLDOWN_MS = 60 \* 1000/);
  assert.match(session, /passwordResetCooldownRemaining\(phone\)/,
    "mini-program must enforce the same persisted 60-second resend guard as web");
  assert.match(session, /if \(!result \|\| typeof result !== "object"\)/,
    "an empty SDK result must never be accepted as an OTP session");
  assert.match(session, /if \(!result\.data \|\| typeof result\.data !== "object"\)/,
    "an empty SDK data envelope must never reach changeOwnPassword");
  assert.match(session, /passwordResetVerifier\(\{ token: code \}\)/);
  assert.match(session, /callStaff\("changeOwnPassword", \{ newPassword \}\)/,
    "password reset must update only the currently verified UID");
  assert.match(session, /if \(verified\) await clearFailedLogin\(auth\)/,
    "the OTP session must be signed out after the reset attempt");
  assert.doesNotMatch(session, /callStaff\("changeOwnPassword", \{[^}]*phone/,
    "the business password change must never trust a client phone");
});
