"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const css = read("styles.css");
const management = read("teacher-management.js");
const managementHtml = read("teacher-management.html");
const create = read("teacher-create.js");
const createHtml = read("teacher-create.html");
const detail = read("staff-detail.js");
const detailHtml = read("staff-detail.html");

for (const html of [createHtml, detailHtml, read("teacher-detail.html")]) {
  assert.match(html, /styles\.css\?v=0\.15\.(?:5[0-3]|61)/, "every teacher management surface must refresh the shared visual system");
  assert.match(html, /<meta\s+name="viewport"/, "teacher pages must declare a mobile viewport");
}
assert.match(managementHtml, /styles\.css\?v=0\.15\.58/, "teacher directory must refresh the horizontal phone table layout");
assert.match(managementHtml, /<meta\s+name="viewport"/, "teacher directory must declare a mobile viewport");
assert.match(managementHtml, /teacher-management\.js\?v=0\.14\.28/, "teacher directory behavior must be cache-busted");
assert.match(createHtml, /teacher-create\.js\?v=0\.5\.0/, "teacher creation behavior must be cache-busted");
assert.match(createHtml, /cloudbase-phone-auth\.js\?v=0\.20\.3/,
  "teacher creation must refresh the no-photo creation API wrapper");
assert.match(detailHtml, /staff-detail\.js\?v=0\.15\.11/, "teacher home behavior must be cache-busted");

