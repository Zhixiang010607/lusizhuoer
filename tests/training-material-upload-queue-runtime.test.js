const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../miniprogram-app/miniprogram/services/training-material-upload-queue.js"), "utf8");
const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness() {
  const module = { exports: {} }, storage = new Map(), calls = [], timers = new Map();
  const data = { startupReady: true, session: { role: "hq", staffId: "test-owner" } };
  let clock = 100000000, timerId = 0;
  const faults = { begin: null, confirm: null, unlink: null, read: null, info: null, request: null, http: 200, published: false, cache: null };
  const wx = {
    getStorageSync: (key) => storage.get(key), setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    getFileSystemManager: () => ({
      getFileInfo: ({ success, fail }) => { if (faults.info) fail(new Error("local file missing")); else success({ size: 280 * 1024 }); },
      readFile: async ({ success, fail }) => {
        try { if (faults.read) await faults.read(); success({ data: new ArrayBuffer(280 * 1024) }); } catch (error) { fail(error); }
      },
      unlink: async ({ filePath, success }) => { if (faults.unlink) await faults.unlink(filePath); success({}); }
    }),
    request: async ({ success, fail }) => { calls.push("PUT"); try { if (faults.request) await faults.request(); success({ statusCode: faults.http }); } catch (error) { fail(error); } }
  };
  vm.runInNewContext(source, {
    module, wx, getApp: () => ({ globalData: data }), Uint8Array,
    Date: { now: () => clock },
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, at: clock + delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    require: (name) => name.endsWith("training-material-cache") ? { store: async () => { calls.push("cache"); if (faults.cache) await faults.cache(); } } : ({ callStaff: async (action, payload) => {
      calls.push(action);
      if (action === "beginTrainingMaterialUpload") {
        if (faults.begin) await faults.begin(payload);
        return { reference: "test-private-reference", upload: { url: "https://example.invalid/private", method: "PUT" } };
      }
      if (action === "confirmTrainingMaterialUpload") {
        if (faults.confirm) await faults.confirm(payload);
        return { material: { id: payload.clientRequestId, ...(faults.published ? { status: "PUBLISHED" } : {}) } };
      }
      return {};
    } })
  });
  const queue = module.exports;
  const input = (suffix = "one", ownerStaffId = "test-owner") => ({ ownerStaffId, clientRequestId: `test_request_${suffix}_123456`, title: "测试", originalName: "test.pdf", bytes: 280 * 1024, filePath: `/private/${suffix}.pdf` });
  const flush = async () => { for (let i = 0; i < 12; i++) await tick(); };
  const wake = async () => { const [id, timer] = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0]; timers.delete(id); clock = timer.at; timer.fn(); await flush(); };
  return { queue, calls, data, faults, timers, storage, input, flush, wake, now: () => clock };
}

test("280KB enqueue starts upload immediately without page re-entry", async () => {
  const h = harness();
  h.queue.enqueue(h.input());
  await h.flush();
  assert.deepEqual(h.calls, ["beginTrainingMaterialUpload", "PUT", "confirmTrainingMaterialUpload"]);
  assert.equal(h.queue.allTasks().length, 0);
});

test("missing object after ambiguous PUT retries the same upload only after original-result confirmation", async () => {
  const h = harness(); let attempts = 0;
  h.faults.request = async () => { if (++attempts === 1) throw new Error("connection failed before transfer"); };
  h.faults.confirm = async () => { if (attempts === 1) throw Object.assign(new Error("missing"), { code: "TRAINING_MATERIAL_UPLOAD_INCOMPLETE" }); };
  h.queue.enqueue(h.input()); await h.flush();
  assert.deepEqual(h.calls, ["beginTrainingMaterialUpload", "PUT", "confirmTrainingMaterialUpload"]);
  await h.wake();
  assert.deepEqual(h.calls, ["beginTrainingMaterialUpload", "PUT", "confirmTrainingMaterialUpload", "PUT", "confirmTrainingMaterialUpload"]);
  assert.equal(h.queue.allTasks().length, 0);
});

test("confirmed upload settles UI before private caching, but preserves source until copy finishes", async () => {
  const h = harness(); let release, committed = false, removed = false;
  h.faults.published = true;
  h.faults.cache = () => new Promise((resolve) => { release = resolve; });
  h.faults.unlink = async () => { removed = true; };
  h.queue.subscribe((event) => { if (event.type === "committed") committed = true; });
  h.queue.enqueue(h.input()); await h.flush();
  assert.equal(committed, true);
  assert.equal(removed, false);
  assert.equal(h.queue.allTasks().length, 0);
  release(); await h.flush();
  assert.equal(removed, true);
});

