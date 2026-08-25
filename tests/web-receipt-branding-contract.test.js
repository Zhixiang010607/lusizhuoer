"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const exporter = read("order-export.js");
const productDetail = read("project-detail.js");
const styles = read("styles.css");
const assetRelative = "assets/receipt/lusizhuoer-receipt-bg-v1.jpg";
const assetPath = path.join(root, assetRelative);

test("web receipt owns a compact generated Lusizhuoer background asset", () => {
  assert.ok(fs.existsSync(assetPath), "web-owned receipt background is missing");
  const bytes = fs.readFileSync(assetPath);
  assert.ok(bytes.length > 20 * 1024, "receipt background must contain the generated artwork");
  assert.ok(bytes.length < 200 * 1024, "web receipt background should remain compact for static hosting");
  assert.equal(bytes[0], 0xff, "receipt background is a JPEG");
  assert.equal(bytes[1], 0xd8, "receipt background is a JPEG");
  assert.ok(!assetRelative.includes("miniprogram-app"), "web must not reference mini-program assets");
});

test("all web receipt canvases use the warm brand palette and generated background", () => {
  for (const contract of [
    `const RECEIPT_BACKGROUND_SOURCE = "${assetRelative}"`,
    'background: "#fffaf3"',
    'panel: "rgba(255, 252, 246, 0.94)"',
    'border: "#dfcfb4"',
    'title: "#302a22"',
    'accent: "#80622f"',
    "function drawReceiptBackground",
    "function prepareReceiptBackground",
    "prepareReceiptBackground()",
    "page * PDF_PAGE_HEIGHT"
  ]) assert.ok(exporter.includes(contract), `web receipt renderer is missing ${contract}`);

  assert.doesNotMatch(exporter, /"#10233f"|"#edf4ff"|"#d9e2ee"|"#245796"|"#315378"/,
    "retired blue receipt colors must not return");
  assert.match(styles, /\.product-preview-frame[^\n]+border:\s*1px solid #dfcfb4[^\n]+background:\s*#eee5d8/,
    "product preview frame should use the same warm presentation palette");
});

test("product samples and real order exports stay on the same branded renderer", () => {
  assert.match(productDetail, /OrderExporter\.createOrderPdfBlob\(options\)/,
    "product PDF preview uses the shared receipt renderer");
  assert.match(productDetail, /OrderExporter\.renderOrderCanvas\(\{ \.\.\.options, paginate: false \}\)/,
    "product image preview uses the shared receipt renderer");
  assert.match(productDetail, /OrderExporter\.createOrderImageBlob\(options\)/,
    "product image sample download uses the shared receipt renderer");

  for (const html of ["project-detail.html", "recharge-detail.html", "verification-detail.html"]) {
    assert.ok(read(html).includes('order-export.js?v=0.1.7'), `${html} must load the branded renderer cache version`);
  }
});
