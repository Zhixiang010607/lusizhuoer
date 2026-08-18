"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const ui = read("business-detail.js");
const html = read("verification-detail.html");
const styles = read("styles.css");
const worker = read("verification-photo-worker.js");
const cloud = read("cloudfunctions/faceRecognition/index.js");
const migration = read("database/migrations/039_direct_verification_photo_upload.sql");

function includes(source, expected, label) {
  assert.ok(source.includes(expected), `${label}: missing ${JSON.stringify(expected)}`);
}

function functionSource(source, name) {
  const marker = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const match = marker.exec(source);
  assert.ok(match, `function ${name} must exist`);
  const start = match.index;
  const signatureEnd = source.indexOf(") {", match.index + match[0].length);
  assert.ok(signatureEnd >= 0, `function ${name} signature must be complete`);
  const bodyStart = signatureEnd + 2;
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`function ${name} body is incomplete`);
}

function sqlFunctionSource(source, name, nextName) {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  assert.ok(start >= 0, `SQL function ${name} must exist`);
  const next = nextName ? source.indexOf(`CREATE OR REPLACE FUNCTION public.${nextName}`, start + 1) : source.length;
  assert.ok(next > start, `SQL function ${name} must be complete`);
  return source.slice(start, next);
}

// Browser contract: exactly one task owns all slots until success or confirmed
// cancellation. A late callback from an older task may not clear the new task.
const uploadEntry = functionSource(ui, "uploadVerificationPhoto");
assert.ok(
  uploadEntry.indexOf("if (verificationPhotoUploadBusy)") < uploadEntry.indexOf("verificationPhotoUploadBusy = true"),
  "the global one-upload guard runs before a new task is created"
);
includes(uploadEntry, "verificationPhotoUploadTask = task", "one current upload task");
includes(uploadEntry, "crypto.getRandomValues", "client request id entropy");
includes(uploadEntry, "task.requestId = `vp_", "client-generated request id");

const runUpload = functionSource(ui, "runVerificationPhotoUpload");
for (const field of [
  'action: "beginVerificationPhotoUpload"', "recordId: task.recordId", "slot: task.slot",
  "requestId: task.requestId", "originalBytes: task.prepared.originalBlob.size",
  'action: "commitVerificationPhotoUpload"'
]) includes(runUpload, field, `direct upload request ${field}`);
includes(runUpload, 'uploadMode === "FUNCTION"', "explicit authenticated function fallback branch");
includes(runUpload, "verificationPhotoBlobDataUrl(task.prepared.originalBlob)", "fallback Base64 conversion");
includes(runUpload, "imageBase64", "fallback commit transports the JPEG bytes");
assert.ok(!runUpload.includes("thumbnailBase64"), "direct upload never Base64-encodes a thumbnail");
assert.ok(!runUpload.includes("sha256VerificationPhoto(task"), "client hashing is not repeated on the critical upload path");
const functionUploadBranchStart = runUpload.indexOf('if (uploadMode === "FUNCTION")');
const directUploadBranchStart = runUpload.indexOf("} else {", functionUploadBranchStart);
const uploadBranchesEnd = runUpload.indexOf("if (task.cancelRequested)", directUploadBranchStart);
const functionUploadBranch = runUpload.slice(functionUploadBranchStart, directUploadBranchStart);
const directUploadBranch = runUpload.slice(directUploadBranchStart, uploadBranchesEnd);
assert.ok(functionUploadBranch.includes("verificationPhotoBlobDataUrl"), "only the function fallback converts the original JPEG to Base64");
assert.ok(functionUploadBranch.includes("imageBase64"), "function fallback sends the JPEG to commit");
assert.ok(functionUploadBranch.includes("functionUploadProof"), "function fallback echoes the server-issued capability proof");
assert.ok(!functionUploadBranch.includes("uploadVerificationPhotoBlob("), "function fallback never attempts a signed browser PUT");
assert.ok(directUploadBranch.includes("uploadVerificationPhotoBlob("), "normal direct mode keeps the signed browser PUT path");
assert.ok(!directUploadBranch.includes("verificationPhotoBlobDataUrl"), "normal direct mode never Base64-encodes the JPEG");
assert.ok(!directUploadBranch.includes("imageBase64"), "normal direct commit sends only request identity");
assert.ok(!directUploadBranch.includes("functionUploadProof"), "normal direct commit never receives or forwards a fallback capability");
assert.ok(
  runUpload.indexOf('action: "beginVerificationPhotoUpload"') < runUpload.indexOf("uploadVerificationPhotoBlob("),
  "permission and upload-intent creation happen before browser storage PUT"
);
assert.ok(
  directUploadBranch.indexOf("await Promise.all(uploads)") < directUploadBranch.indexOf('action: "commitVerificationPhotoUpload"'),
  "commit happens only after every signed PUT succeeds"
);
includes(runUpload, 'clean(error?.code).toUpperCase() === "PHOTO_UPLOAD_ALREADY_ACTIVE"', "cross-tab active conflict");
includes(runUpload, "return await monitorExistingVerificationPhotoUpload(task)", "active conflict never starts a second PUT");
includes(runUpload, "task.intentStarted = true", "server intent acknowledgement");
includes(runUpload, "网络较慢，仍在连接", "a slow begin request explains that photo bytes have not started uploading");
includes(runUpload, "clearTimeout(beginSlowTimer)", "slow-connection notice is cleared when begin settles");
assert.ok(
  runUpload.indexOf("begin?.alreadyCommitted === true") < runUpload.indexOf("signedUploadTarget(begin?.originalUpload)"),
  "an idempotent committed retry succeeds without requiring a fresh signed upload URL"
);

const finishTask = functionSource(ui, "finishVerificationPhotoTask");
assert.ok(
  finishTask.indexOf("if (verificationPhotoUploadTask !== task) return") < finishTask.indexOf("verificationPhotoUploadTask = null"),
  "a late old response cannot unlock or overwrite the new task"
);
includes(finishTask, "verificationPhotoRetryCandidate", "failed or cancelled photo can be retried");
includes(functionSource(ui, "retryVerificationPhotoUpload"), "prepared: candidate.prepared", "retry reuses prepared image bytes");

const cancelTask = functionSource(ui, "cancelVerificationPhotoUpload");
includes(cancelTask, "xhr.abort()", "cancel aborts every in-flight XHR");
includes(cancelTask, "task.beginInFlight", "cancel waits for an already-dispatched begin request");
includes(cancelTask, "!task.intentStarted && !task.beginDispatched", "pre-intent cancellation can finish locally");
includes(cancelTask, "await reconcileVerificationPhotoCancellation", "post-intent cancellation requires server confirmation");

