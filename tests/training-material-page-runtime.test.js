const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const directory = path.join(__dirname, "../miniprogram-app/miniprogram/pages/training-materials");
const source = fs.readFileSync(path.join(directory, "index.js"), "utf8");

function harness(tasks = [], options = {}) {
  let page;
  const retryIds = [], removedIds = [], intervals = new Map(), calls = [], modals = [], invalidated = [];
  let now = 100000, id = 0, list = [];
  let session = { staffId: "owner", uid: "owner-uid", role: "hq", loginAt: "session-1" };
  let subscriber;
  const queue = { allTasks: () => tasks, retry: (id) => { retryIds.push(id); return true; }, dismissFailed: async (id) => { removedIds.push(id); return true; },
    subscribe: (listener) => { subscriber = listener; return () => { subscriber = null; }; }, resume: async () => {} };
  vm.runInNewContext(source, {
    Page: (value) => { page = value; },
    getApp: () => ({ globalData: { startupReady: true, session } }),
    require: (id) => id.endsWith("training-material-upload-queue") ? queue
      : id.endsWith("training-material-cache") ? { invalidate: async (id) => invalidated.push(id) }
      : id.endsWith("api") ? { callStaff: async (action, input) => { calls.push({ action, input }); return options.api ? options.api(action, input) : { materials: list }; } }
      : id.endsWith("session") ? { requireSession: () => session } : {},
    Date: { now: () => now },
    setInterval: (fn) => { const key = ++id; intervals.set(key, fn); return key; }, clearInterval: (key) => intervals.delete(key),
    wx: { showModal: (modal) => { modals.push(modal); if (!options.deferModal) modal.success({ confirm: options.confirm !== false }); } }
  });
  page.data = { ...page.data, session: { ...session }, isHq: true };
  page.setData = (data) => Object.assign(page.data, data);
  return { page, retryIds, removedIds, intervals, calls, modals, invalidated,
    advance: (seconds) => { now += seconds * 1000; for (const fn of intervals.values()) fn(); }, setList: (value) => { list = value; },
    switchActor: () => { session = { ...session, staffId: "other", uid: "other-uid" }; },
    notify: (event) => subscriber?.(event) };
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

test("confirmed upload updates library immediately and refreshes metadata without waiting", async () => {
  let resolveList;
  const h = harness([], { api: () => new Promise((resolve) => { resolveList = resolve; }) });
  h.page.data.keyword = "旧搜索";
  await h.page.onUploadQueueEvent({ type: "committed", task: { ownerStaffId: "owner", title: "秒级资料" },
    material: { id: "confirmed", title: "秒级资料", status: "PUBLISHED", bytes: 280 * 1024 } });
  assert.equal(h.page.data.materials[0].id, "confirmed");
  assert.equal(h.page.data.loading, false);
  assert.equal(h.page.data.keyword, "");
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].action, "listTrainingMaterials");
  assert.equal(h.calls[0].input.keyword, "");
  resolveList({ materials: [{ id: "confirmed", status: "PUBLISHED" }, { id: "another", status: "PUBLISHED" }] });
  await new Promise(setImmediate);
  assert.deepEqual(Array.from(h.page.data.materials, x => x.id), ["confirmed", "another"]);
  assert.match(h.page.data.message, /已在后台上传并发布/);
});

const committed = (id = "new") => ({ type: "committed", task: { ownerStaffId: "owner", title: "新资料" },
  material: { id, title: "新资料", status: "PUBLISHED", bytes: 280 * 1024 } });

test("initial onShow does not repeat the initial library read", async () => {
  const h = harness();
  h.page.onLoad(); h.page.onShow();
  await new Promise(setImmediate);
  assert.equal(h.calls.length, 1);
  h.page.onUnload();
});

test("hidden publication refreshes automatically once on return, not on every progress event", async () => {
  const h = harness();
  h.page.onHide();
  await h.page.onUploadQueueEvent(committed());
  await h.page.onUploadQueueEvent({ type: "progress", task: { ownerStaffId: "owner" } });
  assert.equal(h.calls.length, 0);
  assert.equal(h.page.data.materials[0].id, "new");
  h.setList([{ id: "new", status: "PUBLISHED" }, { id: "existing", status: "PUBLISHED" }]);
  h.page.onShow(); h.page.onShow();
  await new Promise(setImmediate);
  assert.equal(h.calls.length, 1);
  assert.equal(h.page.data.materials.length, 2);
});

test("returning refreshes a publication completed outside the visible page", async () => {
  const h = harness();
  h.page.onHide();
  h.setList([{ id: "published-offpage", status: "PUBLISHED" }]);
  h.page.onShow();
  await new Promise(setImmediate);
  assert.equal(h.page.data.materials[0].id, "published-offpage");
  assert.equal(h.page.data.loading, false);
});

test("the subscribed completion callback and fresh page entry both update the library automatically", async () => {
  const h = harness();
  h.page.onLoad(); h.page.onShow();
  await new Promise(setImmediate);
  h.setList([{ id: "existing", status: "PUBLISHED" }]);
  await h.notify(committed());
  await new Promise(setImmediate);
  assert.deepEqual(Array.from(h.page.data.materials, x => x.id), ["new", "existing"]);
  h.page.onUnload();
  assert.equal(h.notify(committed("late")), undefined);
  const fresh = harness();
  fresh.setList([{ id: "new", status: "PUBLISHED" }]);
  fresh.page.onLoad(); fresh.page.onShow();
  await new Promise(setImmediate);
  assert.equal(fresh.page.data.materials[0].id, "new");
  assert.equal(fresh.calls.length, 1);
  fresh.page.onUnload();
});

