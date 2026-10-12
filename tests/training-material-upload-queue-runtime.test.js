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
  const faults = { begin: null, confirm: null, unlink: null, read: null };
  const wx = {
    getStorageSync: (key) => storage.get(key), setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    getFileSystemManager: () => ({
      getFileInfo: ({ success }) => success({ size: 280 * 1024 }),
      readFile: async ({ success, fail }) => {
        try { if (faults.read) await faults.read(); success({ data: new ArrayBuffer(280 * 1024) }); } catch (error) { fail(error); }
      },
      unlink: async ({ filePath, success }) => { if (faults.unlink) await faults.unlink(filePath); success({}); }
    }),
    request: ({ success }) => { calls.push("PUT"); success({ statusCode: 200 }); }
  };
  vm.runInNewContext(source, {
    module, wx, getApp: () => ({ globalData: data }), Uint8Array,
    Date: { now: () => clock },
    setTimeout: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, at: clock + delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    require: () => ({ callStaff: async (action, payload) => {
      calls.push(action);
      if (action === "beginTrainingMaterialUpload") {
        if (faults.begin) await faults.begin(payload);
        return { reference: "test-private-reference", upload: { url: "https://example.invalid/private", method: "PUT" } };
      }
      if (action === "confirmTrainingMaterialUpload") {
        if (faults.confirm) await faults.confirm(payload);
        return { material: { id: payload.clientRequestId } };
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
