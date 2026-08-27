"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const mini = path.join(root, "miniprogram-app", "miniprogram");

function read(...parts) {
  return fs.readFileSync(path.join(mini, ...parts), "utf8");
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function loadPicker(callFace) {
  let definition;
  vm.runInNewContext(read("components", "customer-picker", "index.js"), {
    Component(value) { definition = value; },
    require(id) {
      if (id === "../../services/api") return { callFace };
      if (id === "../../services/query-tools") return { businessToday: () => "2099-12-31" };
      throw new Error(`unexpected customer-picker dependency ${id}`);
    },
    console, Date, Math, Promise, String, Number, Boolean, Object, Array, Set
  }, { filename: "components/customer-picker/index.js" });
  assert.ok(definition);
  return definition;
}

function pickerInstance(definition, storeId = "7") {
  const events = [];
  const instance = Object.assign({}, definition.methods, {
    properties: { storeId },
    data: JSON.parse(JSON.stringify(definition.data)),
    setData(patch) { Object.assign(this.data, patch); },
    triggerEvent(name, detail) { events.push({ name, detail }); }
  });
  return { instance, events };
}

function row(customerCode, customerName, birthDate = "2000-01-01") {
  return { customerCode, customerName, birthDate };
}

test("active customer dropdown reads every cursor page and deduplicates customer codes", async () => {
  const calls = [];
  const firstCursor = { customerName: "乙", birthDate: "2000-01-02", customerCode: "C-2" };
  const definition = loadPicker(async (action, payload) => {
    assert.equal(action, "listActiveStoreCustomers");
    calls.push(JSON.parse(JSON.stringify(payload)));
    if (!payload.cursor) {
      return {
        customers: [row("C-1", "甲", "2000-01-01"), row("C-2", "乙", "2000-01-02")],
        hasMore: true,
        nextCursor: firstCursor
      };
    }
    return {
      customers: [row("C-2", "乙", "2000-01-02"), row("C-3", "丙", "2000-01-03")],
      hasMore: false,
      nextCursor: null
    };
  });
  const { instance } = pickerInstance(definition);

  await instance.reload();
  assert.deepEqual(Array.from(instance.data.customers, (item) => item.customerCode), ["C-1", "C-2", "C-3"]);
  assert.deepEqual(Array.from(instance.data.customerLabels), [
    "请选择现有客户（共 3 位）", "甲 · 2000-01-01", "乙 · 2000-01-02", "丙 · 2000-01-03"
  ]);
  assert.equal(instance.data.customerPickerIndex, 0);
  assert.deepEqual(calls, [
    { storeId: "7", limit: 100 },
    { storeId: "7", limit: 100, cursor: firstCursor }
  ]);
});

test("store and mode changes clear the list and ignore late pagination responses", async () => {
  const latePage = deferred();
  const latePageStarted = deferred();
  const cursor = { customerName: "甲", birthDate: "2000-01-01", customerCode: "C-1" };
  const definition = loadPicker(async (action, payload) => {
    assert.equal(action, "listActiveStoreCustomers");
    if (payload.storeId === "7" && payload.cursor) {
      latePageStarted.resolve();
      return latePage.promise;
    }
    if (payload.storeId === "7") return { customers: [row("C-1", "甲")], hasMore: true, nextCursor: cursor };
    if (payload.storeId === "8") return { customers: [row("C-8", "新门店客户")], hasMore: false, nextCursor: null };
    throw new Error(`unexpected store ${payload.storeId}`);
  });
  const { instance, events } = pickerInstance(definition);

  const oldLoad = instance.reload();
  await latePageStarted.promise;
  instance.properties.storeId = "8";
  await instance.reload();
  latePage.resolve({ customers: [row("C-OLD", "旧响应")], hasMore: false, nextCursor: null });
  await oldLoad;
  assert.deepEqual(Array.from(instance.data.customers, (item) => item.customerCode), ["C-8"]);

  instance.changeMode({ currentTarget: { dataset: { mode: "manual" } } });
  assert.deepEqual(Array.from(instance.data.customers), []);
  assert.deepEqual(Array.from(instance.data.customerLabels), ["请选择现有客户"]);
  assert.equal(instance.data.customerPickerIndex, 0);
  assert.equal(instance.data.selectedCustomerCode, "");
  assert.equal(events.at(-1).name, "change");
  assert.equal(events.at(-1).detail.customer, null);
});

test("customer picker renders a native dropdown and keeps exact search separate", () => {
  const markup = read("components", "customer-picker", "index.wxml");
  const style = read("components", "customer-picker", "index.wxss");
  const source = read("components", "customer-picker", "index.js");

  assert.match(markup, /<picker[^>]*mode="selector"[^>]*range="\{\{customerLabels\}\}"[^>]*bindchange="selectListedCustomer"/);
  assert.match(markup, /data-mode="manual"[^>]*>姓名／生日<\/button>/);
  assert.match(markup, /姓名或生日任填一项；两项都填时同时匹配/);
  assert.match(markup, /bindtap="clearBirthday"/);
  assert.match(markup, />请选择客户<\/text>/);
  const duplicateMarkup = markup.slice(markup.indexOf('class="duplicate-list"'), markup.indexOf('wx:if="{{candidate}}"'));
  assert.doesNotMatch(duplicateMarkup, /请选择客户编号|<text[^>]*>\s*\{\{item\.customerCode\}\}/,
    "duplicate-name choices use name and birthday while the database code remains an internal key");
  assert.match(markup, /点开下拉框后可上下滑动选择全部客户/);
  assert.doesNotMatch(markup, /class="customer-list"|bindscrolltolower="loadMoreCustomers"/);
  assert.match(style, /\.customer-select-control\s*\{[^}]*min-height:\s*84rpx/);
  assert.match(style, /\.search\s*\{[^}]*display:\s*flex;[^}]*align-items:\s*center;[^}]*justify-content:\s*center;[^}]*line-height:\s*1;[^}]*text-align:\s*center;/s,
    "the exact-search label must be centered in both axes instead of inheriting the native button line box");
  assert.match(source, /callFace\("listActiveStoreCustomers", payload\)/);
  assert.match(source, /if \(cursor\) payload\.cursor = \{ \.\.\.cursor \}/);
  assert.match(source, /while \(true\)/);
  assert.doesNotMatch(source, /loadMoreCustomers/);
});

