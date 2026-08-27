"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const diagnostics = require(path.resolve(
  __dirname,
  "..",
  "miniprogram-app",
  "miniprogram",
  "services",
  "wechat-phone.js"
));

test("WeChat phone authorization distinguishes denial from platform capability failures", () => {
  assert.match(
    diagnostics.authorizationFailureMessage({ errMsg: "getPhoneNumber:fail user deny" }),
    /取消微信手机号授权/
  );
  assert.match(
    diagnostics.authorizationFailureMessage({ errMsg: "getPhoneNumber:fail no permission", errno: 1001 }),
    /尚未取得微信手机号验证权限.*错误码 1001/
  );
  assert.match(
    diagnostics.authorizationFailureMessage({ errMsg: "getPhoneNumber:fail 1400001 quota exhausted" }),
    /手机号快速验证组件/
  );
});

test("WeChat phone diagnostics never echo the one-time phone code", () => {
  const oneTimeCode = "private-one-time-phone-code";
  const message = diagnostics.authorizationFailureMessage({
    code: oneTimeCode,
    errMsg: "getPhoneNumber:fail unknown"
  });
  assert.equal(message.includes(oneTimeCode), false);
});

test("CloudBase phone login failures expose a bounded error code and parse JSON messages", () => {
  assert.equal(
    diagnostics.loginFailureMessage({
      message: JSON.stringify({ message: "该手机号未关联现有账号" }),
      code: "USER_NOT_FOUND"
    }),
    "该手机号未关联现有账号（错误码 USER_NOT_FOUND）"
  );
});
