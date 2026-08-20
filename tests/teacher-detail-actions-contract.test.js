"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const staffDetail = read("staff-detail.js");
const staffDetailHtml = read("staff-detail.html");
const teacherCreateHtml = read("teacher-create.html");
const teacherManagementHtml = read("teacher-management.html");
const legacyTeacherDetail = read("teacher-detail.html");

function sourceBetween(name, nextName) {
  const start = staffDetail.indexOf(`function ${name}`);
  const end = nextName ? staffDetail.indexOf(`function ${nextName}`, start + 1) : staffDetail.length;
  assert.ok(start >= 0 && end > start, `${name} must remain a distinct staff-detail handler`);
  return staffDetail.slice(start, end);
}

assert.match(staffDetail, /params\.get\("id"\) \|\| params\.get\("teacherId"\) \|\| params\.get\("teacherCode"\)/,
  "new teacher home must accept compatibility deep links");
assert.match(staffDetail, /item\.teacher_code, item\.person_code/,
  "teacher home must resolve legacy teacher-code links");

const faceControlSync = sourceBetween("syncTeacherFaceUpdateControls", "clearTeacherFaceUpdate");
const faceOpener = sourceBetween("openTeacherFaceUpdate", "closeTeacherFaceUpdate");
assert.doesNotMatch(faceControlSync, /isStaffArchived\(\)/,
  "archiving must not disable HQ face-profile maintenance");
assert.doesNotMatch(faceOpener, /isStaffArchived\(\)\) return/,
  "archiving must not silently block opening the face form");
assert.match(staffDetail, /老师当前处于封存状态，补录不会恢复登录/,
  "archived-face workflow must say that face changes do not reactivate login");
assert.match(staffDetail, /faceAction\.disabled = !teacherId\(\)/,
  "face action must depend only on a usable teacher identity");
assert.doesNotMatch(staffDetail.slice(staffDetail.indexOf('$("teacherFaceUpdateForm")'), staffDetail.indexOf('$("teacherExperienceConfigForm")')),
  /isStaffArchived\(\)/,
  "face submission must remain available for an archived teacher");

assert.match(staffDetail, /Promise\.allSettled\(\[/,
  "quota read and product catalog read must not fail together");
assert.match(staffDetail, /productCatalogError/,
  "product-catalog outage must have a separate degraded state");
assert.match(staffDetail, /额度与历史已读取，但活跃产品目录暂不可用/,
  "degraded quota state must keep its usable data visible");
assert.match(staffDetail, /staff\.auth_uid && window\.CloudBasePhoneAuth\?\.setStaffStatus/,
  "teacher activation must use the direct status path when an account exists");

assert.match(legacyTeacherDetail, /location\.replace\(destination\)/,
  "legacy teacher detail must redirect rather than show mock data");
assert.match(legacyTeacherDetail, /staff-detail\.html\?role=teacher&id=/,
  "legacy teacher detail must preserve its target teacher");
for (const file of ["query.js", "management.js", "detail.js"]) {
  assert.doesNotMatch(read(file), /teacher-detail\.html/,
    `${file} must no longer point users to the retired mock teacher page`);
}

assert.match(staffDetailHtml, /cloudbase-phone-auth\.js\?v=0\.18\.1/,
  "teacher home must refresh the shared cloud-function client");
assert.match(staffDetailHtml, /staff-detail\.js\?v=0\.15\.1/,
  "teacher home must refresh its action handlers");
assert.match(teacherCreateHtml, /teacher-create\.js\?v=0\.2\.1/,
  "teacher creation must refresh the optional-face UI");
assert.match(teacherManagementHtml, /teacher-management\.js\?v=0\.14\.26/,
  "teacher directory must refresh links into the current home");

console.log("teacher detail actions contract: PASS");
