"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
const root = path.resolve(__dirname, "../miniprogram-app/miniprogram");
test("all authored templates keep store, project and retail codes out of rendered text", () => {
  function scan(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && !["node_modules", "miniprogram_npm"].includes(entry.name)) scan(file);
      else if (entry.isFile() && file.endsWith(".wxml")) {
        assert.doesNotMatch(fs.readFileSync(file, "utf8"), />[^<]*\{\{[^}]*(?:storeCode|store_code|productCode|product_code|projectCode|project_code|storeHero\.code)/i, path.relative(root, file));
      }
    }
  }
  scan(root);
});
function page(name, api, wx = {}) {
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(root, "pages", name, "index.js"), "utf8"), {
    Page(value) { definition = value; }, wx: { setNavigationBarTitle() {}, ...wx },
    require(id) {
      if (id.endsWith("/api")) return { callStaff: api, callFace: api };
      if (id.endsWith("/session")) return { requireSession: () => ({ role: "hq" }) };
      return require(path.resolve(root, "pages", name, id));
    }
  });
  return { ...definition, data: JSON.parse(JSON.stringify(definition.data)), setData(changes, callback) { Object.assign(this.data, changes); callback?.(); } };
}
test("name-only product query keeps duplicate-name store and product IDs distinct", async () => {
  const requests = [];
  const p = page("records", async (action, payload) => {
    requests.push({ action, payload });
    if (action === "listStores") return { stores: [
      { id: "91", store_name: "同名门店", store_code: "STR091" },
      { id: "92", store_name: "同名门店", store_code: "STR092" }
    ] };
    assert.equal(action, "listRetailProductPurchaseReviews");
    return { orders: [], total: 0, products: [
      { productId: "201", productName: "医用面膜", productCode: "PDT201" },
      { productId: "202", productName: "医用面膜", productCode: "PDT202", productStatus: "ARCHIVED" }
    ] };
  });
  await p.onLoad({ type: "product" });
  assert.deepEqual(Array.from(p.data.storeLabels), ["全部门店", "同名门店", "同名门店"]);
  assert.deepEqual(Array.from(p.data.productLabels), ["全部产品", "医用面膜", "医用面膜 · （已封存）"]);
  p.chooseStore({ detail: { value: 2 } }); p.chooseProduct({ detail: { value: 2 } });
  await p.load(1);
  const request = requests.at(-1);
  assert.equal(request.payload.storeId, "92"); assert.equal(request.payload.retailProductId, "202");
  assert.equal(request.payload.status, ""); assert.equal(request.payload.sourceType, "");
});
test("retail management feedback hides both new and legacy creation codes and keeps status target exact", async () => {
  for (const created of [{ code: "PDT202", name: "医用面膜" }, { code: "PDT202" }]) {
    let modal, mutation;
    const p = page("retail-product-management", async (action, payload) => {
      if (action === "setRetailProductStatus") { mutation = payload; return {}; }
      assert.equal(action, "listRetailProducts");
      return { products: [{ id: "202", product_code: "PDT202", product_name: "医用面膜", product_status: "ACTIVE" }] };
    }, { getStorageSync: () => created, removeStorageSync() {}, showModal(options) { modal = options; options.success({ confirm: true }); } });
    p.onLoad(); p.onShow();
    assert.doesNotMatch(p.data.message, /PDT202/);
    await p.load();
    await p.toggleStatus({ currentTarget: { dataset: { ref: "PDT202" } } });
    assert.equal(modal.content, "确认封存“医用面膜”？");
    assert.equal(mutation.productRef, "PDT202"); assert.equal(mutation.status, "ARCHIVED");
  }
});
