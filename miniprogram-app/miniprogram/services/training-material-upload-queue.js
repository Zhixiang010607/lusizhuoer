"use strict";

const { callStaff } = require("./api");
const materialCache = require("./training-material-cache");

const STORAGE_KEY = "training-material-upload-queue-v1";
const MAX_TASK_AGE_MS = 24 * 60 * 60 * 1000;
const RETRY_DELAYS_MS = Object.freeze([1000, 3000, 8000, 20000, 60000]);
const SMALL_PDF_BYTES = 1024 * 1024;
const SLOW_ACK_CHECK_MS = 8000;
const DIRECT_TRANSFER_TIMEOUT_MS = 180000;
// Abort is not proof that storage stopped writing. Retain the exact reference
// for one bounded eight-minute reconciliation window before deferred cleanup.
// This is best-effort orphan cleanup, not a claim about signed URL expiry or
// server-atomic cancellation. Never send another PUT for the cancelled job.
const CANCEL_RECONCILE_DELAY_MS = 8 * 60 * 1000;
const listeners = new Set();
const activeOperations = new Map();
const cancellationCleanups = new Map();
let processing = false;
let rerunRequested = false;
let wakeTimer = null;
let wakeAt = 0;
let activeTaskId = "";

function clean(value) { return String(value ?? "").trim(); }
function cancellationError() { return Object.assign(new Error("上传已取消"), { code: "TRAINING_UPLOAD_CANCELLED" }); }
function isCancelled(task) {
  return task.state === "CANCELLED" || readTasks().some((item) => item.id === task.id && item.state === "CANCELLED");
}
function currentOwnerStaffId() {
  try {
    const data = getApp().globalData;
    return data?.startupReady === true && data.session?.role === "hq" ? clean(data.session.staffId) : "";
  } catch (_) { return ""; }
}
function assertOwner(task) {
  if (!task.ownerStaffId || currentOwnerStaffId() !== task.ownerStaffId) {
    throw Object.assign(new Error("请用提交资料的总部账号登录后继续上传"), { code: "TRAINING_UPLOAD_OWNER_CHANGED" });
  }
  if (isCancelled(task)) throw cancellationError();
}
function readFile(filePath) { return new Promise((resolve, reject) => wx.getFileSystemManager().readFile({ filePath, success: resolve, fail: reject })); }
function fileInfo(filePath) {
  const fs = wx.getFileSystemManager();
  return new Promise((resolve, reject) => typeof fs.stat === "function"
    ? fs.stat({ path: filePath, recursive: false, success: (result) => resolve({ size: result.stats?.size }), fail: reject })
    : fs.getFileInfo({ filePath, success: resolve, fail: reject }));
}
function unlinkFile(filePath) { return new Promise((resolve, reject) => wx.getFileSystemManager().unlink({ filePath, success: resolve, fail: reject })); }

function normalizeTask(task = {}) {
  const createdAt = Number(task.createdAt || Date.now());
  return {
    id: clean(task.id || task.clientRequestId), clientRequestId: clean(task.clientRequestId || task.id),
    ownerStaffId: clean(task.ownerStaffId),
    title: clean(task.title), category: clean(task.category), originalName: clean(task.originalName),
    filePath: clean(task.filePath), bytes: Number(task.bytes || 0), reference: clean(task.reference),
    createdAt, updatedAt: Number(task.updatedAt || createdAt),
    attemptCount: Math.max(0, Number(task.attemptCount || 0)),
    state: clean(task.state || "QUEUED").toUpperCase(), error: clean(task.error),
    // A legacy reference may already have a confirmation in flight. Unknown
    // history is not proof that deleting its object is safe.
    publicationStarted: task.publicationStarted === true || Boolean(task.reference) && task.publicationStarted !== false,
    cancelRemoteCleaned: task.cancelRemoteCleaned === true,
    cancelLocalCleaned: task.cancelLocalCleaned === true,
    cancelReconcileAt: Math.max(0, Number(task.cancelReconcileAt || 0)),
    phase: clean(task.phase), phaseStartedAt: Math.max(0, Number(task.phaseStartedAt || 0)),
    uploadedBytes: Math.max(0, Math.min(Number(task.bytes || 0), Number(task.uploadedBytes || 0))),
    nextAttemptAt: Math.max(0, Number(task.nextAttemptAt || 0))
  };
}

