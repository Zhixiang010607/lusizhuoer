const { callPhoto } = require("./api");

const STORAGE_KEY = "verification-photo-upload-queue-v1";
const MAX_TASK_AGE_MS = 24 * 60 * 60 * 1000;
const RETRY_DELAYS_MS = Object.freeze([1000, 3000, 8000, 20000, 60000]);
const listeners = new Set();
let processing = false;
let wakeTimer = null;

function clean(value) { return String(value ?? "").trim(); }

function readFile(filePath) {
  return new Promise((resolve, reject) => wx.getFileSystemManager().readFile({ filePath, success: resolve, fail: reject }));
}

function fileInfo(filePath) {
  return new Promise((resolve, reject) => wx.getFileSystemManager().getFileInfo({ filePath, success: resolve, fail: reject }));
}

function unlinkFile(filePath) {
  return new Promise((resolve, reject) => wx.getFileSystemManager().unlink({ filePath, success: resolve, fail: reject }));
}

function requestId(slot) {
  const random = Math.random().toString(36).slice(2, 14).padEnd(12, "0");
  return `mini-photo-${Date.now().toString(36)}-${Number(slot)}-${random}`.slice(0, 64);
}

function normalizeTask(task = {}) {
  const slot = Number(task.slot);
  const bytes = Number(task.bytes || 0);
  const createdAt = Number(task.createdAt || Date.now());
  return {
    id: clean(task.id || task.requestId),
    requestId: clean(task.requestId || task.id),
    recordId: clean(task.recordId),
    slot,
    filePath: clean(task.filePath),
    bytes,
    width: Number(task.width || 0),
    height: Number(task.height || 0),
    createdAt,
    updatedAt: Number(task.updatedAt || createdAt),
    attemptCount: Math.max(0, Number(task.attemptCount || 0)),
    state: clean(task.state || "QUEUED").toUpperCase(),
    error: clean(task.error),
    nextAttemptAt: Math.max(0, Number(task.nextAttemptAt || 0))
  };
}

function validTask(task) {
  return task.id && task.requestId && task.recordId
    && Number.isInteger(task.slot) && task.slot >= 2 && task.slot <= 4
    && task.filePath && Number.isInteger(task.bytes) && task.bytes >= 12
    && Number.isFinite(task.createdAt) && task.createdAt > 0;
}

function readTasks() {
  try {
    const stored = typeof wx.getStorageSync === "function" ? wx.getStorageSync(STORAGE_KEY) : [];
    return (Array.isArray(stored) ? stored : []).map(normalizeTask).filter(validTask);
  } catch (_) { return []; }
}

function writeTasks(tasks) {
  try {
    if (typeof wx.setStorageSync === "function") wx.setStorageSync(STORAGE_KEY, tasks.map(normalizeTask).filter(validTask));
  } catch (_) {}
}

function taskSnapshot(task) { return task ? { ...task } : null; }

async function emit(event) {
  const pending = Array.from(listeners).map((listener) => {
    try { return Promise.resolve(listener({ ...event, task: taskSnapshot(event.task) })); }
    catch (error) { return Promise.reject(error); }
  });
  if (pending.length) await Promise.allSettled(pending);
}

function taskErrorMessage(error) {
  return clean(error?.message || error?.errMsg) || "照片后台上传失败，稍后将自动重试";
}

function closedUpload(error) {
  return clean(error?.code).toUpperCase() === "PHOTO_UPLOAD_REQUEST_CLOSED";
}

function updateTask(task, changes) {
  Object.assign(task, changes, { updatedAt: Date.now() });
  const tasks = readTasks();
  const index = tasks.findIndex((item) => item.id === task.id);
  if (index >= 0) tasks[index] = normalizeTask(task);
  else tasks.push(normalizeTask(task));
  writeTasks(tasks);
  return task;
}

function removeTask(task) {
  writeTasks(readTasks().filter((item) => item.id !== task.id));
}

