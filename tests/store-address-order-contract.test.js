"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const detail = read("business-detail.js");
const styles = read("styles.css");
const staffAccount = read("cloudfunctions/staffAccount/index.js");
const faceRecognition = read("cloudfunctions/faceRecognition/index.js");

for (const source of [staffAccount, faceRecognition]) {
  assert.ok(source.includes("s.province AS store_province"), "order service must read store province");
  assert.ok(source.includes("s.city AS store_city"), "order service must read store city");
  assert.ok(source.includes("s.district AS store_district"), "order service must read store district");
  assert.ok(source.includes("s.address_detail AS store_address_detail"), "order service must read detailed store address");
}

assert.ok(detail.includes('const description = `门店详细地址：${fullStoreAddress(record) || "未填写"}`'), "recharge, refund, normal verification and experience verification share one address subtitle");
assert.ok(detail.includes('[record?.storeProvince, record?.storeCity, record?.storeDistrict, record?.storeAddressDetail]'), "the displayed address combines every persisted address part");
assert.ok(detail.includes('"门店详细地址：未填写"} · 提交时间：${submittedAt}'), "verification PDF/image export retains the store address");
assert.ok(!styles.includes("order-store-address-fact"), "the address stays in the compact subtitle instead of taking another card");

console.log("store address order contract: PASS");
