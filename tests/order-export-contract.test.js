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
  "exportCanvasPagesPdf, downloadBlob, safeFilename\n  });",
  "exportCanvasPagesPdf, downloadBlob, safeFilename, __createPdfBytes: createPdfBytes, __preparePhotos: preparePhotos, __layoutDocument: (context, data, photos, options) => layoutDocument(context, data, photos, { image: null }, options), __drawPhotos: drawPhotos\n  });"
);
const decodedImages = [];
const context = {
  window: {},
  TextEncoder,
  Blob,
  URL,
  Intl,
  Date,
  Uint8Array,
  ArrayBuffer,
  setTimeout,
  document: {
    createElement(tag) {
      assert.equal(tag, "canvas");
      return { width: 0, height: 0, getContext: () => ({ drawImage() {} }) };
    }
  },
  createImageBitmap: async () => {
    const image = { width: 100, height: 80, close() {} };
    decodedImages.push(image);
    return image;
  }
};
vm.createContext(context);
vm.runInContext(instrumented, context, { filename: "order-export.js" });
const exporter = context.window.OrderExporter;
assert.equal(typeof exporter.renderOrderCanvas, "function", "preview renderer is available for browser QA");
assert.equal(typeof exporter.exportCanvasPagesPdf, "function", "multi-page table export renderer is available");

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
  assert.ok(html.indexOf("order-export.js?v=0.1.6") < html.indexOf("business-detail.js?v=0.16.21"), "exporter must load before detail controller");
}

includes(verificationHtml, 'class="verification-order-keyfacts verification-order-five-keyfacts"', "verification detail uses a five-fact header");
assert.doesNotMatch(verificationHtml, /id="orderInfo"|<h2>核销信息<\/h2>|verificationHqMessage|总部留言/, "verification detail removes the duplicated information section and HQ message");
includes(verificationHtml, '<h2 id="reviewPanelTitle">门店留言</h2>', "verification detail keeps one store message panel");
includes(detailSource, 'keyFacts.push(factCard("提交时间", submittedAt, ""))', "verification detail adds submission time beside the business facts");
includes(detailSource, 'const description = `门店详细地址：${fullStoreAddress(record) || "未填写"}`', "all order types replace the generic subtitle with the full store address");
includes(detailSource, '`${clean($("orderDescription")?.textContent) || "门店详细地址：未填写"} · 提交时间：${submittedAt}`', "verification customer export includes both store address and submission time");
includes(detailSource, 'if (recharge) $("orderInfo").innerHTML', "the shared controller only renders the detail grid for recharge and refund orders");

