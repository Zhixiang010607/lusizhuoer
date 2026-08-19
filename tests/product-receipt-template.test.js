"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

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
const phoneAuth = read("cloudbase-phone-auth.js");

function functionSource(source, name) {
  const marker = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = marker.exec(source);
  assert.ok(match, `function ${name} must exist`);
  const start = match.index;
  const signatureEnd = source.indexOf(") {", match.index + match[0].length);
  assert.ok(signatureEnd >= 0, `function ${name} signature must be complete`);
  const bodyStart = signatureEnd + 2;
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`function ${name} body is incomplete`);
}

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
  "getProductReceiptTemplate", "beginProductLogoUpload", "uploadProductLogoByFunction", "confirmProductLogoUpload", "discardProductLogoUpload",
  "saveProductReceiptTemplate", "removeProductReceiptLogo", "getProductReceiptLogoData"
]) assert.ok(cloud.includes(`action === "${action}"`), `cloud action ${action}`);
assert.ok(cloud.includes('const FUNCTION_VERSION = "v46"'), "staffAccount exposes the corrected v46 contract");
assert.ok(cloud.includes("envId: process.env.CLOUDBASE_ENV_ID || process.env.TCB_ENV"), "manager and storage calls select the same environment");
assert.ok(cloud.includes("signUploadObject"), "original logo uses direct signed upload");
assert.ok(cloud.includes("canonicalProductLogoUploadUrl"), "signed upload uses a canonical HTTPS gateway target");
assert.ok(cloud.includes("getObjectInfoAuthenticated"), "server verifies the uploaded object");
assert.ok(cloud.includes("downloadAuthenticatedObject"), "server verifies and can return original logo bytes");
assert.ok(cloud.includes("productLogoMagicMatches"), "server rejects spoofed image content");
assert.ok(cloud.includes("const dimensions = productLogoDimensions(buffer, expected.mimeType)"), "signed uploads are checked against dimensions decoded from the stored bytes");
assert.ok(cloud.includes("PRODUCT_LOGO_FUNCTION_MAX_BYTES = 3 * 1024 * 1024"), "function fallback stays below the synchronous invocation payload ceiling");
assert.ok(cloud.includes("manager().storage.uploadObject"), "function fallback writes validated bytes through authenticated PG storage");
assert.ok(cloud.includes("storageUploadResponseMismatch(error)"), "known successful-upload metadata mismatch remains compatible");
assert.ok(phoneAuth.includes("async uploadProductLogoByFunction"), "browser service exposes the authenticated function fallback");
assert.ok(cloud.includes("signed read unavailable; using authenticated fallback"), "a temporary read signer failure cannot hide an already persisted template");
assert.ok(cloud.includes("receipt_template_updated_by"), "template changes retain the HQ actor");

const signingLogs = [];
const signingHarness = {
  module: { exports: {} },
  URL,
  console: { error: (...args) => signingLogs.push(args) },
  fail(message, code) { throw Object.assign(new Error(message), { code }); }
};
vm.createContext(signingHarness);
vm.runInContext([
  functionSource(cloud, "nestedString"),
  functionSource(cloud, "signedStorageUrl"),
  functionSource(cloud, "safeResponseShape"),
  functionSource(cloud, "signedStorageUrlScheme"),
  functionSource(cloud, "canonicalProductLogoUploadUrl"),
  functionSource(cloud, "signedStorageUpload"),
  "module.exports = { signedStorageUpload };"
].join("\n"), signingHarness, { filename: "product-logo-signing-contract.js" });

const canonicalUpload = signingHarness.module.exports.signedStorageUpload(
  { data: { url: "http://internal.invalid/upload", token: "short lived + token" } },
  { envId: "env-test", bucketId: "product templates" },
  "products/9/receipt logo/品牌.png",
  "image/png"
);
const canonicalTarget = new URL(canonicalUpload.url);
assert.equal(canonicalTarget.protocol, "https:", "function returns only an HTTPS signed upload target");
assert.equal(canonicalTarget.hostname, "env-test.api.tcloudbasegateway.com", "canonical target is bound to the configured environment");
assert.equal(decodeURIComponent(canonicalTarget.pathname), "/v1/storages/object/upload/sign/product templates/products/9/receipt logo/品牌.png", "canonical target is bound to the configured bucket and object");
assert.equal(canonicalTarget.searchParams.get("token"), "short lived + token", "short-lived upload token is normalized into the URL");
assert.ok(!canonicalUpload.url.includes("internal.invalid"), "an internal SDK URL is never forwarded to the browser");