test("lost PUT acknowledgement recovers publication before any duplicate transfer", async () => {
  const h = harness();
  h.faults.request = async () => { throw new Error("network connection reset after storage commit"); };
  h.queue.enqueue(h.input()); await h.flush();
  assert.deepEqual(h.calls, ["beginTrainingMaterialUpload", "PUT", "confirmTrainingMaterialUpload"]);
  assert.equal(h.queue.allTasks().length, 0);
});

test("HTTP permission failure stops automatic upload retries rather than wasting minutes", async () => {
  const h = harness(); h.faults.http = 403;
  h.queue.enqueue(h.input()); await h.flush();
  assert.equal(h.calls.filter((x) => x === "PUT").length, 1);
  assert.equal(h.timers.size, 0);
  assert.equal(h.queue.allTasks()[0].nextAttemptAt, 0);
  await h.queue.resume();
  assert.equal(h.calls.filter((x) => x === "PUT").length, 1);
});

test("local file reading and signing overlap, with no PUT until both complete", async () => {
  const h = harness(); let release;
  h.faults.read = () => new Promise((resolve) => { release = resolve; });
  h.queue.enqueue(h.input()); await h.flush();
  assert.deepEqual(h.calls, ["beginTrainingMaterialUpload"]);
  release(); await h.flush();
  assert.equal(h.calls.filter((x) => x === "PUT").length, 1);
});

test("failed local read cleans its allocated upload reference without transfer", async () => {
  const h = harness(); h.faults.read = async () => { throw new Error("read failed"); };
  h.queue.enqueue(h.input()); await h.flush();
  assert.deepEqual(h.calls, ["beginTrainingMaterialUpload", "discardTrainingMaterialUpload"]);
  assert.equal(h.queue.allTasks()[0].reference, "");
});

test("upload stages persist actual milestones and never invent a byte percentage", async () => {
  const h = harness(), events = [];
  h.queue.subscribe((event) => { events.push(event); });
  let release;
  h.faults.request = () => new Promise((resolve) => { release = resolve; });
  h.queue.enqueue(h.input()); await h.flush();
  assert.equal(h.queue.allTasks()[0].phase, "TRANSFERRING");
  assert.equal(h.queue.allTasks()[0].uploadedBytes, 0);
  assert.equal(await h.queue.dismissFailed(h.input().clientRequestId), false);
  release(); await h.flush();
  const progress = events.filter((event) => event.type === "progress");
  assert.deepEqual(progress.map((event) => event.task.phase), ["PREPARING", "SIGNING", "TRANSFERRING", "VERIFYING"]);
  assert.equal(progress.at(-1).task.uploadedBytes, 280 * 1024);
  assert.equal(h.queue.allTasks().length, 0);
});

test("a lost publish acknowledgement recovers the original request even if local PDF is gone", async () => {
  const h = harness(); h.faults.info = true;
  h.storage.set(h.queue.STORAGE_KEY, [{ ...h.input(), reference: "test-private-reference", state: "FAILED" }]);
  await h.queue.resume();
  assert.deepEqual(h.calls, ["confirmTrainingMaterialUpload"]);
  assert.equal(h.queue.allTasks().length, 0);
});

test("committed cold-start residue is removed without a reupload or misleading failure", async () => {
  const h = harness(); h.faults.info = true;
  h.storage.set(h.queue.STORAGE_KEY, [{ ...h.input(), state: "COMMITTED", createdAt: h.now() - 25 * 60 * 60 * 1000 }]);
  await h.queue.resume();
  assert.deepEqual(h.calls, []);
  assert.equal(h.queue.allTasks().length, 0);
});

test("removing a failed task cannot resurrect it from another upload's queue snapshot", async () => {
  const h = harness(); let release;
  h.faults.begin = () => new Promise((resolve) => { release = resolve; });
  h.storage.set(h.queue.STORAGE_KEY, [{ ...h.input("one"), state: "QUEUED" }, { ...h.input("two"), state: "FAILED", reference: "already-bound-private-reference" }]);
  const pending = h.queue.resume(); await h.flush();
  assert.equal(await h.queue.dismissFailed(h.input("two").clientRequestId), true);
  h.faults.begin = null; release(); await pending; await h.flush();
  assert.equal(h.calls.filter((action) => action === "PUT").length, 1);
  assert.equal(h.calls.filter((action) => action === "discardTrainingMaterialUpload").length, 1);
  assert.equal(h.queue.allTasks().length, 0);
});