includes(detailSource, 'filename: `${customerName}+${projectName}+${refund ? "退费" : recharge ? "充值" : "核销"}`', "required filename contract");
includes(detailSource, 'kind: clean($("orderKindTag")?.textContent)', "header order-kind export");
assert.ok(!detailSource.includes('statusLabel: "当前审核状态"'), "customer export does not carry a duplicated approval status card");
includes(detailSource, 'action: "getVerificationPhotoOriginalUrl"', "existing authorized original-photo action");
includes(detailSource, 'action: "getVerificationPhotoExportData"', "CORS-safe authorized export fallback");
includes(detailSource, 'cache: "no-store"', "private signed original is not persisted in the browser HTTP cache");
includes(detailSource, 'mode: "cors"', "private photo CORS fetch");
includes(detailSource, "Math.min(2, queue.length)", "bounded original-photo concurrency");
includes(detailSource, "fetchVerificationPhotoForExport(recordId, photo", "each export photo owns an isolated retry and fallback path");
includes(detailSource, "fetchVerificationPhotoThumbnailFallback(recordId, slot)", "export falls back to the authenticated thumbnail when the original address is unavailable");
includes(detailSource, "核销照片成功读取 ${succeeded} / ${queue.length}", "export progress counts successful photo reads rather than merely completed attempts");
includes(detailSource, "已自动使用安全缩略图完成导出", "successful thumbnail fallback remains visible to the operator");
includes(detailSource, "核销照片清单暂时无法确认，本次没有生成文件", "photo-list failure blocks incomplete export");
includes(detailSource, "if (failures.length)", "known-photo fetch failure blocks incomplete export");
includes(detailSource, "loadedCount !== requiredCount", "known-photo download completeness assertion");
includes(detailSource, 'loading="eager" fetchpriority="high"', "all five short-lived thumbnails start loading before their signed addresses expire");
includes(detailSource, 'button.dataset.photoPreviewState === "failed"', "a failed photo card retries only that photo when clicked");
includes(detailSource, 'delete button.dataset.photoRecovery', "a failed retry never leaves the photo permanently locked");
includes(exporterSource, "if (item.required && !image)", "known-photo decode completeness assertion");
includes(exporterSource, "catch (_) { image = null; }", "imageBitmap decode fallback");
assert.ok(!detailSource.includes("已用占位信息完成导出"), "known photo failures may not be reported as a successful placeholder export");
includes(detailSource, 'exportCurrentOrder("pdf")', "PDF button wiring");
includes(detailSource, 'exportCurrentOrder("image")', "image button wiring");
includes(detailSource, "compactVerification: !recharge", "verification PDF uses compact one-page layout");
includes(detailSource, "customerFacing: true", "all downloaded orders use the customer-facing PDF mode");
includes(detailSource, "const messages = [];", "all downloaded orders omit internal messages");
includes(detailSource, '[["充值次数", rechargeCountLabel], ["提交时间", submittedAt], ["审核时间", reviewedAt]]', "recharge screen and export keep only count and two timestamps");
includes(detailSource, '[["退费次数", rechargeCountLabel], ["提交时间", submittedAt], ["审核时间", reviewedAt]]', "refund screen and export keep only count and two timestamps");
includes(detailSource, "facts: recharge ? facts : verificationFacts", "verification PDF keeps only the customer-facing business facts including address");
includes(detailSource, "details: recharge ? details : []", "verification PDF removes repeated detail grid and unit count");
includes(detailSource, "· 提交时间：${submittedAt}`", "verification PDF keeps submission time after the store address");
includes(detailSource, 'facts.find((item) => item.label === "提交时间")?.value', "verification PDF reads submission time from the compact screen header");
const exportDataSource = detailSource.slice(detailSource.indexOf("function exportDocumentData"), detailSource.indexOf("async function fetchVerificationPhotoUrlBlob"));
assert.ok(!/verification(Store|Hq)Message|recharge(Store|Hq)Message/.test(exportDataSource), "customer PDFs never read any internal message");
const exportCurrentOrderSource = detailSource.slice(detailSource.indexOf("async function exportCurrentOrder"), detailSource.indexOf("function isVoidableOriginalType"));
includes(exportCurrentOrderSource, 'type === "verification" ? await verificationExportPhotos(currentRecord) : { photos: [], warning: "" }', "verification exports keep photos while recharge and refund exports use an empty photo list");
includes(exportCurrentOrderSource, "productTemplateLoadPromise = loadProductReceiptTemplate(currentRecord, { forceLogoRefresh: true })", "every export forces a live logo read for its own product");
includes(exportCurrentOrderSource, "photos: photoResult.photos", "verification photos are passed to the exporter");
for (const removedCopy of ["由总部维护的当前产品单据说明", "导出时间：", "系统工单导出", "露思卓儿客户业务凭证"]) {
  assert.ok(!exporterSource.includes(removedCopy), `customer receipt removes internal/footer copy: ${removedCopy}`);
}
assert.ok(!/html2canvas|jspdf|unpkg|cdnjs/i.test(exporterSource), "export must not load a third-party DOM service");

const headerTexts = [];
const headerRects = [];
let photoDrawCount = 0;
const headerContext = {
  canvas: { width: 1240, height: 1200 },
  fillStyle: "", strokeStyle: "", lineWidth: 1, globalAlpha: 1, font: "", textBaseline: "top", textAlign: "left",
  beginPath() {}, moveTo() {}, arcTo() {}, closePath() {}, fill() {}, stroke() {},
  fillRect(...args) { headerRects.push(args); },
  drawImage() { photoDrawCount += 1; },
  save() {}, restore() {}, clip() {},
  measureText(value) { return { width: String(value).length * 20 }; },
  fillText(value) { headerTexts.push(String(value)); }
};
exporter.__layoutDocument(headerContext, {
  kind: "补录核销",
  title: "核销单 VX202608180001",
  subtitle: "数据库工单完整导出",
  facts: [], details: [], messages: []
}, [], { draw: true, paginate: false });
for (const expected of ["补录核销", "核销单 VX202608180001", "数据库工单完整导出", "LOGO"]) {
  assert.ok(headerTexts.includes(expected), `JPG/PDF header includes ${expected}`);
}
for (const removed of ["当前审核状态", "已通过", "审核已完成"]) assert.ok(!headerTexts.includes(removed), `JPG/PDF header removes ${removed}`);
assert.ok(headerRects.some(([x, y, width, height]) => x === 0 && y === 0 && width === 1240 && height === 18), "export keeps the top accent stripe");

