"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const html = read("teacher-work-orders.html");
const ui = read("teacher-work-orders.js");
const css = read("styles.css");
const authUi = read("auth-ui.js");
const businessUi = read("store-business.js");

test("teacher profile and experience projects stay in compact warm horizontal rows", () => {
  assert.match(html, /styles\.css\?v=0\.15\.59/, "teacher home loads the compact mobile stylesheet revision");
  assert.match(ui, /\["老师姓名",[\s\S]{0,260}\["老师短编号",/,
    "the profile strip contains only the two useful teacher facts");
  assert.doesNotMatch(ui, /loginIdentity|登录手机号|登录账号/,
    "the teacher home must not repeat authenticated login identity");
  assert.doesNotMatch(html, /身份由当前登录账号|<span class="badge">老师本人<\/span>/);
  assert.match(css, /body\[data-teacher-workspace\] #teacherProfileInfo\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/,
    "the two profile facts share one equal-width phone row");
  assert.match(css, /body\[data-teacher-workspace\] \.teacher-profile-panel\s*\{[^}]*#d7ba85[^}]*linear-gradient\(180deg, #fffaf3 0%, #f9edd9 100%\)/s,
    "the teacher profile uses the visible warm ivory and champagne palette");
  assert.match(css, /body\[data-teacher-workspace\] #teacherProfileInfo strong\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap/,
    "long identity values stay inside their own cells");

  assert.match(css, /body\[data-teacher-workspace\] \.teacher-quota-card\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto minmax\(112px, \.92fr\);[^}]*align-items:\s*center;[^}]*min-height:\s*58px/,
    "each experience project is one compact horizontal row");
  assert.match(css, /body\[data-teacher-workspace\] \.teacher-quota-card > div strong,[\s\S]{0,180}white-space:\s*nowrap/,
    "long project names are ellipsized instead of wrapping into tall cards");
  assert.match(css, /body\[data-teacher-workspace\] \.teacher-quota-card dl\s*\{[^}]*repeat\(2, minmax\(0, 1fr\)\)/,
    "monthly allowance and usage share the right-hand space");
  assert.doesNotMatch(css, /teacher-quota-card dl\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/,
    "narrow phones must not stack the two quota facts vertically again");

  for (const color of ["#f4eee3", "#fffaf3", "#d7ba85", "#f5e4c6", "#302a22", "#80622f", "#f4e7d0"]) {
    assert.ok(css.includes(color), `teacher phone palette is missing ${color}`);
  }
});

test("teacher business menu still enters store-first recharge refund verification and experience flows", () => {
  const teacherMenu = authUi.slice(authUi.indexOf('session.role === "teacher"'), authUi.indexOf("} else {", authUi.indexOf('session.role === "teacher"')));
  for (const [href, label] of [
    ["recharge-create.html", "办卡充值"],
    ["refund-create.html", "退费申请"],
    ["verification-create.html", "核销办理"],
    ["verification-experience.html", "体验核销"]
  ]) {
    assert.ok(teacherMenu.includes(`["${href}", "${label}"]`), `${label} must stay in the teacher business menu`);
    assert.match(read(href), /store-business\.js\?v=0\.14\.60/, `${label} must use the store-first business controller`);
  }

  assert.match(businessUi, /const sharedTeacherMode = teacherMode && !legacyTeacherMode/,
    "shared business pages retain a dedicated teacher execution mode");
  assert.match(businessUi, /action:\s*sharedTeacherMode \? "getTeacherBusinessContext" : "getHqBusinessContext"/,
    "teacher store choices come from the authenticated teacher context");
  assert.match(businessUi, /请选择本次办理门店/,
    "teacher business flow requires an explicit store selection");
  assert.match(businessUi, /selectStoreAndStart\(selected\)/,
    "business forms start only after the selected store is confirmed");
});
