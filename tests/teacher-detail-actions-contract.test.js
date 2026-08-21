"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const staffDetail = read("staff-detail.js");
const staffDetailHtml = read("staff-detail.html");
const teacherCreateHtml = read("teacher-create.html");
const teacherCreateScript = read("teacher-create.js");
const teacherManagementHtml = read("teacher-management.html");
const teacherManagement = read("teacher-management.js");
const legacyTeacherDetail = read("teacher-detail.html");

assert.match(staffDetail, /params\.get\("id"\) \|\| params\.get\("teacherId"\) \|\| params\.get\("teacherCode"\)/,
  "new teacher home must accept compatibility deep links");
assert.match(staffDetail, /item\.teacher_code, item\.person_code/,
  "teacher home must resolve legacy teacher-code links");

for (const retired of [
  "staffFaceAction", "teacherFaceUpdatePanel", "teacherFaceUpdateCamera",
  "teacherFaceUpdateConsent", "saveTeacherFaceUpdate", "upsertTeacherFace"
]) {
  assert.equal(staffDetailHtml.includes(retired) || staffDetail.includes(retired), false,
    `teacher detail must expose no post-creation face write surface: ${retired}`);
}
assert.match(staffDetail, /已登记 · 用于体验核销/,
  "teacher home may show the creation-time enrollment state as read-only information");
assert.match(staffDetail, /不用于登录[\s\S]{0,120}普通核销不要求老师再次识别/,
  "teacher home must explain the exact limited purpose of the creation-time face");
assert.match(teacherCreateScript, /outputHeight = Math\.round\(Math\.min\(sourceHeight, 1024\)\)/,
  "required creation-time enrollment must use the customer enrollment crop size");
assert.match(teacherCreateScript, /待服务端检测/,
  "captured photographs must remain explicitly pending until the formal request");
assert.match(teacherCreateScript, /创建时由服务端检测质量，并按配置检测活体/,
  "required creation-time enrollment must explain that quality and configured liveness are checked by the formal server call");
assert.doesNotMatch(teacherCreateScript, /callFaceValidation|validateTeacherFaceEnrollmentCapture|LIVENESS_FAILED/,
  "the browser must not duplicate or partially interpret the service's quality/liveness decision");

assert.match(staffDetail, /Promise\.allSettled\(\[/,
  "quota read and product catalog read must not fail together");
assert.match(staffDetail, /productCatalogError/,
  "product-catalog outage must have a separate degraded state");
assert.match(staffDetail, /额度与历史已读取，但活跃产品目录暂不可用/,
  "degraded quota state must keep its usable data visible");
assert.match(staffDetail, /staff\.auth_uid && hasPhoneAuthMethod\("setStaffStatus"\)/,
  "teacher activation must use the direct status path when an account exists");
assert.match(staffDetail, /function canManageTeacherExperience\(method, messageId, actionName\)/,
  "quota buttons must explain why an action is unavailable instead of silently returning");
assert.match(staffDetail, /老师已封存，体验额度和历史仍可查询，但不能配置、删除或充值/,
  "stale quota controls must keep archived teachers read-only with an explicit explanation");
assert.match(staffDetail, /hasPhoneAuthMethod\("resetStaffPassword"\)/,
  "password reset must fail with an actionable message when its client method is unavailable");
assert.match(staffDetail, /canUpdateByAccount[\s\S]{0,260}canUpdateByMaster/,
  "status action must accept either a login-bound account or a legacy teacher master record");

assert.match(legacyTeacherDetail, /location\.replace\(destination\)/,
  "legacy teacher detail must redirect rather than show mock data");
assert.match(legacyTeacherDetail, /staff-detail\.html\?role=teacher&id=/,
  "legacy teacher detail must preserve its target teacher");
for (const file of ["query.js", "management.js", "detail.js"]) {
  assert.doesNotMatch(read(file), /teacher-detail\.html/,
    `${file} must no longer point users to the retired mock teacher page`);
}

assert.match(staffDetailHtml, /cloudbase-phone-auth\.js\?v=0\.19\.2/,
  "teacher home must refresh the shared cloud-function client");
assert.match(staffDetailHtml, /staff-detail\.js\?v=0\.15\.7/,
  "teacher home must refresh its action handlers");
assert.match(teacherCreateHtml, /teacher-create\.js\?v=0\.3\.1/,
  "teacher creation must refresh the mandatory-face UI");
assert.match(teacherManagementHtml, /teacher-management\.js\?v=0\.14\.28/,
  "teacher directory must refresh links into the current home");
assert.match(teacherManagement, /teacher\.teacher_id \|\| teacher\.teacherId \|\| teacher\.teacher_code/,
  "teacher directory must keep legacy no-login teacher rows navigable");
assert.match(teacherManagement, /teacher\.teacher_name/,
  "teacher directory must render a teacher-master name when staff_name is absent");

console.log("teacher detail actions contract: PASS");