const reconcile = functionSource(ui, "reconcileVerificationPhotoCancellation");
for (const contract of [
  'action: "cancelVerificationPhotoUpload"', 'action: "getVerificationPhotoUploadStatus"',
  "recordId: cancellationRecordId", "requestId: task.requestId",
  '["COMMITTED", "COMPLETED"].includes(status)', "verificationPhotoUploadTerminal(status)",
  "再上传下一张", "task.cancelPromise = null"
]) includes(reconcile, contract, `cancel reconciliation ${contract}`);
includes(reconcile, "cancelNotFound && statusNotFound", "two authoritative not-found confirmations may unlock a never-created intent");
assert.ok(
  !reconcile.slice(reconcile.lastIndexOf('cancelLabel: "再次确认"')).includes("finishVerificationPhotoTask("),
  "an unconfirmed cancellation keeps the global task locked"
);
includes(functionSource(ui, "updateVerificationPhotoTaskUi"), 'meter.removeAttribute("value")', "cancel and recovery states use an indeterminate progress bar");
includes(functionSource(ui, "verificationPhotoCancellationCopy"), "上传未完成，正在恢复", "automatic cleanup keeps the upload failure visible");
includes(functionSource(ui, "verificationPhotoCancellationCopy"), "正在停止上传", "user cancellation has plain-language copy");
includes(reconcile, 'task.reconcileOutcome = "failed"', "a failed upload keeps its recovery outcome across manual rechecks");
includes(reconcile, "task.reconcileFailure = failure", "a failed upload keeps its original error across manual rechecks");
includes(functionSource(ui, "cancelVerificationPhotoUpload"), 'task.reconcileOutcome || "canceled"', "the recheck button preserves failure recovery instead of relabeling it as user cancellation");
includes(reconcile, "progressText: cancelingCopy.progressText", "cancel progress never leaves a stale percentage visible");
includes(reconcile, "callVerificationPhotoLifecycle", "cancel and status checks have bounded client waits");
includes(reconcile, "if (task.beginInFlight)", "not-found checks cannot unlock while the original begin request is unresolved");
includes(functionSource(ui, "updateSignedUploadProgress"), "task.lastRenderedUploadPercent + 5", "upload progress DOM updates are rate limited to visible increments");
includes(styles, '[data-state="canceling"]', "normal cancellation is visually distinct from a failed upload");

const lifecycleHarness = {
  module: { exports: {} },
  setTimeout: (callback) => { queueMicrotask(callback); return 1; },
  clearTimeout: () => {}
};
vm.createContext(lifecycleHarness);
vm.runInContext(`
  const callVerificationPhoto = () => new Promise(() => {});
  ${functionSource(ui, "verificationPhotoUploadError")}
  ${functionSource(ui, "callVerificationPhotoLifecycle")}
  module.exports = { callVerificationPhotoLifecycle };
`, lifecycleHarness, { filename: "verification-photo-lifecycle-timeout.js" });
const lifecycleTimeoutPromise = assert.rejects(
  lifecycleHarness.module.exports.callVerificationPhotoLifecycle({ action: "getVerificationPhotoUploadStatus" }, 1),
  (error) => error?.code === "PHOTO_UPLOAD_CONFIRM_TIMEOUT",
  "a hung cancellation/status check becomes a visible retry state instead of an endless disabled button"
);

const xhrUpload = functionSource(ui, "uploadVerificationPhotoBlob");
for (const contract of [
  "new XMLHttpRequest()", "xhr.upload.addEventListener(\"progress\"", "xhr.timeout = 180000",
  'xhr.addEventListener("abort"', "xhr.send(blob)", "xhr.status >= 200 && xhr.status < 300"
]) includes(xhrUpload, contract, `XHR direct upload ${contract}`);

for (const id of [
  "verificationPhotoUploadTask", "verificationPhotoUploadProgress", "verificationPhotoUploadPercent",
  "cancelVerificationPhotoUpload", "retryVerificationPhotoUpload", "verificationPhotoFileInput"
]) includes(html, `id="${id}"`, `upload task UI ${id}`);
includes(styles, ".verification-photo-upload-task", "upload task styles");
includes(worker, "OffscreenCanvas", "off-main-thread canvas processing");
includes(worker, "createImageBitmap", "off-main-thread image decode");
assert.ok(!worker.includes("readAsDataURL"), "worker returns binary blobs without Base64 expansion");

// Exercise real XHR progress/success/abort behavior from the extracted browser
// function rather than relying only on source-string checks.
class FakeEventTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  emit(name, event = {}) { this.listeners.get(name)?.(event); }
}
class FakeXhr extends FakeEventTarget {
  static instances = [];
  constructor() {
    super();
    this.upload = new FakeEventTarget();
    this.headers = {};
    this.status = 0;
    FakeXhr.instances.push(this);
  }
  open(method, url, async) { this.opened = { method, url, async }; }
  setRequestHeader(key, value) { this.headers[key] = value; }
  send(blob) { this.sent = blob; }
  abort() { this.aborted = true; this.emit("abort"); }
}

const progressSamples = [];
const xhrHarness = {
  module: { exports: {} },
  XMLHttpRequest: FakeXhr,
  clean: (value) => String(value || "").trim(),
  photoSlotLabel: () => "补充照片 1",
  setVerificationPhotoTaskStage: (_task, _state, _title, _detail, progress) => progressSamples.push(progress)
};
vm.createContext(xhrHarness);
vm.runInContext([
  functionSource(ui, "verificationPhotoUploadError"),
  functionSource(ui, "verificationPhotoUploadCanceled"),
  functionSource(ui, "signedUploadTarget"),
  functionSource(ui, "updateSignedUploadProgress"),
  xhrUpload,
  "module.exports = { uploadVerificationPhotoBlob };"
].join("\n"), xhrHarness, { filename: "verification-photo-xhr.js" });

const xhrContractPromise = (async () => {
  const firstTask = { slot: 2, uploadParts: {}, xhrs: new Set() };
  const firstBlob = new Blob([new Uint8Array(100)], { type: "image/jpeg" });
  const firstPromise = xhrHarness.module.exports.uploadVerificationPhotoBlob(firstTask, "高清原图", {
    url: "https://storage.invalid/signed-upload",
    method: "PUT",
    headers: { "Content-Type": "image/jpeg", "X-Test-Signature": "ephemeral" }
  }, firstBlob);
  const firstXhr = FakeXhr.instances.at(-1);
  assert.deepEqual(firstXhr.opened, { method: "PUT", url: "https://storage.invalid/signed-upload", async: true });
  assert.equal(firstXhr.headers["Content-Type"], "image/jpeg");
  assert.equal(firstXhr.headers["X-Test-Signature"], undefined, "raw PUT sends only Content-Type; credentials stay inside the signed URL");
  firstXhr.upload.emit("progress", { lengthComputable: true, loaded: 50 });
  assert.equal(progressSamples.at(-1), 50, "storage upload shows the real 0%-100% transfer progress");
  firstXhr.status = 204;
  firstXhr.emit("load");
  await firstPromise;
  assert.equal(firstTask.xhrs.size, 0, "successful XHR is removed from the active cancellation set");

  const cancelTaskState = { slot: 2, uploadParts: {}, xhrs: new Set() };
  const cancelPromise = xhrHarness.module.exports.uploadVerificationPhotoBlob(cancelTaskState, "高清原图", {
    url: "https://storage.invalid/cancel", method: "PUT", headers: {}
  }, firstBlob);
  const cancelXhr = FakeXhr.instances.at(-1);
  cancelXhr.abort();
  await assert.rejects(cancelPromise, (error) => error?.code === "PHOTO_UPLOAD_CANCELED", "XHR.abort produces the exact cancellable result");
  assert.equal(cancelTaskState.xhrs.size, 0, "aborted XHR is removed from the active set");
})();