function signedUpload(upload, buffer) {
  const url = clean(upload?.url || upload?.signedUrl);
  const method = clean(upload?.method || "PUT").toUpperCase();
  const expectedBytes = Number(upload?.expectedBytes || 0);
  const actualBytes = new Uint8Array(buffer).byteLength;
  if (!/^https:\/\//i.test(url) || method !== "PUT") {
    return Promise.reject(new Error("照片服务没有返回有效的签名直传地址"));
  }
  if (expectedBytes > 0 && expectedBytes !== actualBytes) {
    return Promise.reject(new Error("补充照片大小与服务器授权不一致，请重新选择"));
  }
  return new Promise((resolve, reject) => wx.request({
    url,
    method: "PUT",
    data: buffer,
    header: { "Content-Type": "image/jpeg" },
    responseType: "text",
    timeout: 180000,
    success(response) {
      const statusCode = Number(response?.statusCode || 0);
      if (statusCode >= 200 && statusCode < 300) resolve(response);
      else reject(new Error(`补充照片直传失败（HTTP ${statusCode || "—"}）`));
    },
    fail: reject
  }));
}

async function signedUploadWithRetry(upload, buffer) {
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try { return await signedUpload(upload, buffer); }
    catch (error) {
      lastError = error;
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw lastError || new Error("补充照片直传失败");
}

async function callWithTransportRetry(action, payload) {
  try { return await callPhoto(action, payload); }
  catch (error) {
    if (!error?.submissionUncertain) throw error;
    return callPhoto(action, payload);
  }
}

async function committedFromStatus(task) {
  // resume() increments attemptCount before processing. A value of 1 is the
  // first network attempt and has nothing to reconcile yet.
  if (task.attemptCount < 2) return null;
  let status;
  try {
    status = await callPhoto("getVerificationPhotoUploadStatus", {
      recordId: task.recordId,
      requestId: task.requestId
    });
  } catch (error) {
    if (clean(error?.code).toUpperCase() === "PHOTO_UPLOAD_REQUEST_NOT_FOUND") return null;
    throw error;
  }
  const state = clean(status?.status).toUpperCase();
  if (state === "COMMITTED") return status;
  if (state === "UPLOADING" && status.objectUploaded === true && Number(status.uploadedBytes || 0) === task.bytes) {
    return callWithTransportRetry("commitVerificationPhotoUpload", {
      recordId: task.recordId,
      requestId: task.requestId
    });
  }
  if (state === "CANCELLED" || state === "EXPIRED") {
    const nextId = requestId(task.slot);
    task.requestId = nextId;
    task.attemptCount = 0;
    updateTask(task, { state: "QUEUED", error: "", nextAttemptAt: 0 });
  }
  return null;
}

async function processTask(task) {
  const info = await fileInfo(task.filePath);
  if (Number(info?.size || 0) !== task.bytes) throw new Error("待传照片文件不完整，请重新选择");
  const read = await readFile(task.filePath);
  const buffer = read.data;
  if (new Uint8Array(buffer).byteLength !== task.bytes) throw new Error("待传照片读取不完整，请重新选择");

  const recovered = await committedFromStatus(task);
  if (clean(recovered?.status).toUpperCase() === "COMMITTED") return recovered;

  let begin;
  try {
    begin = await callWithTransportRetry("beginVerificationPhotoUpload", {
      recordId: task.recordId,
      slot: task.slot,
      requestId: task.requestId,
      originalBytes: task.bytes
    });
  } catch (error) {
    if (!closedUpload(error)) throw error;
    const nextId = requestId(task.slot);
    task.requestId = nextId;
    updateTask(task, { state: "QUEUED", error: "", attemptCount: 0, nextAttemptAt: 0 });
    begin = await callWithTransportRetry("beginVerificationPhotoUpload", {
      recordId: task.recordId,
      slot: task.slot,
      requestId: task.requestId,
      originalBytes: task.bytes
    });
  }
  if (begin?.alreadyCommitted === true) return begin;
  if (begin?.uploadMode !== "DIRECT" || !begin?.originalUpload) {
    throw new Error("照片服务没有返回有效的签名直传授权");
  }
  await signedUploadWithRetry(begin.originalUpload, buffer);
  return callWithTransportRetry("commitVerificationPhotoUpload", {
    recordId: task.recordId,
    requestId: task.requestId
  });
}

function scheduleWake(delay) {
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = setTimeout(() => {
    wakeTimer = null;
    void resume();
  }, Math.max(250, Number(delay || 0)));
}

async function cleanupExpiredTasks(tasks) {
  const current = Date.now();
  const kept = [];
  for (const task of tasks) {
    if (current - task.createdAt <= MAX_TASK_AGE_MS) kept.push(task);
    else {
      await unlinkFile(task.filePath).catch(() => {});
      await emit({ type: "expired", task, error: "照片待传时间已超过 24 小时，请重新选择" });
    }
  }
  writeTasks(kept);
  return kept;
}

async function resume(options = {}) {
  if (processing) return false;
  processing = true;
  try {
    let tasks = await cleanupExpiredTasks(readTasks());
    if (options.retryFailed === true) {
      tasks = tasks.map((task) => task.state === "FAILED"
        ? updateTask(task, { state: "QUEUED", error: "", nextAttemptAt: 0 })
        : task);
    }
    for (const persisted of tasks) {
      let task = normalizeTask(persisted);
      const now = Date.now();
      if (task.state === "FAILED" && task.nextAttemptAt > now) {
        scheduleWake(task.nextAttemptAt - now);
        continue;
      }
      if (task.state === "FAILED" && task.attemptCount > RETRY_DELAYS_MS.length) continue;
      updateTask(task, { state: "UPLOADING", error: "", attemptCount: task.attemptCount + 1, nextAttemptAt: 0 });
      await emit({ type: "state", task });
      try {
        const committed = await processTask(task);
        if (clean(committed?.status).toUpperCase() !== "COMMITTED" && committed?.alreadyCommitted !== true) {
          throw new Error("照片服务没有确认保存结果");
        }
        updateTask(task, { state: "COMMITTED", error: "", nextAttemptAt: 0 });
        await emit({ type: "committed", task, committed });
        removeTask(task);
        await unlinkFile(task.filePath).catch(() => {});
      } catch (error) {
        const message = taskErrorMessage(error);
        const retryIndex = Math.min(task.attemptCount - 1, RETRY_DELAYS_MS.length - 1);
        const canRetry = task.attemptCount <= RETRY_DELAYS_MS.length;
        const nextAttemptAt = canRetry ? Date.now() + RETRY_DELAYS_MS[retryIndex] : 0;
        updateTask(task, { state: "FAILED", error: message, nextAttemptAt });
        await emit({ type: "failed", task, error: message });
        if (canRetry) scheduleWake(RETRY_DELAYS_MS[retryIndex]);
        break;
      }
    }
    return true;
  } finally {
    processing = false;
    const now = Date.now();
    if (readTasks().some((task) => task.state === "QUEUED" || (task.state === "FAILED" && task.nextAttemptAt > 0 && task.nextAttemptAt <= now))) {
      scheduleWake(250);
    }
  }
}

function enqueue(input) {
  const task = normalizeTask({ ...input, id: input.requestId, state: "QUEUED", createdAt: Date.now() });
  if (!validTask(task)) throw new Error("照片后台上传任务无效");
  const tasks = readTasks().filter((item) => !(item.recordId === task.recordId && item.slot === task.slot));
  tasks.push(task);
  writeTasks(tasks);
  void emit({ type: "queued", task });
  void resume();
  return taskSnapshot(task);
}

function subscribe(listener) {
  if (typeof listener !== "function") return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function tasksForRecord(recordId) {
  const expected = clean(recordId);
  return readTasks().filter((task) => task.recordId === expected).map(taskSnapshot);
}

function retry(taskId) {
  const expected = clean(taskId);
  const tasks = readTasks();
  const task = tasks.find((item) => item.id === expected);
  if (!task) return false;
  updateTask(task, { state: "QUEUED", error: "", nextAttemptAt: 0 });
  void emit({ type: "state", task });
  void resume();
  return true;
}

module.exports = {
  STORAGE_KEY,
  enqueue,
  resume,
  retry,
  subscribe,
  tasksForRecord
};