assert.throws(
  () => signingHarness.module.exports.signedStorageUpload(
    { data: { url: "http://internal.invalid/sensitive-path", token: "" } },
    { envId: "env-test", bucketId: "product-templates" },
    "products/9/receipt-logo/private.png",
    "image/png"
  ),
  (error) => error?.code === "PRODUCT_LOGO_UPLOAD_SIGN_FAILED",
  "an unsigned non-HTTPS response fails closed"
);
const serializedSigningLogs = JSON.stringify(signingLogs);
assert.ok(serializedSigningLogs.includes('"urlScheme","http"') || serializedSigningLogs.includes('"urlScheme":"http"'), "safe diagnostics retain only the URL scheme");
assert.ok(!serializedSigningLogs.includes("sensitive-path") && !serializedSigningLogs.includes("internal.invalid"), "safe diagnostics do not log the signed URL value");

const fallbackHarness = {
  module: { exports: {} },
  Buffer,
  fail(message, code) { throw Object.assign(new Error(message), { code }); }
};
vm.createContext(fallbackHarness);
vm.runInContext([
  "const PRODUCT_LOGO_FUNCTION_MAX_BYTES = 3 * 1024 * 1024;",
  functionSource(cloud, "productLogoMagicMatches"),
  functionSource(cloud, "productLogoDimensions"),
  functionSource(cloud, "productLogoFunctionBuffer"),
  "module.exports = { productLogoFunctionBuffer };"
].join("\n"), fallbackHarness, { filename: "product-logo-function-fallback-contract.js" });

