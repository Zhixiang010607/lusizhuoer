"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const login = fs.readFileSync(path.join(root, "login.js"), "utf8");
const authUi = fs.readFileSync(path.join(root, "auth-ui.js"), "utf8");
const html = fs.readFileSync(path.join(root, "login.html"), "utf8");
const context = fs.readFileSync(path.join(root, "PROJECT_CONTEXT.md"), "utf8");

test("production Web login accepts HQ accounts only", () => {
  assert.match(login, /WEB_HQ_ONLY_ERROR/);
  assert.match(login, /localDemo\.role !== "hq"/);
  assert.match(login, /staff\.profile\.role !== "hq"/);
  assert.match(login, /await closeUnauthorizedWebSession\(\)/);
  assert.match(login, /CloudBasePhoneAuth\?\.signOut/);
  assert.match(login, /clearWorkspaceSession\(\)/);
  assert.match(html, /login\.js\?v=0\.17\.6/);
  assert.doesNotMatch(html, /验证码登录|id="smsLoginMode"|id="loginSmsCode"|id="sendSmsCode"/);
  assert.doesNotMatch(login, /loginMode|refreshSmsButton|\$\("sendSmsCode"\)/);
  assert.match(login, /signInWithPassword\(phone, password\)/);
  assert.match(login, /changeOwnPassword\(password\)[\s\S]{0,100}CloudBasePhoneAuth\.signOut\(\)/);
});

test("protected Web pages reject an old non-HQ browser session", () => {
  assert.match(authUi, /!isLocalPreview && session\.role !== "hq"/);
  assert.match(authUi, /SESSION_KEYS\.forEach\(\(key\) => sessionStorage\.removeItem\(key\)\)/);
  assert.match(authUi, /CloudBasePhoneAuth\.signOut\(\)/);
  assert.match(authUi, /老师和门店账号请使用微信小程序/);
  assert.match(context, /旧网页版只允许总部账号用“手机号＋密码”登录和使用/);
  assert.match(context, /网页版验证码登录入口已退役/);
});