// Execute both browser transports. The normal route must remain a binary
// signed PUT; only the explicit server-selected FUNCTION fallback may expand
// the already-compressed JPEG into a Base64 cloud-function payload.
async function runBrowserUploadMode(beginResponse) {
  const calls = [];
  const uploads = [];
  const conversions = [];
  const finishes = [];
  const harness = {
    module: { exports: {} },
    __beginResponse: beginResponse,
    __calls: calls,
    __uploads: uploads,
    __conversions: conversions,
    __finishes: finishes
  };
  vm.createContext(harness);
  vm.runInContext(`
    const clean = (value) => String(value || "").trim();
    const photoSlotLabel = () => "补充照片 1";
    const setVerificationPhotoTaskStage = () => {};
    const prepareVerificationPhoto = async () => ({
      originalBlob: { size: 123, kind: "original" },
      thumbnailBlob: { size: 45, kind: "thumbnail" }
    });
    let verificationPhotoUploadTask = null;
    const assertVerificationPhotoTask = (task) => {
      if (verificationPhotoUploadTask !== task) throw new Error("stale task");
    };
    const callVerificationPhoto = async (payload) => {
      globalThis.__calls.push(payload);
      if (payload.action === "beginVerificationPhotoUpload") return globalThis.__beginResponse;
      return { ok: true, photo: { slot: 2 } };
    };
    const directVerificationPhotoUploadUnavailable = () => false;
    const monitorExistingVerificationPhotoUpload = async () => {};
    const verificationPhotoUploadStatus = (payload) => String(payload?.status || "").toUpperCase();
    const reconcileVerificationPhotoCancellation = async () => {};
    const verificationPhotoUploadError = (message, code) => Object.assign(new Error(message), { code });
    const signedUploadTarget = (value) => value || {};
    const uploadVerificationPhotoBlob = async (_task, label, target, blob) => {
      globalThis.__uploads.push({ label, target, blob });
    };
    const verificationPhotoBlobDataUrl = async (blob) => {
      globalThis.__conversions.push(blob);
      return "data:image/jpeg;base64,/9j/2Q==";
    };
    const applyCommittedVerificationPhoto = () => {};
    const finishVerificationPhotoTask = (...args) => globalThis.__finishes.push(args);
    const isVerificationPhotoUploadCanceled = () => false;
    const setTimeout = () => 1;
    const clearTimeout = () => {};
    ${runUpload}
    module.exports = {
      run: async (task) => {
        verificationPhotoUploadTask = task;
        await runVerificationPhotoUpload(task);
      }
    };
  `, harness, { filename: "verification-photo-browser-modes.js" });
  const task = {
    recordId: "71",
    slot: 2,
    requestId: "vp_mode_contract_123",
    file: { name: "photo.jpg" },
    cancelRequested: false,
    intentStarted: false,
    beginDispatched: false,
    beginInFlight: false,
    xhrs: new Set(),
    uploadParts: {},
    progress: 0
  };
  await harness.module.exports.run(task);
  return { calls, uploads, conversions, finishes, task };
}

const browserModeContractPromise = (async () => {
  const direct = await runBrowserUploadMode({
    ok: true,
    requestId: "vp_mode_contract_123",
    status: "UPLOADING",
    uploadMode: "DIRECT",
    originalUpload: { url: "https://storage.invalid/direct", method: "PUT", headers: {} },
    thumbnailUpload: null
  });
  assert.equal(direct.uploads.length, 1, "DIRECT mode performs the original JPEG signed PUT");
  assert.equal(direct.conversions.length, 0, "DIRECT mode never Base64-expands the JPEG");
  const directCommit = direct.calls.find((payload) => payload.action === "commitVerificationPhotoUpload");
  assert.deepEqual(Object.keys(directCommit).sort(), ["action", "recordId", "requestId"], "DIRECT commit sends only request identity");

  const fallback = await runBrowserUploadMode({
    ok: true,
    requestId: "vp_mode_contract_123",
    status: "UPLOADING",
    uploadMode: "FUNCTION",
    functionUploadProof: "a".repeat(64),
    originalUpload: null,
    thumbnailUpload: null
  });
  assert.equal(fallback.uploads.length, 0, "FUNCTION mode never starts a browser storage PUT");
  assert.equal(fallback.conversions.length, 1, "FUNCTION mode Base64-encodes exactly the compressed original once");
  const fallbackCommit = fallback.calls.find((payload) => payload.action === "commitVerificationPhotoUpload");
  assert.equal(fallbackCommit.imageBase64, "data:image/jpeg;base64,/9j/2Q==", "FUNCTION commit carries the fallback JPEG bytes");
  assert.equal(fallbackCommit.functionUploadProof, "a".repeat(64), "FUNCTION commit echoes the exact server-issued proof");
  assert.deepEqual(
    Object.keys(fallbackCommit).sort(),
    ["action", "functionUploadProof", "imageBase64", "recordId", "requestId"],
    "FUNCTION fallback cannot submit bucket, path, dimensions, hash, or other authoritative metadata"
  );
})();

// Execute the task gate with a deliberately unresolved first upload. The
// second slot must not reach the upload runner while the first owns the gate.
let releaseFirstUpload;
const entryCalls = [];
const entryHarness = {
  module: { exports: {} },
  crypto: { getRandomValues(array) { array.set([11, 22, 33]); return array; } }
};
vm.createContext(entryHarness);
vm.runInContext(`
  let verificationPhotoUploadBusy = false;
  let verificationPhotoUploadTask = null;
  let verificationPhotoRetryCandidate = null;
  let verificationPhotoTaskSequence = 0;
  let orderExportBusy = false;
  const entryCalls = globalThis.__entryCalls;
  const clean = (value) => String(value || "").trim();
  const $ = () => ({ className: "", textContent: "" });
  const updateVerificationPhotoTaskUi = () => { globalThis.__busyNotice = true; };
  const setVerificationPhotoButtonsDisabled = () => {};
  const setExportControls = () => {};
  const runVerificationPhotoUpload = (task) => {
    entryCalls.push(task);
    return new Promise((resolve) => { globalThis.__releaseFirstUpload = resolve; });
  };
  ${uploadEntry}
  module.exports = {
    uploadVerificationPhoto,
    state: () => ({ busy: verificationPhotoUploadBusy, task: verificationPhotoUploadTask, notice: globalThis.__busyNotice })
  };
`, Object.assign(entryHarness, { __entryCalls: entryCalls }), { filename: "verification-photo-single-task.js" });
const singleTaskPromise = (async () => {
  const first = entryHarness.module.exports.uploadVerificationPhoto("71", 2, { name: "one.jpg" });
  const firstState = entryHarness.module.exports.state();
  assert.equal(firstState.busy, true);
  assert.match(firstState.task.requestId, /^vp_[A-Za-z0-9_]{12,61}$/, "client request id is generated before begin");
  await entryHarness.module.exports.uploadVerificationPhoto("71", 3, { name: "two.jpg" });
  assert.equal(entryCalls.length, 1, "a second photo cannot enter preprocessing or upload while one task is active");
  assert.equal(entryHarness.module.exports.state().notice, true, "the blocked second action explains how to continue");
  entryHarness.__releaseFirstUpload();
  await first;
})();

