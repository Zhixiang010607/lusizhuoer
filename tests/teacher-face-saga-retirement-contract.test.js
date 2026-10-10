"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const teacher = read("cloudfunctions/teacherCreate/index.js");
const staff = read("cloudfunctions/staffAccount/index.js");
const face = read("cloudfunctions/faceRecognition/index.js");
const browser = read("teacher-create.js");
for (const retired of ["teacher_face_operations", "delegateTeacherFace", "upsertDelegatedTeacherFace",
  "getTeacherFaceOperationStatus", "teacherProvisionWorker", "reconcile-teacher-face-operations"]) {
  assert.equal((teacher + staff + face + browser).includes(retired), false, `retired teacher-face Saga token must stay absent: ${retired}`);
}
assert.match(teacher, /const FUNCTION_VERSION = "teacher-create-v9"/);
assert.match(teacher, /if \(action === "createTeacher"\) return await createTeacher\(event\)/);
assert.match(browser, /CloudBasePhoneAuth\.createTeacher\(/);
assert.match(teacher, /teacher_attendance_face_profiles/,
  "the new profile is attendance-only and must not restore legacy business face columns");
assert.doesNotMatch(teacher, /user\.modifyUser\(|createBlockedAuthentication|operationId|poll/i);
assert.doesNotMatch(staff, /requireCompleteTeacherFaceForActivation|TEACHER_FACE_REQUIRED/,
  "attendance face must never become an activation gate");
assert.match(face, /clockInTeacherAttendance/);
assert.match(face, /Deliberately do not upload or persist event\.imageBase64/,
  "clock-in photos must not be retained");
console.log("retired Saga stays retired while isolated attendance face is enabled: PASS");
