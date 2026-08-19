"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.resolve(__dirname, "../business-detail.js"), "utf8");

function functionSource(name) {
  const match = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`).exec(source);
  assert.ok(match, `function ${name} must exist`);
  const start = match.index;
  const bodyStart = source.indexOf(") {", start) + 2;
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`function ${name} is incomplete`);
}

async function runScenario({ permanentFailure = false, forceLogoRefresh = false } = {}) {
  const harness = {
    module: { exports: {} },
    Promise,
    Object,
    __logoCalls: [],
    __rendered: [],
    __templateReads: []
  };
  vm.createContext(harness);
  vm.runInContext(`
    const PRODUCT_LOGO_DETAIL_RETRY_DELAYS_MS = Object.freeze([0, 1, 2]);
    let productTemplateRequest = 0;
    let currentProductTemplate = null;
    let currentProductTemplateError = null;
    const clean = (value) => String(value ?? "").trim();
    const productReference = () => "PRD001";
    const assertProductReceiptTemplate = (template) => template;
    const waitForProductLogoRetry = async () => {};
    const renderProductReceiptBrand = (template) => globalThis.__rendered.push({
      productName: template.productName,
      hasBlob: Boolean(template.logoBlob)
    });
    const fetchProductLogoBlob = async (_template, _productRef, options) => {
      globalThis.__logoCalls.push(options);
      if (${permanentFailure ? "true" : "false"} || globalThis.__logoCalls.length < 3) {
        const error = new Error("temporary logo read failure");
        error.code = "InternalError";
        throw error;
      }
      return { kind: "verified-logo-blob" };
    };
    const window = {
      CloudBasePhoneAuth: {
        getProductReceiptTemplate: async (options) => {
          globalThis.__templateReads.push(options);
          return {
            id: "1", productCode: "PRD001", productName: "产品一",
            logo: { reference: "pg://product-templates/products/1/receipt-logo/a.png" }
          };
        }
      }
    };
    ${functionSource("loadProductReceiptTemplate")}
    module.exports = {
      loadProductReceiptTemplate,
      state: () => ({ currentProductTemplate, currentProductTemplateError })
    };
  `, harness, { filename: "business-logo-read-reliability.js" });

  const api = harness.module.exports;
  let result = null;
  let error = null;
  try {
    result = await api.loadProductReceiptTemplate({}, { forceLogoRefresh });
  } catch (caught) {
    error = caught;
  }
  return { harness, api, result, error };
}

(async () => {
  const recovered = await runScenario();
  assert.equal(recovered.error, null);
  assert.equal(recovered.harness.__logoCalls.length, 3, "a transient detail-page logo outage gets three bounded attempts");
  assert.equal(recovered.result.logoBlob.kind, "verified-logo-blob");
  assert.equal(recovered.api.state().currentProductTemplate.logoBlob.kind, "verified-logo-blob");
  assert.deepEqual(Array.from(recovered.harness.__logoCalls, (item) => item.forceRefresh), [false, true, true]);

  const failed = await runScenario({ permanentFailure: true });
  assert.match(failed.error.message, /temporary logo read failure/);
  assert.equal(failed.harness.__logoCalls.length, 3, "a persistent outage remains bounded");
  assert.equal(failed.api.state().currentProductTemplate.productName, "产品一", "template metadata remains visible after logo failure");
  assert.equal(failed.api.state().currentProductTemplateError, failed.error);

  const forced = await runScenario({ forceLogoRefresh: true });
  assert.equal(forced.harness.__templateReads[0].forceRefresh, true, "export-time read bypasses the metadata flight cache");
  assert.ok(forced.harness.__logoCalls.every((item) => item.forceRefresh === true), "export-time logo reads all bypass the browser byte cache");
  console.log("business detail logo read reliability: PASS");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
