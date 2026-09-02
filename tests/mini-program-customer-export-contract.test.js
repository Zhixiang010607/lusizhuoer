"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const mini = path.join(root, "miniprogram-app", "miniprogram");
const read = (...parts) => fs.readFileSync(path.join(mini, ...parts), "utf8");
const exporter = require(path.join(mini, "services", "grouped-table-export.js"));

function storedZipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder("utf-8");
  const entries = new Map();
  let offset = 0;
  while (offset + 30 <= bytes.byteLength && view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(bytes.slice(nameStart, nameStart + nameLength));
    entries.set(name, decoder.decode(bytes.slice(dataStart, dataStart + size)));
    offset = dataStart + size;
  }
  return entries;
}

test("grouped customer export produces a real styled XLSX with one section per store", () => {
  assert.equal(exporter.EXPORT_BATCH_SIZE, 100);
  assert.equal(exporter.EXPORT_MAX_ROWS, 10000);
  const report = exporter.createGroupedWorkbook({
    title: "活跃预警查询结果",
    sheetName: "活跃预警",
    criteria: "查询条件：核销间隔至少 30 天｜共 3 位客户",
    rows: [
      { customerName: "客户甲", storeId: "2", storeName: "中心门店", daysSince: 91, source: "正常核销", last: "2026-06-03 09:00" },
      { customerName: "客户乙", storeId: "1", storeName: "安宁门店", daysSince: 67, source: "体验核销", last: "2026-06-27 10:00" },
      { customerName: "客户丙", storeId: "1", storeName: "安宁门店", daysSince: 480, source: "客户建档", last: "从未核销" }
    ],
    columns: [
      { key: "customerName", header: "客户", width: 22 },
      { key: "storeName", header: "门店", width: 20 },
      { key: "daysSince", header: "间隔时间（天）", width: 16, type: "number" },
      { key: "source", header: "计算起点", width: 15 },
      { key: "last", header: "上次核销", width: 21 }
    ]
  });
  assert.equal(report.rowCount, 3);
  assert.equal(report.groupCount, 2);
  assert.equal(report.sheetName, "活跃预警");
  assert.equal(new DataView(report.bytes.buffer, report.bytes.byteOffset).getUint32(0, true), 0x04034b50);

  const entries = storedZipEntries(report.bytes);
  for (const name of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/styles.xml", "xl/worksheets/sheet1.xml"]) {
    assert.ok(entries.has(name), `XLSX is missing ${name}`);
  }
  assert.match(entries.get("xl/workbook.xml"), /sheet name="活跃预警"/);
  assert.match(entries.get("xl/styles.xml"), /numFmtId="164" formatCode="#,##0"/);
  const sheet = entries.get("xl/worksheets/sheet1.xml");
  assert.match(sheet, /活跃预警查询结果/);
  assert.match(sheet, /门店：安宁门店（2 条）/);
  assert.match(sheet, /门店：中心门店（1 条）/);
  assert.match(sheet, /客户[\s\S]*门店[\s\S]*间隔时间（天）[\s\S]*计算起点[\s\S]*上次核销/);
  assert.match(sheet, /<v>480<\/v>/, "counts and interval days must remain numeric Excel cells");
  assert.doesNotMatch(sheet, /生日|项目编号/);
});

test("both operational indicator pages export every cursor page rather than only the visible 20 rows", () => {
  const service = read("services", "grouped-table-export.js");
  assert.match(service, /EXPORT_MAX_ROWS = 10000/);
  assert.match(service, /wx\.getFileSystemManager\(\)\.writeFile/);
  assert.match(service, /wx\.openDocument\(\{ filePath, fileType: "xlsx", showMenu: true/);

  const cases = [
    {
      page: "inactive-customers",
      labels: ["活跃预警查询结果", "客户", "门店", "间隔时间（天）", "计算起点", "上次核销"],
      removed: /生日|上次项目|项目编号/
    },
    {
      page: "low-balance-customers",
      labels: ["余次预警查询结果", "姓名", "项目", "当前剩余", "净开卡", "已核销", "门店"],
      removed: /生日|productCode|项目编号/
    }
  ];
  for (const item of cases) {
    const js = read("pages", item.page, "index.js");
    const wxml = read("pages", item.page, "index.wxml");
    const exportStart = js.indexOf("async exportAll()");
    const exportEnd = js.indexOf("openCustomer(event)", exportStart);
    assert.ok(exportStart >= 0 && exportEnd > exportStart, `${item.page} must define a bounded exportAll handler`);
    const source = js.slice(exportStart, exportEnd);
    assert.match(source, /limit: EXPORT_BATCH_SIZE/);
    assert.match(source, /while \(true\)/, "export must walk the complete server cursor");
    assert.match(source, /result\.summary\?\.selectedTotal/,
      "export must fail instead of silently returning a mixed snapshot if the result set changes");
    assert.match(source, /uniqueRows\.size > EXPORT_MAX_ROWS/);
    assert.match(source, /rows\.length !== expectedTotal/,
      "export must prove that every matching row was collected before opening Excel");
    assert.match(source, /createGroupedWorkbook\(\{/);
    assert.match(source, /groupKey: \(row\) => row\.storeId \|\| row\.storeName/);
    assert.match(source, /await openWorkbook\(\{/);
    for (const label of item.labels) assert.match(source, new RegExp(label), `${item.page} export is missing ${label}`);
    assert.doesNotMatch(source, item.removed);
    assert.match(wxml, /bindtap="exportAll"[\s\S]*导出全部 Excel/);
    assert.match(wxml, /按门店分组/);
    assert.match(wxml, /disabled="\{\{loading \|\| exporting \|\| total <= 0\}\}"/);
  }
});
