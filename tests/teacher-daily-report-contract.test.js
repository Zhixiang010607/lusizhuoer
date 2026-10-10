"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const migration = read("database/migrations/073_staff_daily_reports.sql");
const consoleSql = read("database/cloudbase-console/073-01-staff-daily-reports.sql");
const verifySql = read("database/cloudbase-console/073-readonly-verify.sql");
const requiredMigration = read("database/migrations/077_daily_report_all_fields_required.sql");
const requiredConsoleSql = read("database/cloudbase-console/077-01-daily-report-all-fields-required.sql");
const requiredVerifySql = read("database/cloudbase-console/077-readonly-verify.sql");
const cloud = read("cloudfunctions/staffAccount/index.js");
const cloudReadme = read("cloudfunctions/staffAccount/README.md");
const authUi = read("auth-ui.js");
const html = read("daily-report.html");
const client = read("daily-report.js");
const miniApp = read("miniprogram-app/miniprogram/app.json");
const miniHome = read("miniprogram-app/miniprogram/pages/home/index.wxml");
const miniHomeClient = read("miniprogram-app/miniprogram/pages/home/index.js");
const miniPage = read("miniprogram-app/miniprogram/pages/daily-report/index.wxml");
const miniClient = read("miniprogram-app/miniprogram/pages/daily-report/index.js");
const miniCss = read("miniprogram-app/miniprogram/pages/daily-report/index.wxss");
const miniWorkCalendar = read("miniprogram-app/miniprogram/pages/work-calendar/index.wxml");
const miniWorkCalendarClient = read("miniprogram-app/miniprogram/pages/work-calendar/index.js");
const context = read("PROJECT_CONTEXT.md");

test("migration 073 makes teacher daily reports unique, today-only and immutable", () => {
  assert.equal(consoleSql, migration);
  assert.match(migration, /UNIQUE \(staff_account_id, report_date\)/);
  assert.match(migration, /AT TIME ZONE 'Asia\/Shanghai'/);
  assert.match(migration, /historical employee daily reports are immutable/);
  assert.match(migration, /daily reports cannot be deleted/);
  assert.match(migration, /restricted to active teacher accounts/);
  assert.match(migration, /account\.role_code = 'teacher'/);
  assert.match(migration, /account\.account_status = 'ACTIVE'/);
  assert.match(migration, /teacher\.teacher_status = 'ACTIVE'/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.staff_daily_reports FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.staff_daily_reports FROM service_role/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE ON TABLE public\.staff_daily_reports TO service_role/);
  assert.doesNotMatch(migration, /GRANT[^;]*DELETE/i);
  assert.match(verifySql, /active teacher-only write guard/);
  assert.match(verifySql, /client daily report table access closed/);
});

test("migration 077 requires all four fields without rewriting historical reports", () => {
  assert.equal(requiredConsoleSql, requiredMigration);
  assert.match(requiredMigration, /staff_daily_reports_all_fields_required_v77/);
  assert.match(requiredMigration, /NOT VALID/);
  for (const column of ["completed_work", "customer_project_progress", "problems_and_support", "tomorrow_plan"]) {
    assert.match(requiredMigration, new RegExp(`CHAR_LENGTH\\(BTRIM\\(${column}\\)\\) BETWEEN 1 AND 200`));
  }
  assert.match(requiredMigration, /all four daily report fields are required and limited to 200 characters/);
  assert.match(requiredVerifySql, /daily_report_all_fields_constraint/);
  assert.match(requiredVerifySql, /daily_report_all_fields_trigger/);
});

