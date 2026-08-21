"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");
const html = read("teacher-work-orders.html");
const ui = read("teacher-work-orders.js");
const css = read("styles.css");
const cloud = read("cloudfunctions", "faceRecognition", "index.js");
const migration = read("database", "migrations", "055_remove_teacher_face_order_guards.sql");
const consoleSql = read("database", "cloudbase-console", "055-01-remove-teacher-face-order-guards.sql");

for (const [type, label] of [["VERIFICATION", "核销"], ["RECHARGE", "充值"], ["EXPERIENCE", "体验"], ["REFUND", "退费"]]) {
  assert.match(html, new RegExp(`data-record-type="${type}"[\\s\\S]{0,160}<span>${label}</span>`), `${label} must be a dedicated teacher workspace button`);
}
for (const [preset, label] of [["TODAY", "今天"], ["WEEK", "本周"], ["MONTH", "本月"], ["QUARTER", "本季度"], ["YEAR", "本年"], ["ALL", "全部"], ["CUSTOM", "自定义"]]) {
  assert.match(html, new RegExp(`data-range-preset="${preset}"[^>]*>${label}</button>`), `${label} preset must be visible`);
}
assert.match(html, /data-range-preset="MONTH"[^>]*class="active"|class="active"[^>]*data-range-preset="MONTH"/, "month must be the default selected range");
assert.match(html, /id="teacherExperienceBalances"[^>]*teacher-quota-grid/, "experience balances must have a dynamic project grid");
assert.match(html, /<th scope="col">产品<\/th><th scope="col">核销<\/th><th scope="col">充值<\/th><th scope="col">体验<\/th><th scope="col">退费<\/th>/, "summary matrix axes must match the product and four business metrics");
assert.doesNotMatch(html, /<th[^>]*>[^<]*(?:人脸|状态)[^<]*<\/th>/, "teacher workspace tables must not show face or status columns");
assert.match(html, /styles\.css\?v=0\.15\.55/);
assert.match(html, /teacher-work-orders\.js\?v=0\.16\.1/);
for (const [status, label] of [["Active", "活跃"], ["Archived", "封存"]]) {
  assert.match(html, new RegExp(`id="teacher${status}CustomerBody"`), `${label}客户必须有独立列表`);
  assert.match(html, new RegExp(`id="teacher${status}CustomerPagination"`), `${label}客户必须有独立分页`);
}

assert.match(ui, /timeZone:\s*"Asia\/Shanghai"/, "preset dates must use the business timezone");
assert.match(ui, /preset === "WEEK"[\s\S]{0,240}1 - weekday/, "week must begin on Monday");
assert.match(ui, /preset === "MONTH"[\s\S]{0,180}Date\.UTC\(year, month, 1\)/, "month must begin on day one");
assert.match(ui, /recordType:\s*type[\s\S]{0,220}includeOverview[\s\S]{0,220}rangePayload\(\)/, "the selected type and date range must be sent to the server");
assert.match(ui, /function renderProfile[\s\S]{0,650}老师姓名[\s\S]{0,220}老师短编号[\s\S]{0,220}登录手机号/, "profile must keep only the three useful identity fields");
assert.doesNotMatch(ui, /statusLabel|hasFaceRequest|无人脸记录|账号状态/, "teacher workspace rendering must not retain face or status presentation");
for (const label of ["单号", "门店", "客户", "项目", "次数", "提交时间"]) {
  assert.ok(ui.includes(`data-label="${label}"`), `mobile detail cards must expose ${label}`);
}
assert.match(ui, /getTeacherBusinessCustomers/, "teacher workspace must load linked business customers from the server");
assert.match(ui, /customer-detail\.html\?\$\{customerParams\.toString\(\)\}/, "teacher-linked customer names must open customer profiles");
assert.match(ui, /data-teacher-customer-status/, "teacher active and archived customer pages must be independently pageable");