function validTask(task) {
  return /^[A-Za-z0-9_-]{16,64}$/.test(task.clientRequestId) && task.ownerStaffId
    && task.title && task.originalName && task.filePath
    && Number.isInteger(task.bytes) && task.bytes >= 8;
}

function readTasks() {
  try {
    const value = typeof wx.getStorageSync === "function" ? wx.getStorageSync(STORAGE_KEY) : [];
    return (Array.isArray(value) ? value : []).map(normalizeTask).filter(validTask);
  } catch (_) { return []; }
}

function writeTasks(tasks) {
  try { if (typeof wx.setStorageSync === "function") wx.setStorageSync(STORAGE_KEY, tasks.map(normalizeTask).filter(validTask)); }
  catch (_) {}
}

function updateTask(task, changes) {
  const tasks = readTasks();
  const index = tasks.findIndex((item) => item.id === task.id);
  if (index >= 0 && tasks[index].state === "CANCELLED" && changes.state !== "CANCELLED") throw cancellationError();
  Object.assign(task, changes, { updatedAt: Date.now() });
  if (index >= 0) tasks[index] = normalizeTask(task); else tasks.push(normalizeTask(task));
  writeTasks(tasks);
  return task;
}

function removeTask(task) { writeTasks(readTasks().filter((item) => item.id !== task.id)); }
function snapshot(task) { return task ? { ...task } : null; }

async function emit(event) {
  const pending = Array.from(listeners).map((listener) => {
    try { return Promise.resolve(listener({ ...event, task: snapshot(event.task) })); }
    catch (error) { return Promise.reject(error); }
  });
  if (pending.length) await Promise.allSettled(pending);
}

async function setPhase(task, phase) {
  assertOwner(task);
  updateTask(task, { phase, phaseStartedAt: Date.now() });
  await emit({ type: "progress", task });
  assertOwner(task);
}

function uploadFailure(error, task) {
  const code = clean(error?.code).toUpperCase();
  const message = clean(error?.message || error?.errMsg);
  if (code === "TRAINING_UPLOAD_OWNER_CHANGED") return "请用提交资料的总部账号登录后继续上传";
  if (["UNAUTHENTICATED", "UNASSIGNED_IDENTITY"].includes(code)) return "登录已失效，请重新登录后重试";
  if (code === "FORBIDDEN") return "当前账号没有上传权限";
  if (/domain list|not.*domain|合法域名/i.test(message)) return "PDF 上传域名未配置，请联系总部";
  if (/timeout|timed out|超时/i.test(message)) return "PDF 上传超时，请重试";
  // Never persist a signed URL or platform credentials from a transport error.
  if (/[\u4e00-\u9fff]/.test(message) && !/https?:|token=|signature|不支持的操作/i.test(message)) return message;
  if (task.phase === "PREPARING") return "本地 PDF 读取失败，请重新选择";
  if (task.phase === "SIGNING") return "PDF 上传地址申请失败，请重试";
  if (["VERIFYING", "RECOVERING"].includes(task.phase)) return "PDF 发布结果暂未确认，请用原任务重试";
  return "PDF 传输失败，请检查网络后重试";
}

async function recoverUpload(task) {
  await setPhase(task, "RECOVERING");
  const recovered = await confirmUpload(task);
  assertOwner(task);
  if (!recovered?.material?.id) throw new Error("培训资料服务没有确认发布结果");
  return recovered;
}

async function confirmUpload(task) {
  assertOwner(task);
  // Once publication may be running, cancellation must never delete its
  // object, even if the confirmation response is delayed or lost.
  updateTask(task, { publicationStarted: true });
  if (!readTasks().some((item) => item.id === task.id && item.publicationStarted)) {
    throw new Error("发布状态未保存，请重试");
  }
  const result = await callStaff("confirmTrainingMaterialUpload", confirmPayload(task));
  if (isCancelled(task) && currentOwnerStaffId() === task.ownerStaffId && result?.material?.status === "PUBLISHED") {
    await emit({ type: "committed", task, material: result.material, cancelled: true });
  }
  return result;
}