const png = Buffer.alloc(24);
Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png, 0);
Buffer.from("IHDR", "ascii").copy(png, 12);
png.writeUInt32BE(309, 16);
png.writeUInt32BE(288, 20);
const pngEvent = { imageBase64: `data:image/png;base64,${png.toString("base64")}` };
const pngInput = { mimeType: "image/png", bytes: png.length, width: 309, height: 288 };
assert.deepEqual(
  Buffer.from(fallbackHarness.module.exports.productLogoFunctionBuffer(pngEvent, pngInput)),
  png,
  "function fallback accepts the exact canonical bytes after server-side format and dimension validation"
);
assert.throws(
  () => fallbackHarness.module.exports.productLogoFunctionBuffer(pngEvent, { ...pngInput, bytes: png.length + 1 }),
  (error) => error?.code === "PRODUCT_LOGO_SIZE_MISMATCH",
  "function fallback rejects a client byte-count mismatch"
);
assert.throws(
  () => fallbackHarness.module.exports.productLogoFunctionBuffer(pngEvent, { ...pngInput, width: 310 }),
  (error) => error?.code === "PRODUCT_LOGO_DIMENSIONS_MISMATCH",
  "function fallback rejects client dimensions that differ from the original bytes"
);
assert.throws(
  () => fallbackHarness.module.exports.productLogoFunctionBuffer(
    { imageBase64: "data:image/png;base64,AAAA=" },
    { mimeType: "image/png", bytes: 3, width: 1, height: 1 }
  ),
  (error) => error?.code === "PRODUCT_LOGO_BASE64_INVALID",
  "function fallback requires canonical base64 rather than permissive decoding"
);
assert.throws(
  () => fallbackHarness.module.exports.productLogoFunctionBuffer(
    { imageBase64: "" },
    { mimeType: "image/png", bytes: 3 * 1024 * 1024 + 1, width: 1, height: 1 }
  ),
  (error) => error?.code === "PRODUCT_LOGO_FUNCTION_TOO_LARGE",
  "function fallback rejects metadata above 3 MB before decoding"
);

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
assert.ok(detailUi.includes("function originalFileDataUrl(file)"), "the fallback reads the original file bytes without canvas recompression");
assert.ok(detailUi.includes('error?.code === "PRODUCT_LOGO_UPLOAD_SIGN_FAILED" || signedStage === "UPLOAD"'), "signing and browser PUT failures can use the safe fallback");
assert.ok(detailUi.includes("uploadProductLogoByFunction({ ...input, imageBase64 })"), "the editor can use the authenticated function fallback");
assert.ok(detailUi.includes("discardProductLogoUpload({"), "a failed signed upload requests safe cleanup of its unbound object");
assert.ok(detailUi.includes("logoBlob.size !== Number(template.logo?.bytes || 0)"), "saved original is read back and byte checked");
assert.ok(detailUi.includes("createOrderPdfBlob"), "PDF previews use the production renderer");
assert.ok(detailUi.includes("createOrderImageBlob"), "image downloads use the production renderer");
assert.ok(detailUi.includes("getProductReceiptTemplate({ productRef: projectRef })"), "template loading sends the URL product reference");
assert.ok(!detailUi.includes("template = await window.CloudBasePhoneAuth.getProductReceiptTemplate({ productRef });"), "initial template loading cannot reference an undeclared productRef variable");
assert.ok(detailUi.includes("function currentProductRef()"), "template mutations guard against a missing product object");
assert.ok(detailUi.includes("function assertUrlProduct(candidate)"), "the initial response must match the immutable URL product reference");
assert.ok(detailUi.includes("return projectRef;"), "all mutations remain bound to the immutable URL product reference");
assert.ok(detailUi.includes("function setTemplateControlsReady(ready)"), "template editing remains locked until the product loads");
assert.ok(detailUi.includes('setTemplateControlsReady(false);'), "load failure keeps all mutation controls locked");
assert.ok(detailUi.includes("assertTemplateRoundTrip(saved"), "save response must match the current product and submitted instructions");
assert.ok(detailUi.includes("const reread = await window.CloudBasePhoneAuth.getProductReceiptTemplate"), "save success requires an independent database reread");
assert.ok(detailUi.includes("已保存并从数据库复核"), "success message states that persistence was verified");
assert.ok(detailUi.includes('`${template.productCode || "未编号"} ·'), "the editor always identifies which product owns the template");
assert.ok(detailUi.includes("if (previewQueued) void renderPreview()"), "a save cannot lose its preview refresh behind an older render");
assert.ok(detailHtml.includes('project-detail.js?v=0.2.3'), "template page busts the stale-save script cache");

assert.ok(exporter.includes("drawDocumentHeader(context, documentData, productLogo"), "receipts place the square product logo in the header");
assert.ok(!exporter.includes("drawProductBranding"), "receipts remove the duplicated large logo section");
assert.ok(exporter.includes("drawProductInstructions"), "receipts render product-specific instructions");
assert.ok(exporter.includes("logoRequired === true"), "configured logo failure blocks incomplete output");
assert.ok(businessDetail.includes("getProductReceiptTemplate"), "real receipts load the latest product template");
assert.ok(businessDetail.includes("产品单据模板读取失败，本次没有生成文件"), "real exports fail closed when branding cannot be loaded");
assert.ok(businessDetail.includes("productTemplateLoadPromise = loadProductReceiptTemplate(currentRecord)"), "every real export reloads the latest product template");
assert.ok(businessDetail.includes("尚未配置${receiptKind}单据说明"), "an unconfigured product cannot silently generate an empty receipt");
assert.ok(businessDetail.includes("const request = ++productTemplateRequest"), "older template requests cannot overwrite a newer export-time read");
assert.ok(businessDetail.includes("exportDocumentData(currentRecord, exportTemplate)"), "an export uses its own verified template rather than mutable page state");
assert.ok(detailUi.includes('$("verificationReceiptInstructions").disabled = true'), "text cannot change while its save is being verified");

console.log("product receipt template contract: PASS");
