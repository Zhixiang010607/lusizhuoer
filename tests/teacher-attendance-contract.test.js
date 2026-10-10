"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const migration = read("database/migrations/075_teacher_attendance.sql");
const consoleSql = read("database/cloudbase-console/075-01-teacher-attendance.sql");
const teacherCreate = read("cloudfunctions/teacherCreate/index.js");
const face = read("cloudfunctions/faceRecognition/index.js");
const staff = read("cloudfunctions/staffAccount/index.js");
const app = JSON.parse(read("miniprogram-app/miniprogram/app.json"));
const attendanceJs = read("miniprogram-app/miniprogram/pages/attendance/index.js");
const attendanceWxml = read("miniprogram-app/miniprogram/pages/attendance/index.wxml");
const trackingJs = read("miniprogram-app/miniprogram/pages/attendance-tracking/index.js");
const trackingWxml = read("miniprogram-app/miniprogram/pages/attendance-tracking/index.wxml");
const camera = read("miniprogram-app/miniprogram/components/camera-capture/index.js");

assert.equal(consoleSql, migration, "075 CloudBase SQL must exactly match the canonical migration");
assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.teacher_attendance_face_profiles/);
assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.teacher_attendance_records/);
const recordTable = migration.slice(
  migration.indexOf("CREATE TABLE IF NOT EXISTS public.teacher_attendance_records"),
  migration.indexOf("CREATE INDEX IF NOT EXISTS idx_teacher_attendance_records")
);
assert.doesNotMatch(recordTable, /photo|image|file_id/i,
  "clock-in records must never contain a photo or image reference");
assert.match(recordTable, /UNIQUE \(staff_account_id, attendance_date\)/,
  "each teacher account may have only one immutable daily clock-in");
assert.match(migration, /BEFORE INSERT OR UPDATE OR DELETE ON public\.teacher_attendance_records/,
  "the database must guard the immutable attendance ledger");