// A response belonging to an old task must not unlock a newer task. Only the
// exact current task may clear the global gate and expose retry controls.
const lateHarness = { module: { exports: {} } };
vm.createContext(lateHarness);
vm.runInContext(`
  const newTask = { id: 2, slot: 3, recordId: "71", xhrs: new Set() };
  let verificationPhotoUploadTask = newTask;
  let verificationPhotoUploadBusy = true;
  let verificationPhotoRetryCandidate = null;
  let currentRecord = {};
  let currentVerificationPhotoPayload = { photos: [] };
  let verificationPhotoLoadPromise = Promise.resolve();
  const photoSlotLabel = () => "补充照片";
  const setVerificationPhotoTaskStage = () => { globalThis.__stageCalls = (globalThis.__stageCalls || 0) + 1; };
  const setVerificationPhotoButtonsDisabled = () => {};
  const setExportControls = () => {};
  const refreshVerificationPhotosSilently = async () => null;
  ${functionSource(ui, "verificationPhotoRetryFromTask")}
  ${functionSource(ui, "verificationPhotoManifestReady")}
  ${finishTask}
  module.exports = {
    newTask,
    finishVerificationPhotoTask,
    state: () => ({ task: verificationPhotoUploadTask, busy: verificationPhotoUploadBusy, stages: globalThis.__stageCalls || 0 })
  };
`, lateHarness, { filename: "verification-photo-late-response.js" });
const oldTask = { id: 1, slot: 2, recordId: "71", xhrs: new Set() };
lateHarness.module.exports.finishVerificationPhotoTask(oldTask, "success", "late");
assert.equal(lateHarness.module.exports.state().task, lateHarness.module.exports.newTask, "late old completion preserves the new owner");
assert.equal(lateHarness.module.exports.state().busy, true, "late old completion preserves the global lock");
assert.equal(lateHarness.module.exports.state().stages, 0, "late old completion cannot mutate the new progress UI");
lateHarness.module.exports.finishVerificationPhotoTask(lateHarness.module.exports.newTask, "success", "done", { refresh: false });
assert.equal(lateHarness.module.exports.state().task, null);
assert.equal(lateHarness.module.exports.state().busy, false);

// Exercise cancellation reconciliation for all important races: a confirmed
// cancel, commit winning the race, and a non-terminal server response.
function cancellationScenario(responses) {
  const finishes = [];
  const stages = [];
  const queue = [...responses];
  const harness = { module: { exports: {} }, __finishes: finishes, __stages: stages, __queue: queue };
  vm.createContext(harness);
  vm.runInContext(`
    const clean = (value) => String(value || "").trim();
    const callVerificationPhoto = async () => globalThis.__queue.length ? globalThis.__queue.shift() : { status: "UPLOADING" };
    const callVerificationPhotoLifecycle = callVerificationPhoto;
    const setTimeout = (callback) => { callback(); return 1; };
    const setVerificationPhotoTaskStage = (...args) => globalThis.__stages.push(args);
    const finishVerificationPhotoTask = (...args) => globalThis.__finishes.push(args);
    const applyCommittedVerificationPhoto = () => { globalThis.__applied = true; };
    ${functionSource(ui, "verificationPhotoUploadStatus")}
    ${functionSource(ui, "verificationPhotoUploadTerminal")}
    ${functionSource(ui, "verificationPhotoUploadRequestNotFound")}
    ${functionSource(ui, "verificationPhotoCancellationCopy")}
    ${reconcile}
    module.exports = { reconcileVerificationPhotoCancellation };
  `, harness, { filename: "verification-photo-cancel-race.js" });
  return { harness, finishes, stages };
}

const cancelRacePromise = (async () => {
  const confirmed = cancellationScenario([{ status: "CANCELLED" }]);
  const confirmedTask = { recordId: "71", requestId: "vp_confirmed_123456", slot: 2, progress: 50, xhrs: new Set() };
  await confirmed.harness.module.exports.reconcileVerificationPhotoCancellation(confirmedTask, "canceled");
  assert.equal(confirmed.finishes.length, 1);
  assert.equal(confirmed.finishes[0][1], "canceled", "confirmed cancel unlocks as cancelled");

  const committed = cancellationScenario([{ status: "COMMITTED", photo: { slot: 2 } }]);
  const committedTask = { recordId: "71", requestId: "vp_committed_123456", slot: 2, progress: 90, xhrs: new Set() };
  await committed.harness.module.exports.reconcileVerificationPhotoCancellation(committedTask, "canceled");
  assert.equal(committed.finishes.length, 1);
  assert.equal(committed.finishes[0][1], "success", "commit winning the cancel race is reported as the authoritative success");
  assert.equal(committed.harness.__applied, true, "committed race result updates the visible photo");

  const pending = cancellationScenario(Array.from({ length: 7 }, () => ({ status: "UPLOADING" })));
  const pendingTask = { recordId: "71", requestId: "vp_pending_1234567", slot: 2, progress: 60, xhrs: new Set() };
  await pending.harness.module.exports.reconcileVerificationPhotoCancellation(pendingTask, "canceled");
  assert.equal(pending.finishes.length, 0, "non-terminal cancellation never unlocks a retry");
  assert.equal(pendingTask.cancelPromise, null, "user may explicitly retry cancellation reconciliation");
  assert.ok(pending.stages.some((args) => String(args[3]).includes("再上传下一张")));
})();

// Cloud function contract: live authorization precedes signing; clients never
// choose object paths or provide authoritative metadata at commit.
for (const action of [
  "beginVerificationPhotoUpload", "commitVerificationPhotoUpload",
  "cancelVerificationPhotoUpload", "getVerificationPhotoUploadStatus"
]) includes(cloud, `if (action === "${action}")`, `cloud action ${action}`);

const beginCloud = functionSource(cloud, "beginVerificationPhotoUpload");
const beginStoredSignIndex = beginCloud.indexOf("signVerificationPhotoUploadReference(storedReference)");
const initialOwnerCheckIndex = beginCloud.indexOf("requireVerificationPhotoUploadOwner(context);");
const liveWindowCheckIndex = beginCloud.indexOf("requireVerificationPhotoUploadOwner(context, { requireWindow: true });");
const committedRetryIndex = beginCloud.indexOf('String(existing.request_status) === "COMMITTED"');
assert.ok(
  beginCloud.indexOf("verificationPhotoContext(event)") < beginStoredSignIndex,
  "order/account permission is checked before a signed upload URL is minted"
);
assert.ok(
  beginCloud.indexOf("requireVerificationPhotoUploadOwner(context, { requireWindow: true })")
    < beginStoredSignIndex,
  "submitter and 24-hour window are checked before signing"
);
assert.ok(
  initialOwnerCheckIndex < beginCloud.indexOf("const existingRows = await executeSql"),
  "every begin retry authenticates the exact submitter before reading upload state"
);
assert.ok(
  committedRetryIndex < liveWindowCheckIndex,
  "the same committed request remains idempotently readable after the 24-hour edit window"
);
assert.ok(
  beginCloud.indexOf("Number(existing.photo_slot) !== slot") < beginCloud.indexOf("alreadyCommitted: true")
    && beginCloud.indexOf("Number(existing.expected_original_bytes) !== originalBytes") < beginCloud.indexOf("alreadyCommitted: true"),
  "an idempotent committed retry still binds the original slot and byte count"
);
assert.ok(
  liveWindowCheckIndex < beginCloud.indexOf("availableVerificationPhotoUploadStorage(originalBytes)")
    && liveWindowCheckIndex < beginCloud.indexOf("FROM public.begin_verification_photo_upload("),
  "expired uploads cannot allocate storage paths or enter the live database transaction"
);
assert.ok(
  beginCloud.indexOf("FROM public.begin_verification_photo_upload(") < beginStoredSignIndex,
  "the database transaction locks and establishes the one-active upload intent before any signed URL is minted"
);
assert.ok(
  beginCloud.indexOf("if (!databaseBoolean(request.request_matches))") < beginStoredSignIndex,
  "a cross-tab conflict is returned before any storage upload authority is created"
);
includes(beginCloud, "availableVerificationPhotoUploadStorage(originalBytes)", "existing PostgreSQL bucket and per-file limit preflight");
const bucketReadySource = functionSource(cloud, "verificationPhotoBucketReady");
for (const field of ["row.public", "row.file_size_limit", "row.allowed_mime_types", 'includes("image/jpeg")']) {
  includes(bucketReadySource, field, `private JPEG bucket validation ${field}`);
}
const bucketReadyHarness = {
  module: { exports: {} },
  databaseBoolean: (value) => [true, "true", "t", 1, "1"].includes(value),
  MAX_VERIFICATION_IMAGE_BYTES: 3 * 1024 * 1024
};
vm.createContext(bucketReadyHarness);
vm.runInContext([
  bucketReadySource,
  "module.exports = { verificationPhotoBucketReady };"
].join("\n"), bucketReadyHarness);
const bucketReady = bucketReadyHarness.module.exports.verificationPhotoBucketReady;
assert.equal(bucketReady({ public: false, file_size_limit: 5 * 1024 * 1024, allowed_mime_types: ["image/jpeg"] }, 123), true, "private JPEG bucket with sufficient limit is ready");
assert.equal(bucketReady({ public: true, file_size_limit: 5 * 1024 * 1024, allowed_mime_types: ["image/jpeg"] }, 123), false, "public evidence bucket is rejected");
assert.equal(bucketReady({ public: false, file_size_limit: 100, allowed_mime_types: ["image/jpeg"] }, 123), false, "undersized bucket limit is rejected");
assert.equal(bucketReady({ public: false, file_size_limit: 5 * 1024 * 1024, allowed_mime_types: ["image/png"] }, 123), false, "bucket without JPEG MIME is rejected");
assert.equal(bucketReady({ public: false, file_size_limit: null, allowed_mime_types: '{image/jpeg}' }, 123), true, "PostgreSQL text-array JPEG metadata is accepted");
includes(beginCloud, 'uploadMode = "FUNCTION"', "server-selected authenticated fallback mode");
includes(beginCloud, "signedUploadFunctionFallbackAllowed(error)", "narrow signed-upload fallback predicate");
assert.ok(
  beginCloud.indexOf("requireVerificationPhotoFunctionFallbackStorage(storedReference)")
    < beginCloud.indexOf('uploadMode = "FUNCTION"'),
  "FUNCTION mode is enabled only after the same credential and environment can list the exact bucket"
);
includes(beginCloud, 'functionUploadProof: uploadMode === "FUNCTION"', "only FUNCTION mode receives a fallback capability");
includes(beginCloud, "verificationPhotoFunctionUploadProof(context, request)", "fallback capability is bound to the locked request");
includes(beginCloud, "originalUpload: upload ?", "FUNCTION mode returns no unusable signed target");
includes(beginCloud, "crypto.randomBytes(24)", "server nonce for storage path");
includes(beginCloud, "`records/${context.verificationId}/slot-${slot}/direct-${Date.now()}-${nonce}.jpg`", "server-derived object path");
assert.ok(!/event\.(?:object|bucket|path|key)/.test(beginCloud), "browser cannot choose bucket or object path");
assert.ok(!beginCloud.includes("accessToken"), "begin response never exposes the service storage credential");

