"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const pageRoot = path.join(root, "miniprogram-app", "miniprogram", "pages", "customer-detail");
const js = fs.readFileSync(path.join(pageRoot, "index.js"), "utf8");
const wxml = fs.readFileSync(path.join(pageRoot, "index.wxml"), "utf8");
const wxss = fs.readFileSync(path.join(pageRoot, "index.wxss"), "utf8");

test("mini customer profile paginates every business history at twenty rows", () => {
  assert.match(js, /const HISTORY_LIMIT = 20;/);
  for (const type of ["RECHARGE", "REFUND", "VERIFICATION", "EXPERIENCE", "PRODUCT_PURCHASE"]) {
    assert.match(js, new RegExp(`${type}: \\{ page: 1, cursorStack: \\[null\\], hasMore: false, nextCursor: null, loading: false`));
  }
  for (const field of ["historyType: type", "historyLimit: HISTORY_LIMIT", "cursorSubmittedAt", "cursorId"]) {
    assert.match(js, new RegExp(field));
  }
  assert.match(js, /callFace\("listCustomerMessages", payload\)/);
  assert.match(js, /messageLimit: MESSAGE_LIMIT/);
  assert.match(js, /cursorCreatedAt/);
  assert.match(js, /cursorMessageId/);
  assert.match(js, /callFace\("addCustomerMessage"/);
  assert.match(js, /Array\.from\(content\)\.length/);
  assert.match(wxml, /maxlength="100"/);
  assert.match(wxml, /bindtap="previousHistoryPage"[^>]*>上一页<\/button>/);
  assert.match(wxml, /第 \{\{historyPage\}\} 页/);
  assert.match(wxml, /bindtap="nextHistoryPage"[^>]*>下一页<\/button>/);
  assert.doesNotMatch(wxml, /bindtap="loadMoreHistory"|>加载更多<\/button>|已载 \{\{visibleHistory\.length\}\} 条/);
  assert.match(wxml, /bindtap="loadMoreMessages"/);
  assert.match(wxml, /bindtap="submitMessage"[^>]*>发送留言<\/button>/);
  assert.match(wxss, /\.message-compose \{[^}]*flex-direction: column;[^}]*align-items: stretch;/s);
  assert.match(wxss, /\.submit-message-button \{[^}]*width: 100%;[^}]*align-items: center;[^}]*justify-content: center;[^}]*text-align: center;/s);
});

