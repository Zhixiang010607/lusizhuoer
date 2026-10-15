"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const { attendanceMap } = require("../miniprogram-app/miniprogram/services/attendance-map");
const pages = path.join(__dirname, "../miniprogram-app/miniprogram/pages");
function load(route) {
  let definition; const opened = [];
  const source = fs.readFileSync(path.join(pages, route, "index.js"), "utf8");
  vm.runInNewContext(source, {
    require(name) {
      if (name.endsWith("attendance-map")) return { attendanceMap };
      if (name.endsWith("business-time")) return { formatShanghaiTimestamp: (v) => v };
      if (name.endsWith("query-tools")) return { displayDateTimeAny: (...v) => v[0] || "—" };
      return {};
    }, Page(d) { definition = d; }, wx: { openLocation: (v) => opened.push(v) },
    Date, Number, String, Map, Set, Object, Math
  });
  const page = { ...definition, data: { ...definition.data }, setData(v) { Object.assign(this.data, v); } };
  return { page, opened };
}
const recorded = { id: "synthetic-map-record", latitude: "23.1291", longitude: "113.2644", attendanceType: "CLOCK_IN", checkedInAt: "2026-10-16T01:00:00Z", placeName: "", formattedAddress: "" };
test("map uses recorded coordinates without requiring a resolved text address", () => {
  const original = { ...recorded }; const view = attendanceMap(recorded);
  assert.equal(view.mapReady, true); assert.equal(view.latitude, 23.1291); assert.equal(view.longitude, 113.2644);
  assert.equal(view.markers[0].title, "上班打卡位置"); assert.deepEqual(recorded, original);
  assert.equal(attendanceMap({ ...recorded, attendanceType: "CLOCK_OUT" }).markers[0].title, "下班打卡位置");
  assert.equal(attendanceMap({ latitude: 0, longitude: 0 }).mapReady, true);
});
test("invalid or absent coordinates never become a fabricated zero location", () => {
  for (const value of [null, undefined, "", "  ", "bad", NaN, Infinity, {}, true]) {
    for (const key of ["latitude", "longitude"]) {
      const view = attendanceMap({ ...recorded, [key]: value }); assert.equal(view.mapReady, false); assert.deepEqual(view.markers, []);
    }
  }
  for (const [latitude, longitude] of [[91, 113], [-91, 113], [23, 181], [23, -181]]) assert.equal(attendanceMap({ latitude, longitude }).mapReady, false);
});
for (const [route, select, days, state, open] of [
  ["work-calendar", "selectDate", "days", "selected", "openMap"],
  ["teacher-detail", "selectWorkDate", "calendarDays", "selectedWorkDay", "openAttendanceMap"]
]) {
  test(`${route} prepares both punch markers and opens exactly the stored location`, () => {
    const { page, opened } = load(route); const date = "2026-10-16";
    page.data[days] = [{ date, clockIn: recorded, clockOut: { ...recorded, id: "out", attendanceType: "CLOCK_OUT", latitude: "-33.8688", longitude: "151.2093" } }];
    page[select]({ currentTarget: { dataset: { date } } });
    for (const kind of ["clockIn", "clockOut"]) {
      const view = page.data[state][kind]; assert.equal(view.mapReady, true); assert.equal(view.markers.length, 1);
      page[open]({ currentTarget: { dataset: { kind } } });
      assert.equal(opened.at(-1).latitude, view.latitude); assert.equal(opened.at(-1).longitude, view.longitude);
      page.data[state][kind].latitude = null; page[open]({ currentTarget: { dataset: { kind } } });
    }
    assert.equal(opened.length, 2);
    page.data[days] = [{ date }]; page[select]({ currentTarget: { dataset: { date } } });
    assert.equal(page.data[state].clockIn, null); assert.equal(page.data[state].clockOut, null);
  });
  test(`${route} embeds both maps and preserves responsive photo/location split`, () => {
    const markup = fs.readFileSync(path.join(pages, route, "index.wxml"), "utf8");
    const style = fs.readFileSync(path.join(pages, route, "index.wxss"), "utf8");
    assert.equal((markup.match(/<map wx:if="\{\{[^}]+\.mapReady\}\}" class="punch-map"/g) || []).length, 2);
    for (const kind of ["clockIn", "clockOut"]) for (const field of ["latitude", "longitude", "markers"]) assert.match(markup, new RegExp(`${kind}\\.${field}\\}\\}`));
    assert.doesNotMatch(markup, /未解析附近地点|暂无文字地址/);
    assert.match(markup, /暂无定位坐标/); assert.match(style, /\.punch-map \{[^}]*width: 100%; height: 340rpx/);
    assert.match(style, /@media \(min-width: 700px\) \{[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
    assert.match(style, /\.punch-map \{ height: 240px; flex: 1; min-height: 240px/);
    assert.doesNotMatch(fs.readFileSync(path.join(pages, route, "index.js"), "utf8"), /wx\.getLocation|wx\.chooseLocation/);
  });
}
