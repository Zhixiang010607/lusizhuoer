"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "cloudfunctions/faceRecognition/index.js"), "utf8");

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing source section ${start}`);
  return source.slice(from, to);
}

const dateParser = section("function optionalBusinessQueryDate", "function businessQueryDatabaseId");
const cursorRuntime = section("function activeStoreCustomerCursor", "function scopedQueryCursorTimestamp");

function harness(rowsByCall = []) {
  const sqlCalls = [];
  const context = {
    module: { exports: {} },
    exports: {},
    activeBusinessCaller: async () => ({ storeId: "7", storeCode: "S007", storeName: "测试门店" }),
    executeSql: async (sql) => {
      sqlCalls.push(sql);
      return rowsByCall[sqlCalls.length - 1] || [];
    }
  };
  vm.runInNewContext(`
    function fail(message, code = "BAD_REQUEST") {
      const error = new Error(message);
      error.code = code;
      throw error;
    }
    function sqlText(value) {
      return "'" + String(value == null ? "" : value).replace(/'/g, "''") + "'";
    }
    ${dateParser}
    ${cursorRuntime}
    module.exports = { activeStoreCustomerCursor, listActiveStoreCustomers };
  `, context, { filename: "active-store-customer-cursor-runtime.js" });
  return { ...context.module.exports, sqlCalls };
}

test("listActiveStoreCustomers keeps old calls compatible and returns a stable next cursor", async () => {
  const subject = harness([[
    { customer_code: "C-001", customer_name: "阿安", birth_date: "1990-01-01", cursor_birth_date: "1990-01-01" },
    { customer_code: "C-002", customer_name: "阿安", birth_date: "1991-02-02", cursor_birth_date: "1991-02-02" },
    { customer_code: "C-003", customer_name: "白雪", birth_date: "1992-03-03", cursor_birth_date: "1992-03-03" }
  ]]);

  const result = await subject.listActiveStoreCustomers({ limit: 2 });

  assert.equal(result.ok, true);
  assert.equal(result.hasMore, true);
  assert.deepEqual(Array.from(result.customers, (row) => ({ ...row })), [
    { customerCode: "C-001", customerName: "阿安", birthDate: "1990-01-01" },
    { customerCode: "C-002", customerName: "阿安", birthDate: "1991-02-02" }
  ]);
  assert.deepEqual({ ...result.nextCursor }, {
    customerName: "阿安",
    birthDate: "1991-02-02",
    customerCode: "C-002"
  });
  assert.match(subject.sqlCalls[0], /ORDER BY customer_name ASC, COALESCE\(birth_date, DATE '0001-01-01'\) ASC, customer_code ASC/);
  assert.match(subject.sqlCalls[0], /LIMIT 3\s*$/);
});

test("the next cursor resumes strictly after the last name/birthdate/code tuple", async () => {
  const subject = harness([[
    { customer_code: "C-003", customer_name: "白雪", birth_date: "1992-03-03", cursor_birth_date: "1992-03-03" }
  ]]);
  const cursor = { customerName: "阿安", birthDate: "1991-02-02", customerCode: "C-002" };

  const result = await subject.listActiveStoreCustomers({ limit: 2, cursor });

  assert.equal(result.hasMore, false);
  assert.equal(result.nextCursor, null);
  assert.match(
    subject.sqlCalls[0],
    /AND \(customer_name, COALESCE\(birth_date, DATE '0001-01-01'\), customer_code\) > \('阿安', '1991-02-02'::date, 'C-002'\)/
  );
});

test("exact name and birthday search can paginate only with a matching cursor", async () => {
  const subject = harness([[]]);
  await subject.listActiveStoreCustomers({
    customerName: "同名客户",
    birthDate: "2000-01-01",
    cursor: { customerName: "同名客户", birthDate: "2000-01-01", customerCode: "C-100" }
  });
  assert.match(subject.sqlCalls[0], /AND customer_name = '同名客户' AND birth_date = '2000-01-01'::date/);

  await assert.rejects(
    () => subject.listActiveStoreCustomers({
      customerName: "同名客户",
      birthDate: "2000-01-01",
      cursor: { customerName: "另一位", birthDate: "2000-01-01", customerCode: "C-100" }
    }),
    (error) => error.code === "BAD_REQUEST" && /不一致/.test(error.message)
  );
  assert.equal(subject.sqlCalls.length, 1, "a mismatched cursor is rejected before database access");
});

test("customer cursors reject malformed, partial, padded, invalid-date, and extra fields", () => {
  const { activeStoreCustomerCursor } = harness();
  const invalid = [
    "not-an-object",
    "",
    [],
    {},
    { customerName: "甲", birthDate: "2000-01-01" },
    { customerName: "甲", birthDate: "2000-01-01", customerCode: "C-1", extra: "no" },
    { customerName: " 甲", birthDate: "2000-01-01", customerCode: "C-1" },
    { customerName: "甲", birthDate: "2000-02-31", customerCode: "C-1" },
    { customerName: "甲\n", birthDate: "2000-01-01", customerCode: "C-1" },
    { customerName: "甲", birthDate: "2000-01-01", customerCode: 1 }
  ];
  for (const cursor of invalid) {
    assert.throws(() => activeStoreCustomerCursor(cursor), (error) => error.code === "BAD_REQUEST");
  }
  assert.equal(activeStoreCustomerCursor(undefined), null);
  assert.equal(activeStoreCustomerCursor(null), null);
});

test("cursor values are SQL-escaped instead of interpolated as executable text", async () => {
  const subject = harness([[]]);
  await subject.listActiveStoreCustomers({
    cursor: {
      customerName: "O'Brien",
      birthDate: "2000-01-01",
      customerCode: "C'002"
    }
  });
  assert.match(subject.sqlCalls[0], /\('O''Brien', '2000-01-01'::date, 'C''002'\)/);
});
