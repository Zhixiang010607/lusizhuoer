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
  assert.deepEqual(verification.facts.map((item) => item.label), ["门店", "客户", "项目", "业务老师", "提交时间"]);
  assert.deepEqual(verification.details, []);
  assert.equal(verification.productTemplate.instructions, "核销说明");

  assert.equal(recharge.kind, "充值 / 退费");
  assert.equal(recharge.title, "充值单 SAMPLE001");
  assert.equal(recharge.compactVerification, false);
  assert.deepEqual(recharge.facts.map((item) => item.label), ["门店", "客户", "项目", "业务老师"]);
  assert.deepEqual(recharge.details, [
    { label: "充值次数", value: "10 次" },
    { label: "提交时间", value: "2026-08-19 12:34:56" },
    { label: "审核时间", value: "2026-08-19 12:36:10" }
  ]);
  assert.equal(recharge.productTemplate.instructions, "充值说明");

  assert.deepEqual(renderer.createProductSamplePhotos("verification-image"), [
    { label: "客户建档照片", required: false, placeholder: "照片区域", meta: "样例照片位" },
    { label: "本次核销人脸照", required: false, placeholder: "照片区域", meta: "样例照片位" },
    { label: "补充照片 1", required: false, placeholder: "照片区域", meta: "样例照片位" },
    { label: "补充照片 2", required: false, placeholder: "照片区域", meta: "样例照片位" },
    { label: "补充照片 3", required: false, placeholder: "照片区域", meta: "样例照片位" }
  ]);
  assert.deepEqual(renderer.createProductSamplePhotos("recharge-pdf"), []);

  for (const phrase of [
    "正常核销 / 体验核销", "充值 / 退费", "门店详细地址：示例省示例市示例区示例路 1 号",
    "充值次数与办理时间", "客户留存照、本次核销人脸照与补充照片"
  ]) {
    assert.ok(webProject.includes(phrase) || webExporter.includes(phrase), `web reference is missing ${phrase}`);
    assert.ok(rendererSource.includes(phrase), `mini renderer is missing ${phrase}`);
  }
});

test("native receipt renderer preserves the web A4 and long-image geometry", async () => {
  assert.equal(renderer.CANVAS_WIDTH, 1240);
  assert.equal(renderer.PDF_PAGE_HEIGHT, 1754);
  assert.equal(renderer.PDF_PAGE_WIDTH, 595.28);
  assert.equal(renderer.PDF_PAGE_POINTS_HEIGHT, 841.89);
  for (const contract of [
    "const CANVAS_WIDTH = 1240", "const PDF_PAGE_HEIGHT = 1754", "const PAGE_MARGIN = 64",
    "{ imageHeight: 238, cardHeight: 314 }", "{ imageHeight: 176, cardHeight: 252 }",
    '"#10233f"', '"#edf4ff"', '"#f6f8fb"'
  ]) {
    assert.ok(rendererSource.includes(contract), `mini renderer is missing ${contract}`);
  }
  assert.match(webExporter, /const CANVAS_WIDTH = 1240/);
  assert.match(webExporter, /const PDF_PAGE_HEIGHT = 1754/);
  assert.match(rendererSource, /if \(!instructions\) return y;/, "empty instructions must omit the whole section");

  const canvas = { width: 0, height: 0 };
  const context = {
    canvas,
    measureText(value) { return { width: Array.from(String(value)).length * 18 }; },
    beginPath() {}, moveTo() {}, arcTo() {}, closePath() {}, fill() {}, stroke() {}, fillRect() {},
    fillText() {}, save() {}, restore() {}, clip() {}, drawImage() {},
    set fillStyle(_) {}, set strokeStyle(_) {}, set lineWidth(_) {}, set font(_) {},
    set textBaseline(_) {}, set textAlign(_) {}
  };
  canvas.getContext = () => context;
  canvas.createImage = () => { throw new Error("no image should be decoded for the placeholder sample"); };
  const documentData = renderer.createProductSampleDocument({
    template: { productName: "海洋之蕴", productType: "护理" },
    kind: "recharge-pdf",
    rechargeInstructions: "说明".repeat(1200),
    logoRequired: false
  });
  const result = await renderer.renderReceiptCanvas({ canvas, documentData, photos: [], paginate: true });
  assert.equal(result.width, 1240);
  assert.equal(result.height % 1754, 0);
  assert.ok(result.pageCount > 1, "long instructions must produce real A4 pages");
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

test("product page previews generated native receipts and exports all four formats", () => {
  for (const kind of ["verification-pdf", "verification-image", "recharge-pdf", "recharge-image"]) {
    assert.ok(pageJs.includes(kind), `missing preview kind ${kind}`);
  }
  for (const call of [
    "createProductSampleDocument", "createProductSamplePhotos", "renderReceiptCanvas", "exportReceiptJpegs",
    "queueReceiptRender", "_previewEpoch", "jpegPdf(pages)", "saveImageToAlbum(artifact.images[0].path)",
    "wx.shareFileMessage"
  ]) assert.ok(pageJs.includes(call), `product preview is missing ${call}`);

  assert.match(pageWxml, /wx:for="\{\{previewImages\}\}"/);
  assert.match(pageWxml, /class="generated-receipt"/);
  assert.match(pageWxml, /mode="widthFix"/);
  assert.match(pageWxss, /\.generated-preview \{[^}]*height:\s*64vh;/);
  assert.match(pageWxss, /\.export-canvas \{[^}]*width:\s*1240px;[^}]*height:\s*1754px;/);

  for (const retired of [
    "receipt-facts", "receipt-instructions", "尚未填写单据说明", "文件大小", "像素尺寸", "不压缩", "不裁切", "图片编号"
  ]) assert.doesNotMatch(pageWxml, new RegExp(retired), `page must not render retired text/markup ${retired}`);
});