test("notes, customer status, recent dates, and photo failures retain role boundaries", () => {
  assert.match(wxml, /maxlength="5000"/);
  for (const handler of ["startEditNotes", "saveNotes", "cancelEditNotes"]) {
    assert.match(wxml, new RegExp(`bindtap="${handler}"`));
  }
  assert.match(js, /canManageStatus: session\.role === "hq" \|\| session\.role === "store"/);
  assert.match(js, /canEditNotes: \["hq", "store", "teacher"\]\.includes\(session\.role\)/);
  assert.match(js, /callFace\("updateCustomerStatus"/);
  assert.match(js, /savedStatus !== targetStatus/);
  assert.match(wxml, /最近充值/);
  assert.match(wxml, /最近核销/);
  assert.match(wxml, /客户建立/);
  assert.doesNotMatch(js, /photo-album|saveImageToAlbum|savePhoto|reloadPhoto/,
    "the customer profile no longer exposes photo reload or album writes");
  assert.doesNotMatch(wxml, /重读原图|保存到相册|bindtap="savePhoto"|bindtap="reloadPhoto"/);
  assert.match(wxml, /bindtap="previewPhoto"/,
    "the already loaded customer photo remains available for preview");
  const failedPhoto = js.slice(js.indexOf("photoFailed()"), js.indexOf("previewPhoto()"));
  assert.match(failedPhoto, /photoMessage:/);
  assert.doesNotMatch(failedPhoto, /message:/);
  assert.match(js, /void this\.loadPhoto\(\);[\s\S]*callFace\("getCustomerProfile"/,
    "profile data and the separately authorized photo must load independently");
});

test("notes and messages keep symmetric in-card spacing and the warm internal palette", () => {
  assert.match(wxss, /\.notes-card, \.messages-card \{[^}]*linear-gradient\(180deg, #fffaf3 0%, #fff6e8 100%\);[^}]*border-color: #dcc49c;/s);
  assert.match(wxss, /\.notes-read \{[^}]*width: 100%;[^}]*box-sizing: border-box;[^}]*overflow: hidden;[^}]*background: #fff7eb;[^}]*border: 1rpx solid #d8bc8c;/s,
    "the padded scroll view must remain inside the card instead of consuming the right inset");
  assert.match(wxss, /\.notes-input \{[^}]*background: #fff7eb;[^}]*border-color: #d8bc8c;/s);
  assert.match(wxss, /\.message-list \{[^}]*width: 100%;[^}]*box-sizing: border-box;/s);
  assert.match(wxss, /\.message-item \{[^}]*background: #f9edda;[^}]*border: 1rpx solid #dfc69e;/s);
  assert.match(wxss, /\.message-compose \{[^}]*padding: 16rpx;[^}]*background: #f5ead8;[^}]*border: 1rpx solid #dfc69e;[^}]*border-radius: 18rpx;/s);
  assert.match(wxss, /\.message-input \{[^}]*background: #fffaf3;[^}]*border-color: #d8bc8c;/s);
});

test("balance and history tables have exact centered single-line column widths", () => {
  for (const label of ["累计充值", "累计退费", "累计核销", "剩余", "业务老师", "提交时间", "状态"]) {
    assert.match(wxml, new RegExp(label));
  }
  assert.match(wxml, /item\.unitLabel/);
  assert.match(wxml, /item\.teacherLabel/);
  assert.match(wxml, /item\.submittedAtLabel/);
  assert.match(wxml, /item\.statusLabel/);
  assert.doesNotMatch(wxml, /item\.productCode/,
    "customer profile tables show product names without internal product codes");
  assert.match(wxss, /\.balance-table\s*\{[^}]*width:\s*auto;[^}]*min-width:\s*100%;[^}]*display:\s*inline-table;[^}]*table-layout:\s*auto;/s);
  assert.match(wxss, /\.balance-table-row\s*\{[^}]*display:\s*table-row;/s);
  assert.match(wxml, /historyType === 'RECHARGE' \|\| historyType === 'REFUND' \|\| historyType === 'PRODUCT_PURCHASE' \? 'recharge-history' : 'compact-history'/);
  assert.match(wxml, /historyType === 'PRODUCT_PURCHASE' \? 'product-history' : ''/);
  assert.match(wxml, /data-type="RECHARGE"[^>]*>充值<\/button>[\s\S]*data-type="REFUND"[^>]*>退费<\/button>/);
  assert.match(wxml, /data-type="PRODUCT_PURCHASE"[^>]*>产品<\/button>/);
  assert.match(wxml, /historyType === 'PRODUCT_PURCHASE' \? '产品' : '项目'/);
  assert.match(wxml, /historyType === 'PRODUCT_PURCHASE' \? '数量' : '次数'/);
  assert.match(wxss, /\.history-tabs \{[^}]*grid-template-columns: repeat\(5, minmax\(0, 1fr\)\);/);
  assert.match(wxss, /\.record-table\s*\{[^}]*width:\s*auto;[^}]*min-width:\s*100%;[^}]*display:\s*inline-table;[^}]*table-layout:\s*auto;/s);
  assert.match(wxss, /\.record-row\s*\{[^}]*display:\s*table-row;/s);
  assert.match(wxss, /\.balance-table-row text, \.record-row text\s*\{[^}]*display:\s*table-cell;[^}]*padding:\s*10rpx 18rpx;[^}]*font-size:\s*21rpx;[^}]*text-align:\s*center;[^}]*vertical-align:\s*middle;[^}]*white-space:\s*nowrap;/s);
  assert.match(wxss, /\.history-tabs button \{[^}]*align-items: center;[^}]*justify-content: center;[^}]*text-align: center;[^}]*white-space: nowrap;/s);
});

