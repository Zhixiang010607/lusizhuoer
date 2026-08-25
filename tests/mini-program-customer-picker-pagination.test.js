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

test("active customer list appends cursor pages and deduplicates customer codes", async () => {
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
  assert.deepEqual(Array.from(instance.data.customers, (item) => item.customerCode), ["C-1", "C-2"]);
  assert.equal(instance.data.hasMore, true);
  assert.deepEqual(JSON.parse(JSON.stringify(instance.data.nextCursor)), firstCursor);

  await instance.loadMoreCustomers();
  assert.deepEqual(Array.from(instance.data.customers, (item) => item.customerCode), ["C-1", "C-2", "C-3"]);
  assert.equal(instance.data.hasMore, false);
  assert.equal(instance.data.nextCursor, null);
  assert.deepEqual(calls, [
    { storeId: "7", limit: 100 },
    { storeId: "7", limit: 100, cursor: firstCursor }
  ]);
});

test("store and mode changes clear the list and ignore late pagination responses", async () => {
  const latePage = deferred();
  const cursor = { customerName: "甲", birthDate: "2000-01-01", customerCode: "C-1" };
  const definition = loadPicker(async (action, payload) => {
    assert.equal(action, "listActiveStoreCustomers");
    if (payload.storeId === "7" && payload.cursor) return latePage.promise;
    if (payload.storeId === "7") return { customers: [row("C-1", "甲")], hasMore: true, nextCursor: cursor };
    if (payload.storeId === "8") return { customers: [row("C-8", "新门店客户")], hasMore: false, nextCursor: null };
    throw new Error(`unexpected store ${payload.storeId}`);
  });
  const { instance, events } = pickerInstance(definition);

  await instance.reload();
  const oldAppend = instance.loadMoreCustomers();
  instance.properties.storeId = "8";
  await instance.reload();
  latePage.resolve({ customers: [row("C-OLD", "旧响应")], hasMore: false, nextCursor: null });
  await oldAppend;
  assert.deepEqual(Array.from(instance.data.customers, (item) => item.customerCode), ["C-8"]);

  instance.changeMode({ currentTarget: { dataset: { mode: "manual" } } });
  assert.deepEqual(Array.from(instance.data.customers), []);
  assert.equal(instance.data.nextCursor, null);
  assert.equal(instance.data.hasMore, false);
  assert.equal(instance.data.selectedCustomerCode, "");
  assert.equal(events.at(-1).name, "change");
  assert.equal(events.at(-1).detail.customer, null);
});

test("customer picker renders an internal vertical infinite list and keeps exact search separate", () => {
  const markup = read("components", "customer-picker", "index.wxml");
  const style = read("components", "customer-picker", "index.wxss");
  const source = read("components", "customer-picker", "index.js");

  assert.match(markup, /<scroll-view[^>]*class="customer-list"[^>]*scroll-y[^>]*bindscrolltolower="loadMoreCustomers"/);
  assert.match(markup, /data-mode="manual"[^>]*>姓名＋生日<\/button>/);
  assert.match(markup, /data-code="\{\{item\.customerCode\}\}"[^>]*bindtap="selectListedCustomer"/);
  assert.match(style, /\.customer-list\s*\{[^}]*height:\s*430rpx/);
  assert.match(source, /callFace\("listActiveStoreCustomers", payload\)/);
  assert.match(source, /if \(cursor\) payload\.cursor = \{ \.\.\.cursor \}/);
  assert.doesNotMatch(markup, /<picker[^>]*range="\{\{customerLabels\}\}"/);
});