test("timer retry and manual retry retain request/reference and run under the same owner", async () => {
  const h = harness();
  h.faults.confirm = async () => { throw new Error("temporary disconnect"); };
  h.queue.enqueue(h.input());
  await h.flush();
  assert.equal(h.queue.allTasks()[0].state, "FAILED");
  h.faults.confirm = null;
  await h.wake();
  assert.equal(h.calls.filter((action) => action === "PUT").length, 1);
  assert.equal(h.queue.allTasks().length, 0);
  h.faults.begin = async () => { throw new Error("disconnect"); };
  h.queue.enqueue(h.input("two")); await h.flush();
  h.faults.begin = null;
  assert.equal(h.queue.retry(h.input("two").clientRequestId), true);
  await h.flush();
  assert.equal(h.queue.allTasks().length, 0);
});

test("failed publish stages are actionable and never retain signed URLs", async () => {
  const h = harness();
  h.faults.confirm = async () => { throw new Error("request:fail https://private.example.test/?token=secret"); };
  h.queue.enqueue(h.input()); await h.flush();
  assert.equal(h.queue.allTasks()[0].phase, "VERIFYING");
  assert.equal(h.queue.allTasks()[0].error, "PDF 发布结果暂未确认，请用原任务重试");
  assert.ok(!JSON.stringify(h.queue.allTasks()).includes("token=secret"));
});

test("foreground and page entry cannot reset an exhausted PDF retry budget", async () => {
  const h = harness();
  h.storage.set(h.queue.STORAGE_KEY, [{ ...h.input(), state: "FAILED", attemptCount: 6, nextAttemptAt: 0 }]);
  await h.queue.resume({ ownerStaffId: "test-owner" });
  assert.equal(h.calls.length, 0);
  assert.equal(h.queue.allTasks()[0].attemptCount, 6);
  const app = fs.readFileSync(path.join(__dirname, "../miniprogram-app/miniprogram/app.js"), "utf8");
  const page = fs.readFileSync(path.join(__dirname, "../miniprogram-app/miniprogram/pages/training-materials/index.js"), "utf8");
  assert.doesNotMatch(app, /trainingMaterialUploadQueue\.resume\(\{ retryFailed: true/);
  assert.doesNotMatch(page, /uploadQueue\.resume\(\{ retryFailed: true/);
  assert.match(app, /verificationPhotoUploadQueue\.resume\(\{ retryFailed: true \}\)/);
});

test("enqueue during an in-flight upload drains both jobs exactly once", async () => {
  const h = harness();
  let release;
  h.faults.begin = () => new Promise((resolve) => { release = resolve; });
  h.queue.enqueue(h.input()); await h.flush();
  h.queue.enqueue(h.input("two"));
  h.faults.begin = null; release(); await h.flush();
  assert.equal(h.queue.allTasks().length, 0);
  assert.equal(h.calls.filter((action) => action === "PUT").length, 2);
});

test("startup validation, role and owner checks fail closed without deleting jobs", async () => {
  const h = harness();
  h.data.startupReady = false;
  assert.throws(() => h.queue.enqueue(h.input()), { code: "TRAINING_UPLOAD_OWNER_CHANGED" });
  h.data.startupReady = true;
  h.faults.begin = async () => { h.data.session = { role: "teacher", staffId: "other" }; };
  h.queue.enqueue(h.input()); await h.flush();
  assert.deepEqual(h.calls, ["beginTrainingMaterialUpload"]);
  assert.equal(h.queue.allTasks().length, 1);
  assert.equal(h.queue.retry(h.input().clientRequestId), false);
  assert.equal(await h.queue.resume({ ownerStaffId: "test-owner" }), false);
  h.data.session = { role: "hq", staffId: "other" };
  await h.queue.resume();
  assert.equal(h.calls.length, 1);
  h.data.session.staffId = "test-owner";
  h.faults.begin = null;
  await h.queue.resume({ retryFailed: true });
  assert.equal(h.queue.allTasks().length, 0);
});

test("expiry cleanup preserves jobs enqueued during asynchronous file cleanup", async () => {
  const h = harness();
  h.storage.set(h.queue.STORAGE_KEY, [{ ...h.input("expired"), createdAt: h.now() - 25 * 60 * 60 * 1000 }, { ...h.input("other", "other-owner"), createdAt: 1 }]);
  let release;
  h.faults.unlink = () => new Promise((resolve) => { release = resolve; });
  const pending = h.queue.resume(); await h.flush();
  h.queue.enqueue(h.input("new")); h.faults.unlink = null; release();
  await pending; await h.flush();
  assert.equal(h.calls.filter((action) => action === "PUT").length, 1);
  assert.equal(h.queue.allTasks().length, 1);
  assert.equal(h.queue.allTasks()[0].ownerStaffId, "other-owner");
});
