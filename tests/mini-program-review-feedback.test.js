"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const pagePath = path.resolve(__dirname, "../miniprogram-app/miniprogram/pages/reviews/index.js");
function reviewPage(callStaff) {
  let definition;
  vm.runInNewContext(fs.readFileSync(pagePath, "utf8"), {
    Page(value) { definition = value; },
    require(name) {
      if (name.endsWith("api")) return { callStaff };
      if (name.endsWith("session")) return {};
      if (name.endsWith("query-tools")) return {};
      throw new Error(`Unexpected dependency ${name}`);
    }
  });
  return { ...definition, data: structuredClone(definition.data), setData(value) { Object.assign(this.data, value); } };
}

test("review failure remains visible in the open dialog, retains the note, and guards duplicate clicks", async () => {
  let rejectRequest, calls = 0;
  const page = reviewPage(() => { calls++; return new Promise((_, reject) => { rejectRequest = reject; }); });
  const row = { id: "qa-1", recordCode: "RC260905000001", status: "PENDING" };
  page.data.rows = [row];
  page.openDecision({ currentTarget: { dataset: { id: row.id, decision: "REJECTED" } } });
  page.inputReviewNote({ detail: { value: "示例审核说明" } });
  const request = page.confirmDecision();
  await page.confirmDecision();
  page.closeDecision();
  assert.equal(calls, 1);
  assert.equal(page.data.pendingOpen, true);
  assert.equal(page.data.deciding, true);
  rejectRequest(new Error("网络暂不可用"));
  await request;
  assert.equal(page.data.decisionError, "网络暂不可用");
  assert.equal(page.data.reviewNote, "示例审核说明");
  assert.equal(page.data.pending.id, row.id);
  assert.equal(page.data.pendingOpen, true);
  assert.equal(page.data.deciding, false);
  page.closeDecision();
  page.openDecision({ currentTarget: { dataset: { id: row.id, decision: "APPROVED" } } });
  assert.equal(page.data.decisionError, "");
  assert.equal(page.data.reviewNote, "");
});

test("successful product review closes the dialog and refreshes the current server page", async () => {
  const calls = [];
  const page = reviewPage(async (action, data) => { calls.push({ action, data }); });
  page.data.type = "product-purchase";
  page.data.page = 3;
  page.data.pending = { id: "qa-2", recordCode: "PP20260905123456" };
  page.data.pendingOpen = true;
  page.data.reviewNote = " 示例说明 ";
  page.data.decisionError = "上次请求失败";
  let refreshedPage;
  page.load = async (number) => { refreshedPage = number; };
  await page.confirmDecision();
  assert.equal(calls[0].action, "reviewRetailProductPurchase");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].data)), { recordId: "qa-2", decision: "APPROVED", note: "示例说明" });
  assert.equal(page.data.pendingOpen, false);
  assert.equal(page.data.pending, null);
  assert.equal(page.data.decisionError, "");
  assert.equal(refreshedPage, 3);
});
