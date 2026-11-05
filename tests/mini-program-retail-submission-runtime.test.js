"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
function page(name = "recharge", role = "teacher", fail = false) {
  let definition; const calls = [], intents = [];
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, `../miniprogram-app/miniprogram/pages/${name}/index.js`), "utf8"), {
    Page(value) { definition = value; }, wx: { redirectTo() {} },
    require(id) {
      if (id.endsWith("/api")) return { async callFace(action, payload) {
        calls.push({ action, payload });
        if (fail) throw Object.assign(Error("synthetic response interrupted"), { submissionUncertain: true });
        return { recordStatus: "PENDING", rechargeId: "41", rechargeCode: "RC-QA", purchaseId: "42", purchaseCode: "PP-QA", productGifts: payload.productGifts };
      } };
      if (id.endsWith("/session")) return { requireSession: () => null, getSelectedStore: () => null };
      if (id.endsWith("/submission")) return { begin(type, payload) { intents.push({ type, payload }); return { clientRequestId: "original-request" }; }, confirm: () => ({ clientRequestId: "original-request" }), clear() {}, markUncertain() {} };
      throw Error(id);
    }
  });
  const instance = { ...definition, data: JSON.parse(JSON.stringify(definition.data)), setData(value) { Object.assign(this.data, value); }, openSubmittedOrder() {}, recoverPending: async () => {} };
  Object.assign(instance.data, { session: { role }, store: { id: "1" }, customer: { customerCode: "QA-C" }, selectedProduct: { productId: "2", id: "7" },
    selectedTeacher: { teacherId: "9" }, teacherOptionsReady: true, unitCount: "5", ready: true,
    selectedGiftProduct: { productId: "7", productCode: "QA-P", productName: "医用面膜" }, giftProductQuantity: "3" });
  return { instance, calls, intents };
}
for (const role of ["store", "teacher"]) {
  test(`${role}: submitting a completed gift row without ＋ sends it atomically with recharge`, async () => {
    const { instance, calls, intents } = page("recharge", role);
    await instance.submit(); assert.equal(calls.length, 1);
    assert.equal(calls[0].action, "createRechargeApplication");
    assert.deepEqual(JSON.parse(JSON.stringify(calls[0].payload.productGifts)), [{ retailProductId: "7", unitCount: 3 }]);
    assert.equal(intents[0].payload.productGifts[0].retailProductId, "7");
    assert.equal(instance.data.selectedGiftProduct, null); assert.equal(instance.data.giftProductQuantity, "");
  });
}
test("already-added gifts and final draft are retained once, with duplicate or capacity errors blocking submission", async () => {
  const { instance, calls } = page();
  instance.data.productGifts = [{ retailProductId: "6", unitCount: 2 }];
  await instance.submit(); assert.equal(calls[0].payload.productGifts.length, 2);
  for (const gifts of [[{ retailProductId: "7", unitCount: 2 }], Array.from({ length: 20 }, (_, i) => ({ retailProductId: String(i + 20), unitCount: 1 }))]) {
    const p = page(); p.instance.data.productGifts = gifts; await p.instance.submit();
    assert.equal(p.calls.length, 0); assert.equal(p.intents.length, 0); assert.equal(p.instance.data.error, true);
  }
  const added = page(); assert.equal(added.instance.addProductGift(), true); await added.instance.submit();
  assert.equal(added.calls[0].payload.productGifts.length, 1, "manual ＋ and direct submit must not double the same row");
});
test("partial or invalid gift drafts never disappear into a successful no-gift recharge", async () => {
  for (const quantity of ["", "0", "1.5", "1000", "abc"]) {
    const { instance, calls, intents } = page(); instance.data.giftProductQuantity = quantity;
    await instance.submit(); assert.equal(calls.length, 0); assert.equal(intents.length, 0);
    assert.equal(instance.data.selectedGiftProduct.productName, "医用面膜"); assert.equal(instance.data.error, true);
  }
  const p = page(); p.instance.data.selectedGiftProduct = null; await p.instance.submit();
  assert.equal(p.calls.length, 0); assert.match(p.instance.data.message, /选择/);
});
test("a timeout retains the exact gift-bearing intent and lock; a second click cannot submit again", async () => {
  const { instance, calls, intents } = page("recharge", "teacher", true);
  await instance.submit(); assert.equal(instance.data.locked, true); assert.equal(intents[0].payload.productGifts[0].unitCount, 3);
  instance.data.ready = true; await instance.submit(); assert.equal(calls.length, 1); assert.equal(intents.length, 1);
});
test("no gift stays optional; refund discards stray draft fields and does not enter gift submission", async () => {
  const p = page(); p.instance.data.selectedGiftProduct = null; p.instance.data.giftProductQuantity = "";
  await p.instance.submit(); assert.equal(p.calls[0].payload.productGifts.length, 0);
  const refund = page(); refund.instance.data.refund = true; await refund.instance.submit();
  assert.equal(refund.calls[0].payload.applicationType, "REFUND"); assert.equal(refund.calls[0].payload.productGifts.length, 0);
});
test("the same retail product purchase uses the independent purchase action and idempotency family", async () => {
  for (const role of ["store", "teacher"]) {
    const { instance, calls, intents } = page("product-purchase", role);
    await instance.submit(); assert.equal(calls.length, 1); assert.equal(calls[0].action, "createRetailProductPurchaseApplication");
    assert.equal(calls[0].payload.retailProductId, "7"); assert.equal(calls[0].payload.unitCount, 5);
    assert.equal(intents[0].type, "PRODUCT_PURCHASE"); assert.equal(calls[0].payload.productGifts, undefined);
  }
});

test("new catalog product kinds are selectable by their returned id without a fixed product-name list", async () => {
  const gifts = page();
  gifts.instance.data.giftProducts = Array.from({ length: 37 }, (_, i) => ({ productId: String(i + 100), productCode: `NEW-${i}`, productName: `新增产品种类${i}` }));
  gifts.instance.selectGiftProduct({ detail: { value: 37 } });
  gifts.instance.inputGiftQuantity({ detail: { value: "4" } });
  await gifts.instance.submit();
  assert.equal(gifts.calls[0].payload.productGifts[0].retailProductId, "136");
  assert.equal(gifts.calls[0].payload.productGifts[0].unitCount, 4);
  const purchase = page("product-purchase");
  purchase.instance.data.products = Array.from({ length: 37 }, (_, i) => ({ id: String(i + 100), code: `NEW-${i}`, name: `新增产品种类${i}` }));
  purchase.instance.selectProduct({ detail: { value: 37 } }); await purchase.instance.submit();
  assert.equal(purchase.calls[0].payload.retailProductId, "136");
});
