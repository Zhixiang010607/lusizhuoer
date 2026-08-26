"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const cloud = fs.readFileSync(path.join(root, "cloudfunctions", "faceRecognition", "index.js"), "utf8");

function functionSource(name, nextName) {
  const start = cloud.indexOf(`async function ${name}`);
  const end = cloud.indexOf(`async function ${nextName}`, start + 1);
  assert.ok(start >= 0 && end > start, `${name} source must exist`);
  return cloud.slice(start, end);
}

test("customer search counts approved normal verifications without experience", () => {
  const source = functionSource("queryStoreCustomers", "queryStoreBusinessRecords");
  assert.match(source,
    /FROM public\.verification_records v[\s\S]*?v\.customer_id = c\.id[\s\S]*?v\.record_status = 'APPROVED'[\s\S]*?v\.verification_type = 'NORMAL'\) AS normal_verification_count/,
    "the customer query must derive its visible count from approved NORMAL records");
  assert.match(source, /totalVerificationCount:\s*Number\(customer\.normal_verification_count \|\| 0\)/,
    "the API must expose the dedicated normal-only aggregate");
  assert.doesNotMatch(source, /c\.total_verification_count|customer\.total_verification_count/,
    "the customer query must not use the historical total that also includes experience");
});

test("store dashboard customer lists use the same normal-only count", () => {
  const source = functionSource("getStoreDashboard", "getStoreBusinessAnalytics");
  const customerNormalAggregates = source.match(
    /FROM public\.verification_records v[\s\S]{0,260}?v\.customer_id = c\.id[\s\S]{0,260}?v\.record_status = 'APPROVED'[\s\S]{0,260}?v\.verification_type = 'NORMAL'\) AS total_verification_count/g
  ) || [];
  assert.equal(customerNormalAggregates.length, 2,
    "active and archived store customer pages must each derive normal verification totals");
  assert.doesNotMatch(source, /c\.total_verification_count/,
    "store customer pages must not display the mixed customer master total");
});

