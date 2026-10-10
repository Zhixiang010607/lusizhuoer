"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const queuePath = path.join(root, "miniprogram-app", "miniprogram", "services", "verification-photo-upload-queue.js");
const pagePath = path.join(root, "miniprogram-app", "miniprogram", "pages", "order-detail", "index.js");
const appPath = path.join(root, "miniprogram-app", "miniprogram", "app.js");
const queueSource = fs.readFileSync(queuePath, "utf8");
const pageSource = fs.readFileSync(pagePath, "utf8");
const appSource = fs.readFileSync(appPath, "utf8");

function queueHarness({ storage = new Map(), files = new Map(), callPhoto, request } = {}) {
  const context = {
    module: { exports: {} },
    exports: {},
    require(id) {
      if (id === "./api") return { callPhoto };
      throw new Error(`unexpected queue dependency ${id}`);
    },
    wx: {
      getStorageSync(key) { return storage.get(key); },
      setStorageSync(key, value) { storage.set(key, JSON.parse(JSON.stringify(value))); },
      getFileSystemManager() {
        return {
          readFile({ filePath, success, fail }) {
            const data = files.get(filePath);
            if (data instanceof ArrayBuffer) success({ data });
            else fail(new Error("file missing"));
          },
          getFileInfo({ filePath, success, fail }) {
            const data = files.get(filePath);
            if (data instanceof ArrayBuffer) success({ size: data.byteLength });
            else fail(new Error("file missing"));
          },
          unlink({ filePath, success }) { files.delete(filePath); success({}); }
        };
      },
      request(options) { return request(options); }
    },
    Uint8Array,
    ArrayBuffer,
    Promise,
    Date,
    Math,
    Number,
    String,
    Object,
    RegExp,
    Error,
    Set,
    setTimeout,
    clearTimeout
  };
  vm.createContext(context);
  vm.runInContext(queueSource, context, { filename: "verification-photo-upload-queue.js" });
  return { queue: context.module.exports, storage, files };
}

function jpegBytes(length = 24) {
  const bytes = new Uint8Array(length);
  bytes.set([0xff, 0xd8, 0xff], 0);
  bytes.set([0xff, 0xd9], length - 2);
  return bytes.buffer;
}

function waitForCommitted(queue) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("background upload did not finish")), 1000);
    const unsubscribe = queue.subscribe((event) => {
      if (event.type === "failed") {
        clearTimeout(timer);
        unsubscribe();
        reject(new Error(event.error || "background upload failed"));
        return;
      }
      if (event.type !== "committed") return;
      clearTimeout(timer);
      unsubscribe();
      resolve(event);
    });
  });
}

test("selected photo is rendered before normalization or network upload begins", () => {
  const methodStart = pageSource.indexOf("  async uploadExtraPhoto(event)");
  const methodEnd = pageSource.indexOf("\n  },", methodStart);
  const method = pageSource.slice(methodStart, methodEnd);
  const localPreview = method.indexOf("thumbnailUrl: filePath");
  const normalization = method.indexOf("await this.normalizeExtraPhoto");
  const enqueue = method.indexOf("photoUploadQueue.enqueue");
  assert.ok(localPreview >= 0 && localPreview < normalization,
    "the complete selected local file must be shown before any normalization wait");
  assert.ok(normalization >= 0 && normalization < enqueue,
    "only a verified persistent JPEG may enter the background queue");
  assert.match(method, /pendingUploadPhotoFilePath/,
    "the selected bytes are copied into USER_DATA_PATH before the page releases the task");
});

test("persistent queue uploads exact bytes and finishes after the detail page can be gone", async () => {
  const storage = new Map();
  const files = new Map([["/user/pending.jpg", jpegBytes(24)]]);
  const actions = [];
  const requests = [];
  const harness = queueHarness({
    storage,
    files,
    async callPhoto(action, payload) {
      actions.push({ action, payload });
      if (action === "beginVerificationPhotoUpload") return {
        status: "UPLOADING",
        uploadMode: "DIRECT",
        originalUpload: { url: "https://private.test/object", method: "PUT", expectedBytes: 24 }
      };
      if (action === "commitVerificationPhotoUpload") return {
        status: "COMMITTED",
        recordId: "record-1",
        photo: { slot: 2, originalBytes: 24 }
      };
      throw new Error(`unexpected action ${action}`);
    },
    request(options) {
      requests.push(options);
      options.success({ statusCode: 200 });
    }
  });
  const committed = waitForCommitted(harness.queue);
  harness.queue.enqueue({
    recordId: "record-1",
    slot: 2,
    requestId: "mini-photo-request-000001",
    filePath: "/user/pending.jpg",
    bytes: 24,
    width: 1080,
    height: 1920
  });
  await committed;
  await new Promise((resolve) => setTimeout(resolve, 5));

  assert.deepEqual(actions.map((item) => item.action), [
    "beginVerificationPhotoUpload",
    "commitVerificationPhotoUpload"
  ]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].data.byteLength, 24, "the persisted JPEG is sent byte-for-byte");
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0].header)), { "Content-Type": "image/jpeg" });
  assert.equal(harness.queue.tasksForRecord("record-1").length, 0, "committed work leaves the durable queue");
  assert.equal(files.has("/user/pending.jpg"), false, "the durable file is removed only after commit listeners finish");
});

