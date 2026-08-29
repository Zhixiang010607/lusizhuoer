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
  "exportCanvasPagesPdf, downloadBlob, safeFilename, __createPdfBytes: createPdfBytes, __preparePhotos: preparePhotos, __selectReceiptPhotos: selectReceiptPhotos, __layoutDocument: (context, data, photos, options) => layoutDocument(context, data, photos, { image: null }, options), __drawPhotos: drawPhotos\n  });"
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
assert.ok(pdfText.includes("/MediaBox [0 0 595.28 841.89]"), "PDF pages retain exact A4 dimensions");
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
  assert.ok(html.indexOf("order-export.js?v=0.1.12") < html.indexOf("business-detail.js?v=0.16.28"), "exporter must load before detail controller");
}

includes(verificationHtml, 'class="verification-order-keyfacts verification-order-five-keyfacts"', "verification detail uses a five-fact header");
assert.doesNotMatch(verificationHtml, /id="orderInfo"|<h2>核销信息<\/h2>|verificationHqMessage|总部留言/, "verification detail removes the duplicated information section and HQ message");
includes(verificationHtml, '<h2 id="reviewPanelTitle">门店留言</h2>', "verification detail keeps one store message panel");
includes(detailSource, 'keyFacts.push(factCard("提交时间", submittedAt, ""))', "verification detail adds submission time beside the business facts");
includes(detailSource, 'const description = `门店详细地址：${fullStoreAddress(record) || "未填写"}`', "all order types replace the generic subtitle with the full store address");
includes(detailSource, 'subtitle: clean($("orderDescription")?.textContent) || "门店详细地址：未填写"', "verification customer export keeps the store address as its subtitle");
includes(detailSource, 'if (recharge) $("orderInfo").innerHTML', "the shared controller only renders the detail grid for recharge and refund orders");

includes(detailSource, 'filename: `${customerName}+${projectName}+${refund ? "退费" : recharge ? "充值" : "核销"}`', "required filename contract");
includes(detailSource, 'kind: clean($("orderKindTag")?.textContent)', "header order-kind export");
assert.ok(!detailSource.includes('statusLabel: "当前审核状态"'), "customer export does not carry a duplicated approval status card");
includes(detailSource, 'loading="eager" fetchpriority="high"', "all five short-lived thumbnails start loading before their signed addresses expire");
includes(detailSource, 'button.dataset.photoPreviewState === "failed"', "a failed photo card retries only that photo when clicked");
includes(detailSource, 'delete button.dataset.photoRecovery', "a failed retry never leaves the photo permanently locked");
includes(exporterSource, "function selectReceiptPhotos", "receipt renderer owns a defensive core-photo selector");
includes(exporterSource, "const printablePhotoItems = selectReceiptPhotos(documentData, options?.photos || [])", "supplementary photos are removed before decoding");
includes(exporterSource, "preparePhotos(printablePhotoItems)", "only selected core photos reach the decoder");
assert.doesNotMatch(exporterSource, /documentData\.messages|留言与审核记录/, "all exported receipts ignore messages and audit history even when callers pass them");
assert.ok(!detailSource.includes("已用占位信息完成导出"), "known photo failures may not be reported as a successful placeholder export");
includes(detailSource, 'exportCurrentOrder("pdf")', "PDF button wiring");
includes(detailSource, 'exportCurrentOrder("image")', "image button wiring");
includes(detailSource, "compactVerification: !recharge", "verification PDF uses compact one-page layout");
includes(detailSource, "customerFacing: true", "all downloaded orders use the customer-facing PDF mode");
includes(detailSource, "const messages = [];", "all downloaded orders omit internal messages");
includes(detailSource, '[["充值次数", rechargeCountLabel], ["提交时间", submittedAt], ["审核时间", reviewedAt]]', "recharge screen and export keep only count and two timestamps");
includes(detailSource, '[["退费次数", rechargeCountLabel], ["提交时间", submittedAt], ["审核时间", reviewedAt]]', "refund screen and export keep only count and two timestamps");
includes(detailSource, 'const rechargeFacts = ["客户", "项目", "门店", "业务老师"]', "recharge PDF keeps customer and project on the first row, then store and teacher");
includes(detailSource, "facts: rechargeFacts", "all receipts keep the same compact customer, project, store and teacher fact order");
includes(detailSource, "details,", "verification PDF keeps only type, count and submission time in the compact detail grid");
includes(detailSource, "productGifts: recharge ? normalizeProductGifts(record?.productGifts) : []", "only recharge exports may carry a separate product gift section");
includes(detailSource, 'const details = Array.from($("orderInfo")?.children || [])', "verification PDF reuses the visible type, count and submission-time fields without inventing hidden values");
const exportDataSource = detailSource.slice(detailSource.indexOf("function exportDocumentData"), detailSource.indexOf("async function fetchVerificationPhotoUrlBlob"));
assert.ok(!/verification(Store|Hq)Message|recharge(Store|Hq)Message/.test(exportDataSource), "customer PDFs never read any internal message");
const exportCurrentOrderSource = detailSource.slice(detailSource.indexOf("async function exportCurrentOrder"), detailSource.indexOf("function isVoidableOriginalType"));
includes(exportCurrentOrderSource, "productTemplateLoadPromise = loadProductReceiptTemplate(currentRecord, { forceLogoRefresh: true })", "every export forces a live logo read for its own product");
includes(exportCurrentOrderSource, "photos: []", "all exported receipts omit photos");
for (const removedCopy of ["由总部维护的当前产品单据说明", "导出时间：", "系统工单导出", "露思卓儿客户业务凭证"]) {
  assert.ok(!exporterSource.includes(removedCopy), `customer receipt removes internal/footer copy: ${removedCopy}`);
}
assert.ok(!/html2canvas|jspdf|unpkg|cdnjs/i.test(exporterSource), "export must not load a third-party DOM service");