assert.match(cloud, /TEACHER_WORKSPACE_TYPES = Object\.freeze\(\["VERIFICATION", "RECHARGE", "EXPERIENCE", "REFUND"\]\)/);
assert.match(cloud, /record_status = 'APPROVED'[\s\S]{0,180}config\.categoryClause/, "detail lists must contain only effective records of the selected category");
assert.match(cloud, /teacherWorkspaceDateClauses\("r", options\)[\s\S]{0,180}teacherWorkspaceDateClauses\("v", options\)/, "summary must apply one authoritative range to both business tables");
assert.match(cloud, /event\.metric = 'verification'[\s\S]{0,500}event\.metric = 'recharge'[\s\S]{0,500}event\.metric = 'experience'[\s\S]{0,500}event\.metric = 'refund'/, "product summary must aggregate all four metrics");
assert.match(cloud, /FROM public\.teacher_product_experience_quotas q[\s\S]{0,420}q\.quota_status = 'ACTIVE'[\s\S]{0,180}p\.product_status = 'ACTIVE'/, "all active configured experience projects must be returned dynamically");
assert.doesNotMatch(cloud.slice(cloud.indexOf("async function getTeacherWorkspace"), cloud.indexOf("async function deleteFacePerson")), /SearchPersons|face_enrollment_status|face_person_id/, "workspace reads must have no teacher face dependency");
const customerScope = cloud.slice(cloud.indexOf("function customerProfileScope"), cloud.indexOf("function customerStatusCode"));
assert.match(customerScope, /verification_type IN \('NORMAL', 'EXPERIENCE'\)/, "teacher profile access must be created only by normal or experience verification");
assert.doesNotMatch(customerScope, /recharge_records|SUPPLEMENT/, "recharge and removed supplemental verification must not create a teacher-customer relationship");
const customerAction = cloud.slice(cloud.indexOf("async function getTeacherBusinessCustomers"), cloud.indexOf("async function getTeacherWorkspace"));
assert.match(customerAction, /v\.record_status = 'APPROVED'/, "teacher customer association must use effective verification only");
assert.match(customerAction, /v\.verification_type IN \('NORMAL', 'EXPERIENCE'\)/, "teacher customer association must include normal and experience verification only");
assert.match(customerAction, /c\.customer_status = \$\{sqlText\(status\)\}/, "teacher customer lists must separate active and archived status");

assert.match(css, /teacher-quota-grid\s*\{[^}]*repeat\(auto-fit, minmax\(210px, 1fr\)\)/, "desktop quota cards must adapt to any project count");
assert.match(css, /body\[data-teacher-workspace\] \.teacher-record-tabs\s*\{[^}]*repeat\(4, minmax\(0, 1fr\)\)/, "desktop must show four equal business buttons");
assert.match(css, /@media \(max-width: 760px\)[\s\S]*body\[data-teacher-workspace\] \.teacher-record-tabs\s*\{\s*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/, "phone tabs must form a two-column touch grid");
assert.match(css, /@media \(max-width: 760px\)[\s\S]*teacher-business-panel \.table-scroll \{[^}]*overflow-x:\s*auto/, "phone detail records must remain one row per record and scroll only when needed");
assert.match(css, /teacher-business-panel table \{[^}]*width:\s*max-content;[^}]*min-width:\s*680px/, "phone detail rows must keep a readable horizontal table width");
assert.match(css, /teacher-customer-panel \.table-scroll,[\s\S]{0,220}overflow-x:\s*auto/, "phone customer records must remain horizontal rows with overflow fallback");
assert.match(css, /teacher-summary-matrix \{[^}]*width:\s*max-content;[^}]*min-width:\s*100%/, "phone summary columns must fill available width before scrolling");

for (const sql of [migration, consoleSql]) {
  const guard = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.assert_active_order_master_data"), sql.indexOf("CREATE OR REPLACE FUNCTION public.lock_active_verification_subjects"));
  const lock = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.lock_active_verification_subjects"), sql.indexOf("REVOKE ALL ON FUNCTION public.assert_active_order_master_data"));
  assert.doesNotMatch(`${guard}\n${lock}`, /face_enrollment_status|face_person_id|unbound-face|completed face enrollment/, "migration 055 must remove every teacher-face order gate");
  assert.match(guard, /teacher\.teacher_status = 'ACTIVE'[\s\S]{0,260}account\.role_code = 'teacher'[\s\S]{0,180}account\.account_status = 'ACTIVE'/, "teacher and account activation must remain mandatory");
  assert.match(lock, /customer retained profile photo is required/, "customer retained photo must remain mandatory for verification");
}

console.log("teacher workspace overview contract: PASS");
