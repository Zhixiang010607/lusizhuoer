"use strict";
// Optional real PostgreSQL check; entirely synthetic and local, never production.
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), assert = require("node:assert/strict");
const { PGlite } = require(process.argv[2] || "@electric-sql/pglite");
(async () => {
  const db = new PGlite();
  await db.exec(`CREATE TABLE staff_accounts(id BIGINT PRIMARY KEY,staff_name TEXT);
    CREATE TABLE stores(id BIGINT PRIMARY KEY,store_code TEXT,store_name TEXT);
    CREATE TABLE customers(id BIGINT PRIMARY KEY,customer_code TEXT,customer_name TEXT,birth_date DATE);
    CREATE TABLE teachers(id BIGINT PRIMARY KEY,teacher_code TEXT,teacher_name TEXT);
    CREATE TABLE retail_products(id BIGINT PRIMARY KEY,product_code TEXT,product_name TEXT,product_status TEXT);
    CREATE TABLE recharge_records(id BIGINT PRIMARY KEY,recharge_code TEXT,recharge_type TEXT,record_status TEXT,message TEXT,review_note TEXT,
      submitted_at TIMESTAMPTZ,reviewed_at TIMESTAMPTZ,store_id BIGINT,customer_id BIGINT,teacher_id BIGINT,submitted_by_account_id BIGINT,reviewed_by_account_id BIGINT);
    CREATE TABLE recharge_product_gifts(id BIGINT PRIMARY KEY,recharge_id BIGINT,retail_product_id BIGINT,unit_count INTEGER,store_id BIGINT,customer_id BIGINT,
      teacher_id BIGINT,product_code_snapshot TEXT,product_name_snapshot TEXT);
    CREATE TABLE retail_product_purchase_records(id BIGINT PRIMARY KEY,purchase_code TEXT,record_status TEXT,unit_count INTEGER,message TEXT,review_note TEXT,
      submitted_at TIMESTAMPTZ,reviewed_at TIMESTAMPTZ,store_id BIGINT,customer_id BIGINT,teacher_id BIGINT,retail_product_id BIGINT,
      product_code_snapshot TEXT,product_name_snapshot TEXT,submitted_by_account_id BIGINT,reviewed_by_account_id BIGINT);
    INSERT INTO staff_accounts VALUES(1,'合成提交人');INSERT INTO stores VALUES(1,'QA-S','合成门店');
    INSERT INTO customers VALUES(1,'QA-C','合成客户','2000-01-01');INSERT INTO teachers VALUES(1,'QA-T','合成老师');
    INSERT INTO retail_products VALUES(136,'MASK','医用面膜','ACTIVE'),(888,'NEW','未来新增产品种类','ACTIVE');
    INSERT INTO recharge_records VALUES(1,'RC261105000001','NEW','PENDING','','','2026-11-05T01:00:00Z',NULL,1,1,1,1,NULL);
    INSERT INTO recharge_product_gifts VALUES(1,1,136,3,1,1,1,'MASK','医用面膜');
    INSERT INTO retail_product_purchase_records VALUES(1,'PP20261105000001','APPROVED',2,'','','2026-11-05T02:00:00Z','2026-11-05T03:00:00Z',1,1,1,888,'NEW','未来新增产品种类',1,1);`);
  const source = fs.readFileSync(path.resolve(__dirname, "../cloudfunctions/staffAccount/index.js"), "utf8");
  const start = source.indexOf("async function listRetailProductPurchaseReviews("), end = source.indexOf("async function reviewRetailProductPurchase(", start);
  const context = { requireReviewer(caller) { if (caller.profile?.role !== "hq") throw Error("FORBIDDEN"); },
    requireRetailProductPurchaseSchema: async () => {}, hasRechargeProductGiftSchema: async () => true,
    numericId: value => String(value), strictDashboardDate: value => value,
    sqlText: value => "'" + String(value).replace(/'/g, "''") + "'", fail(message) { throw Error(message); },
    executeSql: async sql => (await db.query(sql)).rows };
  vm.runInNewContext(source.slice(start, end) + "\nthis.query=listRetailProductPurchaseReviews;", context);
  const query = options => context.query({ profile: { role: "hq" } }, { status: "", ...options });
  let result = await query({}); assert.equal(result.total, 2); assert.equal(result.summary.gift, 1); assert.equal(result.summary.purchase, 1);
  assert.equal(result.products.length, 2); assert.ok(result.products.some(p => p.productId === "888"));
  result = await query({ sourceType: "GIFT", retailProductId: "136", status: "PENDING" });
  assert.equal(result.orders.length, 1); assert.equal(result.orders[0].product_name_snapshot, "医用面膜"); assert.equal(result.orders[0].unit_count, 3);
  assert.equal(result.orders[0].record_code, "RC261105000001");
  result = await query({ sourceType: "PURCHASE", retailProductId: "888", status: "APPROVED" });
  assert.equal(result.orders.length, 1); assert.equal(result.orders[0].source_type, "PURCHASE"); assert.equal(result.orders[0].unit_count, 2);
  assert.equal((await query({ recordCode: "RC261105000001" })).orders[0].source_type, "GIFT");
  assert.equal((await query({ recordCode: "PP20261105000001" })).orders[0].source_type, "PURCHASE");
  assert.equal((await query({ storeId: "2" })).total, 0);
  assert.equal((await query({ customerName: "合成", birthDate: "2000-01-01", startDate: "2026-11-05", endDate: "2026-11-05" })).total, 2);
  await db.exec("UPDATE retail_products SET product_status='ARCHIVED' WHERE id=136;UPDATE recharge_records SET record_status='REJECTED'");
  result = await query({ sourceType: "GIFT", retailProductId: "136", status: "REJECTED" });
  assert.equal(result.orders.length, 1); assert.equal(result.products.find(p => p.productId === "136").productStatus, "ARCHIVED");
  // Run the production Mini Program request adapter: ALL must explicitly override the review-only PENDING default.
  let definition;
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, "../miniprogram-app/miniprogram/pages/records/index.js"), "utf8"), {
    Page(value) { definition = value; },
    require(id) {
      if (id.endsWith("/api")) return { callStaff: async (action, payload) => { assert.equal(action, "listRetailProductPurchaseReviews"); return context.query({ profile: { role: "hq" } }, payload); } };
      if (id.endsWith("/session")) return {};
      return require(path.resolve(__dirname, "../miniprogram-app/miniprogram/services", id.split("/").at(-1)));
    }
  });
  const page = { ...definition, data: { ...definition.data, recordType: "PRODUCT_PURCHASE", session: { role: "hq" } } };
  result = await page.requestRecords({ productId: "ALL", statusCategory: "ALL", pageSize: 10, page: 1 });
  assert.equal(result.total, 2); assert.equal(result.orders.length, 2);
  await assert.rejects(context.query({ profile: { role: "store" } }, {}), /FORBIDDEN/);
  result=await query({exportAll:true,sourceType:"GIFT"});assert.equal(result.total,1);assert.equal(result.orders[0].source_type,"GIFT");assert.equal(result.orders[0].product_name_snapshot,"医用面膜");assert(!("review_note" in result.orders[0]));
  await db.exec("INSERT INTO recharge_product_gifts SELECT id+1,1,888,1,1,1,1,'NEW','新增产品' FROM generate_series(1,999) id");
  result=await query({exportAll:true,sourceType:"GIFT"});assert.equal(result.total,1000);assert.equal(new Set(result.orders.map(r=>String(r.source_line_id))).size,1000);
  await db.exec("INSERT INTO recharge_product_gifts VALUES(1001,1,888,1,1,1,1,'NEW','新增产品')");await assert.rejects(query({exportAll:true,sourceType:"GIFT"}),/1000/);
  await db.close(); console.log(JSON.stringify({ postgres: "isolated PGlite", productionWrites: 0,
    checks: ["gift and purchase both queryable", "future catalog kind dynamically selectable", "source/product/status/store/customer/date filters", "RC/PP exact lookup", "archived product history retained", "Mini ALL adapter includes all states", "HQ-only query permission retained"] }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