const headerTexts = [];
const headerRects = [];
const fontDraws = [];
let photoDrawCount = 0;
const headerContext = {
  canvas: { width: 1240, height: 1200 },
  fillStyle: "", strokeStyle: "", lineWidth: 1, globalAlpha: 1, font: "", textBaseline: "top", textAlign: "left",
  beginPath() {}, moveTo() {}, arcTo() {}, closePath() {}, fill() {}, stroke() {},
  fillRect(...args) { headerRects.push(args); },
  drawImage() { photoDrawCount += 1; },
  save() {}, restore() {}, clip() {},
  measureText(value) { return { width: String(value).length * 20 }; },
  fillText(value) {
    const rendered = String(value);
    headerTexts.push(rendered);
    fontDraws.push({ text: rendered, font: String(this.font) });
  }
};
function fontFor(draws, value) {
  const match = draws.find((entry) => entry.text === value);
  assert.ok(match, `missing rendered text for font assertion: ${value}`);
  return match.font;
}
const documentHeaderFontStart = fontDraws.length;
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
const documentHeaderFonts = fontDraws.slice(documentHeaderFontStart);
assert.match(fontFor(documentHeaderFonts, "补录核销"), /\b22px\b/, "order kind uses the enlarged font");
assert.match(fontFor(documentHeaderFonts, "核销单 VX202608180001"), /\b52px\b/, "order title uses the enlarged font");
assert.match(fontFor(documentHeaderFonts, "数据库工单完整导出"), /\b22px\b/, "order subtitle uses the enlarged font");

