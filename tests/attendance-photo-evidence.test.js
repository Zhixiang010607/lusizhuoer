"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const root = path.resolve(__dirname, ".."), read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const source = read("cloudfunctions/faceRecognition/index.js");
const image = require("../cloudfunctions/faceRecognition/attendance-photo");

test("release probe detects missing native dependency without business writes", async () => {
  const context = { Buffer, process: { versions: { node: "20.19.0" }, platform: "linux", arch: "x64" }, module: { exports: {} },
    require(name) { if (name === "./attendance-glyphs.json") return { glyphs: {} }; throw Error("missing native module"); } };
  vm.createContext(context); vm.runInContext(read("cloudfunctions/faceRecognition/attendance-photo.js"), context);
  const probe = await context.module.exports.probeAttendancePhotoRuntime();
  assert.equal(probe.ready, false); assert.equal(probe.errorCode, "ATTENDANCE_PHOTO_RUNTIME_UNAVAILABLE");
  assert.equal(probe.node, "20.19.0");
  assert.match(source, /event\.attendancePhotoProbe === true[\s\S]*probeAttendancePhotoRuntime/);
  const pkg = JSON.parse(read("cloudfunctions/faceRecognition/package.json"));
  assert.equal(pkg.dependencies["@img/sharp-linux-x64"], pkg.dependencies.sharp);
  assert.equal(pkg.engines.node, ">=20.19.0");
});

function harness(options = {}) {
  const calls = [], reference = `pg://customer-photos/attendance/${"a".repeat(48)}.jpg`;
  const photo = Buffer.from("test-compressed-photo"), crypto = require("node:crypto");
  const row = { id: "31", staff_account_id: 7, attendance_date: "2026-10-15", attendance_type: "CLOCK_IN",
    checked_in_at: "2026-10-15T01:02:03Z", photo_object_ref: reference, photo_bytes: photo.length,
    photo_sha256: crypto.createHash("sha256").update(photo).digest("hex"), client_request_id: "attendance_request_123" };
  let writes = 0;
  const mock = {
    async executeSql(sql) {
      calls.push(sql);
      if (/INSERT INTO public.teacher_attendance_records/.test(sql)) { writes++; return options.emptyReturning ? [] : [row]; }
      if (/AS photo_taken_at/.test(sql)) return [{ photo_taken_at: "2026-10-15T01:02:03Z" }];
      if (/SELECT face_person_id/.test(sql)) return [{ face_person_id: "test-profile" }];
      if (/WHERE staff_account_id/.test(sql)) return options.existing || (/client_request_id =/.test(sql) && writes ? [row] : []);
      if (/JOIN public.staff_accounts AS actor/.test(sql)) return options.denied ? [] : [options.legacy ? { ...row, photo_object_ref: null } : row];
      return [];
    },
    async upload() { calls.push("UPLOAD"); if (options.uploadFailure) throw Error("upload unavailable"); return { reference }; },
    async download() { calls.push("DOWNLOAD"); return options.corrupt ? Buffer.from("corrupt") : photo; },
    async active() { if (options.inactive) throw Error("ARCHIVED"); return { staffId: 7, teacherId: 9 }; },
    row, calls
  };
  const context = { Buffer, URL, console, process: { env: {} }, exports: {}, module: { exports: {} }, mock,
    require(name) {
      if (name === "crypto" || name === "https") return require(name);
      if (name === "./attendance-photo") return { prepareAttendancePhoto: async (b, timestamp, type) => {
        calls.push(["PREPARE", b.toString(), timestamp, type]); return { buffer: photo, width: 960, height: 1280 };
      } };
      return {};
    }
  };
  vm.createContext(context);
  vm.runInContext(source + `
    executeSql = mock.executeSql;
    activeTeacherCaller = mock.active;
    requireTeacherAttendanceSchema = async () => {};
    verifiedAttendanceAddressToken = () => ({placeName: '', formattedAddress: '', provider: ''});
    cleanImage = () => ({base64: Buffer.from('same-verified-capture').toString('base64')});
    faceClient = () => ({VerifyFace: async () => ({IsMatch: ${!options.mismatch}, Score: 99})});
    inspectFaceImage = async () => ({qualityScore: 99}); inspectLiveness = async () => ({score: null});
    faceSettings = () => ({verifyThreshold: 60});
    uploadVerificationPhotoObject = mock.upload;
    downloadVerificationPhotoAuthenticated = mock.download;
    deleteVerificationPhotoObject = async () => { mock.calls.push('DELETE'); };
    app = () => ({auth: () => ({getUserInfo: () => ({uid: 'test-authorized-uid'})})});
    signVerificationPhoto = async () => { mock.calls.push('SIGN'); return {url: 'https://example.invalid/private', expiresIn:120}; };
    module.exports = {clockInTeacherAttendance, getAttendancePhoto, verificationPhotoStorageForEvidence};
  `, context);
  return { ...mock, ...context.module.exports };
}
const event = { attendanceType: "CLOCK_IN", clientRequestId: "attendance_request_123", photoEvidenceConsent: true,
  latitude: 30, longitude: 120, accuracy: 10, locationToken: "test" };