const fallbackPredicateHarness = {
  module: { exports: {} },
  responseErrorText: (error) => String(error?.responseError || "")
};
vm.createContext(fallbackPredicateHarness);
vm.runInContext([
  functionSource(cloud, "signedUploadFunctionFallbackAllowed"),
  "module.exports = { signedUploadFunctionFallbackAllowed };"
].join("\n"), fallbackPredicateHarness, { filename: "verification-photo-upload-fallback-predicate.js" });
const fallbackAllowed = fallbackPredicateHarness.module.exports.signedUploadFunctionFallbackAllowed;
assert.equal(
  fallbackAllowed({ code: "STORAGE_INVALID_REQUEST", message: "The related resource does not exist" }),
  true,
  "only the observed missing related-resource signing failure enables FUNCTION mode"
);
assert.equal(
  fallbackAllowed({ responseError: "STORAGE_INVALID_REQUEST: The related resource does not exist" }),
  true,
  "the exact gateway error may be detected from a nested response"
);
assert.equal(fallbackAllowed({ code: "STORAGE_INVALID_REQUEST", message: "invalid request" }), false, "a generic invalid request must fail closed");
assert.equal(fallbackAllowed({ message: "The related resource does not exist" }), false, "a missing-resource phrase without the storage error code must fail closed");
assert.equal(fallbackAllowed({ code: "STORAGE_ACCESS_DENIED", message: "403 forbidden" }), false, "authorization failures never enter the server upload fallback");

const storageEnvironmentErrorSource = functionSource(cloud, "verificationPhotoStorageEnvironmentError");
const storageAccessErrorSource = functionSource(cloud, "verificationPhotoStorageAccessError");
includes(storageEnvironmentErrorSource, 'mismatch.code = "PHOTO_STORAGE_ENV_MISMATCH"', "storage environment mismatch has an actionable stable code");
includes(storageEnvironmentErrorSource, "storage.envId", "storage environment diagnostic identifies the configured environment");
includes(storageEnvironmentErrorSource, "storage.bucketId", "storage environment diagnostic identifies the configured bucket");
const fallbackStorageProbeSource = functionSource(cloud, "requireVerificationPhotoFunctionFallbackStorage");
for (const check of [
  "verificationPhotoReference(referenceValue)", "verificationPhotoStorageForEvidence(reference)",
  "listObjects", "bucketId: reference.bucketId", "limit: 1", "accessToken: storage.accessToken",
  "envId: storage.envId", "verificationPhotoStorageAccessError(error, storage)"
]) includes(fallbackStorageProbeSource, check, `FUNCTION storage preflight ${check}`);

const fallbackStorageProbeCalls = [];
let fallbackStorageProbeFailure = null;
const fallbackStorageProbeHarness = {
  module: { exports: {} },
  __calls: fallbackStorageProbeCalls,
  verificationPhotoReference: () => ({ bucketId: "customer-photos", objectName: "records/71/slot-2/direct-proof.jpg" }),
  verificationPhotoStorageForEvidence: () => ({ bucketId: "customer-photos", accessToken: "same-service-token", envId: "same-env" }),
  responseErrorText: () => "",
  storageBucketMissing: (error) => String(error?.code || "").includes("BUCKET_NOT_FOUND"),
  fail(message, code) { throw Object.assign(new Error(message), { code }); },
  manager: () => ({
    storage: {
      listObjects: async (options) => {
        fallbackStorageProbeCalls.push(options);
        if (fallbackStorageProbeFailure) throw fallbackStorageProbeFailure;
        return { data: [] };
      }
    }
  })
};
vm.createContext(fallbackStorageProbeHarness);
vm.runInContext([
  storageEnvironmentErrorSource,
  storageAccessErrorSource,
  fallbackStorageProbeSource,
  "module.exports = { requireVerificationPhotoFunctionFallbackStorage };"
].join("\n"), fallbackStorageProbeHarness, { filename: "verification-photo-function-storage-probe.js" });
const fallbackStorageProbePromise = (async () => {
  fallbackStorageProbeCalls.length = 0;
  await fallbackStorageProbeHarness.module.exports.requireVerificationPhotoFunctionFallbackStorage("pg://customer-photos/records/71/slot-2/direct-proof.jpg");
  assert.deepEqual(
    JSON.parse(JSON.stringify(fallbackStorageProbeCalls[0])),
    { bucketId: "customer-photos", limit: 1, withDelimiter: false, accessToken: "same-service-token", envId: "same-env" },
    "FUNCTION preflight uses the same bucket, service token, and environment as the failed signed upload"
  );
  fallbackStorageProbeFailure = Object.assign(new Error("The related resource does not exist"), {
    code: "STORAGE_INVALID_REQUEST",
    requestId: "request-123"
  });
  await assert.rejects(
    fallbackStorageProbeHarness.module.exports.requireVerificationPhotoFunctionFallbackStorage("pg://customer-photos/records/71/slot-2/direct-proof.jpg"),
    (error) => error?.code === "PHOTO_STORAGE_ENV_MISMATCH" && error?.requestId === "request-123",
    "a bucket that the same credentials cannot list fails clearly instead of entering FUNCTION mode"
  );
  fallbackStorageProbeFailure = Object.assign(new Error("temporary upstream timeout"), {
    code: "HTTP_504",
    requestId: "request-504"
  });
  await assert.rejects(
    fallbackStorageProbeHarness.module.exports.requireVerificationPhotoFunctionFallbackStorage("pg://customer-photos/records/71/slot-2/direct-proof.jpg"),
    (error) => error?.code === "PHOTO_STORAGE_CHECK_FAILED" && error?.requestId === "request-504",
    "a transient storage probe failure is not misreported as an environment mismatch"
  );
})();

