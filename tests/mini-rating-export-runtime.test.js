"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const zlib = require("node:zlib");
const mini = path.resolve(__dirname, "../miniprogram-app/miniprogram");
const excel = require(path.join(mini, "services/grouped-table-export.js"));
const pdfModule = { exports: {} };
const miniRequire = Object.assign(() => {}, { async: async id => { assert.equal(id, "../packages/report-font/ready.js"); return true; } });
vm.runInNewContext(fs.readFileSync(path.join(mini, "services/grouped-table-pdf.js"), "utf8"), {
  module: pdfModule, require: miniRequire, Uint8Array, ArrayBuffer, get wx() { return global.wx; }
});
const pdf = pdfModule.exports;
const font = zlib.brotliDecompressSync(fs.readFileSync(path.join(mini, "packages/report-font/NotoSansCJKsc-Common-Identity.br")));
function device({ writeError, openError } = {}) {
  const writes = [], opens = [];
  return { writes, opens, wx: {
    env: { USER_DATA_PATH: "/isolated-test" },
    getFileSystemManager: () => ({
      readCompressedFileSync: () => { const foreign = vm.runInNewContext(`new ArrayBuffer(${font.length})`); new Uint8Array(foreign).set(font); return foreign; },
      writeFile(options) {
        // Real WeChat accepts string or ArrayBuffer, not a typed-array view.
        if (!(options.data instanceof ArrayBuffer)) throw Error("writeFile:fail parameter.data should be String/ArrayBuffer instead of Uint8Array");
        writes.push({ path: options.filePath, bytes: new Uint8Array(options.data) });
        if (writeError) options.fail(writeError); else options.success({});
      }
    }),
    openDocument(options) { opens.push(options); if (openError) options.fail(openError); else options.success({}); }
  } };
}
function page(api) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(mini, "pages/rating-analysis/rating-page.js"), "utf8"), {
    module,
    require(id) {
      if (id.endsWith("/api")) return api;
      if (id.endsWith("/session")) return { requireSession: () => ({ role: "hq" }), readSession: () => ({ uid: "synthetic-hq" }) };
      if (id.endsWith("/teacher-team")) return {};
      if (id.endsWith("/grouped-table-pdf")) return pdf;
      return require(path.join(mini, "services", path.basename(id)));
    }, wx: global.wx
  });
  const definition = module.exports.createRatingPage();
  return { ...definition, data: JSON.parse(JSON.stringify(definition.data)), setData(patch, done) { Object.assign(this.data, patch); done?.(); } };
}
function orders(count = 21) {
  return Array.from({ length: count }, (_, i) => ({ id: String(i + 1), recordCode: `VX-TEST-${i + 1}`, customerCode: `TEST-${i + 1}`, customerName: `合成客户${i + 1}`, storeId: String(i % 2 + 1), storeName: `合成门店${i % 2 + 1}`, productName: "合成项目", teacherName: "合成老师", verificationType: "NORMAL", effectiveScore: 4, storeEnvironmentScore: 5, teacherServiceScore: 4, overallExperienceScore: 5, serviceTime: "2026-11-08 10:30" }));
}
test("both document openers send an exact ArrayBuffer slice to WeChat, without backing-buffer padding", async () => {
  const h = device(); global.wx = h.wx;
  try {
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9]);
    const bytes = backing.subarray(2, 5);
    await excel.openWorkbook({ bytes, filename: "边界测试" });
    await pdf.openPdf({ bytes, filename: "边界测试" });
    assert.equal(h.writes.length, 2);
    for (const write of h.writes) assert.deepEqual([...write.bytes], [1, 2, 3]);
    assert.deepEqual(h.opens.map(o => o.fileType), ["xlsx", "pdf"]);
    assert(h.opens.every(o => o.showMenu === true));
  } finally { delete global.wx; }
});
test("rating page exports the complete snapshot through real XLSX/PDF generation, storage, and opening", async () => {
  const h = device(); global.wx = h.wx;
  try {
    const rows = orders(), calls = [];
    const p = page({ callRating: async (action, payload) => { calls.push({ action, payload }); return { orders: rows, total: rows.length }; } });
    p.data.session = { role: "hq" }; p.data.selectedScores = [4]; p.data.searched = true; p.data.total = rows.length;
    await p.exportExcel();
    assert.equal(p.data.error, false, p.data.message);
    assert.match(p.data.message, /已导出 21 单的 Excel/);
    await p.exportPdf();
    assert.equal(p.data.error, false, p.data.message);
    assert.match(p.data.message, /已导出 21 单的 PDF/);
    assert.equal(h.writes.length, 2); assert.equal(h.opens.length, 2);
    assert.equal(Buffer.from(h.writes[0].bytes.slice(0, 2)).toString(), "PK");
    assert.equal(Buffer.from(h.writes[1].bytes.slice(0, 8)).toString(), "%PDF-1.4");
    assert(calls.every(c => c.action === "queryRatingAnalysis" && c.payload.exportAll === true));
    assert(calls.every(c => String(c.payload.scores) === "4"));
    assert.equal(p.data.exporting, false);
  } finally { delete global.wx; }
});
test("write or viewer failures remain failures and never open an unwritten document", async () => {
  const error = { errMsg: "writeFile:fail no space" }, h = device({ writeError: error }); global.wx = h.wx;
  try { await assert.rejects(excel.openWorkbook({ bytes: new Uint8Array([1]), filename: "测试" }), e => e === error); assert.equal(h.opens.length, 0); }
  finally { delete global.wx; }
  const viewerError = { errMsg: "openDocument:fail" }, v = device({ openError: viewerError }); global.wx = v.wx;
  try { await assert.rejects(pdf.openPdf({ bytes: new Uint8Array([1]), filename: "测试" }), e => e === viewerError); assert.equal(v.writes.length, 1); }
  finally { delete global.wx; }
});
test("group leaders cannot enter the export pipeline", async () => {
  const h = device(); global.wx = h.wx; let reads = 0;
  try { const p = page({ callRating: async () => { reads++; return {}; } }); p.data.teamScope = true; p.data.searched = true; p.data.total = 21; await p.exportExcel(); await p.exportPdf(); assert.equal(reads, 0); assert.equal(h.writes.length, 0); }
  finally { delete global.wx; }
});