const compactDocument = {
  compactVerification: true,
  kind: "体验核销",
  title: "核销单 VX202608190024",
  subtitle: "提交时间：2026-08-19 09:11:57",
  facts: [
    { label: "客户", value: "李四" },
    { label: "项目", value: "魔法柔肤" },
    { label: "门店", value: "测试门店" },
    { label: "业务老师", value: "李道良" }
  ],
  details: [
    { label: "工单类型", value: "体验核销" },
    { label: "次数", value: "1 次" },
    { label: "提交时间", value: "2026-08-19 09:11:57", span: 2 }
  ],
  messages: [{ label: "绝不打印的门店留言", value: "绝不打印的审核内容", time: "2026-08-19 09:11:57" }]
};
const compactPhotos = [
  { slot: 4, label: "补充照片 3", meta: "不打印", image: { width: 100, height: 80 } },
  { slot: 1, label: "核销现场照", meta: "核心照片", image: { width: 100, height: 80 } },
  { slot: 0, label: "客户留存照", meta: "核心照片", image: { width: 100, height: 80 } },
  { slot: 2, label: "补充照片 1", meta: "不打印", image: { width: 100, height: 80 } },
  { slot: 3, label: "补充照片 2", meta: "不打印", image: { width: 100, height: 80 } }
];
assert.equal(
  Array.from(exporter.__selectReceiptPhotos(compactDocument, compactPhotos), (photo) => photo.label).join("|"),
  "",
  "slot-based verification exports omit every photo"
);
assert.equal(
  Array.from(exporter.__selectReceiptPhotos(compactDocument, [
    { label: "样例客户留存照" }, { label: "样例核销现场照" }, { label: "样例补充照片" }
  ]), (photo) => photo.label).join("|"),
  "",
  "product samples without explicit slots omit every photo"
);
const compactHeight = exporter.__layoutDocument(headerContext, compactDocument, compactPhotos, { draw: false, paginate: true });
assert.ok(compactHeight <= 1754, `no-photo verification PDF fits one A4 page, got ${compactHeight}px`);
const compactTextStart = headerTexts.length;
const compactFontStart = fontDraws.length;
const compactPhotoDrawStart = photoDrawCount;
exporter.__layoutDocument(headerContext, compactDocument, compactPhotos, { draw: true, paginate: true });
const compactTexts = headerTexts.slice(compactTextStart);
const compactFonts = fontDraws.slice(compactFontStart);
assert.equal(photoDrawCount - compactPhotoDrawStart, 0, "compact verification draws no photos");
assert.ok(compactTexts.includes("次数"), "compact verification PDF keeps the selected unit count");
assert.ok(!compactTexts.includes("不应重复"), "compact verification PDF does not repeat the order number");
for (const removed of ["绝不打印的门店留言", "绝不打印的审核内容", "留言与审核记录", "补充照片 1", "补充照片 2", "补充照片 3"]) {
  assert.ok(!compactTexts.includes(removed), `compact verification omits internal/supplementary content: ${removed}`);
}
for (const removed of ["客户核销照片", "仅保留核销时使用的身份照片", "核销现场照"]) {
  assert.ok(!compactTexts.includes(removed), `compact verification omits photo copy: ${removed}`);
}
assert.match(fontFor(compactFonts, "门店"), /\b20px\b/, "fact labels use the enlarged font");
assert.match(fontFor(compactFonts, "测试门店"), /\b25px\b/, "fact values use the enlarged font");

const rechargeMessageStart = headerTexts.length;
exporter.__layoutDocument(headerContext, {
  kind: "充值申请",
  title: "充值单 RC-NO-MESSAGES",
  subtitle: "测试",
  facts: [], details: [],
  messages: [{ label: "总部审核记录", value: "这一段内部审核内容不允许打印" }]
}, [], { draw: true, paginate: false });
const rechargeMessageTexts = headerTexts.slice(rechargeMessageStart);
for (const removed of ["留言与审核记录", "总部审核记录", "这一段内部审核内容不允许打印"]) {
  assert.ok(!rechargeMessageTexts.includes(removed), `recharge/refund receipts omit ${removed}`);
}