const functionProofSource = functionSource(cloud, "verificationPhotoFunctionUploadProof");
for (const binding of [
  '"verification-photo-function-upload-v1"', "request.request_id", "context.verificationId",
  "context.caller.staffId", "request.photo_slot", "request.expected_original_bytes",
  "request.original_object_ref", 'createHmac("sha256", cloudbaseServiceRoleKey())'
]) includes(functionProofSource, binding, `FUNCTION proof binding ${binding}`);
const requireFunctionProofSource = functionSource(cloud, "requireVerificationPhotoFunctionUploadProof");
includes(requireFunctionProofSource, "/^[a-f0-9]{64}$/", "fallback proof strict hexadecimal shape");
includes(requireFunctionProofSource, "crypto.timingSafeEqual", "fallback proof constant-time comparison");
includes(requireFunctionProofSource, '"PHOTO_FUNCTION_UPLOAD_NOT_AUTHORIZED"', "missing or forged fallback proof fails closed");

const functionProofHarness = {
  module: { exports: {} },
  crypto,
  Buffer,
  cloudbaseServiceRoleKey: () => "test-service-role-secret",
  fail(message, code) { throw Object.assign(new Error(message), { code }); }
};
vm.createContext(functionProofHarness);
vm.runInContext([
  functionProofSource,
  requireFunctionProofSource,
  "module.exports = { verificationPhotoFunctionUploadProof, requireVerificationPhotoFunctionUploadProof };"
].join("\n"), functionProofHarness, { filename: "verification-photo-function-proof.js" });
const proofContext = { verificationId: 71, caller: { staffId: 88 } };
const proofRequest = {
  request_id: "vp_proof_contract_123",
  photo_slot: 2,
  expected_original_bytes: 123,
  original_object_ref: "pg://customer-photos/records/71/slot-2/direct-proof.jpg"
};
const validFunctionProof = functionProofHarness.module.exports.verificationPhotoFunctionUploadProof(proofContext, proofRequest);
assert.match(validFunctionProof, /^[a-f0-9]{64}$/, "server proof is a SHA-256 HMAC capability");
assert.doesNotThrow(() => functionProofHarness.module.exports.requireVerificationPhotoFunctionUploadProof(
  { functionUploadProof: validFunctionProof }, proofContext, proofRequest
));
assert.notEqual(
  functionProofHarness.module.exports.verificationPhotoFunctionUploadProof(proofContext, { ...proofRequest, original_object_ref: `${proofRequest.original_object_ref}.forged` }),
  validFunctionProof,
  "the proof cannot be reused for a different storage path"
);
assert.throws(
  () => functionProofHarness.module.exports.requireVerificationPhotoFunctionUploadProof(
    { functionUploadProof: "0".repeat(64) }, proofContext, proofRequest
  ),
  (error) => error?.code === "PHOTO_FUNCTION_UPLOAD_NOT_AUTHORIZED",
  "a DIRECT client cannot force Base64 fallback without the server-only capability"
);

const signedUpload = functionSource(cloud, "signedVerificationPhotoUpload");
includes(signedUpload, 'headers: { "Content-Type": "image/jpeg" }', "raw signed PUT content-type contract");
assert.ok(!signedUpload.includes("storage.accessToken"), "signed target never returns storage accessToken");

const signingHarness = {
  module: { exports: {} },
  URL,
  console: { error() {} },
  safeResponseShape: () => ({}),
  fail(message, code) { const error = new Error(message); error.code = code; throw error; }
};
vm.createContext(signingHarness);
vm.runInContext([
  functionSource(cloud, "nestedResponseValue"),
  signedUpload,
  "module.exports = { signedVerificationPhotoUpload };"
].join("\n"), signingHarness, { filename: "verification-photo-signed-target.js" });
const signedTarget = signingHarness.module.exports.signedVerificationPhotoUpload(
  { data: { signedUrl: "https://storage.invalid/object.jpg?algorithm=test", uploadToken: "short-lived-token" } },
  { bucketId: "verification-photos", accessToken: "service-role-must-not-leak" },
  "records/71/slot-2/direct-server.jpg"
);
assert.equal(new URL(signedTarget.url).searchParams.get("token"), "short-lived-token", "SDK token is normalized into the complete signed URL");
assert.deepEqual(JSON.parse(JSON.stringify(signedTarget.headers)), { "Content-Type": "image/jpeg" });
assert.equal(Object.prototype.hasOwnProperty.call(signedTarget, "token"), false, "short-lived token is not duplicated into response fields");
assert.ok(!JSON.stringify(signedTarget).includes("service-role-must-not-leak"), "service role accessToken never enters the browser response");

const inspectObject = functionSource(cloud, "inspectVerificationPhotoObject");
for (const securityCheck of [
  "getObjectInfoAuthenticated", "bytes !== expectedBytes", 'contentType !== "image/jpeg"',
  "returnedBucket !== reference.bucketId", "!allowedNames.includes(returnedName)",
  "downloadVerificationPhotoAuthenticated", "verificationPhotoBufferMetadata(buffer)"
]) includes(inspectObject, securityCheck, `server object verification ${securityCheck}`);
assert.ok(!inspectObject.includes("signVerificationPhoto("), "commit inspection never depends on a short-lived public URL");
assert.ok(!inspectObject.includes("downloadVerificationPhotoBytes("), "commit inspection never uses unauthenticated HTTPS download code");
assert.ok(!inspectObject.includes("allowCustomerProfile"), "upload commit inspection cannot opt into arbitrary customer profile paths");

const authenticatedDownload = functionSource(cloud, "downloadVerificationPhotoAuthenticated");
for (const securityCheck of [
  "verificationPhotoReference(referenceValue)", "verificationPhotoStorageForEvidence(reference)",
  "downloadAuthenticatedObject", "bucketId: reference.bucketId", "objectName,",
  "declaredBytes > maximumBytes", "totalBytes > maximumBytes", "Buffer.concat(chunks)",
  "storageObjectMissing(error)"
]) includes(authenticatedDownload, securityCheck, `authenticated object download ${securityCheck}`);
includes(authenticatedDownload, "options.allowCustomerProfile === true", "customer profile path access requires an explicit option");
includes(authenticatedDownload, "reference.bucketId === customerStorage.bucketId", "profile allowance remains bound to the configured customer bucket");
includes(authenticatedDownload, "photoObjectCandidates(reference.bucketId, reference.objectName)", "profile download supports historical repeated-bucket paths");
includes(authenticatedDownload, ": [reference.objectName]", "ordinary evidence downloads use only the exact stored object path");
assert.ok(!authenticatedDownload.includes("signedPhotoUrl"), "authenticated inspection does not create or expose a signed URL");