function cleanupCancelledTask(task) {
  if (cancellationCleanups.has(task.id)) return cancellationCleanups.get(task.id);
  const cleanup = (async () => {
    const stored = readTasks().find((item) => item.id === task.id && item.state === "CANCELLED");
    if (!stored || currentOwnerStaffId() !== stored.ownerStaffId || activeOperations.has(task.id)) return;
    if (!stored.cancelLocalCleaned) {
      await unlinkFile(stored.filePath).catch((error) => {
        if (!/ENOENT|no such file|not exist/i.test(clean(error?.message || error?.errMsg))) throw error;
      });
      if (currentOwnerStaffId() !== stored.ownerStaffId) return;
      updateTask(stored, { state: "CANCELLED", cancelLocalCleaned: true });
    }
    if (!stored.publicationStarted && stored.cancelReconcileAt > Date.now()) {
      scheduleWake(stored.cancelReconcileAt - Date.now());
      return;
    }
    // Never race a possible publish with discard: the existing server discard
    // is a bound-object check, not an atomic cancellation of publication.
    if (!stored.cancelRemoteCleaned) {
      if (stored.reference && !stored.publicationStarted) {
        const result = await callStaff("discardTrainingMaterialUpload", { reference: stored.reference });
        if (!result?.discarded && !result?.currentlyBound) return;
      }
      if (currentOwnerStaffId() !== stored.ownerStaffId) return;
      updateTask(stored, { state: "CANCELLED", cancelRemoteCleaned: true });
    }
    // All old work has settled and keeps its own in-memory cancelled state.
    // Compact the durable tombstone rather than repeating cleanup forever.
    if (currentOwnerStaffId() === stored.ownerStaffId && !activeOperations.has(task.id)) removeTask(stored);
  })().catch(() => {}).finally(() => cancellationCleanups.delete(task.id));
  cancellationCleanups.set(task.id, cleanup);
  return cleanup;
}

function finishOperation(task, operation) {
  if (!operation.settled || !operation.drained) return;
  if (activeOperations.get(task.id) === operation) activeOperations.delete(task.id);
  if (isCancelled(task)) void cleanupCancelledTask(task);
}

function reportSlowTransfer(result, startedAt, bytes) {
  const elapsedMs = Math.max(0, Date.now() - startedAt);
  const status = Number(result?.statusCode || 0);
  if (elapsedMs < 5000 && status >= 200 && status < 300) return;
  const profile = result?.profile || {};
  const duration = (start, end) => Number.isFinite(profile[start]) && Number.isFinite(profile[end])
    ? Math.max(0, profile[end] - profile[start]) : null;
  // Only numeric timings. Never log URLs, headers, tokens, filenames or UID.
  console.info("training PDF direct transport", {
    bytes, elapsedMs, status,
    dnsMs: duration("domainLookUpStart", "domainLookUpEnd"),
    connectMs: duration("connectStart", "connectEnd"),
    tlsMs: duration("SSLconnectionStart", "SSLconnectionEnd"),
    untilResponseMs: duration("requestStart", "responseStart")
  });
}