assert.match(teacherCreate, /const FUNCTION_VERSION = "teacher-create-v8"/);
assert.match(teacherCreate, /event\.consent !== true[\s\S]*cleanImage\(event\.imageBase64\)/);
assert.match(teacherCreate, /api\.CreatePerson\(/,
  "teacher creation must create the dedicated attendance identity");
assert.match(teacherCreate, /INSERT INTO public\.teacher_attendance_face_profiles/,
  "teacher creation must atomically bind that identity to the new teacher");
assert.match(teacherCreate, /profile_photo_file_id/,
  "only the consented attendance enrollment photo is privately retained");

assert.match(face, /const FUNCTION_VERSION = PHOTO_ONLY_FUNCTION \? "v11" : "v123"/);
const clockInStart = face.indexOf("async function clockInTeacherAttendance");
const clockInEnd = face.indexOf("// Normal and teacher-gift EXPERIENCE", clockInStart);
const clockIn = face.slice(clockInStart, clockInEnd);
assert.match(clockIn, /activeTeacherCaller\(\)[\s\S]*teacher_attendance_face_profiles/);
assert.match(clockIn, /inspectFaceImage[\s\S]*inspectLiveness[\s\S]*VerifyFace/);
assert.match(clockIn, /accuracy[\s\S]*500/);
assert.match(clockIn, /teacher_attendance_records/);
assert.doesNotMatch(clockIn, /uploadVerificationPhotoObject|uploadAttendancePhoto|profile_photo_file_id/,
  "clock-in photos must not be uploaded or persisted");
assert.match(face, /action === "clockInTeacherAttendance"/);

assert.match(staff, /const FUNCTION_VERSION = "v85"/);
assert.match(staff, /async function getOwnAttendanceMonth/);
assert.match(staff, /async function getHqAttendanceTrackingDay/);
assert.match(staff, /action === "getOwnAttendanceMonth"/);
assert.match(staff, /action === "getHqAttendanceTrackingDay"/);

const subpackageRoots = new Set(app.subPackages.map((entry) => entry.root));
assert.equal(subpackageRoots.has("pages/attendance"), true);
assert.equal(subpackageRoots.has("pages/attendance-tracking"), true);
assert.deepEqual(app.requiredPrivateInfos, ["getLocation"]);
assert.match(app.permission["scope.userLocation"].desc, /老师本人考勤打卡/);
assert.match(camera, /camera:\s*"front"/,
  "teacher enrollment and clock-in capture must request the front camera");
assert.match(attendanceJs, /requestLocation\("gcj02", true\)[\s\S]*requestLocation\("wgs84", false\)/,
  "clock-in must support both mainland GCJ-02 and overseas WGS-84 location results");
assert.match(attendanceJs, /ensureLocationPermission\(\)[\s\S]*getSystemSetting[\s\S]*getAppAuthorizeSetting[\s\S]*scope\.userLocation/,
  "location failures must distinguish system and mini-program authorization");
assert.match(attendanceJs, /function localDeviceTime\(\)/,
  "the teacher confirmation preview must use the phone timezone outside China");
assert.match(attendanceWxml, /手机当前时间[\s\S]*坐标类型[\s\S]*定位精度/,
  "the confirmation must identify the local preview and coordinate type");
assert.match(attendanceWxml, /locationErrorCode[\s\S]*permissionAction === 'system'/,
  "location failures must expose a safe code and the relevant settings entry");
assert.match(attendanceJs, /onShow\(\)[\s\S]*_resumeLocationAfterSettings[\s\S]*prepareCheckIn\(\)/,
  "returning from phone settings must continue the same clock-in attempt");
assert.match(attendanceWxml, /去开启手机定位并继续打卡[\s\S]*去开启微信位置权限并继续打卡/,
  "a teacher without location permission must receive an explicit continue-clock-in action");
assert.match(attendanceJs, /currentPlatform\([\s\S]*IPAD[\s\S]*IOS[\s\S]*ANDROID/,
  "phone and iPad platform metadata must be normalized");
assert.match(attendanceJs, /callFace\("clockInTeacherAttendance"/);
assert.match(attendanceJs, /async prepareCheckIn\(\)[\s\S]*await locate\(\)/,
  "teacher must read the current location before face verification");
assert.match(attendanceJs, /confirmCheckInContext\(\)[\s\S]*checkInStage: "face"/,
  "teacher must explicitly confirm time and location before the camera stage");
assert.match(attendanceJs, /120000/,
  "a confirmed location must expire instead of being reused indefinitely");
assert.match(attendanceWxml, /获取当前时间地点[\s\S]*确认时间地点[\s\S]*验证人脸并打卡/,
  "the visible teacher flow must order location confirmation before face recognition");
assert.match(attendanceWxml, /最终打卡时间以服务端记录为准/,
  "the confirmation preview must not replace authoritative server time");
assert.match(attendanceWxml, /现场照片仅发送给人脸验证接口，本次验证结束后不保存/);
assert.match(attendanceWxml, /未录入考勤人脸，可以进入并查看考勤记录，但暂时不能进行人脸打卡/,
  "a legacy teacher without an attendance face must still enter and read attendance history");
assert.match(attendanceWxml, /未录入人脸，暂不能打卡/,
  "only the clock-in action is disabled when the attendance face is missing");
assert.match(attendanceWxml, /<map[\s\S]*openLocation/);
assert.match(trackingJs, /callStaff\("getHqAttendanceTrackingDay"/);
assert.match(trackingWxml, /已打卡[\s\S]*未打卡/);
assert.match(trackingWxml, /class="tracking-table-scroll"[^>]*scroll-x="true"/);
assert.match(trackingWxml, /class="tracking-row tracking-head"/);
assert.doesNotMatch(trackingWxml, /teacher-card|teacher-row/);
assert.match(trackingWxml, /<map[\s\S]*openLocation/);
assert.match(trackingWxml, /打卡时间[\s\S]*打卡详情[\s\S]*人脸档案/,
  "attendance rows must expose exact time and a map detail link, with face profile last");
assert.match(trackingWxml, /打卡时间：\{\{detail\.attendance\.checkedTime\}\}/,
  "attendance detail must show the full date and second-level time beside the map");

console.log("teacher attendance contract: PASS");