const authenticatedProfileDownloadCalls = [];
const authenticatedProfileBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const authenticatedProfileHarness = {
  module: { exports: {} },
  Buffer,
  __calls: authenticatedProfileDownloadCalls,
  verificationPhotoStorageSettings: () => ({ bucketId: "verification-photos", accessToken: "verification-token", envId: "env" }),
  photoStorageSettings: () => ({ bucketId: "customer-photos", accessToken: "customer-token", envId: "env" }),
  fail(message, code) { throw Object.assign(new Error(message), { code }); },
  manager: () => ({
    storage: {
      downloadAuthenticatedObject: async (options) => {
        authenticatedProfileDownloadCalls.push(options);
        if (options.objectName.startsWith("customer-photos/")) {
          throw Object.assign(new Error("object not found"), { code: "STORAGE_OBJECT_NOT_FOUND" });
        }
        return {
          status: 200,
          headers: { "content-length": String(authenticatedProfileBytes.length) },
          body: {
            async *[Symbol.asyncIterator]() { yield authenticatedProfileBytes; }
          }
        };
      }
    }
  })
};
vm.createContext(authenticatedProfileHarness);
vm.runInContext([
  functionSource(cloud, "verificationPhotoStorageCandidates"),
  functionSource(cloud, "verificationPhotoReference"),
  functionSource(cloud, "photoObjectCandidates"),
  functionSource(cloud, "storageObjectMissing"),
  functionSource(cloud, "verificationPhotoStorageForEvidence"),
  authenticatedDownload,
  "module.exports = { downloadVerificationPhotoAuthenticated };"
].join("\n"), authenticatedProfileHarness, { filename: "verification-photo-authenticated-profile-download.js" });
const authenticatedProfileDownloadPromise = (async () => {
  authenticatedProfileDownloadCalls.length = 0;
  await assert.rejects(
    authenticatedProfileHarness.module.exports.downloadVerificationPhotoAuthenticated(
      "pg://customer-photos/customers/7/profile.jpg",
      1024
    ),
    (error) => error?.code === "PHOTO_BUCKET_MISMATCH",
    "default authenticated evidence download rejects arbitrary customer-photo paths"
  );
  assert.equal(authenticatedProfileDownloadCalls.length, 0, "rejected customer paths never reach storage");

  const downloaded = await authenticatedProfileHarness.module.exports.downloadVerificationPhotoAuthenticated(
    "pg://customer-photos/customer-photos/customers/7/profile.jpg",
    1024,
    { allowCustomerProfile: true }
  );
  assert.deepEqual(Buffer.from(downloaded), authenticatedProfileBytes, "explicit profile download returns the retained JPEG bytes");
  assert.deepEqual(
    authenticatedProfileDownloadCalls.map((call) => call.objectName),
    ["customer-photos/customers/7/profile.jpg", "customers/7/profile.jpg"],
    "legacy repeated bucket prefix falls back to the normalized object path after exact-path miss"
  );
  assert.ok(
    authenticatedProfileDownloadCalls.every((call) => call.bucketId === "customer-photos" && call.accessToken === "customer-token" && call.envId === "env"),
    "legacy candidate retry stays inside the configured private customer bucket and credentials"
  );
})();
const bufferMetadata = functionSource(cloud, "verificationPhotoBufferMetadata");
includes(bufferMetadata, "jpegDimensions(buffer)", "server parses JPEG dimensions from authenticated bytes");
includes(bufferMetadata, 'crypto.createHash("sha256").update(buffer)', "server hashes authenticated bytes");

const commitCloud = functionSource(cloud, "commitVerificationPhotoUpload");
assert.ok(
  commitCloud.indexOf("requireVerificationPhotoUploadOwner(context)")
    < commitCloud.indexOf('initialState.status === "COMMITTED"'),
  "commit authenticates the submitter before reading an idempotent result"
);
assert.ok(
  commitCloud.indexOf('initialState.status === "COMMITTED"')
    < commitCloud.indexOf("requireVerificationPhotoUploadOwner(context, { requireWindow: true })")
    && commitCloud.indexOf("requireVerificationPhotoUploadOwner(context, { requireWindow: true })")
      < commitCloud.indexOf("inspectVerificationPhotoObject("),
  "an already committed retry works after 24 hours, while a live upload rechecks the window before inspection"
);
includes(commitCloud, "inspected = await inspectVerificationPhotoObject", "server-inspected metadata");
includes(commitCloud, "if (event.imageBase64)", "commit accepts bytes only for the explicit function fallback");
includes(commitCloud, "if (PHOTO_ONLY_FUNCTION && !event.imageBase64)", "dedicated photo service refuses a byte-less direct-upload commit");
includes(commitCloud, '"PHOTO_FUNCTION_UPLOAD_REQUIRED"', "dedicated photo service has a stable function-upload-only error");
assert.ok(
  commitCloud.indexOf("requireVerificationPhotoFunctionUploadProof(event, context, request)")
    < commitCloud.indexOf("cleanVerificationJpeg("),
  "fallback capability is verified before attacker-controlled Base64 is decoded"
);
includes(commitCloud, 'cleanVerificationJpeg(', "fallback JPEG is decoded and validated on the server");
assert.ok(
  commitCloud.indexOf("fallbackPhoto.buffer.length !== Number(request.expected_original_bytes)")
    < commitCloud.indexOf("uploadVerificationPhotoReference(request.original_object_ref, fallbackPhoto.buffer)"),
  "fallback bytes must exactly match the locked upload intent before server storage"
);
assert.ok(
  commitCloud.indexOf("uploadVerificationPhotoReference(request.original_object_ref, fallbackPhoto.buffer)")
    < commitCloud.indexOf("verificationPhotoBufferMetadata(fallbackPhoto.buffer)"),
  "function upload derives commit metadata from the exact server-validated JPEG bytes after storage accepts them"
);
assert.ok(
  commitCloud.indexOf("verificationPhotoBufferMetadata(fallbackPhoto.buffer)")
    < commitCloud.indexOf("public.commit_verification_photo_upload"),
  "function upload computes server-owned dimensions and hash before the atomic database commit"
);
assert.ok(
  !commitCloud.slice(
    commitCloud.indexOf("if (event.imageBase64)"),
    commitCloud.indexOf("} else {", commitCloud.indexOf("if (event.imageBase64)"))
  ).includes("inspectVerificationPhotoObject("),
  "normal function uploads avoid immediately downloading the JPEG that this invocation just stored"
);
for (const value of ["inspected.bytes", "inspected.width", "inspected.height", "inspected.sha256"]) {
  includes(commitCloud, value, `database receives authoritative ${value}`);
}
assert.ok(!/event\.(?:imageWidth|imageHeight|sha256|contentType|object|bucket|path|key)/.test(commitCloud), "commit ignores client bucket, path, dimensions, hash, and content-type metadata");
assert.ok(
  commitCloud.indexOf('initialState.status === "COMMITTED"') < commitCloud.indexOf("inspectVerificationPhotoObject("),
  "commit retry is idempotent and does not redownload an already committed object"
);
assert.ok(
  commitCloud.indexOf('initialState.status === "CANCELLED"') < commitCloud.indexOf("inspectVerificationPhotoObject("),
  "cancelled/expired intent cannot be committed by a late response"
);