for (const label of ["老师姓名", "老师编号", "联系电话", "状态", "体验额度", "账号操作"]) {
  assert.ok(management.includes(`data-label="${label}"`), `mobile teacher cards must expose the ${label} field label`);
}
assert.match(management, /teacher-archive-button/, "teacher archive must use the restrained destructive action class");
assert.match(management, /teacher-activate-button/, "teacher activation must have a distinct restorative action class");
assert.match(management, /const authoritative = \[teacher\.account_status, teacher\.teacher_status\][\s\S]{0,260}if \(authoritative\.length\) return authoritative\.includes\("ARCHIVED"\)/, "teacher list status must prefer account and teacher master fields over a stale compatibility status");
assert.match(management, /textContent = `\$\{action\}中…`[\s\S]{0,220}aria-busy/, "teacher status writes must expose a visible and semantic pending state");
assert.match(management, /finally \{[\s\S]{0,160}await loadTeachers\(\)/, "teacher list must reconcile from the server even after a status request error");
assert.match(management, /AUTH_CREDENTIAL_MISSING[\s\S]{0,120}AUTH_ACCOUNT_MISSING[\s\S]{0,320}压力测试或历史占位账号[\s\S]{0,180}安全保持封存/, "teacher list must explain that a credential-less placeholder cannot be activated");
assert.match(management, /TEACHER_PROFILE_MISSING[\s\S]{0,260}老师资料修复迁移/, "teacher status errors must turn a missing profile code into an actionable recovery message");
assert.match(createHtml, /老师不采集照片、不建立人脸/,
  "new-teacher UI must state that creation has no teacher photograph or face identity");
assert.match(createHtml, /无需照片[\s\S]{0,600}体验核销自动绑定老师，现场只核验客户人脸/,
  "the visible account rules must make the no-photo customer-verification policy explicit");
assert.doesNotMatch(`${createHtml}\n${create}`,
  /teacherFaceConsent|teacherFaceCamera|capturedFaceImage|faceImageBase64|validateTeacherCreateCapture|createTeacherWithFace/,
  "teacher creation must expose no camera, consent, face payload or face API");
assert.match(create,
  /Boolean\(\$\("personCreateName"\)\.value\.trim\(\)\)[\s\S]{0,180}Boolean\(\$\("personPhone"\)\.value\.trim\(\)\)[\s\S]{0,180}passwordIsValid/,
  "teacher submit readiness must depend only on name, phone and password");
assert.match(create, /await window\.CloudBasePhoneAuth\.createTeacher\(\{[\s\S]{0,260}staffName,[\s\S]{0,120}phone,[\s\S]{0,120}initialPassword/,
  "the page must await one lightweight teacher creation request");
assert.match(create,
  /function completedTeacherCreation\(result\)[\s\S]{0,1200}proof\?\.complete[\s\S]{0,1000}teacherStatus !== "ACTIVE"[\s\S]{0,240}accountStatus !== "ACTIVE"[\s\S]{0,240}authStatus !== "ACTIVE"/,
  "visible success must require the server's complete proof and all three active states");
assert.doesNotMatch(create, /ENROLLED|personId|photoSha256|photoBytes/,
  "visible success must not require or report any teacher face artifact");
assert.match(create,
  /function setFormLocked\(locked\)[\s\S]{0,300}personCreateName[\s\S]{0,160}personPhone[\s\S]{0,160}personInitialPassword/,
  "the single in-flight request must lock all three identity fields");
assert.match(create,
  /signature\.includes\("CLIENT_REQUEST_TIMEOUT"\)[\s\S]{0,500}禁止在本页重复提交[\s\S]{0,700}!outcomeUncertain\) setFormLocked\(false\)/,
  "a timeout must keep the current page permanently locked instead of enabling a concurrent retry");
for (const legacy of [
  "beginTeacherProvisionWithFace", "provisionTeacherWithFace", "getTeacherFaceOperationStatus",
  "readTeacherProvisionResult", "operationId", "teacherProvisionWorker", "beforeunload"
]) {
  assert.equal(create.includes(legacy), false, `teacher-create must not retain legacy ${legacy} orchestration`);
}
assert.doesNotMatch(create, /\bwhile\s*\(|setInterval\s*\(|请保持本页打开/,
  "the new-teacher page must not poll or ask the operator to keep an in-memory worker alive");
assert.match(detail, /function setButtonPending[\s\S]{0,480}aria-busy/, "teacher home writes must share a semantic pending-state helper");
assert.match(detail, /savingConfig[\s\S]{0,120}savingRecharge/, "quota controls must remain disabled for the whole write operation");
assert.match(detail, /const authoritative = \[staff\?\.account_status, staff\?\.teacher_status\][\s\S]{0,260}if \(authoritative\.length\) return authoritative\.includes\("ARCHIVED"\)/, "teacher home status must ignore a stale generic status when authoritative fields exist");
assert.match(detail, /const refreshed = await load\(\)[\s\S]{0,300}actualArchived/, "teacher home must reconcile the status from the server before reporting success or failure");
assert.match(detail, /AUTH_CREDENTIAL_MISSING[\s\S]{0,120}AUTH_ACCOUNT_MISSING[\s\S]{0,320}压力测试或历史占位账号[\s\S]{0,180}安全保持封存/, "teacher home must keep a credential-less placeholder archived with an actionable explanation");
assert.doesNotMatch(`${detailHtml}\n${detail}`,
  /staffFaceAction|teacherFaceUpdate|upsertTeacherFace|补录老师人脸|更换老师人脸/,
  "teacher home must expose no face add, replacement or modification workflow");
assert.match(detail, /现场只核验客户人脸/,
  "teacher home must explain that experience verification scans only the customer");

assert.match(css, /--teacher-action:\s*#173a66/, "teacher primary actions must use the restrained navy palette");
assert.match(css, /--teacher-danger-bg:\s*#fff6f5[\s\S]{0,160}--teacher-danger-ink:\s*#96342d/, "teacher destructive actions must use a soft archived-status red palette");
assert.match(css, /body\[data-management="teacher"\] button:focus-visible[\s\S]{0,520}outline:\s*3px solid/, "teacher actions must have a visible keyboard focus ring");
assert.match(css, /body\[data-management="teacher"\] button:disabled[\s\S]{0,520}cursor:\s*not-allowed[\s\S]{0,520}background:\s*#edf1f5/, "teacher actions must have a stable disabled treatment");
assert.match(css, /button\[aria-busy="true"\]::after[\s\S]{0,420}teacher-button-spin/, "pending teacher actions must show a progress indicator");

const mobile = css.slice(css.lastIndexOf("@media (max-width: 760px)"));
assert.match(mobile, /body\[data-management="teacher"\] \.teacher-directory-window\s*\{[\s\S]{0,260}height:\s*auto[\s\S]{0,260}max-height:\s*none[\s\S]{0,260}overflow-x:\s*auto/, "phone teacher results must scroll horizontally inside each directory panel");
assert.match(mobile, /teacher-directory-table\s*\{[\s\S]{0,180}width:\s*860px[\s\S]{0,180}min-width:\s*860px[\s\S]{0,180}display:\s*table/, "phone teacher results must retain a readable horizontal table width");
assert.match(mobile, /teacher-directory-table colgroup\s*\{\s*display:\s*table-column-group/, "phone teacher table must retain its declared responsive column widths");
assert.match(mobile, /teacher-directory-table tbody\s*\{\s*display:\s*table-row-group/, "phone teacher records must stay one teacher per horizontal table row");
assert.match(mobile, /teacher-directory-table td::before\s*\{\s*display:\s*none;\s*content:\s*none/, "phone horizontal rows must not inject stacked card field labels");
assert.match(mobile, /teacher-directory-table \.teacher-status-action\s*\{\s*width:\s*auto;\s*min-height:\s*44px/, "phone teacher account actions must stay inline while meeting the 44px touch target");
assert.match(mobile, /body\[data-hq-create="teacher"\] \.hq-create-main,[\s\S]{0,180}width:\s*calc\(100% - 16px\)/, "teacher create and detail pages must use the phone width without horizontal overflow");
assert.doesNotMatch(createHtml, /teacher-face-enrollment-layout/,
  "the teacher creation page must not retain the obsolete face-enrollment layout");
assert.match(css, /teacher-create-rule-grid\s*\{[^}]*repeat\(3,/,
  "teacher creation rules must use three desktop columns");
assert.match(css, /@media \(max-width: 640px\)[\s\S]*teacher-create-rule-grid\s*\{\s*grid-template-columns:\s*1fr/,
  "teacher creation rules must stack into one mobile column");
assert.match(mobile, /teacher-experience-form (input|select|textarea)[\s\S]{0,220}min-width:\s*0[\s\S]{0,220}font-size:\s*16px/, "quota inputs must fit narrow screens without mobile zoom");

console.log("teacher UI responsive contract: PASS");
