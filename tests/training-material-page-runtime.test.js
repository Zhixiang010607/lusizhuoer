const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const directory = path.join(__dirname, "../miniprogram-app/miniprogram/pages/training-materials");
const source = fs.readFileSync(path.join(directory, "index.js"), "utf8");

function harness(tasks = []) {
  let page;
  const retryIds = [], removedIds = [], intervals = new Map();
  let now = 100000, id = 0, list = [];
  const queue = { allTasks: () => tasks, retry: (id) => { retryIds.push(id); return true; }, dismissFailed: async (id) => { removedIds.push(id); return true; } };
  vm.runInNewContext(source, {
    Page: (value) => { page = value; },
    require: (id) => id.endsWith("training-material-upload-queue") ? queue : id.endsWith("api") ? { callStaff: async () => ({ materials: list }) } : {},
    Date: { now: () => now },
    setInterval: (fn) => { const key = ++id; intervals.set(key, fn); return key; }, clearInterval: (key) => intervals.delete(key),
    wx: { showModal: ({ success }) => success({ confirm: true }) }
  });
  page.data = { ...page.data, session: { staffId: "owner" }, isHq: true };
  page.setData = (data) => Object.assign(page.data, data);
  return { page, retryIds, removedIds, intervals, advance: (seconds) => { now += seconds * 1000; for (const fn of intervals.values()) fn(); }, setList: (value) => { list = value; } };
}

test("pending PDF list excludes committed and other-owner jobs", () => {
  const { page } = harness([
    { id: "retry-original", ownerStaffId: "owner", state: "FAILED", bytes: 280 * 1024 },
    { id: "uploading", ownerStaffId: "owner", state: "UPLOADING", bytes: 280 * 1024 },
    { id: "done", ownerStaffId: "owner", state: "COMMITTED" },
    { id: "other", ownerStaffId: "another-owner", state: "FAILED" }
  ]);
  page.syncPendingTasks();
  assert.deepEqual(Array.from(page.data.pendingTasks, (task) => task.id), ["uploading"]);
  assert.deepEqual(Array.from(page.data.failedTasks, (task) => task.id), ["retry-original"]);
  assert.equal(page.data.failedTasks[0].stateLabel, "可重试或移除");
  assert.equal(page.data.pendingTasks[0].stateLabel, "准备文件");
});

test("retry action reuses the original task and never chooses or enqueues a second PDF", () => {
  const { page, retryIds } = harness();
  page.retryUpload({ currentTarget: { dataset: { id: "original-request-id" } } });
  assert.deepEqual(retryIds, ["original-request-id"]);
  assert.equal(page.data.error, false);
});

test("PDF retry and list actions have bounded centered controls at both breakpoints", () => {
  const markup = fs.readFileSync(path.join(directory, "index.wxml"), "utf8");
  const css = fs.readFileSync(path.join(directory, "index.wxss"), "utf8");
  assert.match(markup, /wx:for="\{\{failedTasks\}\}"[^>]*class="pending-row has-retry"/);
  assert.match(markup, /class="retry-button" data-id="\{\{item\.id\}\}" bindtap="retryUpload"/);
  assert.match(css, /\.pending-row\.has-retry \{ grid-template-columns: minmax\(0, 1fr\) 132rpx;/);
  assert.match(css, /\.pending-row \.retry-button \{[^}]*width: 100% !important;[^}]*max-width: 100%;[^}]*align-items: center;[^}]*justify-content: center;[^}]*box-sizing: border-box/);
  assert.match(css, /\.pending-error \{[^}]*overflow-wrap: anywhere;[^}]*word-break: break-word/);
  assert.match(css, /\.upload-grid \.choose-button, \.upload-grid \.publish-button \{[^}]*width: 100% !important;[^}]*line-height: 1/);
  assert.match(css, /@media \(min-width: 700px\)[\s\S]*\.pending-row\.has-retry \{ grid-template-columns: minmax\(0, 1fr\) 96px;/);
});

test("visible upload stages tick real elapsed time, reset per phase and stop while hidden", () => {
  const tasks = [{ id: "active", ownerStaffId: "owner", state: "UPLOADING", phase: "TRANSFERRING", phaseStartedAt: 100000, bytes: 280 * 1024, uploadedBytes: 0 }];
  const h = harness(tasks);
  h.page._visible = true; h.page.syncPendingTasks(); h.advance(7);
  assert.equal(h.page.data.pendingTasks[0].stateLabel, "正在上传");
  assert.equal(h.page.data.pendingTasks[0].elapsedLabel, "已等待 7 秒");
  assert.equal(h.page.data.pendingTasks[0].transferLabel, "");
  Object.assign(tasks[0], { phase: "VERIFYING", phaseStartedAt: 107000, uploadedBytes: 280 * 1024 });
  h.advance(2);
  assert.equal(h.page.data.pendingTasks[0].elapsedLabel, "已等待 2 秒");
  assert.equal(h.page.data.pendingTasks[0].transferLabel, "已传 280 KB / 280 KB");
  h.page.onHide(); assert.equal(h.intervals.size, 0);
});

test("published list never includes failed, archived or unknown states", async () => {
  const h = harness();
  h.setList([{ id: "ok", title: "完整 PDF", status: "PUBLISHED" }, { id: "failed", status: "FAILED" }, { id: "old", status: "ARCHIVED" }, { id: "unknown" }]);
  await h.page.loadMaterials();
  assert.deepEqual(Array.from(h.page.data.materials, (item) => item.id), ["ok"]);
});

test("failed task removal is confirmed, exact and separate from library archival", async () => {
  const h = harness([{ id: "failed", ownerStaffId: "owner", state: "FAILED" }]);
  h.page.syncPendingTasks();
  await h.page.removeFailedUpload({ currentTarget: { dataset: { id: "other" } } });
  assert.equal(h.removedIds.length, 0);
  await h.page.removeFailedUpload({ currentTarget: { dataset: { id: "failed" } } });
  assert.deepEqual(h.removedIds, ["failed"]);
  assert.equal(h.page.data.message, "失败任务已移除。");
});

test("title search and learning files are separate spaced cards, with larger bounded file names", () => {
  const markup = fs.readFileSync(path.join(directory, "index.wxml"), "utf8");
  const css = fs.readFileSync(path.join(directory, "index.wxss"), "utf8");
  const searchStart = markup.indexOf('class="card search-card"');
  const libraryStart = markup.indexOf('class="card library-card"');
  assert.ok(searchStart > 0 && libraryStart > searchStart);
  const searchSection = markup.slice(searchStart, libraryStart);
  assert.match(searchSection, /class="search-row"/);
  assert.doesNotMatch(searchSection, /material-list|material-row/);
  assert.doesNotMatch(markup.slice(libraryStart), /search-row/);
  assert.match(css, /\.card \{[^}]*margin-bottom: 16rpx/);
  assert.match(css, /\.search-card \.search-row \{ margin-bottom: 0; \}/);
  assert.match(css, /\.selected-file-name \{[^}]*font-size: 24rpx;[^}]*text-overflow: ellipsis/);
  assert.match(css, /\.material-title \{[^}]*font-size: 30rpx;[^}]*text-overflow: ellipsis/);
});