test("stale list response cannot erase a newly committed material or fresher count", async () => {
  const responses = [];
  const h = harness([], { api: () => new Promise(resolve => responses.push(resolve)) });
  const oldRead = h.page.loadMaterials();
  await h.page.onUploadQueueEvent(committed());
  responses[1]({ materials: [{ id: "new", status: "PUBLISHED" }, { id: "older", status: "PUBLISHED" }] });
  await new Promise(setImmediate);
  responses[0]({ materials: [] }); await oldRead;
  assert.deepEqual(Array.from(h.page.data.materials, x => x.id), ["new", "older"]);
});

test("a lagging list snapshot retains just-confirmed publication without duplicating its ID", async () => {
  const h = harness();
  await h.page.onUploadQueueEvent(committed());
  await new Promise(setImmediate);
  assert.equal(h.page.data.materials[0].id, "new");
  h.setList([{ id: "new", status: "PUBLISHED" }]);
  await h.page.onUploadQueueEvent(committed());
  await new Promise(setImmediate);
  assert.equal(h.page.data.materials.length, 1);
});

test("a background list failure preserves publication and cannot turn it into an upload failure", async () => {
  const h = harness([], { api: async () => { throw new Error("network down"); } });
  await h.page.onUploadQueueEvent(committed());
  await new Promise(setImmediate);
  assert.equal(h.page.data.materials[0].id, "new");
  assert.match(h.page.data.message, /上传已成功.*列表刷新失败/);
  assert.equal(h.page.data.loading, false);
});

test("failed, progress and invalid/unpublished completion events never refresh or add library rows", async () => {
  const h = harness();
  for (const type of ["progress", "state", "queued", "failed", "settled"]) {
    await h.page.onUploadQueueEvent({ type, task: { ownerStaffId: "owner" } });
  }
  for (const material of [{}, { id: "archived", status: "ARCHIVED" }]) {
    await h.page.onUploadQueueEvent({ ...committed(), material });
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.page.data.materials.length, 0);
});

test("unload, actor change and a changed keyword reject late automatic refresh results", async () => {
  for (const cancel of [h => h.page.onUnload(), h => h.switchActor(), h => h.page.inputKeyword({ detail: { value: "别的" } })]) {
    let resolveList;
    const h = harness([], { api: () => new Promise(resolve => { resolveList = resolve; }) });
    await h.page.onUploadQueueEvent(committed());
    cancel(h);
    resolveList({ materials: [{ id: "late", status: "PUBLISHED" }] });
    await new Promise(setImmediate);
    assert.equal(h.page.data.materials[0].id, "new");
  }
});

test("completion from another owner or after an account switch cannot mutate the library", async () => {
  const h = harness();
  await h.page.onUploadQueueEvent({ ...committed(), task: { ownerStaffId: "another" } });
  h.switchActor();
  await h.page.onUploadQueueEvent(committed());
  assert.equal(h.calls.length, 0);
  assert.equal(h.page.data.materials.length, 0);
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
  h.page.data.isHq = false;
  h.setList([{ id: "ok", title: "完整 PDF", status: "PUBLISHED" }, { id: "failed", status: "FAILED" }, { id: "old", status: "ARCHIVED" }, { id: "unknown" }]);
  await h.page.loadMaterials();
  assert.deepEqual(Array.from(h.page.data.materials, (item) => item.id), ["ok"]);
});

test("HQ retains stopped-reading rows only for retrying deletion", async () => {
  const h = harness();
  h.setList([{ id: "pending", status: "ARCHIVED" }, { id: "failed", status: "FAILED" }]);
  await h.page.loadMaterials();
  assert.deepEqual(Array.from(h.page.data.materials, x => x.id), ["pending"]);
});

test("cancelled PDF deletion never calls the server or invalidates cache", async () => {
  const h = harness([], { confirm: false });
  h.page.data.materials = [{ id: "1", title: "设备学习" }];
  await h.page.archiveMaterial({ currentTarget: { dataset: { id: "1" } } });
  assert.match(h.modals[0].content, /设备学习.*云端 PDF 和资料记录.*无法恢复/);
  assert.equal(h.calls.length, 0);
  assert.equal(h.invalidated.length, 0);
  assert.equal(h.page.data.materials.length, 1);
});

test("rapid taps share one confirmation, then remove only the exact server-confirmed row", async () => {
  const h = harness([], { deferModal: true, api: async (action, input) => ({ material: { id: input.materialId, deleted: true } }) });
  h.page.data.materials = [{ id: "1", title: "设备学习" }, { id: "2", title: "另一份" }];
  const event = { currentTarget: { dataset: { id: "1" } } };
  const pending = h.page.archiveMaterial(event);
  await h.page.archiveMaterial(event);
  assert.equal(h.modals.length, 1);
  h.modals[0].success({ confirm: true });
  await pending;
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].input.confirmDeletion, true);
  assert.deepEqual(Array.from(h.page.data.materials, x => x.id), ["2"]);
  assert.deepEqual(h.invalidated, ["1"]);
});

test("leaving during confirmation prevents deletion", async () => {
  const h = harness([], { deferModal: true });
  h.page.data.materials = [{ id: "1", title: "测试" }];
  const pending = h.page.archiveMaterial({ currentTarget: { dataset: { id: "1" } } });
  h.page.onUnload();
  h.modals[0].success({ confirm: true });
  await pending;
  assert.equal(h.calls.length, 0);
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
