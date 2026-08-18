"use strict";

const assert = require("node:assert/strict");
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
assert.ok(!runUpload.includes("imageBase64"), "direct upload never Base64-encodes the photo");
assert.ok(!runUpload.includes("thumbnailBase64"), "direct upload never Base64-encodes a thumbnail");
assert.ok(!runUpload.includes("sha256VerificationPhoto(task"), "client hashing is not repeated on the critical upload path");
assert.ok(
  runUpload.indexOf('action: "beginVerificationPhotoUpload"') < runUpload.indexOf("uploadVerificationPhotoBlob("),
  "permission and upload-intent creation happen before browser storage PUT"
);
assert.ok(
  runUpload.indexOf("await Promise.all(uploads)") < runUpload.indexOf('action: "commitVerificationPhotoUpload"'),
  "commit happens only after every signed PUT succeeds"
);
includes(runUpload, 'clean(error?.code).toUpperCase() === "PHOTO_UPLOAD_ALREADY_ACTIVE"', "cross-tab active conflict");
includes(runUpload, "return await monitorExistingVerificationPhotoUpload(task)", "active conflict never starts a second PUT");
includes(runUpload, "task.intentStarted = true", "server intent acknowledgement");

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
  "确认服务器结束前不能开始下一张", "task.cancelPromise = null"
]) includes(reconcile, contract, `cancel reconciliation ${contract}`);
includes(reconcile, "cancelNotFound && statusNotFound", "two authoritative not-found confirmations may unlock a never-created intent");
assert.ok(
  !reconcile.slice(reconcile.indexOf('setVerificationPhotoTaskStage(task, "CANCELING", "取消尚未确认"')).includes("finishVerificationPhotoTask("),
  "an unconfirmed cancellation keeps the global task locked"
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
  assert.equal(progressSamples.at(-1), 58.5, "50% storage progress maps into the 32%-85% upload stage");
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
    const callFaceRecognition = async () => globalThis.__queue.length ? globalThis.__queue.shift() : { status: "UPLOADING" };
    const setTimeout = (callback) => { callback(); return 1; };
    const setVerificationPhotoTaskStage = (...args) => globalThis.__stages.push(args);
    const finishVerificationPhotoTask = (...args) => globalThis.__finishes.push(args);
    const applyCommittedVerificationPhoto = () => { globalThis.__applied = true; };
    ${functionSource(ui, "verificationPhotoUploadStatus")}
    ${functionSource(ui, "verificationPhotoUploadTerminal")}
    ${functionSource(ui, "verificationPhotoUploadRequestNotFound")}
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
  assert.ok(pending.stages.some((args) => String(args[3]).includes("确认服务器结束前不能开始下一张")));
})();

// Cloud function contract: live authorization precedes signing; clients never
// choose object paths or provide authoritative metadata at commit.
for (const action of [
  "beginVerificationPhotoUpload", "commitVerificationPhotoUpload",
  "cancelVerificationPhotoUpload", "getVerificationPhotoUploadStatus"
]) includes(cloud, `if (action === "${action}")`, `cloud action ${action}`);

const beginCloud = functionSource(cloud, "beginVerificationPhotoUpload");
assert.ok(
  beginCloud.indexOf("verificationPhotoContext(event)") < beginCloud.indexOf("signVerificationPhotoUploadObject(objectName)"),
  "order/account permission is checked before a signed upload URL is minted"
);
assert.ok(
  beginCloud.indexOf("requireVerificationPhotoUploadOwner(context, { requireWindow: true })")
    < beginCloud.indexOf("signVerificationPhotoUploadObject(objectName)"),
  "submitter and 24-hour window are checked before signing"
);
includes(beginCloud, "crypto.randomBytes(24)", "server nonce for storage path");
includes(beginCloud, "`records/${context.verificationId}/slot-${slot}/direct-${Date.now()}-${nonce}.jpg`", "server-derived object path");
assert.ok(!/event\.(?:object|bucket|path|key)/.test(beginCloud), "browser cannot choose bucket or object path");
assert.ok(!beginCloud.includes("accessToken"), "begin response never exposes the service storage credential");

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
  "downloadVerificationPhotoBytes", "jpegDimensions(buffer)", 'createHash("sha256").update(buffer)'
]) includes(inspectObject, securityCheck, `server object verification ${securityCheck}`);

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
includes(commitCloud, "const inspected = await inspectVerificationPhotoObject", "server-inspected metadata");
for (const value of ["inspected.bytes", "inspected.width", "inspected.height", "inspected.sha256"]) {
  includes(commitCloud, value, `database receives authoritative ${value}`);
}
assert.ok(!/event\.(?:imageWidth|imageHeight|sha256|contentType|object|bucket)/.test(commitCloud), "commit ignores all client metadata except the request identity");
assert.ok(
  commitCloud.indexOf('initialState.status === "COMMITTED"') < commitCloud.indexOf("inspectVerificationPhotoObject("),
  "commit retry is idempotent and does not redownload an already committed object"
);
assert.ok(
  commitCloud.indexOf('initialState.status === "CANCELLED"') < commitCloud.indexOf("inspectVerificationPhotoObject("),
  "cancelled/expired intent cannot be committed by a late response"
);

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

Promise.all([xhrContractPromise, singleTaskPromise, cancelRacePromise])
  .then(() => console.log("verification photo direct upload: PASS"))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
