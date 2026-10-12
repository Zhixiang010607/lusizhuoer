const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const directory = path.join(__dirname, "../miniprogram-app/miniprogram/pages/training-materials");
const source = fs.readFileSync(path.join(directory, "index.js"), "utf8");

function harness(tasks = []) {
  let page;
  const retryIds = [];
  const queue = { allTasks: () => tasks, retry: (id) => { retryIds.push(id); return true; } };
  vm.runInNewContext(source, {
    Page: (value) => { page = value; },
    require: (id) => id.endsWith("training-material-upload-queue") ? queue : {},
    wx: {}
  });
  page.data = { ...page.data, session: { staffId: "owner" }, isHq: true };
  page.setData = (data) => Object.assign(page.data, data);
  return { page, retryIds };
}

test("pending PDF list excludes committed and other-owner jobs", () => {
  const { page } = harness([
    { id: "retry-original", ownerStaffId: "owner", state: "FAILED", bytes: 280 * 1024 },
    { id: "uploading", ownerStaffId: "owner", state: "UPLOADING", bytes: 280 * 1024 },
    { id: "done", ownerStaffId: "owner", state: "COMMITTED" },
    { id: "other", ownerStaffId: "another-owner", state: "FAILED" }
  ]);
  page.syncPendingTasks();
  assert.deepEqual(Array.from(page.data.pendingTasks, (task) => task.id), ["retry-original", "uploading"]);
  assert.equal(page.data.pendingTasks[0].stateLabel, "等待重试");
  assert.equal(page.data.pendingTasks[1].stateLabel, "后台上传中");
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
  assert.match(markup, /item\.state === 'FAILED' \? 'has-retry' : ''/);
  assert.match(markup, /class="retry-button" data-id="\{\{item\.id\}\}" bindtap="retryUpload"/);
  assert.match(css, /\.pending-row\.has-retry \{ grid-template-columns: minmax\(0, 1fr\) 132rpx;/);
  assert.match(css, /\.pending-row \.retry-button \{[^}]*width: 100% !important;[^}]*max-width: 100%;[^}]*align-items: center;[^}]*justify-content: center;[^}]*box-sizing: border-box/);
  assert.match(css, /\.pending-error \{[^}]*overflow-wrap: anywhere;[^}]*word-break: break-word/);
  assert.match(css, /\.upload-grid \.choose-button, \.upload-grid \.publish-button \{[^}]*width: 100% !important;[^}]*line-height: 1/);
  assert.match(css, /@media \(min-width: 700px\)[\s\S]*\.pending-row\.has-retry \{ grid-template-columns: minmax\(0, 1fr\) 96px;/);
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
