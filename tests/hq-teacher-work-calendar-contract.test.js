"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const staff = read("cloudfunctions/staffAccount/index.js");
const teacherCreate = read("cloudfunctions/teacherCreate/index.js");
const page = read("miniprogram-app/miniprogram/pages/teacher-detail/index.js");
const view = read("miniprogram-app/miniprogram/pages/teacher-detail/index.wxml");
const style = read("miniprogram-app/miniprogram/pages/teacher-detail/index.wxss");
const migration = read("database/cloudbase-console/082-01-teacher-attendance-face-replacement.sql");
const verify = read("database/cloudbase-console/082-readonly-verify.sql");
const context = read("PROJECT_CONTEXT.md");

assert.match(staff, /const FUNCTION_VERSION = "v90"/);
assert.match(staff, /async function getHqTeacherWorkMonth/);
assert.match(staff, /requireHq\(caller\)/);
assert.match(staff, /JOIN target ON TRUE[\s\S]*LEFT JOIN events ON TRUE/);
assert.match(staff, /public\.teacher_attendance_records/);
assert.match(staff, /public\.staff_daily_reports/);
assert.match(staff, /if \(action === "getHqTeacherWorkMonth"\)/);
assert.match(staff, /attendanceResponse\(\{ \.\.\.row, attendance_date: row\.event_date \}\)/,
  "HQ monthly attendance must preserve the event date returned by the union query");
assert.match(staff, /employment_start_date/);

assert.match(teacherCreate, /const FUNCTION_VERSION = "teacher-create-v9"/);
assert.match(teacherCreate, /async function replaceTeacherAttendanceFace/);
assert.match(teacherCreate, /event\.consent !== true/);
assert.match(teacherCreate, /UniquePersonControl: 0/);
assert.match(teacherCreate, /INSERT INTO public\.teacher_attendance_face_replacements/);
assert.match(teacherCreate, /UPDATE public\.teacher_attendance_face_profiles/);
assert.match(teacherCreate, /readAttendanceFaceReplacementProof/);
assert.match(teacherCreate, /FACE_REPLACEMENT_RESULT_UNCERTAIN/);
assert.match(teacherCreate, /if \(!committed && cleanupSafe\)/);
assert.match(teacherCreate, /replaceTeacherAttendanceFace/);

assert.match(page, /callStaff\("getHqTeacherWorkMonth"/);
assert.match(page, /callTeacherCreate\(\{[\s\S]*action: "replaceTeacherAttendanceFace"/);
assert.match(page, /hq_teacher_attendance_face_replacement/);
assert.match(page, /wx\.removeStorageSync\(faceReplacementKey\(this\.data\.teacherId\)\)/);
assert.match(page, /clockInState:[\s\S]*clockOutState:[\s\S]*reportState:/);
assert.match(page, /chooseWorkMonth/);
assert.match(page, /showFaceResultToast\("重新扫脸成功/);
assert.match(view, /基本资料/);
assert.match(view, /项目配置/);
assert.match(view, /考勤日报/);
assert.match(view, /考勤月历/);
assert.match(view, /日报月历/);
assert.match(view, /重新扫脸/);
assert.match(view, /每格左点上班、右点下班/);
assert.match(view, /上一年[\s\S]*上月[\s\S]*下月[\s\S]*下一年/);
assert.match(view, /点此直接选择年月/);
assert.match(view, /未入职/);
assert.match(view, /face-result-toast/);
assert.match(style, /\.status-dot\.done\s*\{\s*background: #3177c8/);
assert.match(style, /\.status-dot\.missing\s*\{\s*background: #c94a42/);
assert.match(style, /\.face-result-toast/);

assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.teacher_attendance_face_replacements/);
assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public\.teacher_attendance_face_profiles TO service_role/);
assert.match(migration, /teacher attendance face profile ownership is immutable/);
assert.match(verify, /082 replacement guard/);
assert.match(context, /“基本资料／项目配置／考勤日报”/);
assert.match(context, /不改变任何核销链路/);

console.log("HQ teacher monthly work calendar and attendance-face replacement contract: PASS");
