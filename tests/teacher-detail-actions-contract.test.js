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
assert.match(staffDetailHtml, /teacherFaceUpdateCamera[\s\S]*?captureTeacherFaceUpdate/,
  "teacher face replacement must use the same camera-first capture interaction as customer enrollment");
assert.doesNotMatch(staffDetailHtml, /teacherFaceUpdateFile|type="file"/,
  "teacher face replacement must not bypass capture validation through a file upload");
assert.match(staffDetail, /navigator\.mediaDevices\?\.getUserMedia/,
  "teacher face replacement must request a live camera capture");
assert.match(staffDetail, /action:\s*["']validateTeacherFaceEnrollmentCapture["']/,
  "teacher face replacement must use the dedicated HQ quality/liveness preflight");
assert.match(staffDetail, /outputHeight = Math\.round\(Math\.min\(sourceHeight, 1024\)\)/,
  "teacher face replacement must use the customer enrollment crop size");
assert.match(staffDetail, /qualityThreshold[\s\S]{0,220}liveness\.threshold/,
  "teacher face replacement must show quality and liveness thresholds returned by the preflight");
assert.match(staffDetail, /LIVENESS_FAILED[\s\S]{0,250}FACE_NOT_FOUND/,
  "teacher face replacement must distinguish liveness and capture-quality failures");
assert.match(staffDetail, /teacherFaceUpdate\.validated/,
  "teacher face replacement must require a locally validated capture before saving");
assert.match(staffDetail, /teacherFaceUpdate\.requestId \|\|= requestId\("teacher_face_update"\)/,
  "a validated teacher capture must retain one request id for retry-safe saving");
assert.match(teacherCreateScript, /outputHeight = Math\.round\(Math\.min\(sourceHeight, 1024\)\)/,
  "optional creation-time enrollment must use the customer enrollment crop size");
assert.match(teacherCreateScript, /qualityThreshold[\s\S]{0,220}liveness\.threshold/,
  "optional creation-time enrollment must show the preflight thresholds");
assert.match(teacherCreateScript, /LIVENESS_FAILED[\s\S]{0,250}FACE_NOT_FOUND/,
  "optional creation-time enrollment must distinguish liveness and capture-quality failures");

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

assert.match(staffDetailHtml, /cloudbase-phone-auth\.js\?v=0\.18\.1/,
  "teacher home must refresh the shared cloud-function client");
assert.match(staffDetailHtml, /staff-detail\.js\?v=0\.15\.3/,
  "teacher home must refresh its action handlers");
assert.match(teacherCreateHtml, /teacher-create\.js\?v=0\.2\.2/,
  "teacher creation must refresh the optional-face UI");
assert.match(teacherManagementHtml, /teacher-management\.js\?v=0\.14\.27/,
  "teacher directory must refresh links into the current home");
assert.match(teacherManagement, /teacher\.teacher_id \|\| teacher\.teacherId \|\| teacher\.teacher_code/,
  "teacher directory must keep legacy no-login teacher rows navigable");
assert.match(teacherManagement, /teacher\.teacher_name/,
  "teacher directory must render a teacher-master name when staff_name is absent");

console.log("teacher detail actions contract: PASS");
