"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const staff = read("cloudfunctions/staffAccount/index.js");
const face = read("cloudfunctions/faceRecognition/index.js");
const schema = read("database/schema.sql");
const context = read("PROJECT_CONTEXT.md");
const directoryJs = read("miniprogram-app/miniprogram/pages/hq-directory/index.js");
const directoryView = read("miniprogram-app/miniprogram/pages/hq-directory/index.wxml");
const teacherDetail = read("miniprogram-app/miniprogram/pages/teacher-detail/index.wxml");
const dashboard = read("miniprogram-app/miniprogram/services/home-dashboard.js");
const orderDetail = read("miniprogram-app/miniprogram/pages/order-detail/index.js");

assert.match(staff, /const FUNCTION_VERSION = "v92"/);
assert.match(staff, /COALESCE\(NULLIF\(BTRIM\(t\.teacher_code\), ''\),[\s\S]*a\.id::text\)/,
  "teacher directory compatibility code must use the real unique teacher code");
assert.doesNotMatch(staff.slice(staff.indexOf('if (action === "listStaff")'), staff.indexOf('if (action === "listProducts")')), /LPAD\(a\.id::text, 3/,
  "staff IDs must never be truncated into duplicate three-character display codes");

assert.match(face, /const FUNCTION_VERSION = PHOTO_ONLY_FUNCTION \? "v12" : "v128"/);
assert.match(face, /SELECT t\.id AS teacher_id, t\.teacher_code, t\.teacher_name, a\.phone AS teacher_phone/);
assert.match(face, /teacherPhone: teacher\.teacher_phone/);
assert.match(face, /teacherPhone: caller\.teacherPhone/);

assert.doesNotMatch(directoryView, /老师编号|\{\{item\.code\}\}/);
assert.match(directoryView, /老师姓名[\s\S]*联系电话[\s\S]*状态/);
assert.doesNotMatch(directoryJs, /item\.code\.toLocaleLowerCase/);
assert.doesNotMatch(teacherDetail, /编号 \{\{profile\.code\}\}/);
assert.match(teacherDetail, /联系电话 \{\{profile\.phone\}\}/);
assert.match(dashboard, /老师姓名[\s\S]{0,180}联系电话/);
assert.doesNotMatch(dashboard, /老师短编号/);
assert.doesNotMatch(orderDetail, /label: "业务老师"[^\n]*teacherCode/);

for (const page of ["product-purchase", "recharge", "verification"]) {
  const js = read(`miniprogram-app/miniprogram/pages/${page}/index.js`);
  const wxml = read(`miniprogram-app/miniprogram/pages/${page}/index.wxml`);
  assert.match(js, /teacherPhone/);
  assert.match(js, /displayName: teacherName \+ \(teacherPhone/);
  assert.doesNotMatch(wxml, /teacherCode/);
  assert.match(wxml, /selectedTeacher\.displayName/);
}

assert.match(schema, /teacher_code VARCHAR\(32\) NOT NULL UNIQUE/);
assert.match(schema, /customer_code VARCHAR\(32\) NOT NULL UNIQUE/);
assert.match(context, /小程序可见界面不再展示老师编号/);
assert.match(context, /手机号仍由全局唯一约束保证不同账号不重复/);

console.log("teacher visible identity contract: PASS");