test("history tabs, paging, and full refresh reset the controlled horizontal position", () => {
  assert.match(js, /historyType: "RECHARGE", visibleHistory: \[\], historyPage: 1, historyHasMore: false, historyScrollLeft: 0/);
  assert.match(wxml, /class="table-scroll record-scroll"[^>]*scroll-left="\{\{historyScrollLeft\}\}"[^>]*bindscroll="rememberHistoryScroll"/);
  const loadSection = js.slice(js.indexOf("async load()"), js.indexOf("async loadPhoto()"));
  assert.match(loadSection, /historyScrollLeft: 0/);
  const changeStart = js.indexOf("changeHistory(event)");
  const changeSection = js.slice(changeStart, js.indexOf("syncHistory()", changeStart));
  assert.match(changeSection, /historyType: type, historyScrollLeft: 0/);
  assert.match(js, /rememberHistoryScroll\(event\)[\s\S]*this\.data\.historyScrollLeft = scrollLeft/);
  assert.match(js, /this\.setData\(\{ \[field\]: incoming, historyScrollLeft: 0 \}\)/);
});

test("history mapper preserves refund signs, teachers, dates, and server statuses", () => {
  let pageDefinition;
  const sandbox = {
    Page(definition) { pageDefinition = definition; },
    require(id) {
      if (id === "../../services/api") return { callFace: async () => ({}) };
      if (id === "../../services/session") return { requireSession: () => null };
      if (id === "../../services/photo-album") return { saveImageToAlbum: async () => ({ saved: true }) };
      if (id === "../../services/query-tools") {
        return {
          displayDate: (value) => String(value || "").slice(0, 10) || "—",
          displayDateAny: (...values) => String(values.find(Boolean) || "").slice(0, 10) || "—",
          displayDateTimeAny: (...values) => String(values.find(Boolean) || "")
        };
      }
      throw new Error(`unexpected dependency ${id}`);
    },
    wx: {}, console, String, Number, Boolean, Math, Date, Array, Object, Set,
    encodeURIComponent, decodeURIComponent, Promise
  };
  vm.runInNewContext(`${js}\nglobalThis.__customerDetailTest = { mapHistory, mapBalances };`, sandbox);
  assert.ok(pageDefinition);
  const mapped = sandbox.__customerDetailTest.mapHistory([{
    id: "7", rechargeCode: "RF7", rechargeType: "REFUND", unitCount: 3,
    productName: "项目", teacherName: "叶老师", teacherCode: "T7",
    submittedAt: "2026-08-25T01:00:00Z", recordStatus: "APPROVED"
  }], "RECHARGE")[0];
  assert.equal(mapped.unitLabel, "−3 次");
  assert.equal(mapped.teacherLabel, "叶老师");
  assert.equal(mapped.submittedAtLabel, "2026-08-25T01:00:00Z");
  assert.equal(mapped.statusLabel, "审核通过");
  const refund = sandbox.__customerDetailTest.mapHistory([{
    id: "7", rechargeCode: "RF7", rechargeType: "REFUND", unitCount: 3,
    recordStatus: "APPROVED"
  }], "REFUND")[0];
  assert.equal(refund.unitLabel, "−3 次");
  const newRecharge = sandbox.__customerDetailTest.mapHistory([{
    id: "8", rechargeType: "NEW", unitCount: 2, recordStatus: "PENDING"
  }], "RECHARGE")[0];
  assert.equal(newRecharge.unitLabel, "+2 次");
  const completed = sandbox.__customerDetailTest.mapHistory([{
    id: "9", verificationType: "NORMAL", unitCount: 1, recordStatus: "APPROVED"
  }], "VERIFICATION")[0];
  assert.equal(completed.statusLabel, "已完成");
  const supplement = sandbox.__customerDetailTest.mapHistory([{
    id: "10", verificationType: "SUPPLEMENT", unitCount: 1, recordStatus: "APPROVED"
  }], "VERIFICATION")[0];
  assert.equal(supplement.statusLabel, "审核通过");
  const purchase = sandbox.__customerDetailTest.mapHistory([{
    id: "11", purchaseCode: "PP20260826000011", unitCount: 3, recordStatus: "PENDING"
  }], "PRODUCT_PURCHASE")[0];
  assert.equal(purchase.recordCode, "PP20260826000011");
  assert.equal(purchase.unitLabel, "3 件");
  assert.equal(purchase.statusLabel, "待审核");
  const balance = sandbox.__customerDetailTest.mapBalances([{
    totalRechargeCount: 9, totalVerificationCount: 4, remainingCount: 5
  }])[0];
  assert.deepEqual(
    [balance.totalRechargeCount, balance.totalVerificationCount, balance.remainingCount],
    [9, 4, 5]
  );
});

