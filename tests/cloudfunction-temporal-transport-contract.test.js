"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

function loadTemporalParser(relativePath) {
  const source = fs.readFileSync(path.join(root, relativePath), "utf8");
  const start = source.indexOf("function temporalNumber");
  const end = source.indexOf("async function executeSql", start);
  assert.ok(start >= 0 && end > start, `${relativePath} must define its SQL temporal transport layer`);
  const context = { result: null, Date, JSON, Number, Math, String, Object, Array };
  vm.runInNewContext(`${source.slice(start, end)}\nresult = { sqlTemporalText, parseSqlRows };`, context);
  return context.result;
}

for (const relativePath of [
  "cloudfunctions/faceRecognition/index.js",
  "cloudfunctions/staffAccount/index.js"
]) {
  test(`${relativePath} serializes database temporal values before CloudBase transport`, () => {
    const { sqlTemporalText, parseSqlRows } = loadTemporalParser(relativePath);
    const timestamp = "2026-08-27T12:34:56.123Z";

    assert.equal(sqlTemporalText(new Date(timestamp), "submitted_at"), timestamp);
    assert.equal(sqlTemporalText({ seconds: 1787834096, nanoseconds: 123000000 }, "reviewed_at"),
      "2026-08-27T12:34:56.123Z");
    assert.equal(sqlTemporalText({ $date: { $numberLong: "1787834096123" } }, "created_at"), timestamp);
    assert.equal(sqlTemporalText("2026-08-27 12:34:56.123456+00", "application_time"), timestamp);
    assert.equal(sqlTemporalText("2001-06-07", "birth_date"), "2001-06-07");

    const untouched = { opaque: true };
    assert.equal(sqlTemporalText(untouched, "customer_id"), untouched,
      "non-temporal database values must retain their original representation");

    const rows = parseSqlRows({
      Columns: ["submitted_at", "birth_date", "customer_name"],
      Rows: [[{ _seconds: 1787834096, _nanoseconds: 0 }, "2001-06-07", "测试客户"]]
    });
    assert.equal(rows[0].submitted_at, "2026-08-27T12:34:56.000Z");
    assert.equal(rows[0].birth_date, "2001-06-07");
    assert.equal(rows[0].customer_name, "测试客户");
  });
}