async function signedUpload(upload, buffer, task) {
  const url = clean(upload?.url);
  const bytes = new Uint8Array(buffer).byteLength;
  if (!/^https:\/\//i.test(url) || clean(upload?.method || "PUT").toUpperCase() !== "PUT") {
    throw new Error("培训资料服务没有返回有效上传地址");
  }
  let requestTask;
  let checkpointTimer;
  let checkpointFlight;
  let cancelled = false;
  const startedAt = Date.now();
  const cancel = () => { if (!cancelled) { cancelled = true; clearTimeout(checkpointTimer); requestTask?.abort?.(); } };
  const operation = activeOperations.get(task.id);
  if (operation) operation.abort = cancel;
  const response = new Promise((resolve, reject) => { requestTask = wx.request({
    url, method: "PUT", data: buffer,
    header: { ...(upload.headers || {}), "Content-Type": "application/pdf" },
    dataType: "text", responseType: "text", enableHttp2: true, enableProfile: true,
    // Do not cut off a slow-but-progressing PUT just to report a shorter time.
    // The verified checkpoint shortens lost-ack waits without forcing retries.
    timeout: DIRECT_TRANSFER_TIMEOUT_MS,
    success(response) {
      if (!cancelled) reportSlowTransfer(response, startedAt, bytes);
      const code = Number(response?.statusCode || 0);
      if (code >= 200 && code < 300) resolve(response);
      else reject(Object.assign(new Error(`培训 PDF 上传失败（HTTP ${code || "—"}，${bytes} 字节）`), { statusCode: code }));
    },
    fail(error) {
      if (!cancelled) reportSlowTransfer(error, startedAt, bytes);
      reject(error);
    }
  }); });
  // Consume both native outcomes even when authoritative recovery wins first.
  // A local preview or HTTP response headers alone are never publication proof.
  const nativeOutcome = response.then((value) => ({ value }), (error) => ({ error }));
  const checkpoint = new Promise((resolve) => {
    if (bytes > SMALL_PDF_BYTES) return;
    checkpointTimer = setTimeout(() => {
      checkpointFlight = (async () => {
        try { return { recovered: await recoverUpload(task) }; }
        catch (error) {
          const code = clean(error?.code).toUpperCase();
          if (code === "TRAINING_MATERIAL_UPLOAD_INCOMPLETE" || code === "TRAINING_MATERIAL_READ_FAILED" || error?.submissionUncertain) {
            await setPhase(task, "TRANSFERRING");
            return { error, incomplete: code === "TRAINING_MATERIAL_UPLOAD_INCOMPLETE" };
          }
          return { error, stop: true };
        }
      })().catch((error) => ({ error, stop: true }));
      checkpointFlight.then((outcome) => {
        if (outcome.recovered || outcome.stop) resolve({ checkpoint: outcome });
      });
    }, SLOW_ACK_CHECK_MS);
  });
  try {
    const first = await Promise.race([nativeOutcome, checkpoint]);
    clearTimeout(checkpointTimer);
    const checked = first.checkpoint || (checkpointFlight ? await checkpointFlight : null);
    assertOwner(task);
    if (checked?.recovered) { cancel(); return checked.recovered; }
    if (checked?.stop) { cancel(); checked.error.trainingRecoveryStopped = true; throw checked.error; }
    if (first.error) {
      const status = Number(first.error?.statusCode || 0);
      // A prior read outage must not hide the PUT's authoritative rejection
      // and accidentally turn HTTP 403/400 into an automatic retry.
      if (status >= 400 && status < 500 && ![408, 409, 429].includes(status)) throw first.error;
      if (checked?.error && !checked.incomplete) {
        checked.error.trainingRecoveryStopped = true;
        throw checked.error; // Unknown result: never blindly resend.
      }
      throw first.error;
    }
    return first.value;
  } finally {
    clearTimeout(checkpointTimer);
    if (operation?.abort === cancel) operation.abort = null;
    if (currentOwnerStaffId() !== task.ownerStaffId || isCancelled(task)) cancel();
  }
}

async function signedUploadWithRetry(upload, buffer, task) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assertOwner(task);
    try { return await signedUpload(upload, buffer, task); }
    catch (error) {
      assertOwner(task);
      lastError = error;
      if (error.trainingRecoveryStopped) throw error;
      const status = Number(error?.statusCode || 0);
      if (status && status !== 408 && status !== 409 && status !== 429 && status < 500) throw error;
      // A lost PUT acknowledgement may mean the file is already complete.
      // Reconcile AFTER every uncertain attempt, including the final one.
      // An earlier missing-object checkpoint is stale while PUT is in flight.
      try {
        return await recoverUpload(task);
      } catch (recoveryError) {
        if (clean(recoveryError?.code).toUpperCase() !== "TRAINING_MATERIAL_UPLOAD_INCOMPLETE") throw recoveryError;
      }
      assertOwner(task);
      if (status === 409 || attempt === 1) throw error;
      // The original request is authoritatively missing. No extra fixed
      // sleep, new request ID or second file read is needed before retry.
      await setPhase(task, "TRANSFERRING");
    }
  }
  throw lastError || new Error("培训 PDF 上传失败");
}