test("profile body survives a photo failure and replaces each selected twenty-row history page", async () => {
  let pageDefinition;
  const calls = [];
  async function callFace(action, payload) {
    calls.push({ action, payload });
    if (action === "getCustomerPhotoUrl") throw new Error("photo unavailable");
    if (action === "listCustomerMessages") {
      return {
        messages: [{ id: "m1", authorName: "门店", authorRole: "store", createdAt: "2026-08-25T01:00:00Z", content: "已联系" }],
        totalCount: 1, page: { hasMore: false, nextCursor: null }
      };
    }
    if (action === "getCustomerProfile" && payload.historyType === "RECHARGE") {
      if (!payload.cursorSubmittedAt) {
        return {
          recharges: [{ id: "1", rechargeCode: "RC1", rechargeType: "NEW", unitCount: 5, recordStatus: "APPROVED" }],
          history: { recharges: { hasMore: true, nextCursor: { submittedAt: "cursor-time", id: "1" } } }
        };
      }
      assert.equal(payload.cursorSubmittedAt, "cursor-time");
      assert.equal(payload.cursorId, "1");
      return {
        recharges: [{ id: "2", rechargeCode: "RC2", rechargeType: "NEW", unitCount: 2, recordStatus: "APPROVED" }],
        history: { recharges: { hasMore: false, nextCursor: null } }
      };
    }
    if (action === "getCustomerProfile") {
      return {
        customer: {
          customerCode: "C1", customerName: "客户", customerStatus: "ACTIVE",
          birthDate: "2000-01-01", createdAt: "2026-08-01T00:00:00Z"
        },
        balances: [],
        recharges: [{ id: "1", rechargeCode: "RC1", rechargeType: "NEW", unitCount: 5, recordStatus: "APPROVED" }],
        refunds: [],
        verifications: [],
        experiences: [],
        productPurchases: [],
        history: {
          recharges: { hasMore: true, nextCursor: { submittedAt: "cursor-time", id: "1" } },
          refunds: { hasMore: false, nextCursor: null },
          verifications: { hasMore: false, nextCursor: null },
          experiences: { hasMore: false, nextCursor: null },
          productPurchases: { hasMore: false, nextCursor: null }
        }
      };
    }
    throw new Error(`unexpected face action ${action}`);
  }
  const sandbox = {
    Page(definition) { pageDefinition = definition; },
    require(id) {
      if (id === "../../services/api") return { callFace };
      if (id === "../../services/session") return { requireSession: () => ({ role: "store" }) };
      if (id === "../../services/photo-album") return { saveImageToAlbum: async () => ({ saved: true }) };
      if (id === "../../services/query-tools") {
        return {
          displayDate: (value) => String(value || "").slice(0, 10) || "—",
          displayDateAny: (...values) => String(values.find(Boolean) || "").slice(0, 10) || "—",
          displayDateTimeAny: (...values) => String(values.find(Boolean) || "")
        };
      }
      throw new Error(`unexpected dependency ${id}`);
    },
    wx: {}, console, String, Number, Boolean, Math, Date, Array, Object, Set,
    encodeURIComponent, decodeURIComponent, Promise
  };
  vm.runInNewContext(js, sandbox);
  const page = {
    ...pageDefinition,
    data: { ...pageDefinition.data, customerCode: "C1" },
    setData(update) { Object.assign(this.data, update); }
  };
  page._historyState = {};
  page._messageCursor = null;
  page._profileEpoch = 0;
  page._photoEpoch = 0;
  page._messageEpoch = 0;
  await page.load();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.data.profile.customerCode, "C1");
  assert.equal(page.data.photoError, true, "a signed-photo failure must stay inside the photo state");
  assert.equal(page.data.error, false, "a signed-photo failure must not turn the profile body into an error");
  assert.equal(page.data.messages.length, 1);
  assert.equal(page.data.recharges.length, 1);
  page.nextHistoryPage();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(Array.from(page.data.recharges, (row) => row.unitLabel).join("|"), "+2 次");
  assert.equal(page.data.historyPage, 2);
  assert.equal(page.data.historyHasMore, false);
  page.previousHistoryPage();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(Array.from(page.data.recharges, (row) => row.unitLabel).join("|"), "+5 次");
  assert.equal(page.data.historyPage, 1);
  assert.ok(calls.some(({ action, payload }) => action === "getCustomerProfile" && payload.historyLimit === 20));
});
