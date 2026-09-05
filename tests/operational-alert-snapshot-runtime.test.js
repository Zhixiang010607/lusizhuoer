"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const cloud = fs.readFileSync(path.join(root, "cloudfunctions/faceRecognition/index.js"), "utf8");

function sqlResult(rows) {
  const values = Array.isArray(rows) ? rows : rows ? [rows] : [];
  if (!values.length) return { Columns: [], Rows: [] };
  const columns = Object.keys(values[0]);
  return { Columns: columns, Rows: values.map((row) => columns.map((column) => row[column])) };
}

function runtime() {
  const sqlCalls = [];
  const inactiveRows = [
    {
      id: "11", customer_code: "CST011", customer_name: "零次客户", birth_date: null,
      customer_status: "ACTIVE", store_id: "3", store_code: "STR003", store_name: "测试门店",
      baseline_at: "2026-01-01T00:00:00Z", baseline_source: "NORMAL", balance_category: "ZERO",
      days_since: "247", last_verification_id: "51", last_verification_code: "VX51",
      last_verification_type: "NORMAL", last_product_name: "项目甲", cursor_baseline_at: "2026-01-01T00:00:00.000000Z",
      selected_total: "2", category_total: "2", zero_balance_customers: "1", nonzero_balance_customers: "1",
      normal_baseline: "1", experience_baseline: "1", never_verified: "0"
    },
    {
      id: "12", customer_code: "CST012", customer_name: "有余次客户", birth_date: null,
      customer_status: "ACTIVE", store_id: "3", store_code: "STR003", store_name: "测试门店",
      baseline_at: "2026-02-01T00:00:00Z", baseline_source: "EXPERIENCE", balance_category: "NONZERO",
      days_since: "216", last_verification_id: "52", last_verification_code: "VX52",
      last_verification_type: "EXPERIENCE", last_product_name: "项目乙", cursor_baseline_at: "2026-02-01T00:00:00.000000Z",
      selected_total: "2", category_total: "2", zero_balance_customers: "1", nonzero_balance_customers: "1",
      normal_baseline: "1", experience_baseline: "1", never_verified: "0"
    }
  ];
  const lowRows = [
    {
      customer_id: "11", customer_code: "CST011", customer_name: "零次客户", birth_date: null,
      store_id: "3", store_code: "STR003", store_name: "测试门店", product_id: "21",
      product_code: "PRD021", product_name: "项目甲", total_recharge_count: "10",
      total_verification_count: "10", remaining_count: "0", updated_at: "2026-09-01T00:00:00Z",
      balance_category: "ZERO", selected_total: "2", category_total: "2", customer_total: "2",
      product_total: "2", zero_balance: "1", nonzero_below_threshold: "1"
    },
    {
      customer_id: "12", customer_code: "CST012", customer_name: "低余次客户", birth_date: null,
      store_id: "3", store_code: "STR003", store_name: "测试门店", product_id: "22",
      product_code: "PRD022", product_name: "项目乙", total_recharge_count: "10",
      total_verification_count: "8", remaining_count: "2", updated_at: "2026-09-01T00:00:00Z",
      balance_category: "NONZERO", selected_total: "2", category_total: "2", customer_total: "2",
      product_total: "2", zero_balance: "1", nonzero_below_threshold: "1"
    }
  ];
  const executePGSql = async ({ Sql }) => {
    sqlCalls.push(Sql);
    if (Sql.includes("information_schema.columns")) {
      return sqlResult({ has_store_account_id: true, has_staff_store_assignments: false });
    }
    if (Sql.includes("FROM public.staff_accounts") && Sql.includes("WHERE auth_uid")) {
      return sqlResult({ staff_id: "7", role_code: "hq", account_status: "ACTIVE" });
    }
    if (Sql.includes("WITH eligible_customers AS")) return sqlResult(inactiveRows);
    if (Sql.includes("WITH eligible_balances AS")) return sqlResult(lowRows);
    throw new Error(`unexpected SQL: ${Sql}`);
  };
  const module = { exports: {} };
  const sandbox = {
    Buffer, URL, console: { error() {}, warn() {} }, exports: module.exports, module,
    process: { env: { CLOUDBASE_ENV_ID: "test-env" } },
    setTimeout, clearTimeout, setInterval, clearInterval,
    require(name) {
      if (name === "crypto") return require("node:crypto");
      if (name === "@cloudbase/node-sdk") {
        return { init: () => ({ auth: () => ({ getUserInfo: () => ({ uid: "hq-auth-uid" }) }) }) };
      }
      if (name === "@cloudbase/manager-node") {
        return { init: () => ({ database: { executePGSql } }) };
      }
      throw new Error(`unexpected dependency: ${name}`);
    }
  };
  vm.runInNewContext(cloud, sandbox, { filename: "cloudfunctions/faceRecognition/index.js" });
  return { main: module.exports.main, sqlCalls };
}

test("both operational warning sections and their exports come from one SQL snapshot", async () => {
  const { main, sqlCalls } = runtime();
  const inactive = await main({
    action: "queryInactiveVerificationCustomers", minimumDays: 30, balanceCategory: "BOTH", limit: 20
  });
  assert.equal(inactive.ok, true);
  assert.equal(inactive.sections.ZERO.customers.length, 1);
  assert.equal(inactive.sections.NONZERO.customers.length, 1);
  assert.equal(inactive.summary.selectedTotal, 2);

  const inactiveExport = await main({
    action: "queryInactiveVerificationCustomers", minimumDays: 30, balanceCategory: "BOTH", exportAll: true
  });
  assert.equal(inactiveExport.ok, true);
  assert.equal(inactiveExport.exportCustomers.length, 2);

  const low = await main({
    action: "queryLowBalanceCustomers", remainingBelow: 3, balanceCategory: "BOTH", limit: 20
  });
  assert.equal(low.ok, true);
  assert.equal(low.sections.ZERO.balances.length, 1);
  assert.equal(low.sections.NONZERO.balances.length, 1);
  assert.equal(low.summary.selectedTotal, 2);

  const lowExport = await main({
    action: "queryLowBalanceCustomers", remainingBelow: 3, balanceCategory: "BOTH", exportAll: true
  });
  assert.equal(lowExport.ok, true);
  assert.equal(lowExport.exportBalances.length, 2);

  assert.equal(sqlCalls.filter((sql) => sql.includes("WITH eligible_customers AS")).length, 2);
  assert.equal(sqlCalls.filter((sql) => sql.includes("WITH eligible_balances AS")).length, 2);
  assert.equal(sqlCalls.filter((sql) => sql.includes("summary AS") && sql.includes("page_rows AS")).length, 4,
    "each screen or export request must use one statement for summary and rows");
});
