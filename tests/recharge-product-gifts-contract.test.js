"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `${startMarker} section must exist`);
  return source.slice(start, end);
}

test("migration 061 stores immutable recharge gifts with parent scope and active-product validation", () => {
  const migration = read("database/migrations/061_recharge_product_gifts.sql");
  const consoleSql = read("database/cloudbase-console/061-01-recharge-product-gifts.sql");
  const verify = read("database/cloudbase-console/061-readonly-verify.sql");
  for (const sql of [migration, consoleSql]) {
    assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.recharge_product_gifts/);
    assert.match(sql, /recharge_id BIGINT NOT NULL REFERENCES public\.recharge_records\(id\) ON DELETE RESTRICT/);
    assert.match(sql, /retail_product_id BIGINT NOT NULL REFERENCES public\.retail_products\(id\) ON DELETE RESTRICT/);
    assert.match(sql, /display_order BETWEEN 1 AND 20/);
    assert.match(sql, /unit_count BETWEEN 1 AND 999/);
    assert.match(sql, /UNIQUE \(recharge_id, retail_product_id\)/);
    assert.match(sql, /parent_record\.recharge_type <> 'NEW'/);
    assert.match(sql, /NEW\.store_id IS DISTINCT FROM parent_record\.store_id[\s\S]*NEW\.customer_id IS DISTINCT FROM parent_record\.customer_id[\s\S]*NEW\.teacher_id IS DISTINCT FROM parent_record\.teacher_id/);
    assert.match(sql, /retail_product\.product_status <> 'ACTIVE'/);
    assert.match(sql, /NEW\.product_code_snapshot := retail_product\.product_code/);
    assert.match(sql, /NEW\.product_name_snapshot := retail_product\.product_name/);
    assert.match(sql, /trg_061_prevent_recharge_product_gift_update/);
    assert.match(sql, /trg_061_prevent_recharge_product_gift_delete/);
    assert.match(sql, /RECHARGE_PRODUCT_GIFT_IMMUTABLE/);
    assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
    assert.match(sql, /BEGIN;[\s\S]*COMMIT;\s*$/);
  }
  assert.doesNotMatch(verify, /(?:^|\n)\s*(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE)\b/i);
  assert.equal((verify.match(/\('[^']+',/g) || []).length, 8, "061 verification must retain eight checks");
  assert.match(read("database/cloudbase-console/061-README.md"), /8 行[\s\S]*READY/);
});

test("faceRecognition v92 validates and atomically creates recharge gifts", () => {
  const cloud = read("cloudfunctions/faceRecognition/index.js");
  assert.match(cloud, /PHOTO_ONLY_FUNCTION \? "v9" : "v92"/);
  const list = section(cloud, "async function listActiveRetailProducts", "function normalizeRechargeProductGifts");
  assert.match(list, /activeBusinessCaller\(event\)/);
  assert.match(list, /FROM public\.retail_products[\s\S]*product_status = 'ACTIVE'/);
  assert.doesNotMatch(list, /ARCHIVED/);

  const normalize = section(cloud, "function normalizeRechargeProductGifts", "function parsedProductGiftRows");
  assert.match(normalize, /refund && value\.length/);
  assert.match(normalize, /value\.length > 20/);
  assert.match(normalize, /seen\.has\(retailProductId\)/);
  assert.match(normalize, /unitCount < 1 \|\| unitCount > 999/);

  const create = section(cloud, "async function createRechargeApplication", "async function requireVerificationSubmissionSchema");
  assert.match(create, /normalizeRechargeProductGifts\(event\.productGifts, refund\)/);
  assert.match(create, /FROM public\.retail_products[\s\S]*product_status = 'ACTIVE'/);
  assert.match(create, /WITH current_balance AS/);
  assert.match(create, /inserted_gifts AS \([\s\S]*INSERT INTO public\.recharge_product_gifts/);
  assert.match(create, /inserted\.store_id, inserted\.customer_id, inserted\.teacher_id/);
  assert.match(create, /sameGiftRequest[\s\S]*sameRequest/);
  assert.match(create, /productGifts: storedProductGifts/);
  assert.match(cloud, /action === "listActiveRetailProducts"/);
  assert.match(cloud, /recoverBusinessSubmission[\s\S]*productGifts/);
});

test("staff detail readers expose the immutable gift lines", () => {
  const cloud = read("cloudfunctions/staffAccount/index.js");
  assert.match(cloud, /const FUNCTION_VERSION = "v74"/);
  assert.match(cloud, /TO_REGCLASS\('public\.recharge_product_gifts'\)/);
  assert.match(cloud, /JSONB_AGG\(JSONB_BUILD_OBJECT\([\s\S]*'productCode', gift\.product_code_snapshot[\s\S]*'unitCount', gift\.unit_count/);
  assert.match(cloud, /WHERE gift\.recharge_id = r\.id/);
  assert.match(cloud, /AS product_gifts/);
});

test("web store and teacher recharge flows use choose, quantity, plus, delete order", () => {
  const storeHtml = read("recharge-create.html");
  const teacherHtml = read("teacher-recharge-create.html");
  for (const html of [storeHtml, teacherHtml]) {
    assert.match(html, /第三步：填写产品赠予/);
    const select = html.indexOf('id="rechargeGiftProduct"');
    const quantity = html.indexOf('id="rechargeGiftQuantity"');
    const add = html.indexOf('id="addRechargeGift"');
    assert.ok(select >= 0 && select < quantity && quantity < add, "gift controls must remain choose → quantity → plus");
    assert.match(html, /class="recharge-gift-plus"[\s\S]*>＋<\/button>/);
    assert.match(html, /store-business\.js\?v=0\.14\.59/);
  }
  const logic = read("store-business.js");
  assert.match(logic, /action: "listActiveRetailProducts"/);
  assert.match(logic, /data-remove-recharge-gift/);
  assert.match(logic, /rechargeProductGifts\.splice\(index, 1\)/);
  assert.match(logic, /productGifts: refundPage \? \[\] : rechargeProductGifts\.map/);
  const styles = read("styles.css");
  assert.match(styles, /\.recharge-gift-plus \{[^}]*display: flex;[^}]*align-items: center;[^}]*justify-content: center;[^}]*border-radius: 50%/);
});

test("mini recharge gift flow and customer confirmation are centered and removable", () => {
  const page = read("miniprogram-app/miniprogram/pages/recharge/index.wxml");
  const logic = read("miniprogram-app/miniprogram/pages/recharge/index.js");
  assert.match(page, /第三步：填写产品赠予/);
  const picker = page.indexOf('bindchange="selectGiftProduct"');
  const quantity = page.indexOf('bindinput="inputGiftQuantity"');
  const add = page.indexOf('bindtap="addProductGift"');
  assert.ok(picker >= 0 && picker < quantity && quantity < add, "mini gift controls must remain choose → quantity → plus");
  assert.match(page, /bindtap="removeProductGift"/);
  assert.match(logic, /callFace\("listActiveRetailProducts", \{ storeId \}\)/);
  assert.match(logic, /productGifts: this\.data\.refund \? \[\] : this\.data\.productGifts\.map/);
  assert.match(logic, /this\.data\.productGifts\.filter\(\(_, giftIndex\) => giftIndex !== index\)/);

  const pickerStyles = read("miniprogram-app/miniprogram/components/customer-picker/index.wxss");
  const confirm = pickerStyles.match(/\.confirm \{[^}]+\}/)?.[0] || "";
  assert.match(confirm, /height: 82rpx/);
  assert.match(confirm, /display: flex/);
  assert.match(confirm, /align-items: center/);
  assert.match(confirm, /justify-content: center/);
  assert.match(confirm, /line-height: 1/);
});

test("recharge detail and exports preserve gift name, code and quantity", () => {
  const web = read("business-detail.js");
  const mini = read("miniprogram-app/miniprogram/pages/order-detail/index.js");
  const miniPage = read("miniprogram-app/miniprogram/pages/order-detail/index.wxml");
  for (const source of [web, mini]) {
    assert.match(source, /function normalizeProductGifts/);
    assert.match(source, /productGifts/);
    assert.match(source, /赠予产品/);
    assert.match(source, /productCode/);
    assert.match(source, /unitCount/);
  }
  assert.match(read("recharge-detail.html"), /id="rechargeProductGiftsPanel"/);
  assert.match(miniPage, /产品赠予/);
  assert.match(miniPage, /item\.productCode/);
  assert.match(miniPage, /item\.unitCount/);
});
