"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const zlib = require("node:zlib");

const root = path.resolve(__dirname, "..");
const mini = path.join(root, "miniprogram-app", "miniprogram");
const read = (...parts) => fs.readFileSync(path.join(mini, ...parts), "utf8");
const exporter = require(path.join(mini, "services", "grouped-table-export.js"));
const pdfExporter = require(path.join(mini, "services", "grouped-table-pdf.js"));
const cjkFontArchive = fs.readFileSync(path.join(mini, "pages", "rating-analysis", "NotoSansCJKsc-Common-Identity.br"));
const cjkFontBytes = zlib.brotliDecompressSync(cjkFontArchive);
const CJK_FONT_SHA256 = "3f8f30776e78a3adab2be1c59f5a5b42718a9d37ec7964107523abb8bc2971f1";

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
  assert.equal(exporter.EXPORT_MAX_ROWS, 1000);
  const report = exporter.createGroupedWorkbook({
    title: "活跃预警查询结果",
    sheetName: "活跃预警",
    criteria: "查询条件：核销间隔至少 30 天｜共 3 位客户",
    rows: [
      { category: "任意项目非 0", customerName: "客户甲", storeId: "2", storeName: "中心门店", daysSince: 91, source: "正常核销", last: "2026-06-03 09:00" },
      { category: "全部项目为 0", customerName: "客户乙", storeId: "1", storeName: "安宁门店", daysSince: 67, source: "体验核销", last: "2026-06-27 10:00" },
      { category: "全部项目为 0", customerName: "客户丙", storeId: "1", storeName: "安宁门店", daysSince: 480, source: "客户建档", last: "从未核销" }
    ],
    columns: [
      { key: "category", header: "预警分类", width: 18 },
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
  assert.match(sheet, /预警分类[\s\S]*客户[\s\S]*门店[\s\S]*间隔时间（天）[\s\S]*计算起点[\s\S]*上次核销/);
  assert.match(sheet, /<v>480<\/v>/, "counts and interval days must remain numeric Excel cells");
  assert.doesNotMatch(sheet, /生日|项目编号/);
});

test("grouped PDF export is vector, paginated, store-grouped, and capped at 1000 rows", () => {
  assert.equal(pdfExporter.PDF_EXPORT_MAX_ROWS, 1000);
  const report = pdfExporter.createGroupedPdf({
    cjkFontBytes,
    title: "余次预警查询结果",
    criteria: "全部项目｜共 2 个卡项",
    rows: [
      { storeId: "1", storeName: "安宁门店", category: "项目余次为 0", name: "客户甲", remaining: 0 },
      { storeId: "2", storeName: "中心门店", category: "非 0 且低于阈值", name: "客户乙", remaining: 2 }
    ],
    columns: [
      { key: "category", header: "预警分类", width: 18 },
      { key: "name", header: "客户", width: 20 },
      { key: "remaining", header: "当前剩余", width: 12, type: "number" }
    ]
  });
  assert.equal(report.rowCount, 2);
  assert.equal(report.groupCount, 2);
  assert.ok(report.pages >= 1);
  assert.equal(Buffer.from(report.bytes.slice(0, 8)).toString("latin1"), "%PDF-1.4");
  const source = read("services", "grouped-table-pdf.js");
  assert.match(source, /\/Subtype \/Type0 \/BaseFont \/NotoSansCJKsc-Regular/);
  assert.match(source, /\/FontFile3 8 0 R/);
  assert.match(source, /\/Subtype \/CIDFontType0C/);
  assert.doesNotMatch(source, /STSong-Light|UniGB-UCS2-H/,
    "marketing PDFs must not depend on a reader-provided Adobe-GB1 font pack");
  assert.match(source, /addText\(commands/);
  assert.doesNotMatch(source, /canvas|JPEG|PNG|drawImage/i,
    "marketing PDFs must remain vector text and lines rather than screenshots");
  assert.match(source, /wx\.openDocument\(\{ filePath, fileType: "pdf", showMenu: true/);
});

test("each marketing export subpackage contains the verified embedded Chinese font below the package limit", () => {
  for (const page of ["inactive-customers", "low-balance-customers", "rating-analysis"]) {
    const pageRoot = path.join(mini, "pages", page);
    const archive = fs.readFileSync(path.join(pageRoot, "NotoSansCJKsc-Common-Identity.br"));
    const font = zlib.brotliDecompressSync(archive);
    assert.equal(crypto.createHash("sha256").update(font).digest("hex"), CJK_FONT_SHA256);
    assert.ok(archive.byteLength < 800_000, `${page} compressed embedded font must remain below 800 KB`);
    const rawPackageBytes = fs.readdirSync(pageRoot).reduce((sum, file) => sum + fs.statSync(path.join(pageRoot, file)).size, 0);
    assert.ok(rawPackageBytes < 2 * 1024 * 1024, `${page} raw subpackage must remain below 2 MB`);
  }
  const project = JSON.parse(fs.readFileSync(path.join(root, "miniprogram-app", "project.config.json"), "utf8"));
  for (const page of ["inactive-customers", "low-balance-customers", "rating-analysis"]) {
    assert.ok(project.packOptions.include.some((rule) => rule.type === "file"
      && rule.value === `pages/${page}/NotoSansCJKsc-Common-Identity.br`),
    `${page} compressed font must be forced into preview and upload packages`);
  }
  const license = read("services", "NotoSansCJKsc-LICENSE.txt");
  assert.match(license, /SIL OPEN FONT LICENSE Version 1\.1/);
  assert.match(license, /modified subset of Noto Sans CJK SC Regular/);
  assert.match(license, /common Simplified Chinese glyphs/);
});

test("PDF export can read the embedded font from the active WeChat subpackage", () => {
  const attempts = [];
  global.getCurrentPages = () => [{ route: "pages/rating-analysis/index" }];
  global.wx = {
    getFileSystemManager() {
      return {
        readCompressedFileSync({ filePath, compressionAlgorithm }) {
          attempts.push(filePath);
          assert.equal(compressionAlgorithm, "br");
          if (filePath.startsWith("/")) throw new Error("absolute package path unavailable");
          return cjkFontBytes;
        }
      };
    }
  };
  try {
    const report = pdfExporter.createGroupedPdf({
      title: "评价分析查询结果",
      criteria: "门店：全部门店",
      rows: [{ storeId: "1", storeName: "中心门店", name: "客户甲" }],
      columns: [{ key: "name", header: "客户", width: 20 }]
    });
    assert.ok(report.bytes.byteLength > cjkFontBytes.byteLength);
    assert.deepEqual(attempts, [
      "/pages/rating-analysis/NotoSansCJKsc-Common-Identity.br",
      "pages/rating-analysis/NotoSansCJKsc-Common-Identity.br"
    ]);
  } finally {
    delete global.wx;
    delete global.getCurrentPages;
  }
});

test("all three marketing pages export complete PDF and Excel reports rather than only visible rows", () => {
  const service = read("services", "grouped-table-export.js");
  assert.match(service, /EXPORT_MAX_ROWS = 1000/);
  assert.match(service, /wx\.getFileSystemManager\(\)\.writeFile/);
  assert.match(service, /wx\.openDocument\(\{ filePath, fileType: "xlsx", showMenu: true/);

  const cases = [
    {
      page: "inactive-customers",
      labels: ["活跃预警查询结果", "预警分类", "客户", "门店", "间隔时间（天）", "计算起点", "上次核销"],
      removed: /生日|上次项目|项目编号/
    },
    {
      page: "low-balance-customers",
      labels: ["余次预警查询结果", "预警分类", "姓名", "项目", "当前剩余", "净开卡", "已核销", "门店"],
      removed: /生日|productCode|项目编号/
    }
  ];
  for (const item of cases) {
    const js = read("pages", item.page, "index.js");
    const wxml = read("pages", item.page, "index.wxml");
    const exportStart = js.indexOf("async collectExportSnapshot(");
    const exportEnd = js.indexOf("openCustomer(event)", exportStart);
    assert.ok(exportStart >= 0 && exportEnd > exportStart, `${item.page} must define bounded complete export handlers`);
    const source = js.slice(exportStart, exportEnd);
    assert.match(source, /basePayload\(EXPORT_BATCH_SIZE\)/);
    assert.match(source, /exportAll: true/,
      "export must request one complete server-side snapshot");
    assert.match(source, /result\.summary\?\.selectedTotal/,
      "export must fail instead of silently returning a mixed snapshot if the result set changes");
    assert.match(source, /rows\.length !== snapshotTotal/,
      "export must prove that every matching row was collected before opening a document");
    assert.match(source, /createGroupedPdf\(reportOptions\)/);
    assert.match(source, /createGroupedWorkbook\(reportOptions\)/);
    assert.match(source, /groupKey: \(row\) => row\.storeId \|\| row\.storeName/);
    assert.match(source, /await openPdf\(\{/);
    assert.match(source, /await openWorkbook\(\{/);
    for (const label of item.labels) assert.match(source, new RegExp(label), `${item.page} export is missing ${label}`);
    assert.doesNotMatch(source, item.removed);
    assert.match(wxml, /bindtap="exportPdf"[\s\S]*导出 PDF/);
    assert.match(wxml, /bindtap="exportExcel"[\s\S]*导出 Excel/);
    assert.match(wxml, /按门店分组/);
    assert.match(wxml, /1000/);
    assert.match(wxml, /disabled="\{\{loading \|\| exporting \|\| total <= 0\}\}"/);
  }

  const ratingJs = read("pages", "rating-analysis", "index.js");
  const ratingWxml = read("pages", "rating-analysis", "index.wxml");
  assert.match(ratingJs, /callRating\("queryRatingAnalysis", \{ \.\.\.this\.payload\(1, EXPORT_BATCH_SIZE\), exportAll: true \}\)/);
  assert.match(ratingJs, /rows\.length !== expectedTotal/);
  assert.match(ratingJs, /createGroupedPdf\(reportOptions\)/);
  assert.match(ratingJs, /createGroupedWorkbook\(reportOptions\)/);
  assert.match(ratingJs, /评价覆盖率：[\s\S]*1–5分分布：/);
  assert.match(ratingWxml, /bindtap="exportPdf"[\s\S]*导出 PDF/);
  assert.match(ratingWxml, /bindtap="exportExcel"[\s\S]*导出 Excel/);
  assert.match(ratingWxml, /1000 单/);
});