const compactDocument = {
  compactVerification: true,
  kind: "体验核销",
  title: "核销单 VX202608190024",
  subtitle: "提交时间：2026-08-19 09:11:57",
  facts: [
    { label: "门店", value: "测试门店" },
    { label: "客户", value: "李四" },
    { label: "项目", value: "魔法柔肤" },
    { label: "业务老师", value: "李道良" }
  ],
  details: [{ label: "核销次数", value: "1" }, { label: "核销单编号", value: "不应重复" }],
  messages: [{ label: "门店留言", value: "无", time: "2026-08-19 09:11:57" }]
};
const compactPhotos = Array.from({ length: 5 }, (_, index) => ({ label: `照片 ${index + 1}`, meta: "已留存" }));
const compactHeight = exporter.__layoutDocument(headerContext, compactDocument, compactPhotos, { draw: false, paginate: true });
assert.ok(compactHeight < 1754, `five-photo verification PDF fits one A4 page, got ${compactHeight}px`);
const compactTextStart = headerTexts.length;
exporter.__layoutDocument(headerContext, compactDocument, compactPhotos, { draw: true, paginate: true });
const compactTexts = headerTexts.slice(compactTextStart);
assert.ok(!compactTexts.includes("核销次数"), "compact verification PDF does not repeat the fixed one-unit count");
assert.ok(!compactTexts.includes("不应重复"), "compact verification PDF does not repeat the order number");

const multilineInstructionStart = headerTexts.length;
exporter.__layoutDocument(headerContext, {
  kind: "充值",
  title: "充值单 RC202608200001",
  subtitle: "门店详细地址：测试地址",
  facts: [], details: [], messages: [],
  productTemplate: { instructions: "5、疗程后保持清洁。\n7、疗程后坚持护理。\n7、三个月内注意饮食。" }
}, [], { draw: true, paginate: false });
const multilineInstructionTexts = headerTexts.slice(multilineInstructionStart);
assert.ok(multilineInstructionTexts.includes("产品说明"), "product instructions keep the customer-facing section title");
for (const line of ["5、疗程后保持清洁。", "7、疗程后坚持护理。", "7、三个月内注意饮食。"]) {
  assert.ok(multilineInstructionTexts.includes(line), `product instructions preserve manual line break: ${line}`);
}

(async () => {
  const fivePhotos = Array.from({ length: 5 }, (_, slot) => ({
    slot,
    label: `照片 ${slot + 1}`,
    required: true,
    blob: new Blob([onePixelJpeg], { type: "image/jpeg" })
  }));
  const prepared = await exporter.__preparePhotos(fivePhotos);
  assert.equal(prepared.filter((item) => item.required && item.image).length, 5, "all five existing photos decode before export");
  assert.equal(decodedImages.length, 5, "five photo blobs were decoded");
  exporter.__drawPhotos(headerContext, prepared, 0, true, false);
  assert.equal(photoDrawCount, 5, "all five decoded photos are actually drawn into the export canvas");

  context.createImageBitmap = async () => { throw new Error("imageOrientation option unsupported"); };
  context.Image = class FallbackImage {
    constructor() {
      this.width = 90;
      this.height = 70;
      this.listeners = {};
    }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    set src(_value) { queueMicrotask(() => this.listeners.load?.()); }
  };
  const fallbackPrepared = await exporter.__preparePhotos([{
    slot: 0,
    label: "客户原始留存照",
    required: true,
    blob: new Blob([onePixelJpeg], { type: "image/jpeg" })
  }]);
  assert.ok(fallbackPrepared[0].image, "Image fallback succeeds when createImageBitmap is unavailable or incompatible");

  context.Image = class InvalidImage {
    constructor() { this.listeners = {}; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    set src(_value) { queueMicrotask(() => this.listeners.error?.()); }
  };
  await assert.rejects(
    exporter.__preparePhotos([{ slot: 1, label: "本次核销人脸照", required: true, blob: new Blob(["invalid"], { type: "image/jpeg" }) }]),
    /本次核销人脸照解码失败.*没有生成文件/,
    "a corrupt known photo blocks the download instead of becoming a placeholder"
  );
  await assert.rejects(
    exporter.__preparePhotos([{ slot: 0, label: "客户原始留存照", required: true, blob: null }]),
    /尚未完整载入.*没有生成文件/,
    "known existing photo may not silently become a placeholder"
  );
  const placeholders = await exporter.__preparePhotos([{ slot: 2, label: "补充照片 1", required: false, blob: null, placeholder: "尚未上传" }]);
  assert.equal(placeholders[0].image, null, "authoritatively empty slot remains an allowed placeholder");
  console.log("order export contract: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
