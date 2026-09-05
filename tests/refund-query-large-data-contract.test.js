const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

test("refund query pages indexed business rows before display joins", () => {
  const source = read("cloudfunctions/faceRecognition/index.js");
  const queryStart = source.indexOf("async function queryStoreBusinessRecords");
  const queryEnd = source.indexOf("async function", queryStart + 20);
  const query = source.slice(queryStart, queryEnd > queryStart ? queryEnd : undefined);

  assert.match(source, /PHOTO_ONLY_FUNCTION \? "v10" : "v113"/);
  assert.match(query, /WITH page_records AS/);
  assert.match(query, /FROM page_records/);
  assert.match(query, /JOIN public\.customers customer_filter/);
  assert.doesNotMatch(query, /created_store_id\s*=\s*\$\{alias\}\.store_id/);
  assert.ok(
    query.indexOf("WITH page_records AS") < query.indexOf("FROM page_records"),
    "page CTE must be declared before display joins read it",
  );
});

test("schema and migration provide refund query cursor indexes", () => {
  const sources = [
    read("database/schema.rebuild.sql"),
    read("database/migrations/067_refund_query_performance.sql"),
    read("database/cloudbase-console/067-01-refund-query-performance.sql"),
  ];
  const indexes = [
    "idx_recharge_store_type_cursor",
    "idx_recharge_store_type_status_cursor",
    "idx_recharge_type_cursor",
    "idx_recharge_type_product_store_cursor",
  ];

  for (const source of sources) {
    for (const index of indexes) assert.match(source, new RegExp(index));
    assert.match(source, /recharge_type IN \('NEW', 'REFUND'\)/);
  }
});

test("console handoff verifies all refund query indexes", () => {
  const verify = read("database/cloudbase-console/067-readonly-verify.sql");
  assert.match(verify, /COUNT\(\*\) = 4 THEN 'READY'/);
  assert.match(verify, /recharge_type = 'REFUND'/);
});
