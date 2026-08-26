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
assert.match(staffDetail, /老师身份由登录手机号和账号主档绑定[\s\S]{0,160}现场只核验客户人脸/,
  "teacher home must explain account binding and customer-only experience verification");
assert.match(staffDetail, /document\.title = isTeacher \? "老师主页" : `\$\{labels\[role\]\}主页`/,
  "shared staff detail must use a role-correct browser title");
assert.match(staffDetail, /backToManagement[\s\S]{0,120}textContent = `返回\$\{isTeacher \? "老师管理" : "总部管理"\}`/,
  "shared staff detail must use a role-correct management link");
assert.match(staffDetail, /staffSecurityTitle[\s\S]{0,100}textContent = `\$\{labels\[role\]\}账号管理`/,
  "shared staff detail must not label HQ account controls as teacher controls");
assert.doesNotMatch(`${teacherCreateHtml}\n${teacherCreateScript}`,
  /camera|capturedFace|faceImage|validateTeacherCreateCapture|createTeacherWithFace|老师人脸|拍照|活体/i,
  "teacher creation must contain no photograph or teacher-face workflow");
assert.match(teacherCreateScript, /CloudBasePhoneAuth\.createTeacher\(\{/,
  "teacher creation must use the lightweight account-and-profile service");

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
assert.match(staffDetail, /refreshed && actualArchived === expectedArchived[\s\S]{0,500}setStaffStatusFeedback\(`\$\{labels\[role\]\}已\$\{expectedArchived \? "封存" : "激活"\}。`, "success"\)/,
  "status feedback must be based on the authoritative database refresh");
assert.doesNotMatch(staffDetail, /接口响应中断|数据库当前状态为/,
  "confirmed status actions must not expose transport or database diagnostics in the UI");

assert.match(legacyTeacherDetail, /location\.replace\(destination\)/,
  "legacy teacher detail must redirect rather than show mock data");
assert.match(legacyTeacherDetail, /staff-detail\.html\?role=teacher&id=/,
  "legacy teacher detail must preserve its target teacher");
for (const file of ["query.js", "management.js", "detail.js"]) {
  assert.doesNotMatch(read(file), /teacher-detail\.html/,
    `${file} must no longer point users to the retired mock teacher page`);
}

assert.match(staffDetailHtml, /cloudbase-phone-auth\.js\?v=0\.20\.3/,
  "teacher home must refresh the shared cloud-function client");
assert.match(staffDetailHtml, /staff-detail\.js\?v=0\.15\.10/,
  "teacher home must refresh its action handlers");
assert.match(teacherCreateHtml, /teacher-create\.js\?v=0\.5\.0/,
  "teacher creation must refresh the no-photo UI");
assert.match(teacherManagementHtml, /teacher-management\.js\?v=0\.14\.28/,
  "teacher directory must refresh links into the current home");
assert.match(teacherManagement, /teacher\.teacher_id \|\| teacher\.teacherId \|\| teacher\.teacher_code/,
  "teacher directory must keep legacy no-login teacher rows navigable");
assert.match(teacherManagement, /teacher\.teacher_name/,
  "teacher directory must render a teacher-master name when staff_name is absent");

console.log("teacher detail actions contract: PASS");