test("staffAccount v91 derives the teacher identity from the authenticated profile", () => {
  assert.match(cloud, /const FUNCTION_VERSION = "v91"/);
  assert.match(cloudReadme, /当前版本：`v91`/);
  assert.match(cloud, /function requireDailyReportTeacher\(caller\)/);
  assert.match(cloud, /caller\.profile\?\.role !== "teacher"/);
  assert.match(cloud, /caller\.profile\?\.teacherStatus !== "ACTIVE"/);
  assert.match(cloud, /const staffId = numericId\(caller\.profile\?\.staffId, "当前员工账号"\)/);
  assert.doesNotMatch(cloud, /event\.(staffId|teacherId)[\s\S]{0,100}staff_daily_reports/);
  for (const action of ["getOwnDailyReportMonth", "getOwnDailyReport", "saveOwnDailyReport"]) {
    assert.match(cloud, new RegExp(`action === "${action}"`));
  }
  assert.match(cloud, /WHERE [^\n]*reportDate[^\n]*context\.server_today|WHERE \$\{sqlText\(reportDate\)\}::date = context\.server_today/);
  assert.match(cloud, /DAILY_REPORT_FIELD_MAX_CHARS = 200/);
});

test("only the teacher workspaces expose the calendar and today editor", () => {
  const hqAccess = authUi.slice(authUi.indexOf("hq: new Set"), authUi.indexOf("store: new Set"));
  const storeAccess = authUi.slice(authUi.indexOf("store: new Set"), authUi.indexOf("teacher: new Set"));
  const teacherAccess = authUi.slice(authUi.indexOf("teacher: new Set"), authUi.indexOf("};", authUi.indexOf("teacher: new Set")));
  assert.doesNotMatch(hqAccess, /daily-report\.html/);
  assert.doesNotMatch(storeAccess, /daily-report\.html/);
  assert.match(teacherAccess, /daily-report\.html/);
  assert.match(authUi, /session\.role === "teacher"[\s\S]{0,220}工作日报/);
  assert.match(html, /id="dailyReportCalendar"/);
  assert.match(html, /id="dailyCompletedWork"[^>]*required/);
  assert.equal((html.match(/<textarea[^>]*required/g) || []).length, 4);
  assert.match(html, /maxlength="200"/);
  assert.match(html, /id="dailyReportEdit"[^>]*>编辑/);
  assert.match(html, /id="dailyReportSave"[^>]*>确认提交/);
  assert.match(client, /date > state\.serverToday/);
  assert.match(client, /result\.editable \? "editable" : "readonly"/);
  assert.match(client, /state\.selectedDate !== state\.serverToday/);
  assert.match(miniApp, /pages\/daily-report/);
  assert.match(miniHome, /bindtap="openDailyReport">工作日报/);
  assert.match(miniHomeClient, /session\.role !== "teacher"[\s\S]{0,180}\/pages\/work-calendar\/index\?mode=report/);
  assert.match(miniWorkCalendar, /日报月历/);
  assert.match(miniWorkCalendar, /填写今日日报/);
  assert.match(miniWorkCalendarClient, /\/pages\/daily-report\/index/);
  assert.match(miniPage, /<date-selector[^>]*value="\{\{pendingDate\}\}"/);
  assert.match(miniPage, /class="confirm-button"[^>]*bindtap="confirmDate"/);
  assert.match(miniPage, /data-field="completedWork"/);
  assert.equal((miniPage.match(/maxlength="200"/g) || []).length, 4);
  assert.equal((miniPage.match(/必填/g) || []).length, 4);
  assert.equal((miniPage.match(/bindtap="edit"/g) || []).length, 1);
  assert.equal((miniPage.match(/bindtap="save"/g) || []).length, 1);
  assert.match(miniPage, />确认提交<\/button>/);
  assert.match(miniClient, /requireSession\(\["teacher"\]\)/);
  assert.match(miniClient, /callStaff\("saveOwnDailyReport"/);
  assert.match(miniClient, /FIELD_LABELS/);
  assert.match(miniClient, /selectedDate !== this\.data\.serverToday/);
  assert.match(miniCss, /\.save-button \{[^}]*height: 84rpx;[^}]*display: flex;[^}]*align-items: center;[^}]*justify-content: center;/,
    "the whole-report submit button must center its label horizontally and vertically");
  assert.match(miniCss, /@media \(min-width: 700px\)/);
  assert.match(context, /老师工作日报最终规则/);
  assert.match(context, /四栏全部必填/);
});