function confirmPayload(task) {
  return {
    clientRequestId: task.clientRequestId, title: task.title, category: task.category,
    originalName: task.originalName, bytes: task.bytes, mimeType: "application/pdf",
    reference: task.reference
  };
}

async function processTask(task) {
  assertOwner(task);
  if (task.reference) {
    await setPhase(task, "RECOVERING");
    try { return await confirmUpload(task); }
    catch (error) {
      if (!["TRAINING_MATERIAL_UPLOAD_INCOMPLETE", "TRAINING_MATERIAL_REFERENCE_INVALID", "TRAINING_MATERIAL_BUCKET_MISMATCH"].includes(clean(error?.code).toUpperCase())) throw error;
      assertOwner(task);
      await callStaff("discardTrainingMaterialUpload", { reference: task.reference }).catch(() => {});
      updateTask(task, { reference: "", uploadedBytes: 0 });
    }
  }
  await setPhase(task, "PREPARING");
  const info = await fileInfo(task.filePath);
  assertOwner(task);
  if (Number(info?.size || 0) !== task.bytes) throw new Error("待传 PDF 文件不完整，请重新选择");
  await setPhase(task, "SIGNING");
  // File IO and remote signing are independent. Keep both results, including
  // failures, so a failed local read cannot leak a newly allocated reference.
  const [local, signed] = await Promise.allSettled([
    readFile(task.filePath), callStaff("beginTrainingMaterialUpload", confirmPayload(task))
  ]);
  if (isCancelled(task) && signed.status === "fulfilled") {
    // A delayed signing response belongs only to this cancelled request.
    updateTask(task, { state: "CANCELLED", reference: clean(signed.value?.reference) });
  }
  assertOwner(task);
  if (signed.status === "rejected") throw signed.reason;
  const pending = signed.value;
  updateTask(task, { reference: clean(pending.reference), uploadedBytes: 0 });
  if (local.status === "rejected" || new Uint8Array(local.value.data).byteLength !== task.bytes) {
    await callStaff("discardTrainingMaterialUpload", { reference: task.reference }).catch(() => {});
    updateTask(task, { reference: "" });
    throw local.status === "rejected" ? new Error("本地 PDF 读取失败，请重新选择") : new Error("待传 PDF 读取不完整，请重新选择");
  }
  await setPhase(task, "TRANSFERRING");
  const recovered = await signedUploadWithRetry(pending.upload || {}, local.value.data, task);
  assertOwner(task);
  updateTask(task, { uploadedBytes: task.bytes });
  await setPhase(task, "VERIFYING");
  if (recovered?.material?.id) return recovered;
  return confirmUpload(task);
}

function scheduleWake(delay) {
  const nextWakeAt = Date.now() + Math.max(250, Number(delay || 0));
  if (wakeTimer && wakeAt <= nextWakeAt) return;
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeAt = nextWakeAt;
  wakeTimer = setTimeout(() => { wakeTimer = null; wakeAt = 0; void resume(); }, Math.max(250, Number(delay || 0)));
}

async function cleanupExpiredTasks(tasks, ownerStaffId) {
  const now = Date.now();
  for (const task of tasks) {
    if (task.ownerStaffId === ownerStaffId && task.state === "CANCELLED") {
      if (!activeOperations.has(task.id)) void cleanupCancelledTask(task);
      continue;
    }
    if (task.ownerStaffId === ownerStaffId && task.state !== "COMMITTED" && now - task.createdAt > MAX_TASK_AGE_MS) {
      assertOwner(task);
      if (task.reference) await callStaff("discardTrainingMaterialUpload", { reference: task.reference }).catch(() => {});
      assertOwner(task);
      await unlinkFile(task.filePath).catch(() => {});
      removeTask(task);
      await emit({ type: "expired", task, error: "培训 PDF 待传时间已超过 24 小时，请重新选择" });
    }
  }
  return readTasks();
}