const multilineInstructionStart = headerTexts.length;
const multilineInstructionFontStart = fontDraws.length;
exporter.__layoutDocument(headerContext, {
  kind: "充值",
  title: "充值单 RC202608200001",
  subtitle: "门店详细地址：测试地址",
  facts: [], details: [], messages: [],
  productTemplate: { instructions: "5、疗程后保持清洁。\n7、疗程后坚持护理。\n7、三个月内注意饮食。" }
}, [], { draw: true, paginate: false });
const multilineInstructionTexts = headerTexts.slice(multilineInstructionStart);
const multilineInstructionFonts = fontDraws.slice(multilineInstructionFontStart);
assert.ok(multilineInstructionTexts.includes("产品说明"), "product instructions keep the customer-facing section title");
for (const line of ["5、疗程后保持清洁。", "7、疗程后坚持护理。", "7、三个月内注意饮食。"]) {
  assert.ok(multilineInstructionTexts.includes(line), `product instructions preserve manual line break: ${line}`);
}
assert.match(fontFor(multilineInstructionFonts, "产品说明"), /\b34px\b/, "product instruction heading uses the enlarged font");
assert.match(fontFor(multilineInstructionFonts, "说明"), /\b25px\b/, "product instruction label uses the enlarged font");
assert.match(fontFor(multilineInstructionFonts, "5、疗程后保持清洁。"), /\b24px\b/, "product instruction body uses the enlarged font");

const longInstructions = Array.from(
  { length: 90 },
  (_, index) => `${index + 1}、疗程说明必须完整保留，并在跨页时继续排版。`
).join("\n");
const longInstructionStart = headerTexts.length;
const longInstructionHeight = exporter.__layoutDocument(headerContext, {
  kind: "充值",
  title: "充值单 RC-LONG-INSTRUCTIONS",
  subtitle: "门店详细地址：测试地址",
  facts: [], details: [], messages: [],
  productTemplate: { instructions: longInstructions }
}, [], { draw: true, paginate: true });
const longInstructionTexts = headerTexts.slice(longInstructionStart);
assert.ok(longInstructionHeight > 1754, "long product instructions span more than one A4 canvas page");
assert.ok(longInstructionTexts.includes("说明（续）"), "continued product instructions are explicitly labelled on later pages");
assert.ok(longInstructionTexts.includes("90、疗程说明必须完整保留，并在跨页时继续排版。"), "the final instruction remains in the rendered receipt");

const noGiftStart = headerTexts.length;
exporter.__layoutDocument(headerContext, {
  kind: "充值申请", title: "充值单 RC-NO-GIFT", subtitle: "测试",
  facts: [], details: [
    { label: "充值次数", value: "10 次" },
    { label: "提交时间", value: "2026-08-26 22:46" },
    { label: "审核时间", value: "—" }
  ], productGifts: [], messages: []
}, [], { draw: true, paginate: false });
assert.ok(!headerTexts.slice(noGiftStart).includes("赠予产品"), "giftless recharge exports omit the whole gift section");

const giftStart = headerTexts.length;
exporter.__layoutDocument(headerContext, {
  kind: "充值申请", title: "充值单 RC-WITH-GIFT", subtitle: "测试",
  facts: [], details: [
    { label: "充值次数", value: "10 次" },
    { label: "提交时间", value: "2026-08-26 22:46" },
    { label: "审核时间", value: "2026-08-26 22:50" }
  ], productGifts: [{ productName: "面霜", productCode: "PDT001", unitCount: 2 }], messages: []
}, [], { draw: true, paginate: false });
const giftTexts = headerTexts.slice(giftStart);
for (const expected of ["赠予产品", "面霜", "2 件"]) {
  assert.ok(giftTexts.includes(expected), `separate gift section includes ${expected}`);
}
assert.ok(!giftTexts.includes("PDT001"), "printed recharge receipts omit gift product numbers");

(async () => {
  const fivePhotos = Array.from({ length: 5 }, (_, slot) => ({
    slot,
    label: `照片 ${slot + 1}`,
    required: true,
    blob: new Blob([slot === 1 ? onePixelJpeg : Buffer.from("archive and supplement must never decode")], { type: "image/jpeg" })
  }));
  const selectedPhotos = exporter.__selectReceiptPhotos({ compactVerification: true }, fivePhotos);
  const prepared = await exporter.__preparePhotos(selectedPhotos);
  assert.equal(prepared.length, 0, "verification export prepares no photos");
  assert.equal(decodedImages.length, 0, "verification photo blobs never reach the decoder");
  const preparedDrawStart = photoDrawCount;
  exporter.__drawPhotos(headerContext, prepared, 0, true, false);
  assert.equal(photoDrawCount - preparedDrawStart, 0, "verification export draws no photo");

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
