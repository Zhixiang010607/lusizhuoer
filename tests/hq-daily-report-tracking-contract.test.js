"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const cloud = read("cloudfunctions/staffAccount/index.js");
const authUi = read("auth-ui.js");
const html = read("daily-report-tracking.html");
const client = read("daily-report-tracking.js");
const css = read("daily-report-tracking.css");
const migration = read("database/migrations/074_hq_daily_report_tracking.sql");
const consoleSql = read("database/cloudbase-console/074-01-hq-daily-report-tracking.sql");
const verifySql = read("database/cloudbase-console/074-readonly-verify.sql");
const miniApp = read("miniprogram-app/miniprogram/app.json");
const miniHome = read("miniprogram-app/miniprogram/pages/home/index.wxml");
const miniHomeClient = read("miniprogram-app/miniprogram/pages/home/index.js");
const miniPage = read("miniprogram-app/miniprogram/pages/daily-report-tracking/index.wxml");
const miniClient = read("miniprogram-app/miniprogram/pages/daily-report-tracking/index.js");
const miniCss = read("miniprogram-app/miniprogram/pages/daily-report-tracking/index.wxss");

test("migration 074 adds only the date-first tracker index", () => {
  assert.equal(consoleSql, migration);
  assert.match(migration, /idx_staff_daily_reports_report_date_account/);
  assert.match(migration, /\(report_date DESC, staff_account_id\)/);
  assert.doesNotMatch(migration, /ALTER TABLE public\.teachers|birth_date/i);
  assert.match(verifySql, /daily report date index/);
});

test("HQ tracker reads active teacher roster and exposes no write action", () => {
  assert.match(cloud, /const FUNCTION_VERSION = "v92"/);
  assert.match(cloud, /async function getHqDailyReportTrackingDay\(caller/);
  assert.match(cloud, /async function getHqDailyReportDetail\(caller/);
  assert.match(cloud, /requireHq\(caller\)/);
  assert.match(cloud, /teacher\.teacher_status = 'ACTIVE'/);
  assert.match(cloud, /account\.account_status = 'ACTIVE'/);
  const detailQuery = cloud.slice(
    cloud.indexOf("async function getHqDailyReportDetail"),
    cloud.indexOf("let teacherAttendanceSchemaReady")
  );
  assert.match(detailQuery, /teacher\.teacher_status = 'ACTIVE'/);
  assert.match(detailQuery, /account\.account_status = 'ACTIVE'/);
  assert.match(cloud, /account\.phone/);
  assert.match(cloud, /completed: teachers\.filter/);
  assert.match(cloud, /incomplete: teachers\.filter/);
  assert.doesNotMatch(cloud, /saveHqDailyReport|updateHqDailyReport|deleteHqDailyReport/);
});

test("HQ operations menu links to a responsive read-only tracker", () => {
  const hqAccess = authUi.slice(authUi.indexOf("hq: new Set"), authUi.indexOf("store: new Set"));
  const storeAccess = authUi.slice(authUi.indexOf("store: new Set"), authUi.indexOf("teacher: new Set"));
  const teacherAccess = authUi.slice(authUi.indexOf("teacher: new Set"), authUi.indexOf("};", authUi.indexOf("teacher: new Set")));
  assert.match(hqAccess, /daily-report-tracking\.html/);
  assert.doesNotMatch(storeAccess, /daily-report-tracking\.html/);
  assert.doesNotMatch(teacherAccess, /daily-report-tracking\.html/);
  assert.match(authUi, /const operationLinks = \[[\s\S]*?日报追踪[\s\S]*?\];/);
  assert.match(authUi, /data-menu="hq-operations"[\s\S]*?operationLinks\.map/);
  for (const text of ["已填写", "未填写", "老师姓名", "老师电话", "日报内容", "是否完成"]) {
    assert.match(html, new RegExp(text));
  }
  assert.match(client, /staff-detail\.html\?role=teacher/);
  assert.match(client, /getHqDailyReportTrackingDay/);
  assert.match(client, /getHqDailyReportDetail/);
  assert.match(client, /teacher\.phone/);
  assert.doesNotMatch(`${html}\n${client}`, /老师生日|birthDate|打卡|attendance/i);
  assert.match(css, /@media\s*\(max-width:\s*1180px\)/);
  assert.match(css, /@media\s*\(max-width:\s*760px\)/);
  assert.match(css, /daily-tracking-columns\s*\{[^}]*grid-template-columns:\s*1fr/);
  assert.match(miniApp, /pages\/daily-report-tracking/);
  assert.match(miniHome, /data-type="daily-report-tracking"[\s\S]{0,80}日报追踪/);
  assert.match(miniHomeClient, /type === "daily-report-tracking"[\s\S]{0,160}\/pages\/daily-report-tracking\/index/);
  assert.match(miniClient, /requireSession\(\["hq"\]\)/);
  assert.match(miniClient, /getHqDailyReportTrackingDay/);
  assert.match(miniClient, /getHqDailyReportDetail/);
  assert.match(client, /const sections = \[\["今日完成事项", report\.completedWork\]\]/);
  assert.match(miniClient, /label: "今日完成事项"/);
  assert.doesNotMatch(`${client}\n${miniClient}`, /客户或项目进展|遇到的问题|明日计划/);
  for (const text of ["老师姓名", "老师电话", "日报内容", "是否完成"]) assert.match(miniPage, new RegExp(text));
  assert.doesNotMatch(`${miniPage}\n${miniClient}`, /老师生日|birthDate/i);
  assert.match(miniPage, /class="tracking-table-scroll"[^>]*scroll-x="true"/);
  assert.match(miniPage, /class="tracking-row tracking-head"/);
  assert.match(miniPage, /wx:for="\{\{completed\}\}"[^>]*class="tracking-row"/);
  assert.match(miniPage, /wx:for="\{\{incomplete\}\}"[^>]*class="tracking-row"/);
  assert.doesNotMatch(miniPage, /teacher-card|teacher-row/);
  assert.match(miniCss, /\.tracking-table \{[^}]*display: inline-table/);
  assert.match(miniCss, /\.tracking-row > text \{[^}]*display: table-cell[^}]*font-size: 24rpx/,
    "daily-report tracking headers and rows must match the mobile project-summary table size");
  assert.match(miniCss, /@media \(min-width: 700px\)[\s\S]*?\.tracking-row > text \{[^}]*font-size: 14px/,
    "daily-report tracking headers and rows must match the tablet project-summary table size");
  assert.match(miniCss, /@media \(min-width: 700px\)/);
});
