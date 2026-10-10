"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const migration = read("database/migrations/075_teacher_attendance.sql");
const consoleSql = read("database/cloudbase-console/075-01-teacher-attendance.sql");
const twoPunchMigration = read("database/migrations/078_teacher_two_punch_attendance.sql");
const twoPunchConsoleSql = read("database/cloudbase-console/078-01-teacher-two-punch-attendance.sql");
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
assert.equal(twoPunchConsoleSql, twoPunchMigration, "078 CloudBase SQL must exactly match the canonical migration");
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
assert.match(twoPunchMigration, /attendance_type IN \('CLOCK_IN', 'CLOCK_OUT'\)/);
assert.match(twoPunchMigration, /UNIQUE \(staff_account_id, attendance_date, attendance_type\)/,
  "each teacher account may have one immutable punch of each type per day");
assert.match(twoPunchMigration, /clock-out requires an existing same-day clock-in/,
  "the database must reject clock-out before clock-in");
assert.match(twoPunchMigration, /SET attendance_type = 'CLOCK_IN'/,
  "legacy attendance rows must remain available as clock-in records");

assert.match(teacherCreate, /const FUNCTION_VERSION = "teacher-create-v8"/);
assert.match(teacherCreate, /event\.consent !== true[\s\S]*cleanImage\(event\.imageBase64\)/);
assert.match(teacherCreate, /api\.CreatePerson\(/,
  "teacher creation must create the dedicated attendance identity");
assert.match(teacherCreate, /INSERT INTO public\.teacher_attendance_face_profiles/,
  "teacher creation must atomically bind that identity to the new teacher");
assert.match(teacherCreate, /profile_photo_file_id/,
  "only the consented attendance enrollment photo is privately retained");

assert.match(face, /const FUNCTION_VERSION = PHOTO_ONLY_FUNCTION \? "v11" : "v124"/);
const clockInStart = face.indexOf("async function clockInTeacherAttendance");
const clockInEnd = face.indexOf("// Normal and teacher-gift EXPERIENCE", clockInStart);
const clockIn = face.slice(clockInStart, clockInEnd);
assert.match(clockIn, /activeTeacherCaller\(\)[\s\S]*teacher_attendance_face_profiles/);
assert.match(clockIn, /inspectFaceImage[\s\S]*inspectLiveness[\s\S]*VerifyFace/);
assert.match(clockIn, /accuracy[\s\S]*500/);
assert.match(clockIn, /teacher_attendance_records/);
assert.match(clockIn, /attendanceType\(event\.attendanceType\)/);
assert.match(clockIn, /ATTENDANCE_CLOCK_IN_REQUIRED/,
  "clock-out must be rejected before expensive face verification if clock-in is absent");
assert.match(clockIn, /ON CONFLICT \(staff_account_id, attendance_date, attendance_type\)/);
assert.doesNotMatch(clockIn, /uploadVerificationPhotoObject|uploadAttendancePhoto|profile_photo_file_id/,
  "clock-in photos must not be uploaded or persisted");
assert.match(face, /action === "clockInTeacherAttendance"/);

assert.match(staff, /const FUNCTION_VERSION = "v86"/);
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
assert.match(attendanceJs, /requireLocationPrivacyAuthorization\(\)[\s\S]*wx\.requirePrivacyAuthorize/,
  "location collection must actively satisfy the WeChat privacy authorization gate");
assert.match(attendanceJs, /async function locate\(\)[\s\S]*await requireLocationPrivacyAuthorization\(\)[\s\S]*await ensureLocationPermission\(\)/,
  "privacy authorization must run before location scope authorization");
assert.match(attendanceJs, /function localDeviceTime\(\)/,
  "the teacher confirmation preview must use the phone timezone outside China");
assert.match(attendanceWxml, /手机当前时间[\s\S]*坐标类型[\s\S]*定位精度/,
  "the confirmation must identify the local preview and coordinate type");
assert.match(attendanceWxml, /locationErrorCode[\s\S]*打开小程序权限设置[\s\S]*打开手机系统定位设置/,
  "location failures must expose a safe code and both relevant settings entries");
assert.match(attendanceWxml, /查看隐私保护指引[\s\S]*重新请求隐私授权/,
  "privacy denial must have an in-app recovery path instead of sending the teacher to phone settings");
assert.match(attendanceWxml, /重新请求定位授权[\s\S]*打开小程序权限设置/,
  "missing mini-program location scope must first be recreated instead of relying on a nonexistent settings row");
assert.doesNotMatch(attendanceJs, /右上角“…”→设置→打开“位置信息”/,
  "the client must not promise a fixed settings path before WeChat has created the location scope");
assert.match(attendanceJs, /onShow\(\)[\s\S]*_resumeLocationAfterSettings[\s\S]*prepareCheckIn\(\)/,
  "returning from phone settings must continue the same clock-in attempt");
assert.match(attendanceWxml, /打开小程序权限设置[\s\S]*permissionAction === 'system'[\s\S]*打开手机系统定位设置/,
  "system settings must only be offered for a diagnosed system-level location failure");
assert.match(attendanceJs, /openSystemLocationSettings\(\)[\s\S]*精确位置/,
  "the system-level recovery path must explain precise-location requirements");
assert.match(attendanceJs, /currentPlatform\([\s\S]*IPAD[\s\S]*IOS[\s\S]*ANDROID/,
  "phone and iPad platform metadata must be normalized");
assert.match(attendanceJs, /callFace\("clockInTeacherAttendance"/);
assert.match(attendanceJs, /attendanceType,[\s\S]*requestId\(this\.data\.serverToday, attendanceType\)/,
  "clock-in and clock-out must use separately idempotent requests");
assert.match(attendanceJs, /async prepareCheckIn\(\)[\s\S]*await locate\(\)/,
  "teacher must read the current location before face verification");
assert.match(attendanceJs, /confirmCheckInContext\(\)[\s\S]*checkInStage: "face"/,
  "teacher must explicitly confirm time and location before the camera stage");
assert.match(attendanceJs, /120000/,
  "a confirmed location must expire instead of being reused indefinitely");
assert.match(attendanceWxml, /获取\{\{selectedAttendance\.clockIn \? '下班' : '上班'\}\}打卡时间地点[\s\S]*确认时间地点[\s\S]*验证人脸并提交/,
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
assert.match(trackingWxml, /已上班打卡[\s\S]*未上班打卡/);
assert.match(trackingWxml, /class="tracking-table-scroll"[^>]*scroll-x="true"/);
assert.match(trackingWxml, /class="tracking-row tracking-head"/);
assert.doesNotMatch(trackingWxml, /teacher-card|teacher-row/);
assert.match(trackingWxml, /<map[\s\S]*openLocation/);
assert.match(trackingWxml, /老师姓名[\s\S]*老师电话[\s\S]*上班时间[\s\S]*上班详情[\s\S]*下班时间[\s\S]*下班详情[\s\S]*工作时长/,
  "HQ attendance rows must expose the exact seven requested columns");
assert.doesNotMatch(trackingWxml, /人脸档案/,
  "the retired face-profile result column must not displace the seven attendance fields");
assert.match(trackingWxml, /detail\.teacherName[\s\S]*detail\.phone[\s\S]*detail\.attendance\.checkedTime[\s\S]*<map/,
  "each punch detail must identify the teacher, phone, exact time and map");

console.log("teacher attendance contract: PASS");