test("manual lookup accepts either name or birthday and reads every matching cursor page", async () => {
  const calls = [];
  const cursor = { customerName: "同名", birthDate: "2000-01-01", customerCode: "C-1" };
  const definition = loadPicker(async (action, payload) => {
    assert.equal(action, "listActiveStoreCustomers");
    calls.push(JSON.parse(JSON.stringify(payload)));
    if (!payload.cursor) {
      return { customers: [row("C-1", "同名")], hasMore: true, nextCursor: cursor };
    }
    return { customers: [row("C-2", "同名", "2001-02-02")], hasMore: false, nextCursor: null };
  });
  const { instance } = pickerInstance(definition);
  instance.data.manualName = "同名";

  await instance.manualSearch();

  assert.equal(instance.data.duplicateMatches.length, 2);
  assert.match(instance.data.message, /找到 2 位匹配客户/);
  assert.deepEqual(calls, [
    { storeId: "7", limit: 100, customerName: "同名" },
    { storeId: "7", limit: 100, customerName: "同名", cursor }
  ]);
});

test("manual lookup accepts birthday alone and rejects only a completely empty search", async () => {
  const calls = [];
  const definition = loadPicker(async (action, payload) => {
    assert.equal(action, "listActiveStoreCustomers");
    calls.push(JSON.parse(JSON.stringify(payload)));
    return {
      customers: [row("C-1", "甲", "2001-06-07"), row("C-2", "乙", "2001-06-07")],
      hasMore: false,
      nextCursor: null
    };
  });
  const { instance } = pickerInstance(definition);

  await instance.manualSearch();
  assert.equal(calls.length, 0);
  assert.equal(instance.data.error, true);
  assert.match(instance.data.message, /至少填写一项/);

  instance.data.manualBirthday = "2001-06-07";
  await instance.manualSearch();
  assert.deepEqual(calls, [{ storeId: "7", limit: 100, birthDate: "2001-06-07" }]);
  assert.equal(instance.data.duplicateMatches.length, 2);
  instance.clearBirthday();
  assert.equal(instance.data.manualBirthday, "");
});

test("dropdown selection resolves the selected customer and loads the same photo confirmation", async () => {
  const definition = loadPicker(async (action, payload) => {
    if (action === "listActiveStoreCustomers") {
      return { customers: [row("C-1", "甲"), row("C-2", "乙", "2000-02-02")], hasMore: false };
    }
    assert.equal(action, "getActiveStoreCustomerDetail");
    assert.equal(payload.customerCode, "C-2");
    return { customer: row("C-2", "乙", "2000-02-02"), photoUrl: "https://example.test/c-2.jpg" };
  });
  const { instance } = pickerInstance(definition);

  await instance.reload();
  await instance.selectListedCustomer({ detail: { value: "2" } });
  assert.equal(instance.data.customerPickerIndex, 2);
  assert.equal(instance.data.selectedCustomerCode, "C-2");
  assert.equal(instance.data.candidate.customerCode, "C-2");
  assert.equal(instance.data.photoUrl, "https://example.test/c-2.jpg");
});
