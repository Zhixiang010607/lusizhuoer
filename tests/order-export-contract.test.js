"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const exporterSource = read("order-export.js");
const detailSource = read("business-detail.js");
const rechargeHtml = read("recharge-detail.html");
const verificationHtml = read("verification-detail.html");

function includes(source, expected, label) {
  assert.ok(source.includes(expected), `${label}: missing ${JSON.stringify(expected)}`);
}

const instrumented = exporterSource.replace(
  "window.OrderExporter = Object.freeze({ exportOrder, renderOrderCanvas, safeFilename });",
  "window.OrderExporter = Object.freeze({ exportOrder, renderOrderCanvas, safeFilename, __createPdfBytes: createPdfBytes });"
);
const context = {
  window: {},
  TextEncoder,
  Blob,
  URL,
  Intl,
  Date,
  Uint8Array,
  ArrayBuffer,
  setTimeout
};
vm.createContext(context);
vm.runInContext(instrumented, context, { filename: "order-export.js" });
const exporter = context.window.OrderExporter;
assert.equal(typeof exporter.renderOrderCanvas, "function", "preview renderer is available for browser QA");

assert.equal(exporter.safeFilename("李四+海洋护理+核销"), "李四+海洋护理+核销");
assert.equal(exporter.safeFilename('李四/护理:*?"<>|'), "李四_护理_______");

// A minimal JPEG is sufficient to validate PDF object offsets and binary
// image embedding without involving DOM canvas APIs in this contract test.
const onePixelJpeg = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/Aaf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/Aaf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IV//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z",
  "base64"
);
const pdfBytes = exporter.__createPdfBytes([{ width: 1, height: 1, bytes: new Uint8Array(onePixelJpeg) }]);
const pdfText = Buffer.from(pdfBytes).toString("latin1");
assert.ok(pdfText.startsWith("%PDF-1.4"), "PDF header");
assert.ok(pdfText.includes("/Subtype /Image"), "PDF image object");
assert.ok(pdfText.includes("xref\n0 6"), "PDF xref count");
assert.ok(pdfText.endsWith("%%EOF\n"), "PDF trailer");

const twoPagePdf = Buffer.from(exporter.__createPdfBytes([
  { width: 1, height: 1, bytes: new Uint8Array(onePixelJpeg) },
  { width: 1, height: 1, bytes: new Uint8Array(onePixelJpeg) }
])).toString("latin1");
assert.ok(twoPagePdf.includes("/Count 2"), "PDF page tree count");
assert.ok(twoPagePdf.includes("xref\n0 9"), "multi-page PDF xref count");

for (const html of [rechargeHtml, verificationHtml]) {
  includes(html, 'id="exportOrderPdf"', "PDF export button");
  includes(html, 'id="exportOrderImage"', "image export button");
  assert.ok(html.indexOf("order-export.js?v=0.1.0") < html.indexOf("business-detail.js?v=0.15.22"), "exporter must load before detail controller");
}

includes(detailSource, 'filename: `${customerName}+${projectName}+${recharge ? "充值" : "核销"}`', "required filename contract");
includes(detailSource, 'action: "getVerificationPhotoOriginalUrl"', "existing authorized original-photo action");
includes(detailSource, 'action: "getVerificationPhotoExportData"', "CORS-safe authorized export fallback");
includes(detailSource, 'cache: "force-cache"', "reuse already loaded original-photo response");
includes(detailSource, 'mode: "cors"', "private photo CORS fetch");
includes(detailSource, "Math.min(3, queue.length)", "bounded original-photo concurrency");
includes(detailSource, 'placeholder: "照片暂无法读取"', "failed original placeholder");
includes(detailSource, 'placeholder: listError ? "照片信息暂不可用"', "photo-list failure placeholder");
includes(detailSource, "catch (error)", "per-photo export failure isolation");
assert.ok(!detailSource.includes("if (currentVerificationPhotoPayload?.error) throw currentVerificationPhotoPayload.error"), "photo-list failure must not block order export");
includes(detailSource, 'exportCurrentOrder("pdf")', "PDF button wiring");
includes(detailSource, 'exportCurrentOrder("image")', "image button wiring");
assert.ok(!/html2canvas|jspdf|unpkg|cdnjs/i.test(exporterSource), "export must not load a third-party DOM service");

console.log("order export contract: PASS");