test("multiple pending photos remain serial across page-independent uploads", async () => {
  const storage = new Map();
  const files = new Map([
    ["/user/slot-2.jpg", jpegBytes(24)],
    ["/user/slot-3.jpg", jpegBytes(28)]
  ]);
  const actions = [];
  let active = 0;
  let maximumActive = 0;
  const harness = queueHarness({
    storage,
    files,
    async callPhoto(action, payload) {
      actions.push(`${action}:${payload.slot || payload.requestId}`);
      if (action === "beginVerificationPhotoUpload") {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        return {
          status: "UPLOADING",
          uploadMode: "DIRECT",
          originalUpload: {
            url: `https://private.test/${payload.slot}`,
            method: "PUT",
            expectedBytes: payload.slot === 2 ? 24 : 28
          }
        };
      }
      if (action === "commitVerificationPhotoUpload") {
        active -= 1;
        return { status: "COMMITTED" };
      }
      throw new Error(`unexpected action ${action}`);
    },
    request(options) { setTimeout(() => options.success({ statusCode: 200 }), 5); }
  });
  const completed = new Promise((resolve, reject) => {
    let count = 0;
    const timer = setTimeout(() => reject(new Error("serial queue did not finish")), 1000);
    const unsubscribe = harness.queue.subscribe((event) => {
      if (event.type === "failed") {
        clearTimeout(timer);
        unsubscribe();
        reject(new Error(event.error || "background upload failed"));
      } else if (event.type === "committed" && ++count === 2) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });
  harness.queue.enqueue({
    recordId: "record-serial", slot: 2, requestId: "mini-photo-serial-000002",
    filePath: "/user/slot-2.jpg", bytes: 24, width: 1080, height: 1920
  });
  harness.queue.enqueue({
    recordId: "record-serial", slot: 3, requestId: "mini-photo-serial-000003",
    filePath: "/user/slot-3.jpg", bytes: 28, width: 1920, height: 1080
  });
  await completed;

  assert.equal(maximumActive, 1, "the service allows only one active upload per order");
  assert.deepEqual(actions.map((entry) => entry.split(":")[0]), [
    "beginVerificationPhotoUpload", "commitVerificationPhotoUpload",
    "beginVerificationPhotoUpload", "commitVerificationPhotoUpload"
  ]);
});

test("cold start reconciles and resumes the same saved request id", async () => {
  const storage = new Map();
  const filePath = "/user/restart.jpg";
  const requestId = "mini-photo-request-restart1";
  storage.set("verification-photo-upload-queue-v1", [{
    id: requestId,
    requestId,
    recordId: "record-2",
    slot: 3,
    filePath,
    bytes: 32,
    width: 1920,
    height: 1080,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    attemptCount: 1,
    state: "FAILED",
    error: "offline",
    nextAttemptAt: 0
  }]);
  const files = new Map([[filePath, jpegBytes(32)]]);
  const calls = [];
  const harness = queueHarness({
    storage,
    files,
    async callPhoto(action, payload) {
      calls.push({ action, payload });
      if (action === "getVerificationPhotoUploadStatus") return {
        status: "UPLOADING", objectUploaded: false, uploadedBytes: 0
      };
      if (action === "beginVerificationPhotoUpload") return {
        status: "UPLOADING",
        uploadMode: "DIRECT",
        originalUpload: { url: "https://private.test/restart", method: "PUT", expectedBytes: 32 }
      };
      if (action === "commitVerificationPhotoUpload") return { status: "COMMITTED" };
      throw new Error(`unexpected action ${action}`);
    },
    request(options) { options.success({ statusCode: 204 }); }
  });
  const committed = waitForCommitted(harness.queue);
  await harness.queue.resume({ retryFailed: true });
  await committed;

  assert.deepEqual(calls.map((item) => item.action), [
    "getVerificationPhotoUploadStatus",
    "beginVerificationPhotoUpload",
    "commitVerificationPhotoUpload"
  ]);
  assert.ok(calls.every((item) => item.payload.requestId === requestId),
    "resume reuses one idempotent server request instead of creating duplicate photos");
});

test("app launch and foreground both resume the durable queue", () => {
  assert.match(appSource, /verificationPhotoUploadQueue\.resume\(\{ retryFailed: true \}\)/,
    "a restored session resumes pending uploads on cold launch");
  assert.match(appSource, /onShow\(\)[\s\S]*startup\.then\(\(session\) => session && verificationPhotoUploadQueue\.resume/,
    "returning to the foreground resumes a task interrupted by WeChat suspension");
  assert.doesNotMatch(pageSource.slice(pageSource.indexOf("  onUnload()"), pageSource.indexOf("\n  async load()")),
    /cancelVerificationPhotoUpload|verificationPhotoUploadQueue\.remove/,
    "leaving the detail page never cancels or deletes its background upload");
});
