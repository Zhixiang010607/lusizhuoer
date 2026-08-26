"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const business = read("store-business.js");

function functionSource(source, name) {
  const marker = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = marker.exec(source);
  assert.ok(match, `function ${name} must exist`);
  const signatureEnd = source.indexOf(") {", match.index + match[0].length);
  assert.ok(signatureEnd >= 0, `function ${name} signature must be complete`);
  const bodyStart = signatureEnd + 2;
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(match.index, index + 1);
    }
  }
  throw new Error(`function ${name} body is incomplete`);
}

function customerPagingHarness(callCustomerEnrollment) {
  const context = { module: { exports: {} }, callCustomerEnrollment };
  vm.createContext(context);
  vm.runInContext([
    functionSource(business, "normalizedActiveCustomer"),
    functionSource(business, "activeCustomerCursorKey"),
    functionSource(business, "fetchAllActiveStoreCustomers"),
    "module.exports = { fetchAllActiveStoreCustomers };"
  ].join("\n"), context);
  return {
    fetchAllActiveStoreCustomers: context.module.exports.fetchAllActiveStoreCustomers,
    setCaller(next) { context.callCustomerEnrollment = next; }
  };
}

test("web business customer selector reads every cursor page in stable order and de-duplicates codes", async () => {
  const calls = [];
  const firstCursor = { customerName: "乙", birthDate: "2000-02-02", customerCode: "C002" };
  const harness = customerPagingHarness(async (payload) => {
    calls.push(JSON.parse(JSON.stringify(payload)));
    if (calls.length === 1) {
      return {
        storeId: "S1",
        storeName: "第一门店",
        customers: [
          { customerCode: "C001", customerName: "甲", birthDate: "2000-01-01" },
          { customerCode: "C002", customerName: "乙", birthDate: "2000-02-02" }
        ],
        hasMore: true,
        nextCursor: firstCursor
      };
    }
    return {
      storeId: "S1",
      storeName: "第一门店",
      customers: [
        { customerCode: "C002", customerName: "乙", birthDate: "2000-02-02" },
        { customerCode: "C003", customerName: "丙", birthDate: "2000-03-03" }
      ],
      hasMore: false,
      nextCursor: null
    };
  });
  const progress = [];
  const result = await harness.fetchAllActiveStoreCustomers({
    expectedStoreId: "S1",
    isCurrent: () => true,
    onProgress: (count) => progress.push(count)
  });

  assert.deepEqual(JSON.parse(JSON.stringify(result.customers.map((customer) => customer.id))), ["C001", "C002", "C003"]);
  assert.deepEqual(progress, [2, 3]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].cursor, undefined);
  assert.deepEqual(calls[1].cursor, firstCursor);
});

test("web exact name and birthday search retains its filters on every cursor page", async () => {
  const calls = [];
  const cursor = { customerName: "同名", birthDate: "2001-06-07", customerCode: "C010" };
  const harness = customerPagingHarness(async (payload) => {
    calls.push(JSON.parse(JSON.stringify(payload)));
    return calls.length === 1
      ? { storeId: "S1", customers: [], hasMore: true, nextCursor: cursor }
      : { storeId: "S1", customers: [], hasMore: false, nextCursor: null };
  });

  await harness.fetchAllActiveStoreCustomers({
    customerName: "同名",
    birthDate: "2001-06-07",
    expectedStoreId: "S1"
  });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.customerName, "同名");
    assert.equal(call.birthDate, "2001-06-07");
  }
  assert.deepEqual(calls[1].cursor, cursor);
});

test("web customer pagination refuses stale stores, stale pages and broken cursors", async () => {
  let resolvePage;
  let current = true;
  let calls = 0;
  const pendingPage = new Promise((resolve) => { resolvePage = resolve; });
  const harness = customerPagingHarness(async () => {
    calls += 1;
    return pendingPage;
  });
  const staleResult = harness.fetchAllActiveStoreCustomers({ expectedStoreId: "S1", isCurrent: () => current });
  current = false;
  resolvePage({
    storeId: "S1",
    customers: [{ customerCode: "C001", customerName: "甲", birthDate: "2000-01-01" }],
    hasMore: true,
    nextCursor: { customerName: "甲", birthDate: "2000-01-01", customerCode: "C001" }
  });
  assert.equal(await staleResult, null);
  assert.equal(calls, 1, "a stale response must not request or render the next page");

  harness.setCaller(async () => ({ storeId: "S2", customers: [], hasMore: false, nextCursor: null }));
  await assert.rejects(
    harness.fetchAllActiveStoreCustomers({ expectedStoreId: "S1" }),
    /其他门店的数据/
  );

  harness.setCaller(async () => ({ storeId: "S1", customers: [], hasMore: true, nextCursor: null }));
  await assert.rejects(
    harness.fetchAllActiveStoreCustomers({ expectedStoreId: "S1" }),
    /分页游标无效/
  );
});

test("web business pages keep native scrolling selection plus exact lookup and scope invalidation", () => {
  for (const page of ["recharge-create.html", "refund-create.html", "verification-create.html", "verification-experience.html"]) {
    const html = read(page);
    assert.match(html, /<select id="serviceCustomerSelect"><\/select>/, `${page} must retain the native scrolling customer select`);
    assert.match(html, /id="serviceCustomerName"/, `${page} must retain exact name lookup`);
    assert.match(html, /id="serviceCustomerBirthday"/, `${page} must retain exact birthday lookup`);
    assert.ok(html.includes("store-business.js?v=0.14.60"), `${page} must load the current cursor-aware workflow`);
  }
  assert.ok(business.includes("scopeRequest === customerLookupScopeRequest"), "late responses must be tied to the current store scope");
  assert.ok(business.includes('window.addEventListener("pagehide"'), "leaving a page invalidates pending customer reads");
  assert.ok(business.includes("seenCustomerCodes.has(customer.id)"), "cursor overlap must not duplicate customer options");
  assert.ok(business.includes("candidateCustomer?.id === id ? candidateCustomer : null"), "an exact match can be confirmed while the full selector is still loading");
  assert.ok(!business.includes("先显示前 100 位"), "the selector must no longer claim that only the first 100 customers are selectable");
});
