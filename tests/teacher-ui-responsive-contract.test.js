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

for (const html of [managementHtml, createHtml, detailHtml, read("teacher-detail.html")]) {
  assert.match(html, /styles\.css\?v=0\.15\.50/, "every teacher management surface must refresh the shared visual system");
  assert.match(html, /<meta\s+name="viewport"/, "teacher pages must declare a mobile viewport");
}
assert.match(managementHtml, /teacher-management\.js\?v=0\.14\.28/, "teacher directory behavior must be cache-busted");
assert.match(createHtml, /teacher-create\.js\?v=0\.2\.4/, "teacher creation behavior must be cache-busted");
assert.match(detailHtml, /staff-detail\.js\?v=0\.15\.4/, "teacher home behavior must be cache-busted");

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
assert.match(createHtml, /老师人脸（必填）/, "new teachers must show face capture as mandatory");
assert.doesNotMatch(createHtml, /teacher-face-optional|老师人脸（可选）|可后续补录/, "new-teacher UI must not retain the optional disclosure or copy");
assert.match(createHtml, /id="teacherFaceConsent"[^>]*required/, "mandatory face consent must use native form semantics");
assert.match(create, /Boolean\(capturedFaceImage\)[\s\S]{0,300}Boolean\(\$\("teacherFaceConsent"\)\.checked\)[\s\S]{0,160}faceValidated/, "teacher submit must require capture, consent and completed preflight");
assert.match(create, /if \(!liveness\.checked\)[\s\S]{0,300}LIVENESS_REQUIRED/, "teacher creation must fail closed when liveness is not checked");
assert.doesNotMatch(create, /CloudBasePhoneAuth\.provisionTeacher\(/, "teacher creation must not keep a generic no-face submit path");
assert.match(create, /setAttribute\("aria-busy", "true"\)[\s\S]{0,180}正在创建并绑定人脸…/, "teacher creation must show a pending state while face binding is committed");
assert.match(detail, /function setButtonPending[\s\S]{0,480}aria-busy/, "teacher home writes must share a semantic pending-state helper");
assert.match(detail, /savingConfig[\s\S]{0,120}savingRecharge/, "quota controls must remain disabled for the whole write operation");
assert.match(detail, /const authoritative = \[staff\?\.account_status, staff\?\.teacher_status\][\s\S]{0,260}if \(authoritative\.length\) return authoritative\.includes\("ARCHIVED"\)/, "teacher home status must ignore a stale generic status when authoritative fields exist");
assert.match(detail, /const refreshed = await load\(\)[\s\S]{0,300}actualArchived/, "teacher home must reconcile the status from the server before reporting success or failure");
assert.match(detail, /AUTH_CREDENTIAL_MISSING[\s\S]{0,120}AUTH_ACCOUNT_MISSING[\s\S]{0,320}压力测试或历史占位账号[\s\S]{0,180}安全保持封存/, "teacher home must keep a credential-less placeholder archived with an actionable explanation");

assert.match(css, /--teacher-action:\s*#173a66/, "teacher primary actions must use the restrained navy palette");
assert.match(css, /--teacher-danger-bg:\s*#fff6f5[\s\S]{0,160}--teacher-danger-ink:\s*#96342d/, "teacher destructive actions must use a soft archived-status red palette");
assert.match(css, /body\[data-management="teacher"\] button:focus-visible[\s\S]{0,520}outline:\s*3px solid/, "teacher actions must have a visible keyboard focus ring");
assert.match(css, /body\[data-management="teacher"\] button:disabled[\s\S]{0,520}cursor:\s*not-allowed[\s\S]{0,520}background:\s*#edf1f5/, "teacher actions must have a stable disabled treatment");
assert.match(css, /button\[aria-busy="true"\]::after[\s\S]{0,420}teacher-button-spin/, "pending teacher actions must show a progress indicator");

const mobile = css.slice(css.lastIndexOf("@media (max-width: 760px)"));
assert.match(mobile, /body\[data-management="teacher"\] \.teacher-directory-window\s*\{[\s\S]{0,240}height:\s*auto[\s\S]{0,240}max-height:\s*none[\s\S]{0,240}overflow:\s*visible/, "phone teacher results must use document scrolling instead of a clipped inner pane");
assert.match(mobile, /teacher-directory-table\s*\{[\s\S]{0,180}min-width:\s*0[\s\S]{0,180}display:\s*block/, "phone teacher results must not retain the 760px desktop table width");
assert.match(mobile, /teacher-directory-table tbody\s*\{\s*display:\s*grid/, "phone teacher rows must become readable cards");
assert.match(mobile, /content:\s*attr\(data-label\)/, "phone teacher cards must show field labels");
assert.match(mobile, /teacher-directory-table \.teacher-status-action\s*\{\s*width:\s*100%;\s*min-height:\s*44px/, "phone teacher account actions must meet the 44px touch target");
assert.match(mobile, /body\[data-hq-create="teacher"\] \.hq-create-main,[\s\S]{0,180}width:\s*calc\(100% - 16px\)/, "teacher create and detail pages must use the phone width without horizontal overflow");
assert.match(css, /@media \(max-width: 900px\)[\s\S]{0,800}teacher-face-enrollment-layout\s*\{\s*grid-template-columns:\s*1fr/, "mandatory face enrollment must stack into one readable column on phones");
assert.match(mobile, /teacher-experience-form (input|select|textarea)[\s\S]{0,220}min-width:\s*0[\s\S]{0,220}font-size:\s*16px/, "quota inputs must fit narrow screens without mobile zoom");

console.log("teacher UI responsive contract: PASS");