async function resume(options = {}) {
  const ownerStaffId = currentOwnerStaffId();
  if (!ownerStaffId || (options.ownerStaffId && clean(options.ownerStaffId) !== ownerStaffId)) return false;
  if (processing) { rerunRequested = true; return false; }
  processing = true;
  try {
    let tasks = await cleanupExpiredTasks(readTasks(), ownerStaffId);
    tasks = tasks.filter((task) => task.ownerStaffId === ownerStaffId);
    if (options.retryFailed === true) {
      tasks = tasks.map((task) => task.state === "FAILED" ? updateTask(task, { state: "QUEUED", error: "", attemptCount: 0, nextAttemptAt: 0 }) : task);
    }
    for (const stored of tasks) {
      if (currentOwnerStaffId() !== ownerStaffId) break;
      // A failed job can be removed while another job is awaiting the network.
      // Re-read rather than resurrecting a cancelled job from the old snapshot.
      const current = readTasks().find((item) => item.id === stored.id && item.ownerStaffId === ownerStaffId);
      if (!current) continue;
      const task = normalizeTask(current);
      if (task.state === "CANCELLED") continue;
      if (task.state === "COMMITTED") {
        removeTask(task);
        await unlinkFile(task.filePath).catch(() => {});
        await emit({ type: "settled", task });
        continue;
      }
      const now = Date.now();
      if (task.state === "FAILED" && task.nextAttemptAt > now) { scheduleWake(task.nextAttemptAt - now); continue; }
      if (task.state === "FAILED" && task.attemptCount > RETRY_DELAYS_MS.length) continue;
      activeTaskId = task.id;
      updateTask(task, { state: "UPLOADING", phase: "PREPARING", phaseStartedAt: now, error: "", attemptCount: task.attemptCount + 1, nextAttemptAt: 0 });
      await emit({ type: "state", task });
      if (!readTasks().some((item) => item.id === task.id && item.state !== "CANCELLED")) { activeTaskId = ""; continue; }
      const operation = { task, abort: null, cancel: null, settled: false, drained: false };
      const cancellation = new Promise((_, reject) => { operation.cancel = () => { operation.abort?.(); reject(cancellationError()); }; });
      activeOperations.set(task.id, operation);
      const work = processTask(task).finally(() => {
        operation.settled = true;
        finishOperation(task, operation);
      });
      try {
        const result = await Promise.race([work, cancellation]);
        assertOwner(task);
        if (!result?.material?.id) throw new Error("培训资料服务没有确认发布结果");
        updateTask(task, { state: "COMMITTED", error: "", nextAttemptAt: 0 });
        await emit({ type: "committed", task, material: result.material });
        removeTask(task);
        // The confirmed upload itself is a valid local read source for HQ.
        // Keep it until the private cache copy finishes, after the UI settles.
        if (result.material.status === "PUBLISHED") await materialCache.store(task.filePath, result.material).catch(() => {});
        await unlinkFile(task.filePath).catch(() => {});
      } catch (error) {
        if (error?.code === "TRAINING_UPLOAD_CANCELLED" || isCancelled(task)) continue;
        const message = uploadFailure(error, task);
        const retryIndex = Math.min(task.attemptCount - 1, RETRY_DELAYS_MS.length - 1);
        const status = Number(error?.statusCode || 0);
        const terminal = (status >= 400 && status < 500 && status !== 408 && status !== 429)
          || ["FORBIDDEN", "UNAUTHENTICATED", "UNASSIGNED_IDENTITY", "BAD_REQUEST", "IDEMPOTENCY_CONFLICT",
            "TRAINING_MATERIAL_SIZE_MISMATCH", "TRAINING_MATERIAL_TYPE_INVALID", "TRAINING_MATERIAL_FORMAT_INVALID", "TRAINING_MATERIAL_DELETED"].includes(clean(error?.code).toUpperCase());
        const canRetry = !terminal && error?.code !== "TRAINING_UPLOAD_OWNER_CHANGED"
          && task.attemptCount <= RETRY_DELAYS_MS.length;
        const nextAttemptAt = canRetry ? Date.now() + RETRY_DELAYS_MS[retryIndex] : 0;
        updateTask(task, { state: "FAILED", error: message, nextAttemptAt,
          attemptCount: terminal ? RETRY_DELAYS_MS.length + 1 : task.attemptCount });
        await emit({ type: "failed", task, error: message });
        if (canRetry) scheduleWake(RETRY_DELAYS_MS[retryIndex]);
        if (error?.code === "TRAINING_UPLOAD_OWNER_CHANGED") break;
      } finally {
        activeTaskId = "";
        operation.drained = true;
        finishOperation(task, operation);
      }
    }
    return true;
  } catch (error) {
    if (error?.code === "TRAINING_UPLOAD_OWNER_CHANGED") return false;
    throw error;
  } finally {
    processing = false;
    if (rerunRequested) { rerunRequested = false; void resume(); }
  }
}

