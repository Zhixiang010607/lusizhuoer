"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const mini = path.join(root, "miniprogram-app", "miniprogram");
const pageJs = fs.readFileSync(path.join(mini, "pages", "product-detail", "index.js"), "utf8");
const pageWxml = fs.readFileSync(path.join(mini, "pages", "product-detail", "index.wxml"), "utf8");
const pageWxss = fs.readFileSync(path.join(mini, "pages", "product-detail", "index.wxss"), "utf8");
const rendererSource = fs.readFileSync(path.join(mini, "services", "order-receipt.js"), "utf8");
const webProject = fs.readFileSync(path.join(root, "project-detail.js"), "utf8");
const webExporter = fs.readFileSync(path.join(root, "order-export.js"), "utf8");
const renderer = require(path.join(mini, "services", "order-receipt.js"));

test("product sample facts match the web mobile preview for verification and recharge", () => {
  const shared = {
    template: { productName: "海洋之蕴", productType: "护理" },
    verificationInstructions: "核销说明",
    rechargeInstructions: "充值说明",
    logoRequired: true
  };
  const verification = renderer.createProductSampleDocument({ ...shared, kind: "verification-pdf" });
  const recharge = renderer.createProductSampleDocument({ ...shared, kind: "recharge-image" });

  assert.equal(verification.kind, "正常核销 / 体验核销");
  assert.equal(verification.title, "核销单 SAMPLE001");
  assert.equal(verification.compactVerification, true);
  assert.deepEqual(verification.facts.map((item) => item.label), ["客户", "门店", "项目", "业务老师", "提交时间"]);
  assert.deepEqual(verification.facts[0], {
    label: "客户", value: "示例客户 · C1-SAMPLE001", singleLine: true, span: 2
  }, "product samples print the customer name and number together on one line");
  assert.deepEqual(verification.details, []);
  assert.equal(verification.productTemplate.instructions, "核销说明");

  assert.equal(recharge.kind, "充值 / 退费");
  assert.equal(recharge.title, "充值单 SAMPLE001");
  assert.equal(recharge.compactVerification, false);
  assert.deepEqual(recharge.facts.map((item) => item.label), ["客户", "项目", "门店", "业务老师"]);
  assert.deepEqual(recharge.facts[0], {
    label: "客户", value: "示例客户 · C1-SAMPLE001", singleLine: true
  }, "recharge samples place the complete customer identity beside the project");
  assert.deepEqual(recharge.facts[1], {
    label: "项目", value: "海洋之蕴", singleLine: true
  });
  assert.deepEqual(recharge.details, [
    { label: "充值次数", value: "10 次" },
    { label: "提交时间", value: "2026-08-19 12:34:56" },
    { label: "审核时间", value: "2026-08-19 12:36:10" }
  ]);
  assert.equal(recharge.productTemplate.instructions, "充值说明");

  assert.deepEqual(renderer.createProductSamplePhotos("verification-image"), [
    { slot: 1, label: "客户核销照片", required: false, placeholder: "照片区域", meta: "样例照片位" }
  ]);
  assert.deepEqual(renderer.createProductSamplePhotos("recharge-pdf"), []);

  for (const phrase of [
    "正常核销 / 体验核销", "充值 / 退费", "门店详细地址：示例省示例市示例区示例路 1 号",
    "充值次数与办理时间"
  ]) {
    assert.ok(webProject.includes(phrase) || webExporter.includes(phrase), `web reference is missing ${phrase}`);
    assert.ok(rendererSource.includes(phrase), `mini renderer is missing ${phrase}`);
  }
  assert.ok(rendererSource.includes("仅保留核销时使用的身份照片"));
  assert.doesNotMatch(rendererSource, /留言与审核记录|补充照片|本次核销人脸照/,
    "generated receipts must not contain message sections or supplemental-photo wording");
});