const exactFallbackUpload = functionSource(cloud, "uploadVerificationPhotoReference");
for (const securityCheck of [
  "verificationPhotoReference(referenceValue)", "verificationPhotoStorageForEvidence(reference)",
  "bucketId: reference.bucketId", "objectName: reference.objectName", "body: buffer",
  "upsert: false", "downloadVerificationPhotoAuthenticated(referenceValue", "existing.length === buffer.length",
  "existingSha === expectedSha", "signedUploadFunctionFallbackAllowed(error)",
  "verificationPhotoStorageEnvironmentError(error, storage)"
]) includes(exactFallbackUpload, securityCheck, `exact server fallback upload ${securityCheck}`);
includes(exactFallbackUpload, '"PHOTO_UPLOAD_CONTENT_CONFLICT"', "an existing fallback object with different bytes fails with an explicit conflict");
assert.ok(!exactFallbackUpload.includes("verificationPhotoStorageCandidates()"), "fallback never drifts into a client-unbound or alternate bucket");
assert.ok(!exactFallbackUpload.includes("allowCustomerProfile"), "fallback upload retry cannot opt into arbitrary customer profile paths");

let fallbackExistingBytes = Buffer.from([1, 2, 3, 4]);
const fallbackObjectHarness = {
  module: { exports: {} },
  Buffer,
  crypto,
  MAX_VERIFICATION_IMAGE_BYTES: 3 * 1024 * 1024,
  verificationPhotoReference: () => ({ bucketId: "customer-photos", objectName: "records/71/slot-2/direct-existing.jpg" }),
  verificationPhotoStorageForEvidence: () => ({ bucketId: "customer-photos", accessToken: "token", envId: "env" }),
  storageUploadResponseMismatch: () => false,
  downloadVerificationPhotoAuthenticated: async () => fallbackExistingBytes,
  signedUploadFunctionFallbackAllowed: () => false,
  verificationPhotoStorageEnvironmentError: (error) => error,
  fail(message, code) { throw Object.assign(new Error(message), { code }); },
  manager: () => ({ storage: { uploadObject: async () => { throw new Error("object already exists"); } } }),
  console: { warn() {} }
};
vm.createContext(fallbackObjectHarness);
vm.runInContext([
  exactFallbackUpload,
  "module.exports = { uploadVerificationPhotoReference };"
].join("\n"), fallbackObjectHarness, { filename: "verification-photo-existing-fallback-object.js" });
const fallbackContentConflictPromise = (async () => {
  const matching = Buffer.from([1, 2, 3, 4]);
  const matchedReference = await fallbackObjectHarness.module.exports.uploadVerificationPhotoReference("ignored", matching);
  assert.deepEqual(
    JSON.parse(JSON.stringify(matchedReference)),
    { bucketId: "customer-photos", objectName: "records/71/slot-2/direct-existing.jpg" },
    "a lost upload response is idempotent only when the existing object bytes are identical"
  );

  fallbackExistingBytes = Buffer.from([4, 3, 2, 1]);
  await assert.rejects(
    fallbackObjectHarness.module.exports.uploadVerificationPhotoReference("ignored", matching),
    (error) => error?.code === "PHOTO_UPLOAD_CONTENT_CONFLICT",
    "same-size but different existing object content cannot be silently accepted or overwritten"
  );
})();

for (const name of ["cancelVerificationPhotoUpload", "getVerificationPhotoUploadStatus"]) {
  const source = functionSource(cloud, name);
  assert.ok(
    source.indexOf("verificationPhotoContext(event)") < source.indexOf("verificationPhotoUploadRequestId(event)"),
    `${name} authorizes the live order before using the request id`
  );
  includes(source, "requireVerificationPhotoUploadOwner(context)", `${name} exact submitter scope`);
  includes(source, "context.verificationId", `${name} binds request to the specified order`);
  includes(source, "context.caller.staffId", `${name} binds request to the authenticated submitter`);
}

// Database contract: one active generation per order, locked state transitions,
// idempotent retry, and the 24-hour rule are enforced below the cloud function.
for (const contract of [
  "request_id VARCHAR(64) PRIMARY KEY",
  "WHERE status = 'UPLOADING'",
  "uq_verification_photo_upload_one_active_order",
  "ON public.verification_photo_upload_requests (verification_id)",
  "ENABLE ROW LEVEL SECURITY",
  "REVOKE ALL ON TABLE public.verification_photo_upload_requests FROM PUBLIC",
  "cleanup_after >= created_at + INTERVAL '3 hours'",
  ">= 30",
  "PHOTO_UPLOAD_RATE_LIMITED"
]) includes(migration, contract, `migration 039 ${contract}`);

const beginSql = sqlFunctionSource(migration, "begin_verification_photo_upload", "commit_verification_photo_upload");
for (const contract of [
  "FROM public.verification_records AS v", "FOR UPDATE", "order_submitter <> p_actor_account_id",
  "CLOCK_TIMESTAMP() >= order_submitted_at + INTERVAL '24 hours'",
  "existing_request.request_id IS NOT NULL", "FALSE, TRUE",
  "active_request.request_id IS NOT NULL", "FALSE, FALSE",
  "p_original_object_ref NOT LIKE", "/direct-%.jpg"
]) includes(beginSql, contract, `begin SQL ${contract}`);
assert.ok(
  beginSql.indexOf("existing_request.request_id IS NOT NULL") < beginSql.indexOf("active_request.request_id IS NOT NULL"),
  "same request id is idempotent before the one-active conflict check"
);

const commitSql = sqlFunctionSource(migration, "commit_verification_photo_upload", "cancel_verification_photo_upload");
for (const contract of [
  "FROM public.verification_records AS v", "FOR UPDATE", "order_submitter <> p_actor_account_id",
  "upload_request.status = 'COMMITTED'", "upload_request.status IN ('CANCELLED', 'EXPIRED')",
  "CLOCK_TIMESTAMP() >= order_submitted_at + INTERVAL '24 hours'",
  "p_actual_original_bytes <> upload_request.expected_original_bytes",
  "upload_request.original_object_ref", "SET status = 'COMMITTED'"
]) includes(commitSql, contract, `commit SQL ${contract}`);
assert.ok(
  commitSql.indexOf("upload_request.status IN ('CANCELLED', 'EXPIRED')") < commitSql.indexOf("INSERT INTO public.verification_photos"),
  "a late canceled generation cannot overwrite the photo row"
);
assert.ok(
  commitSql.indexOf("upload_request.status = 'COMMITTED'") < commitSql.indexOf("INSERT INTO public.verification_photos"),
  "committing the same generation twice is idempotent"
);

const cancelSql = sqlFunctionSource(migration, "cancel_verification_photo_upload");
for (const contract of [
  "FROM public.verification_records AS v", "FOR UPDATE", "order_submitter <> p_actor_account_id",
  "pending.request_id = p_request_id", "upload_request.verification_id <> p_verification_id",
  "upload_request.actor_account_id <> p_actor_account_id", "upload_request.status = 'UPLOADING'",
  "SET status = 'CANCELLED'", "did_cancel := TRUE"
]) includes(cancelSql, contract, `cancel SQL ${contract}`);
assert.ok(
  commitSql.indexOf("FROM public.verification_records AS v") < commitSql.indexOf("FROM public.verification_photo_upload_requests AS pending")
    && cancelSql.indexOf("FROM public.verification_records AS v") < cancelSql.indexOf("FROM public.verification_photo_upload_requests AS pending"),
  "commit and cancel take locks in the same order, serializing their race"
);

Promise.all([
  lifecycleTimeoutPromise,
  xhrContractPromise,
  browserModeContractPromise,
  fallbackStorageProbePromise,
  authenticatedProfileDownloadPromise,
  fallbackContentConflictPromise,
  singleTaskPromise,
  cancelRacePromise
])
  .then(() => console.log("verification photo direct upload: PASS"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
