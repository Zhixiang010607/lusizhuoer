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

test("mini customer profile consumes the existing cursor and message contracts", () => {
  assert.match(js, /const HISTORY_LIMIT = 50;/);
  for (const type of ["RECHARGE", "VERIFICATION", "EXPERIENCE"]) {
    assert.match(js, new RegExp(`${type}: \\{ hasMore: false, nextCursor: null, loading: false`));
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

test("balance and history tables have exact centered single-line column widths", () => {
  for (const label of ["累计充值", "累计核销", "剩余", "业务老师", "提交日期", "状态"]) {
    assert.match(wxml, new RegExp(label));
  }
  assert.match(wxml, /item\.unitLabel/);
  assert.match(wxml, /item\.teacherLabel/);
  assert.match(wxml, /item\.submittedAtLabel/);
  assert.match(wxml, /item\.statusLabel/);
  assert.doesNotMatch(wxml, /item\.productCode/,
    "customer profile tables show product names without internal product codes");
  assert.match(wxss, /\.balance-table \{ width: 660rpx; min-width: 660rpx;/);
  assert.match(wxss, /\.balance-table-row \{[^}]*width: 660rpx;[^}]*grid-template-columns: 240rpx 140rpx 140rpx 140rpx;/s);
  assert.equal(240 + 140 + 140 + 140, 660);
  assert.match(wxml, /record-table \{\{historyType === 'RECHARGE' \? 'recharge-history' : 'compact-history'\}\}/);
  assert.match(wxss, /\.record-table\.recharge-history, \.record-table\.recharge-history \.record-row \{ min-width: 950rpx; \}/);
  assert.match(wxss, /\.record-table\.compact-history, \.record-table\.compact-history \.record-row \{ min-width: 880rpx; \}/);
  assert.match(wxss, /\.recharge-history \.record-row \{ grid-template-columns: minmax\(210rpx, 1\.35fr\) minmax\(130rpx, 0\.8fr\) minmax\(130rpx, 0\.8fr\) minmax\(90rpx, 0\.55fr\) minmax\(160rpx, 0\.95fr\) minmax\(230rpx, 1\.3fr\); \}/);
  assert.match(wxss, /\.compact-history \.record-row \{ grid-template-columns: minmax\(210rpx, 1\.4fr\) minmax\(130rpx, 0\.85fr\) minmax\(130rpx, 0\.85fr\) minmax\(90rpx, 0\.6fr\) minmax\(160rpx, 1fr\) minmax\(160rpx, 1fr\); \}/);
  assert.equal(210 + 130 + 130 + 90 + 160 + 230, 950);
  assert.equal(210 + 130 + 130 + 90 + 160 + 160, 880);
  assert.match(wxss, /\.balance-table-row text, \.record-row text \{[^}]*align-items: center;[^}]*justify-content: center;[^}]*text-align: center;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/s);
  assert.match(wxss, /\.history-tabs button \{[^}]*align-items: center;[^}]*justify-content: center;[^}]*text-align: center;[^}]*white-space: nowrap;/s);
});

test("history tabs and full refresh reset the controlled horizontal position", () => {
  assert.match(js, /historyType: "RECHARGE", visibleHistory: \[\], historyHasMore: false, historyScrollLeft: 0/);
  assert.match(wxml, /class="table-scroll record-scroll"[^>]*scroll-left="\{\{historyScrollLeft\}\}"[^>]*bindscroll="rememberHistoryScroll"/);
  const loadSection = js.slice(js.indexOf("async load()"), js.indexOf("async loadPhoto()"));
  assert.match(loadSection, /historyScrollLeft: 0/);
  const changeStart = js.indexOf("changeHistory(event)");
  const changeSection = js.slice(changeStart, js.indexOf("syncHistory()", changeStart));
  assert.match(changeSection, /historyType: type, historyScrollLeft: 0/);
  assert.match(js, /rememberHistoryScroll\(event\)[\s\S]*this\.data\.historyScrollLeft = scrollLeft/);
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
          displayDateTime: (value) => String(value || "")
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
  assert.equal(mapped.submittedAtLabel, "2026-08-25");
  assert.equal(mapped.statusLabel, "审核通过");
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
  const balance = sandbox.__customerDetailTest.mapBalances([{
    totalRechargeCount: 9, totalVerificationCount: 4, remainingCount: 5
  }])[0];
  assert.deepEqual(
    [balance.totalRechargeCount, balance.totalVerificationCount, balance.remainingCount],
    [9, 4, 5]
  );
});

test("profile body survives a photo failure and appends only the selected history cursor", async () => {
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
      assert.equal(payload.cursorSubmittedAt, "cursor-time");
      assert.equal(payload.cursorId, "1");
      return {
        recharges: [{ id: "2", rechargeCode: "RF2", rechargeType: "REFUND", unitCount: 2, recordStatus: "APPROVED" }],
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
        verifications: [],
        experiences: [],
        history: {
          recharges: { hasMore: true, nextCursor: { submittedAt: "cursor-time", id: "1" } },
          verifications: { hasMore: false, nextCursor: null },
          experiences: { hasMore: false, nextCursor: null }
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
          displayDateTime: (value) => String(value || "")
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
  await page.loadMoreHistory();
  assert.equal(Array.from(page.data.recharges, (row) => row.unitLabel).join("|"), "+5 次|−2 次");
  assert.equal(page.data.historyHasMore, false);
  assert.ok(calls.some(({ action, payload }) => action === "getCustomerProfile" && payload.historyLimit === 50));
});