test("native receipt renderer preserves the web A4 and long-image geometry", async () => {
  assert.equal(renderer.CANVAS_WIDTH, 1240);
  assert.equal(renderer.PDF_PAGE_HEIGHT, 1754);
  assert.equal(renderer.PDF_PAGE_WIDTH, 595.28);
  assert.equal(renderer.PDF_PAGE_POINTS_HEIGHT, 841.89);
  assert.equal(renderer.OUTPUT_SCALE, 2);
  assert.equal(renderer.OUTPUT_WIDTH, 2480);
  assert.equal(renderer.OUTPUT_PAGE_HEIGHT, 3508);
  assert.equal(renderer.RECEIPT_BACKGROUND_SOURCE, "/images/receipt/lusizhuoer-receipt-bg-v1.jpg");
  const receiptBackground = path.join(mini, renderer.RECEIPT_BACKGROUND_SOURCE.replace(/^\//, ""));
  assert.ok(fs.existsSync(receiptBackground), "generated Lusizhuoer receipt background is missing");
  assert.ok(fs.statSync(receiptBackground).size < 180 * 1024,
    "receipt background must stay compact enough for the mini-program main package");
  for (const contract of [
    "const CANVAS_WIDTH = 1240", "const PDF_PAGE_HEIGHT = 1754", "const PAGE_MARGIN = 64",
    "const OUTPUT_SCALE = 2", "const OUTPUT_WIDTH = CANVAS_WIDTH * OUTPUT_SCALE",
    "const OUTPUT_PAGE_HEIGHT = PDF_PAGE_HEIGHT * OUTPUT_SCALE", "drawPreparedReceipt",
    "{ imageHeight: 280, cardHeight: 370 }",
    'background: "#fffaf3"', 'border: "#dfcfb4"', 'title: "#302a22"',
    'accent: "#80622f"', "drawReceiptBackground", "prepareReceiptBackground",
    "singleLine", "fittedSize", "context.fillText(value, x + 18, y + 50, maxWidth)",
    "title: 52", "subtitle: 22", "factLabel: 20", "factValue: 25", "sectionTitle: 34",
    "photoLabel: 24", "instructionBody: 24", "pageNumber: 18", "drawInstructionText"
  ]) {
    assert.ok(rendererSource.includes(contract), `mini renderer is missing ${contract}`);
  }
  assert.match(webExporter, /const CANVAS_WIDTH = 1240/);
  assert.match(webExporter, /const PDF_PAGE_HEIGHT = 1754/);
  assert.match(rendererSource, /if \(!instructions\) return y;/, "empty instructions must omit the whole section");
  assert.doesNotMatch(rendererSource, /"#10233f"|"#edf4ff"|"#d9e2ee"/,
    "the retired blue receipt palette must not return");

  const canvas = { width: 0, height: 0 };
  let backgroundDrawCount = 0;
  const customerIdentityDraws = [];
  const paintedTexts = [];
  const context = {
    canvas,
    measureText(value) { return { width: Array.from(String(value)).length * 18 }; },
    beginPath() {}, moveTo() {}, arcTo() {}, closePath() {}, fill() {}, stroke() {}, fillRect() {},
    fillText(value, x, y, maxWidth) {
      paintedTexts.push({ value: String(value), x, y, maxWidth });
      if (String(value).includes("C1-SAMPLE001")) customerIdentityDraws.push({ value, x, y, maxWidth });
    },
    save() {}, restore() {}, clip() {}, scale() {}, translate() {}, drawImage() { backgroundDrawCount += 1; },
    set fillStyle(_) {}, set strokeStyle(_) {}, set lineWidth(_) {}, set font(_) {},
    set textBaseline(_) {}, set textAlign(_) {}
  };
  canvas.getContext = () => context;
  canvas.createImage = () => {
    const image = { width: 930, height: 1316, onload: null, onerror: null };
    Object.defineProperty(image, "src", {
      set() { queueMicrotask(() => image.onload && image.onload()); }
    });
    return image;
  };
  const documentData = renderer.createProductSampleDocument({
    template: { productName: "海洋之蕴", productType: "护理" },
    kind: "recharge-pdf",
    rechargeInstructions: "说明".repeat(1200),
    logoRequired: false
  });
  documentData.messages = [
    { label: "提交说明", value: "绝不能打印的提交留言" },
    { label: "审核说明", value: "绝不能打印的审核留言" }
  ];
  const result = await renderer.renderReceiptCanvas({ canvas, documentData, photos: [], paginate: true });
  assert.equal(result.width, 2480);
  assert.equal(result.height, 3508, "the active PDF canvas stays within one 300 DPI A4 page");
  assert.equal(result.logicalHeight % 1754, 0);
  assert.ok(result.pageCount > 1, "long instructions must produce real A4 pages");
  assert.equal(typeof result.renderPage, "function", "multi-page PDF output renders one high-resolution page at a time");
  assert.equal(backgroundDrawCount, result.pageCount,
    "every A4 product-preview page must draw the shared Lusizhuoer background exactly once");
  assert.deepEqual(customerIdentityDraws.map((item) => item.value), ["示例客户 · C1-SAMPLE001"],
    "the customer name and number are painted once instead of wrapped into multiple lines");
  assert.ok(customerIdentityDraws[0].maxWidth > 480 && customerIdentityDraws[0].maxWidth < 540,
    "the one-line customer identity stays inside the left half-row beside the project");
  assert.equal(paintedTexts.some((item) => item.value.includes("绝不能打印")), false,
    "documentData messages are ignored by every PDF/image receipt render");
  const instructionDraws = paintedTexts.filter((item) => /^说明/.test(item.value));
  assert.ok(instructionDraws.length > 10, "the long product instructions are painted across pages");
  assert.ok(instructionDraws.every((item) => {
    const pageY = ((item.y % 1754) + 1754) % 1754;
    return pageY < 1690;
  }), "larger instruction text stays above every A4 page footer");
});

test("verification renderer decodes and paints only the current verification photo", async () => {
  const loadedSources = [];
  const paintedTexts = [];
  const canvas = { width: 0, height: 0 };
  const context = {
    canvas,
    measureText(value) { return { width: Array.from(String(value)).length * 18 }; },
    beginPath() {}, moveTo() {}, arcTo() {}, closePath() {}, fill() {}, stroke() {}, fillRect() {},
    fillText(value) { paintedTexts.push(String(value)); },
    save() {}, restore() {}, clip() {}, scale() {}, translate() {}, drawImage() {},
    set fillStyle(_) {}, set strokeStyle(_) {}, set lineWidth(_) {}, set font(_) {},
    set textBaseline(_) {}, set textAlign(_) {}
  };
  canvas.getContext = () => context;
  canvas.createImage = () => {
    const image = { width: 930, height: 1316, onload: null, onerror: null };
    Object.defineProperty(image, "src", {
      set(value) { loadedSources.push(String(value)); queueMicrotask(() => image.onload && image.onload()); }
    });
    return image;
  };
  const documentData = renderer.createProductSampleDocument({
    template: { productName: "示例项目", productType: "护理" },
    kind: "verification-pdf",
    verificationInstructions: "核销说明",
    logoRequired: false
  });
  documentData.messages = [{ label: "审核说明", value: "不应打印的审核留言" }];
  const photos = [
    { slot: 0, label: "客户建档留存照", required: true, source: "archive-photo-0" },
    { slot: 1, label: "客户核销照片", required: true, source: "verification-photo-1" },
    { slot: 2, label: "额外位置一", required: true, source: "extra-photo-2" },
    { slot: 3, label: "额外位置二", required: true, source: "extra-photo-3" },
    { slot: 4, label: "额外位置三", required: true, source: "extra-photo-4" }
  ];
  const result = await renderer.renderReceiptCanvas({ canvas, documentData, photos, paginate: true });
  assert.deepEqual(loadedSources.filter((source) => source.startsWith("verification-photo")), ["verification-photo-1"]);
  assert.equal(loadedSources.some((source) => source.startsWith("archive-photo")), false,
    "the initial customer archive photo is not decoded for a work-order receipt");
  assert.equal(loadedSources.some((source) => source.startsWith("extra-photo")), false,
    "supplemental photos are not decoded and cannot block receipt generation");
  assert.ok(paintedTexts.includes("客户核销照片"));
  assert.equal(paintedTexts.includes("客户建档留存照"), false);
  assert.equal(paintedTexts.some((value) => value.includes("额外位置") || value.includes("不应打印")), false);
  assert.equal(result.pageCount, 1, "the enlarged one-photo verification receipt still fits one A4 page");
});

test("PDF writer creates true multi-page A4 output instead of one tall page", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const pdf = Buffer.from(renderer.createPdfBytes([
    { width: 1240, height: 1754, bytes: jpeg },
    { width: 1240, height: 1754, bytes: jpeg }
  ])).toString("latin1");
  assert.ok(pdf.startsWith("%PDF-1.4"));
  assert.match(pdf, /\/Count 2\b/);
  assert.equal((pdf.match(/\/MediaBox \[0 0 595\.28 841\.89\]/g) || []).length, 2);
  assert.equal((pdf.match(/\/Filter \/DCTDecode/g) || []).length, 2);
  assert.ok(pdf.endsWith("%%EOF\n"));
});

test("300 DPI PDF pages render and export sequentially instead of keeping one huge multi-page canvas", async () => {
  const rendered = [];
  const captures = [];
  const priorWx = global.wx;
  global.wx = {
    canvasToTempFilePath(options) {
      captures.push({ y: options.y, width: options.width, height: options.height, quality: options.quality });
      options.success({ tempFilePath: `/tmp/page-${captures.length}.jpg` });
    }
  };
  try {
    const pages = await renderer.exportReceiptJpegs({
      canvas: {}, paginate: true, pageCount: 3,
      width: 2480, height: 3508, pageHeight: 3508,
      renderPage(index) { rendered.push(index); }
    }, {});
    assert.deepEqual(rendered, [0, 1, 2]);
    assert.deepEqual(captures, [
      { y: 0, width: 2480, height: 3508, quality: 0.98 },
      { y: 0, width: 2480, height: 3508, quality: 0.98 },
      { y: 0, width: 2480, height: 3508, quality: 0.98 }
    ]);
    assert.deepEqual(pages.map((page) => [page.width, page.height]), [
      [2480, 3508], [2480, 3508], [2480, 3508]
    ]);
  } finally {
    if (priorWx === undefined) delete global.wx; else global.wx = priorWx;
  }
});

test("product page previews generated native receipts and exports all four formats", () => {
  for (const kind of ["verification-pdf", "verification-image", "recharge-pdf", "recharge-image"]) {
    assert.ok(pageJs.includes(kind), `missing preview kind ${kind}`);
  }
  for (const call of [
    "createProductSampleDocument", "createProductSamplePhotos", "renderReceiptCanvas", "exportReceiptJpegs",
    "queueReceiptRender", "_previewEpoch", "jpegPdf(pages)", "saveImageToAlbum(artifact.images[0].path)",
    "wx.openDocument"
  ]) assert.ok(pageJs.includes(call), `product preview is missing ${call}`);
  assert.match(pageJs, /fileType:\s*"pdf"[\s\S]*showMenu:\s*true/,
    "generated A4 PDFs open with the native menu available");
  assert.doesNotMatch(pageJs, /shareFileMessage/,
    "the async preview renderer cannot invoke shareFileMessage after the original TAP gesture expires");

  assert.match(pageWxml, /wx:for="\{\{previewImages\}\}"/);
  assert.match(pageWxml, /class="generated-receipt"/);
  assert.match(pageWxml, /mode="widthFix"/);
  assert.match(pageWxss, /\.generated-preview \{[^}]*height:\s*64vh;/);
  assert.match(pageWxss, /\.export-canvas \{[^}]*width:\s*1240px;[^}]*height:\s*1754px;/);
  assert.match(pageWxss, /\.receipt-preview \{[^}]*background:\s*#f4ead9;[^}]*border:\s*1rpx solid #dfcfb4;/,
    "the product preview frame uses the same warm brand palette as the generated receipt");
  assert.match(pageWxss, /\.generated-receipt \{[^}]*background:\s*#fffaf3;/,
    "generated product samples keep the receipt background tone while loading");

  for (const retired of [
    "receipt-facts", "receipt-instructions", "尚未填写单据说明", "文件大小", "像素尺寸", "不压缩", "不裁切", "图片编号"
  ]) assert.doesNotMatch(pageWxml, new RegExp(retired), `page must not render retired text/markup ${retired}`);
});