function enqueue(input) {
  const task = normalizeTask({ ...input, id: input.clientRequestId, state: "QUEUED", createdAt: Date.now() });
  if (!validTask(task)) throw new Error("培训 PDF 后台上传任务无效");
  assertOwner(task);
  const tasks = readTasks().filter((item) => item.id !== task.id);
  tasks.push(task);
  writeTasks(tasks);
  void emit({ type: "queued", task });
  void resume();
  return snapshot(task);
}

function subscribe(listener) {
  if (typeof listener !== "function") return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function allTasks() { return readTasks().filter((task) => task.state !== "CANCELLED").map(snapshot); }

async function cancel(taskId) {
  const task = readTasks().find((item) => item.id === clean(taskId));
  if (!task || currentOwnerStaffId() !== task.ownerStaffId || task.state === "COMMITTED") return false;
  if (task.state === "CANCELLED") return true;
  // Persist and verify before aborting. This tombstone prevents cold starts,
  // retry timers and late asynchronous callbacks from resurrecting the job.
  const operation = activeOperations.get(task.id);
  const uncertainPut = !task.publicationStarted && (operation?.abort || task.phase === "TRANSFERRING");
  updateTask(task, { state: "CANCELLED", nextAttemptAt: 0, error: "",
    cancelReconcileAt: uncertainPut ? Date.now() + CANCEL_RECONCILE_DELAY_MS : 0 });
  if (!readTasks().some((item) => item.id === task.id && item.state === "CANCELLED")) {
    throw new Error("取消未保存，请重试；暂未停止原任务");
  }
  if (operation) operation.task.state = "CANCELLED";
  operation?.cancel();
  await emit({ type: "cancelled", task });
  if (!operation) void cleanupCancelledTask(task);
  void resume();
  return true;
}
function retry(taskId) {
  const task = readTasks().find((item) => item.id === clean(taskId));
  if (!task) return false;
  if (currentOwnerStaffId() !== task.ownerStaffId) return false;
  if (task.state !== "FAILED" || activeTaskId === task.id) return false;
  updateTask(task, { state: "QUEUED", error: "", attemptCount: 0, nextAttemptAt: 0 });
  void resume();
  return true;
}

async function dismissFailed(taskId) {
  const task = readTasks().find((item) => item.id === clean(taskId));
  if (!task || task.state !== "FAILED" || activeTaskId === task.id
      || currentOwnerStaffId() !== task.ownerStaffId) return false;
  removeTask(task); // Stop retries before asynchronous cleanup starts.
  await emit({ type: "removed", task });
  // Existing server cancellation refuses to delete a published/bound object.
  if (task.reference && currentOwnerStaffId() === task.ownerStaffId) {
    await callStaff("discardTrainingMaterialUpload", { reference: task.reference }).catch(() => {});
  }
  await unlinkFile(task.filePath).catch(() => {});
  return true;
}

module.exports = { STORAGE_KEY, enqueue, resume, retry, cancel, dismissFailed, subscribe, allTasks };
