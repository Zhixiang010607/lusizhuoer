"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const cloud = read("cloudfunctions/staffAccount/index.js");
const schema = read("database/schema.sql");
const migration = read("database/migrations/045_product_receipt_templates.sql");
const detailHtml = read("project-detail.html");
const detailUi = read("project-detail.js");
const management = read("management.js");
const createHtml = read("project-create.html");
const createUi = read("project-create.js");
const exporter = read("order-export.js");
const businessDetail = read("business-detail.js");

for (const column of [
  "receipt_logo_file_id", "receipt_logo_mime_type", "receipt_logo_original_name",
  "receipt_logo_bytes", "receipt_logo_width", "receipt_logo_height",
  "verification_receipt_instructions", "recharge_receipt_instructions",
  "receipt_template_updated_by", "receipt_template_updated_at"
]) {
  assert.ok(schema.includes(column), `schema must include ${column}`);
  assert.ok(migration.includes(column), `migration must include ${column}`);
}
assert.ok(migration.includes("receipt_logo_bytes BETWEEN 8 AND 8388608"), "original logo size is bounded without recompression");
assert.ok(migration.includes("NORMAL and EXPERIENCE"), "verification and experience share a template");
assert.ok(migration.includes("NEW recharge and REFUND"), "recharge and refund share a template");

for (const action of [
  "getProductReceiptTemplate", "beginProductLogoUpload", "confirmProductLogoUpload",
  "saveProductReceiptTemplate", "removeProductReceiptLogo", "getProductReceiptLogoData"
]) assert.ok(cloud.includes(`action === "${action}"`), `cloud action ${action}`);
assert.ok(cloud.includes("signUploadObject"), "original logo uses direct signed upload");
assert.ok(cloud.includes("getObjectInfoAuthenticated"), "server verifies the uploaded object");
assert.ok(cloud.includes("downloadAuthenticatedObject"), "server verifies and can return original logo bytes");
assert.ok(cloud.includes("productLogoMagicMatches"), "server rejects spoofed image content");
assert.ok(cloud.includes("receipt_template_updated_by"), "template changes retain the HQ actor");

assert.ok(!createHtml.includes('id="projectCreateDescription" required'), "product description is optional");
assert.ok(createUi.includes("if (!productName || !productType)"), "only product name and category are mandatory");
assert.ok(createUi.includes("project-detail.html?projectId="), "new product continues directly to template setup");
assert.ok(management.includes('href="project-detail.html?projectId='), "existing products open the template page");

for (const id of [
  "productLogoPreview", "verificationReceiptInstructions", "rechargeReceiptInstructions",
  "productPreviewFrame", "downloadProductPreview"
]) assert.ok(detailHtml.includes(`id="${id}"`), `template page includes ${id}`);
for (const kind of ["verification-pdf", "verification-image", "recharge-pdf", "recharge-image"]) {
  assert.ok(detailHtml.includes(`data-preview-kind="${kind}"`), `template page includes ${kind}`);
}
assert.ok(detailUi.includes("xhr.send(file)"), "the exact browser File is uploaded without canvas recompression");
assert.ok(detailUi.includes("logoBlob.size !== Number(template.logo?.bytes || 0)"), "saved original is read back and byte checked");
assert.ok(detailUi.includes("createOrderPdfBlob"), "PDF previews use the production renderer");
assert.ok(detailUi.includes("createOrderImageBlob"), "image downloads use the production renderer");
assert.ok(detailUi.includes("getProductReceiptTemplate({ productRef: projectRef })"), "template loading sends the URL product reference");
assert.ok(!detailUi.includes("getProductReceiptTemplate({ productRef });"), "template loading cannot reference an undeclared productRef variable");
assert.ok(detailUi.includes("function currentProductRef()"), "template mutations guard against a missing product object");
assert.ok(detailUi.includes("function setTemplateControlsReady(ready)"), "template editing remains locked until the product loads");
assert.ok(detailUi.includes('setTemplateControlsReady(false);'), "load failure keeps all mutation controls locked");
assert.ok(detailHtml.includes('project-detail.js?v=0.2.2'), "template page busts the broken script cache");

assert.ok(exporter.includes("drawDocumentHeader(context, documentData, productLogo"), "receipts place the square product logo in the header");
assert.ok(!exporter.includes("drawProductBranding"), "receipts remove the duplicated large logo section");
assert.ok(exporter.includes("drawProductInstructions"), "receipts render product-specific instructions");
assert.ok(exporter.includes("logoRequired === true"), "configured logo failure blocks incomplete output");
assert.ok(businessDetail.includes("getProductReceiptTemplate"), "real receipts load the latest product template");
assert.ok(businessDetail.includes("产品单据模板读取失败，本次没有生成文件"), "real exports fail closed when branding cannot be loaded");

console.log("product receipt template contract: PASS");
