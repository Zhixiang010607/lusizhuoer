"use strict";

const { callStaff } = require("./api");

const STORAGE_KEY = "training-material-upload-queue-v1";
const MAX_TASK_AGE_MS = 24 * 60 * 60 * 1000;
const RETRY_DELAYS_MS = Object.freeze([1000, 3000, 8000, 20000, 60000]);
const listeners = new Set();
let processing = false;
let rerunRequested = false;
let wakeTimer = null;
let wakeAt = 0;

function clean(value) { return String(value ?? "").trim(); }
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
}
function readFile(filePath) { return new Promise((resolve, reject) => wx.getFileSystemManager().readFile({ filePath, success: resolve, fail: reject })); }
function fileInfo(filePath) { return new Promise((resolve, reject) => wx.getFileSystemManager().getFileInfo({ filePath, success: resolve, fail: reject })); }
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
  Object.assign(task, changes, { updatedAt: Date.now() });
  const tasks = readTasks();
  const index = tasks.findIndex((item) => item.id === task.id);
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

function signedUpload(upload, buffer) {
  const url = clean(upload?.url);
  const bytes = new Uint8Array(buffer).byteLength;
  if (!/^https:\/\//i.test(url) || clean(upload?.method || "PUT").toUpperCase() !== "PUT") {
    return Promise.reject(new Error("培训资料服务没有返回有效上传地址"));
  }
  return new Promise((resolve, reject) => wx.request({
    url, method: "PUT", data: buffer,
    header: { ...(upload.headers || {}), "Content-Type": "application/pdf" },
    responseType: "text", timeout: 180000,
    success(response) {
      const code = Number(response?.statusCode || 0);
      if (code >= 200 && code < 300) resolve(response);
      else reject(new Error(`培训 PDF 上传失败（HTTP ${code || "—"}，${bytes} 字节）`));
    },
    fail: reject
  }));
}

async function signedUploadWithRetry(upload, buffer, task) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assertOwner(task);
    try { return await signedUpload(upload, buffer); }
    catch (error) { lastError = error; if (!attempt) await new Promise((resolve) => setTimeout(resolve, 350)); }
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
  const info = await fileInfo(task.filePath);
  assertOwner(task);
  if (Number(info?.size || 0) !== task.bytes) throw new Error("待传 PDF 文件不完整，请重新选择");
  if (task.reference) {
    try { return await callStaff("confirmTrainingMaterialUpload", confirmPayload(task)); }
    catch (error) {
      if (!["TRAINING_MATERIAL_UPLOAD_INCOMPLETE", "TRAINING_MATERIAL_REFERENCE_INVALID", "TRAINING_MATERIAL_BUCKET_MISMATCH"].includes(clean(error?.code).toUpperCase())) throw error;
      assertOwner(task);
      await callStaff("discardTrainingMaterialUpload", { reference: task.reference }).catch(() => {});
      updateTask(task, { reference: "" });
    }
  }
  const read = await readFile(task.filePath);
  assertOwner(task);
  if (new Uint8Array(read.data).byteLength !== task.bytes) throw new Error("待传 PDF 读取不完整，请重新选择");
  const pending = await callStaff("beginTrainingMaterialUpload", confirmPayload(task));
  updateTask(task, { reference: clean(pending.reference) });
  await signedUploadWithRetry(pending.upload || {}, read.data, task);
  assertOwner(task);
  return callStaff("confirmTrainingMaterialUpload", confirmPayload(task));
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
    if (task.ownerStaffId === ownerStaffId && now - task.createdAt > MAX_TASK_AGE_MS) {
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
      const task = normalizeTask(stored);
      const now = Date.now();
      if (task.state === "FAILED" && task.nextAttemptAt > now) { scheduleWake(task.nextAttemptAt - now); continue; }
      if (task.state === "FAILED" && task.attemptCount > RETRY_DELAYS_MS.length) continue;
      updateTask(task, { state: "UPLOADING", error: "", attemptCount: task.attemptCount + 1, nextAttemptAt: 0 });
      await emit({ type: "state", task });
      try {
        const result = await processTask(task);
        if (!result?.material?.id) throw new Error("培训资料服务没有确认发布结果");
        updateTask(task, { state: "COMMITTED", error: "", nextAttemptAt: 0 });
        await emit({ type: "committed", task, material: result.material });
        removeTask(task);
        await unlinkFile(task.filePath).catch(() => {});
      } catch (error) {
        const message = clean(error?.message || error?.errMsg) || "培训 PDF 后台上传失败";
        const retryIndex = Math.min(task.attemptCount - 1, RETRY_DELAYS_MS.length - 1);
        const canRetry = task.attemptCount <= RETRY_DELAYS_MS.length;
        const nextAttemptAt = canRetry ? Date.now() + RETRY_DELAYS_MS[retryIndex] : 0;
        updateTask(task, { state: "FAILED", error: message, nextAttemptAt });
        await emit({ type: "failed", task, error: message });
        if (canRetry) scheduleWake(RETRY_DELAYS_MS[retryIndex]);
        if (error?.code === "TRAINING_UPLOAD_OWNER_CHANGED") break;
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

function allTasks() { return readTasks().map(snapshot); }
function retry(taskId) {
  const task = readTasks().find((item) => item.id === clean(taskId));
  if (!task) return false;
  if (currentOwnerStaffId() !== task.ownerStaffId) return false;
  updateTask(task, { state: "QUEUED", error: "", attemptCount: 0, nextAttemptAt: 0 });
  void resume();
  return true;
}

module.exports = { STORAGE_KEY, enqueue, resume, retry, subscribe, allTasks };
