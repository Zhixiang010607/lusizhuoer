"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
const read = p => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
test("090 is standalone, scoped, immutable and does not rewrite historical records", () => {
  const sql = read("database/migrations/090_teacher_photo_attendance.sql");
  assert.equal(sql, read("database/cloudbase-console/090-01-teacher-photo-attendance.sql"));
  assert.match(sql, /attendance_method VARCHAR\(8\) NOT NULL DEFAULT 'FACE'/);
  assert.match(sql, /attendance_method = 'PHOTO'[\s\S]*face_score IS NULL AND face_request_id IS NULL/);
  assert.match(sql, /NEW.attendance_method = 'FACE' AND NOT EXISTS/);
  assert.match(sql, /TG_OP <> 'INSERT'/); assert.match(sql, /account_status = 'ACTIVE' AND t.teacher_status = 'ACTIVE'/);
  assert.match(sql, /clock-out requires an earlier same-day clock-in/);
  assert.doesNotMatch(sql, /DELETE FROM|UPDATE public\.|verification_records|ble_|DROP TRIGGER/);
  assert.ok(Buffer.byteLength(sql.replace(/\n/g, "\r\n")) < 3500);
});
test("090 preview keeps counts, historical digest and guard digests in one CLI result", () => {
  const sql = read("database/cloudbase-console/090-preview.sql").replace(/--[^\n]*/g, "");
  assert.equal(sql.split(";").filter(s => s.trim()).length, 1);
  assert.match(sql, /COUNT\(\*\) AS records, COUNT\(photo_object_ref\) AS photos/);
  assert.match(sql, /TO_JSONB\(r\) - 'attendance_method'/);
  assert.match(sql, /JSONB_AGG\(JSONB_BUILD_OBJECT/);
  assert.match(sql, /MD5\(pg_get_functiondef\(tgfoid\)\)/);
});
function pageFixture() {
  let definition; const calls = [];
  vm.runInNewContext(read("miniprogram-app/miniprogram/pages/attendance/index.js"), {
    Page: d => { definition = d; }, Date, setTimeout, getCurrentPages: () => [],
    wx: { getStorageSync: () => "same_request_123", setStorageSync() {}, removeStorageSync() {}, getDeviceInfo: () => ({ platform: "ios" }) },
    require(name) {
      if (name.endsWith("/api")) return { callFace: async (action, event) => { calls.push({ action, event }); return { attendance: { id: "photo-1" } }; } };
      return {};
    }
  });
  const camera = { getCapture: () => ({ imageBase64: "live-photo" }), reset() {} };
  const p = { ...definition, data: { ...definition.data, serverToday: "2026-11-01", faceEnrolled: false,
    todayAttendance: { completed: false }, photoConsent: true, loading: false,
    locationPreview: { capturedAtMs: Date.now(), latitude: 30, longitude: 120, accuracy: 10 } },
    setData(d) { Object.assign(this.data, d); }, selectComponent: () => camera, loadMonth: async () => {} };
  return { p, calls };
}
test("unenrolled teacher confirms location and submits a live photo without face flags", async () => {
  const { p, calls } = pageFixture(); p.confirmCheckInContext();
  assert.equal(p.data.checkInStage, "photo");
  await p.clockIn(); assert.equal(calls.length, 1);
  assert.equal(calls[0].action, "clockInTeacherAttendance");
  assert.equal(calls[0].event.imageBase64, "live-photo");
  assert.equal(calls[0].event.photoEvidenceConsent, true);
  assert.equal(p.data.message, "上班打卡成功。");
});
test("expired location and missing retention consent still stop photo submission", async () => {
  const { p, calls } = pageFixture(); p.confirmCheckInContext(); p.data.photoConsent = false;
  await p.clockIn(); assert.equal(calls.length, 0); assert.match(p.data.message, /同意保存/);
  p.data.photoConsent = true; p.data.locationPreview.capturedAtMs -= 120001;
  await p.clockIn(); assert.equal(calls.length, 0); assert.equal(p.data.checkInStage, "idle");
});
async function captureFixture(photoOnly) {
  let definition; const calls = [];
  vm.runInNewContext(read("miniprogram-app/miniprogram/components/camera-capture/index.js"), {
    Component: d => { definition = d; },
    wx: {
      chooseMedia(o) { calls.push(o); o.success({ tempFiles: [{ tempFilePath: "/synthetic-live.jpg" }] }); },
      compressImage(o) { calls.push("COMPRESS"); o.success({ tempFilePath: "/synthetic-thumb.jpg" }); },
      getImageInfo(o) { o.success({ width: 320, height: 480, type: "jpeg" }); },
      getFileSystemManager: () => ({ getFileInfo(o) { o.success({ size: 100 }); }, readFile(o) { o.success({ data: "aW1hZ2U=" }); } })
    }
  });
  const c = { ...definition.methods, properties: { photoOnly }, data: { ...definition.data }, setData(d) { Object.assign(this.data, d); }, triggerEvent() {} };
  await c.takePhoto(); return { c, calls };
}
test("attendance capture is camera-only with no unnecessary thumbnail or face-check message", async () => {
  const { c, calls } = await captureFixture(true);
  assert.equal(c.data.captureReady, true);
  assert.equal(calls[0].sourceType.join(","), "camera"); assert.equal(calls[0].camera, "front");
  assert.equal(calls.includes("COMPRESS"), false); assert.equal(c.getCapture().thumbnailBase64, "");
  assert.doesNotMatch(c.data.message, /质量|活体|人脸检查/);
});
test("default enrollment/customer camera behavior remains unchanged", async () => {
  const { c, calls } = await captureFixture(false);
  assert.equal(c.data.captureReady, true); assert.equal(calls.includes("COMPRESS"), true);
  assert.ok(c.getCapture().thumbnailBase64); assert.match(c.data.message, /质量、活体与人脸检查/);
});
