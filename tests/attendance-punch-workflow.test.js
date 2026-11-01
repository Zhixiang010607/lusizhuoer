"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm"), path = require("node:path");
const root = path.resolve(__dirname, "../miniprogram-app/miniprogram");
const read = p => fs.readFileSync(path.join(root, p), "utf8");
const today = "2026-11-01";
function fixture(initialRecords = []) {
  let page, records = [...initialRecords], resets = 0; const calls = [], scrolls = [];
  const camera = { getCapture: () => ({ imageBase64: "isolated-live-photo" }), reset() { resets += 1; } };
  const wx = {
    getStorageSync: () => "isolated-request", setStorageSync() {}, removeStorageSync() {},
    getDeviceInfo: () => ({ platform: "ios" }), pageScrollTo: x => scrolls.push(x),
    getSetting: o => o.success({ authSetting: { "scope.userLocation": true } }),
    getSystemSetting: () => ({ locationEnabled: true }), getAppAuthorizeSetting: () => ({ locationAuthorized: "authorized" }),
    getLocation: o => o.success({ latitude: 30, longitude: 120, accuracy: 10 })
  };
  vm.runInNewContext(read("pages/attendance/index.js"), {
    Page: p => { page = p; }, Date, setTimeout, wx, getCurrentPages: () => [],
    require(name) {
      if (name.endsWith("business-time")) return require(path.join(root, "services/business-time"));
      if (name.endsWith("session")) return { waitForStartupSession: async () => {}, requireSession: () => ({ role: "teacher" }) };
      return {
        callStaff: async () => ({ month: today.slice(0, 7), serverToday: today, records }),
        callFace: async (action, payload) => {
          calls.push({ action, payload });
          if (action === "resolveTeacherAttendanceLocation") return { placeName: "合成位置", locationToken: "isolated-location" };
          assert.equal(action, "clockInTeacherAttendance");
          const row = { id: "isolated-" + payload.attendanceType, attendanceDate: today, attendanceType: payload.attendanceType,
            checkedInAt: payload.attendanceType === "CLOCK_IN" ? "2026-11-01T01:00:00Z" : "2026-11-01T10:00:00Z", latitude: 30, longitude: 120 };
          records.push(row); return { attendance: row };
        }
      };
    }
  });
  const p = { ...page, data: JSON.parse(JSON.stringify(page.data)), setData(v) { Object.assign(this.data, v); }, selectComponent: () => camera };
  Object.assign(p.data, { loading: false, serverToday: today, selectedDate: today, pendingDate: today, visibleMonth: today.slice(0, 7) });
  return { p, calls, scrolls, resets: () => resets };
}
const inRecord = { id: "isolated-in", attendanceDate: today, attendanceType: "CLOCK_IN", checkedInAt: "2026-11-01T01:00:00Z", latitude: 30, longitude: 120 };
const workflowCondition = read("pages/attendance/index.wxml").match(/<block wx:if="\{\{(!loading && selectedDate === serverToday[^\n]+?)\}\}">/)[1];
function showsWorkflow(data) { return vm.runInNewContext(workflowCondition, data); }
test("one tab controls the entire workflow, not just the existing photo/map", () => {
  for (const date of [today, "2026-10-31"]) for (const loading of [false, true]) for (const kind of ["clockIn", "clockOut"]) {
    for (const [clockIn, clockOut] of [[null, null], [inRecord, null], [inRecord, { id: "out" }]]) {
      const actual = Boolean(showsWorkflow({ loading, selectedDate: date, serverToday: today, punchKind: kind, selectedAttendance: { clockIn, clockOut } }));
      const expected = !loading && date === today && (kind === "clockIn" ? !clockIn : Boolean(clockIn && !clockOut));
      assert.equal(actual, expected, JSON.stringify({ date, loading, kind, clockIn: !!clockIn, clockOut: !!clockOut }));
    }
  }
});
test("tab changes discard local photo/location/consent and permission retry without cloud writes", () => {
  const { p, calls, resets } = fixture();
  Object.assign(p.data, { checkInStage: "photo", pendingAttendanceType: "CLOCK_IN", locationPreview: { capturedAtMs: Date.now() },
    captureReady: true, photoConsent: true, permissionDenied: true, permissionAction: "system", locationErrorCode: "old", message: "old", error: true });
  p._resumeLocationAfterSettings = true; p.choosePunch({ detail: { kind: "clockOut" } });
  assert.equal(p.data.punchKind, "clockOut"); assert.equal(p.data.checkInStage, "idle"); assert.equal(p.data.locationPreview, null);
  for (const key of ["captureReady", "photoConsent", "permissionDenied", "error"]) assert.equal(p.data[key], false);
  assert.equal(p.data.pendingAttendanceType, ""); assert.equal(p.data.message, ""); assert.equal(p._resumeLocationAfterSettings, false);
  assert.equal(resets(), 1); assert.equal(calls.length, 0);
  for (const busy of ["loading", "locating", "clocking"]) { p.data[busy] = true; p.choosePunch({ detail: { kind: "clockIn" } }); assert.equal(p.data.punchKind, "clockOut"); p.data[busy] = false; }
  p.choosePunch({ detail: { kind: "invalid" } }); assert.equal(p.data.punchKind, "clockOut");
});
test("clock-in stays on its own record; clock-out starts only after explicitly switching", async () => {
  const { p, calls, scrolls } = fixture();
  await p.prepareCheckIn(); assert.equal(p.data.pendingAttendanceType, "CLOCK_IN"); p.confirmCheckInContext();
  p.data.photoConsent = true; await p.clockIn();
  assert.equal(p.data.punchKind, "clockIn"); assert.ok(p.data.selectedAttendance.clockIn); assert.equal(Boolean(showsWorkflow(p.data)), false);
  const count = calls.length; await p.prepareCheckIn(); assert.equal(calls.length, count);
  p.choosePunch({ detail: { kind: "clockOut" } }); assert.equal(Boolean(showsWorkflow(p.data)), true);
  assert.equal(p.data.locationPreview, null); assert.equal(p.data.photoConsent, false);
  await p.prepareCheckIn(); assert.equal(p.data.pendingAttendanceType, "CLOCK_OUT"); p.confirmCheckInContext();
  p.data.photoConsent = true; await p.clockIn();
  assert.equal(p.data.punchKind, "clockOut"); assert.ok(p.data.selectedAttendance.clockOut); assert.equal(Boolean(showsWorkflow(p.data)), false);
  assert.equal(calls.filter(x => x.action === "clockInTeacherAttendance").map(x => x.payload.attendanceType).join(","), "CLOCK_IN,CLOCK_OUT");
  assert.equal(scrolls.length, 2); assert.ok(scrolls.every(x => x.scrollTop === 0));
});
test("client guards reject hidden/history/incorrect-type submissions before any API call", async () => {
  const { p, calls } = fixture(); p.data.punchKind = "clockOut";
  await p.prepareCheckIn(); await p.clockIn(); assert.equal(calls.length, 0);
  p.data.punchKind = "clockIn"; p.data.selectedDate = "2026-10-31";
  await p.prepareCheckIn(); await p.clockIn(); assert.equal(calls.length, 0);
  p.data.selectedDate = today; p.data.pendingAttendanceType = "CLOCK_OUT"; p.data.checkInStage = "confirm";
  p.data.locationPreview = { capturedAtMs: Date.now() }; p.confirmCheckInContext(); assert.equal(p.data.checkInStage, "confirm");
  p.data.checkInStage = "photo"; p.data.photoConsent = true; await p.clockIn(); assert.equal(calls.length, 0);
});
test("changing date clears a draft and cannot submit while viewing history", async () => {
  const { p, calls } = fixture([inRecord]); await p.loadMonth("2026-11", today);
  p.choosePunch({ detail: { kind: "clockOut" } }); await p.prepareCheckIn(); p.confirmCheckInContext();
  p.data.pendingDate = "2026-10-31";
  p.selectDate({ currentTarget: { dataset: { date: "2026-10-31" } } });
  assert.equal(p.data.checkInStage, "idle"); assert.equal(p.data.pendingAttendanceType, ""); assert.equal(p.data.locationPreview, null);
  const count = calls.length; await p.prepareCheckIn(); await p.clockIn(); assert.equal(calls.length, count);
});
test("calendar navigation preserves requested punch tab without changing backend contracts", async () => {
  const { p } = fixture([inRecord]); await p.onLoad({ kind: "clockOut" });
  assert.equal(p.data.punchKind, "clockOut"); assert.equal(Boolean(showsWorkflow(p.data)), true);
  assert.match(read("pages/work-calendar/index.js"), /attendance\/index\?kind=\$\{this\.data\.punchKind/);
});
test("disabled attendance tabs keep readable neutral and selected colors", () => {
  const css = read("components/punch-tabs/index.wxss");
  assert.match(css, /\.punch-tab\[disabled\] \{[^}]*color: #776957 !important;[^}]*opacity: 1 !important;/);
  assert.match(css, /\.punch-tab\.active\[disabled\] \{[^}]*color: #fff !important;[^}]*background: #91754a !important;/);
});