test("new punch binds only the same verified capture after private readback", async () => {
  const h = harness(); const result = await h.clockInTeacherAttendance(event);
  assert.equal(result.attendance.id, "31");
  assert.deepEqual(h.calls.find(Array.isArray), ["PREPARE", "same-verified-capture", "2026-10-15T01:02:03Z", "CLOCK_IN"]);
  const insert = h.calls.find((s) => typeof s === "string" && s.includes("INSERT INTO public.teacher_attendance_records"));
  assert.ok(insert.includes("photo_object_ref, photo_bytes, photo_sha256"));
  assert.ok(h.calls.indexOf("DOWNLOAD") < h.calls.indexOf(insert));
});
for (const [name, options] of [["face mismatch", { mismatch: true }], ["upload failure", { uploadFailure: true }], ["corrupt object", { corrupt: true }], ["archived caller", { inactive: true }]]) {
  test(`${name} never inserts a punch`, async () => {
    const h = harness(options); await assert.rejects(h.clockInTeacherAttendance(event));
    assert.equal(h.calls.some((s) => typeof s === "string" && s.includes("INSERT INTO")), false);
  });
}
test("no retention consent never uploads or inserts", async () => {
  const h = harness(); await assert.rejects(h.clockInTeacherAttendance({ ...event, photoEvidenceConsent: false }));
  assert.equal(h.calls.includes("UPLOAD"), false);
});
test("existing daily punch is returned without replacing its photo", async () => {
  const h = harness({ existing: [{ id: "30" }] }); const result = await h.clockInTeacherAttendance(event);
  assert.equal(result.idempotentReplay, true); assert.equal(result.attendance.id, "30"); assert.equal(h.calls.includes("UPLOAD"), false);
});
test("empty RETURNING is independently confirmed without deleting the bound file", async () => {
  const h = harness({ emptyReturning: true }); const result = await h.clockInTeacherAttendance(event);
  assert.equal(result.attendance.id, "31"); assert.equal(h.calls.includes("DELETE"), false);
});
test("photo reads reauthorize exact attendance, deny unrelated callers, and preserve legacy absence", async () => {
  const denied = harness({ denied: true }); await assert.rejects(denied.getAttendancePhoto({ attendanceId: "31" }));
  assert.equal(denied.calls.includes("SIGN"), false);
  const legacy = await harness({ legacy: true }).getAttendancePhoto({ attendanceId: "31" }); assert.equal(legacy.photo, null);
  const h = harness(); const authorized = await h.getAttendancePhoto({ attendanceId: "31", authorizeOnly: true });
  assert.equal(authorized.photo.bytes, h.row.photo_bytes); assert.equal(h.calls.includes("SIGN"), false);
  const sql = h.calls.find((s) => s.includes("JOIN public.staff_accounts AS actor"));
  assert.match(sql, /actor\.auth_uid = 'test-authorized-uid'/);
  assert.match(sql, /actor\.role_code = 'hq' OR[\s\S]*actor\.id = attendance\.staff_account_id/);
  assert.match(sql, /teacher\.teacher_status = 'ACTIVE'/);
});
test("authorized byte fallback validates integrity and does not need a signed URL", async () => {
  const h = harness(); const result = await h.getAttendancePhoto({ attendanceId: "31", readBytes: true });
  assert.equal(Buffer.from(result.photo.imageBase64, "base64").length, h.row.photo_bytes);
  assert.equal(h.calls.includes("SIGN"), false);
  await assert.rejects(harness({ corrupt: true }).getAttendancePhoto({ attendanceId: "31", readBytes: true }));
});
test("attendance shares work-order HD byte boundaries and thumbnail/original transport without altering verification evidence", () => {
  const pipeline=read("cloudfunctions/faceRecognition/attendance-photo.js");
  assert.doesNotMatch(pipeline,/\.resize\(|for \(const (?:edge|quality)/);
  assert.match(pipeline,/quality: 92, chromaSubsampling: "4:4:4"/);
  assert.match(pipeline,/ATTENDANCE_HD_PHOTO_TOO_LARGE/);
  const attendance=source.slice(source.indexOf("async function clockInTeacherAttendance"),source.indexOf("async function persistVerifiedFaceEvidence"));
  assert.equal((attendance.match(/downloadVerificationPhotoAuthenticated\([^\n]*MAX_VERIFICATION_IMAGE_BYTES/g)||[]).length,2);
  assert.match(attendance,/thumbnailTransform: event.original !== true/);
  assert.doesNotMatch(attendance,/512 \* 1024|524288/);
  const migration=read("database/migrations/089_teacher_attendance_hd_photo.sql");
  assert.equal(migration,read("database/cloudbase-console/089-01-teacher-attendance-hd-photo.sql"));
  assert.match(migration,/photo_bytes BETWEEN 4 AND 3145728/);
  assert.match(migration,/photo_width BETWEEN 160 AND 10000/);
  assert.match(migration,/photo_taken_at = checked_in_at/);
  assert.doesNotMatch(migration,/UPDATE |DELETE FROM|verification_records|DROP TRIGGER|CREATE.*FUNCTION/);
});
test("watermark uses correct Beijing date across UTC midnight and distinguishes punches", () => {
  assert.equal(image.shanghaiStamp("2026-10-14T18:02:03.123Z"), "2026-10-15 02:02:03");
  assert.notDeepEqual(image.stampSvg("2026-10-15 09:00:00", 960, "CLOCK_IN"), image.stampSvg("2026-10-15 09:00:00", 960, "CLOCK_OUT"));
  assert.throws(() => image.stampSvg("2026-10-15 09:00:00", 960, "OTHER"));
  assert.doesNotMatch(image.stampSvg("2026-10-15 09:00:00", 960, "CLOCK_IN").toString(), /<text|font-family/);
});
test("only the timestamp is enlarged and bold; complete date fits even the smallest accepted capture", () => {
  for (const width of [160,240,320,480,720,960,1280]) {
    for (const type of ["CLOCK_IN","CLOCK_OUT"]) {
      const svg=image.stampSvg("2026-10-15 09:02:03",width,type).toString();
      const overlayWidth=Number(/<svg[^>]*width="(\d+)"/.exec(svg)[1]);
      assert.ok(overlayWidth<=width,`${width}: overlay ${overlayWidth} must fit`);
      const paths=[...svg.matchAll(/<path[^>]+>/g)].map(x=>x[0]);
      const date=paths.filter(x=>x.includes('fill="#fff"'));
      const labels=paths.filter(x=>x.includes('fill="#f8ddb0"'));
      assert.equal(date.length,19); assert.equal(labels.length,9);
      const labelScale=Number(/scale\(([^,]+)/.exec(labels[0])[1]);
      assert.equal(labelScale,Math.round(Math.max(12,Math.round(width/36))*.8)/1000);
      const dateScale=Number(/scale\(([^,]+)/.exec(date[0])[1]);
      if(width>=480) assert.ok(dateScale>=Math.max(12,Math.round(width/36))*1.9/1000);
      else if(width===320) assert.ok(dateScale>=.018);
      date.forEach(p=>assert.match(p,/stroke-width="18"/));
      labels.forEach(p=>assert.match(p,/stroke-width="0"/));
    }
  }
});
test("migration remains scoped, immutable, private and does not fabricate historical photos", () => {
  const sql = read("database/migrations/088_teacher_attendance_photo_evidence.sql");
  assert.match(sql, /photo_taken_at = checked_in_at/);
  assert.match(sql, /new attendance requires verified private photo evidence/);
  assert.match(sql, /INTERVAL '2 minutes'/);
  assert.match(sql, /REVOKE ALL ON TABLE[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(sql, /UPDATE public\.teacher_attendance_records|verification_records|verification_ble|DELETE FROM/);
  for (const name of ["088-01-teacher-attendance-photo-schema.sql", "088-02-teacher-attendance-photo-guard.sql"]) assert.ok(Buffer.byteLength(read(`database/cloudbase-console/${name}`).replace(/\n/g, "\r\n")) < 3500);
});
test("all Mini Program and HQ Web details use separate attendance photo surfaces", () => {
  for (const p of ["attendance", "attendance-tracking", "teacher-detail", "work-calendar"]) {
    assert.match(read(`miniprogram-app/miniprogram/pages/${p}/index.wxml`), /<attendance-photo attendance-id=/);
    assert.equal(JSON.parse(read(`miniprogram-app/miniprogram/pages/${p}/index.json`)).usingComponents["attendance-photo"], "/components/attendance-photo/index");
  }
  assert.match(read("attendance-tracking.js"), /data-attendance-photo=/);
  assert.match(read("staff-detail.js"), /data-attendance-photo=/);
  const component = read("miniprogram-app/miniprogram/components/attendance-photo/index.js");
  assert.match(component, /authorizeOnly: true/); assert.match(component, /this\.current\(epoch, account\)/);
  assert.doesNotMatch(component, /setStorageSync\([^)]*(?:url|Base64)/);
});
test("tablet attendance places address and photo in equal columns without changing phone order", () => {
  for (const p of ["attendance", "attendance-tracking", "teacher-detail", "work-calendar"]) {
    const markup = read(`miniprogram-app/miniprogram/pages/${p}/index.wxml`);
    const css = read(`miniprogram-app/miniprogram/pages/${p}/index.wxss`);
    assert.match(markup, /class="punch-body"><view class="punch-location">/);
    assert.match(markup, /class="attendance-evidence" fill="\{\{true\}\}"/);
    assert.match(css, /\.punch-body \.attendance-evidence \{ order: -1/);
    assert.match(css, /@media \(min-width: 700px\) \{[\s\S]*\.punch-body \{ display: grid; grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  }
  const component = read("miniprogram-app/miniprogram/components/attendance-photo/index.wxss");
  assert.match(component, /\.fill \.photo-button \{[^}]*height: 44px/);
  assert.match(read("miniprogram-app/miniprogram/components/attendance-photo/index.wxml"), /mode="aspectFit"/);
});
