"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "cloudfunctions", "teacherCreate", "index.js"), "utf8");

assert.match(source, /const FUNCTION_VERSION = "teacher-create-v7"/);
assert.match(source, /actions: \["health", "createTeacher"\]/);
assert.match(source, /await requireHq\(\)/, "teacher creation must remain headquarters-only");
assert.match(source, /event\.consent !== true[\s\S]{0,160}CONSENT_REQUIRED/);
assert.match(source, /cleanImage\(event\.imageBase64\)/);
assert.match(source, /inspectFaceImage\(api, base64\)[\s\S]{0,180}inspectLiveness\(api, base64\)/);
assert.match(source, /api\.CreatePerson\([\s\S]{0,500}QualityControl: 3/);
assert.match(source, /uploadAttendancePhoto\(personId, buffer\)/);
assert.match(source, /INSERT INTO public\.teacher_attendance_face_profiles/);
assert.match(source, /createActiveAuthentication\([\s\S]{0,900}insertTeacherRecord\(/,
  "the synchronous creation must join face enrollment, Auth, account, teacher and attendance profile");
assert.match(source, /attendanceFaceEnrolled: Boolean\(shell\.face_person_id\)/);
assert.match(source, /attendanceFaceStatus: "ENROLLED"/);
assert.match(source, /deleteAttendancePhoto[\s\S]{0,500}deleteFacePerson/,
  "failed creation must compensate private photo and remote face artifacts");
assert.doesNotMatch(source, /\boperationId\b|\bworker\b|\bpoll(?:ing)?\b|setInterval\s*\(|setTimeout\s*\(/i,
  "teacher creation must remain one bounded synchronous request, not restore the retired Saga");

console.log("teacherCreate v7 attendance-face synchronous contract: PASS");
