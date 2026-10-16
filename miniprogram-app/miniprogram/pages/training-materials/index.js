"use strict";

const { callStaff } = require("../../services/api");
const { requireSession } = require("../../services/session");
const uploadQueue = require("../../services/training-material-upload-queue");
const materialCache = require("../../services/training-material-cache");

const MAX_PDF_BYTES = 100 * 1024 * 1024;
const UPLOAD_PHASES = {
  PREPARING: "准备文件", SIGNING: "申请上传地址", TRANSFERRING: "正在上传",
  VERIFYING: "校验并发布", RECOVERING: "核对上传结果"
};

function wxCall(executor) {
  return new Promise((resolve, reject) => executor(resolve, reject));
}

function uploadRequestId() {
  return `training-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`.slice(0, 64);
}

function pendingFilePath(requestId) {
  return `${wx.env.USER_DATA_PATH}/training-${String(requestId).replace(/[^A-Za-z0-9_-]/g, "_")}.pdf`;
}

function copyFile(sourcePath, destinationPath) {
  return new Promise((resolve, reject) => wx.getFileSystemManager().copyFile({ srcPath: sourcePath, destPath: destinationPath, success: resolve, fail: reject }));
}

function fileInfo(filePath) {
  const fs = wx.getFileSystemManager();
  return new Promise((resolve, reject) => typeof fs.stat === "function"
    ? fs.stat({ path: filePath, recursive: false, success: (result) => resolve({ size: result.stats?.size }), fail: reject })
    : fs.getFileInfo({ filePath, success: resolve, fail: reject }));
}

function unlinkFile(filePath) {
  return new Promise((resolve, reject) => wx.getFileSystemManager().unlink({ filePath, success: resolve, fail: reject }));
}

function readableBytes(value) {
  const bytes = Number(value || 0);
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
  return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

function readableDate(value) {
  const text = String(value || "");
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : "—";
}

function userFacingError(error, fallback) {
  const message = String(error?.message || error?.errMsg || "").trim();
  if (!message || /不支持的操作|unsupported|unknown action/i.test(message)) return fallback;
  return message;
}

function readingError(error, stage) {
  const code = String(error?.code || "").toUpperCase();
  const message = String(error?.message || error?.errMsg || "");
  if (["UNAUTHENTICATED", "UNASSIGNED_IDENTITY"].includes(code)) return "登录已失效，请重新登录后阅读";
  if (code === "FORBIDDEN") return "当前账号没有阅读权限";
  if (code === "NOT_FOUND") return "资料已下架或不存在，请刷新列表";
  if (/domain list|合法域名|not.*domain|url not in/i.test(message)) return "PDF 下载域名未配置，请联系总部";
  if (/timeout|timed out|超时/i.test(message)) return "PDF 读取超时，请重试";
  if (/network|connect|网络/i.test(message)) return "网络连接失败，请重试";
  if (stage === "ACCESS") return "未取得 PDF 阅读地址，请重试";
  if (stage === "DOWNLOAD") return "PDF 文件读取失败，请重试";
  if (stage === "VALIDATE") return "PDF 文件不完整，请重新读取";
  return "PDF 打开失败，请重试；仍失败请联系总部检查文件";
}

function materialView(item = {}) {
  return {
    id: String(item.id || ""),
    title: String(item.title || ""),
    category: String(item.category || ""),
    originalName: String(item.originalName || ""),
    bytes: Number(item.bytes || 0),
    sizeLabel: readableBytes(item.bytes),
    status: String(item.status || ""),
    statusLabel: String(item.status || "") === "PUBLISHED" ? "已发布" : "已下架",
    publishedAt: String(item.publishedAt || ""),
    createdAt: String(item.createdAt || ""),
    dateLabel: readableDate(item.publishedAt || item.createdAt),
    createdByName: String(item.createdByName || "")
  };
}

function sameReader(session) {
  try {
    const data = getApp().globalData;
    const current = data.startupReady === true ? data.session : null;
    return current && ["hq", "teacher"].includes(current.role)
      && current.staffId === session.staffId && current.uid === session.uid
      && current.role === session.role && current.loginAt === session.loginAt;
  } catch (_) { return false; }
}

Page({
  data: {
    session: {}, isHq: false, loading: true, busy: false, openingId: "", keyword: "",
    title: "", selectedFile: null, materials: [], pendingTasks: [], failedTasks: [],
    message: "", error: false
  },
  onLoad() {
    this._unloaded = false;
    let session;
    try { session = requireSession(["hq", "teacher"]); }
    catch (_) { return wx.reLaunch({ url: "/pages/home/index" }); }
    if (!session) return;
    this.setData({ session, isHq: session.role === "hq" });
    if (session.role === "hq") {
      this._unsubscribe = uploadQueue.subscribe((event) => this.onUploadQueueEvent(event));
      this.syncPendingTasks();
      void uploadQueue.resume({ ownerStaffId: session.staffId });
    }
    this.loadMaterials();
  },
  onShow() {
    this._visible = true;
    if (this.data.isHq) { this.syncPendingTasks(); void uploadQueue.resume({ ownerStaffId: this.data.session.staffId }); }
    if (this._refreshOnShow) {
      this._refreshOnShow = false;
      void this.loadMaterials({ background: true });
    }
  },
  onHide() { this._visible = false; this._refreshOnShow = true; this.stopProgressTicker(); },
  onUnload() {
    this._unloaded = true;
    this._visible = false;
    this.stopProgressTicker();
    this._downloadTask?.abort?.();
    this._downloadTask = null;
    this._epoch = Number(this._epoch || 0) + 1;
    this._unsubscribe?.();
    this._unsubscribe = null;
  },
  syncPendingTasks() {
    const now = Date.now();
    const tasks = uploadQueue.allTasks().filter((task) => task.ownerStaffId === String(this.data.session.staffId || "") && task.state !== "COMMITTED").map((task) => {
      const stage = UPLOAD_PHASES[task.phase] || "准备文件";
      const seconds = Math.max(0, Math.floor((now - Number(task.phaseStartedAt || now)) / 1000));
      const retrySeconds = Math.max(0, Math.ceil((Number(task.nextAttemptAt || 0) - now) / 1000));
      return {
        ...task, sizeLabel: readableBytes(task.bytes),
        stateLabel: task.state === "FAILED" ? (retrySeconds ? `${retrySeconds} 秒后重试` : "可重试或移除")
          : task.state === "UPLOADING" ? stage : "等待上传",
        elapsedLabel: task.state === "UPLOADING" ? `已等待 ${seconds} 秒` : "",
        transferLabel: task.state === "UPLOADING" && task.uploadedBytes > 0 ? `已传 ${readableBytes(task.uploadedBytes)} / ${readableBytes(task.bytes)}` : "",
        phaseIndex: task.phase === "TRANSFERRING" ? 1 : ["VERIFYING", "RECOVERING"].includes(task.phase) ? 2 : 0,
        error: task.error ? userFacingError({ message: task.error }, "上传失败，请重试") : ""
      };
    });
    this.setData({ pendingTasks: tasks.filter((task) => task.state !== "FAILED"), failedTasks: tasks.filter((task) => task.state === "FAILED") });
    if (this._visible && tasks.length && !this._progressTimer) {
      this._progressTimer = setInterval(() => this.syncPendingTasks(), 1000);
    } else if (!tasks.length) this.stopProgressTicker();
  },
  stopProgressTicker() {
    if (this._progressTimer) clearInterval(this._progressTimer);
    this._progressTimer = null;
  },
  async onUploadQueueEvent(event = {}) {
    if (this._unloaded || !sameReader(this.data.session) || !this.data.isHq || event.task?.ownerStaffId !== String(this.data.session.staffId || "")) return;
    this.syncPendingTasks();
    if (event.type === "committed") {
      const item = materialView(event.material);
      if (!item.id || item.status !== "PUBLISHED") return;
      const rows = this.data.materials.filter((row) => row.id !== item.id);
      rows.unshift(item);
      this._epoch = Number(this._epoch || 0) + 1;
      // Show the authoritative publication immediately, even when an old
      // search would hide it. Refresh metadata without delaying queue cleanup.
      this.setData({ materials: rows, keyword: "", loading: false,
        message: `《${event.task?.title || "培训资料"}》已在后台上传并发布。`, error: false });
      if (this._visible === false) this._refreshOnShow = true;
      else void this.loadMaterials({ background: true, confirmedMaterial: item });
    } else if (event.type === "failed") {
      this.setData({ message: event.task?.nextAttemptAt ? "上传未完成，稍后自动重试。" : "上传失败，可重试或移除任务。", error: true });
    } else if (event.type === "removed" || event.type === "settled") {
      this.setData({ message: "", error: false });
    }
  },
  async loadMaterials(options = {}) {
    if (this._unloaded || !sameReader(this.data.session)) return;
    const epoch = Number(this._epoch || 0) + 1;
    this._epoch = epoch;
    const owner = { ...this.data.session };
    const keyword = String(this.data.keyword || "").trim();
    const background = options.background === true;
    if (!background) this.setData({ loading: true, message: "", error: false });
    const isCurrent = () => !this._unloaded && epoch === this._epoch && sameReader(owner)
      && keyword === String(this.data.keyword || "").trim();
    try {
      const result = await callStaff("listTrainingMaterials", { keyword });
      if (!isCurrent()) return;
      const rows = (result.materials || []).filter((item) => item.status === "PUBLISHED" || this.data.isHq && item.status === "ARCHIVED").map(materialView);
      // A just-confirmed publication must not vanish behind a lagging list
      // snapshot. Later searches/returns still use the current server list.
      const confirmed = options.confirmedMaterial;
      if (confirmed?.id && !rows.some((item) => item.id === confirmed.id)) rows.unshift(confirmed);
      this.setData({ materials: rows });
    } catch (error) {
      if (isCurrent()) this.setData({ message: options.confirmedMaterial
        ? "上传已成功，资料列表刷新失败，请点搜索重试。"
        : userFacingError(error, "培训资料读取失败，请稍后重试"), error: true });
    } finally {
      if (!this._unloaded && epoch === this._epoch && sameReader(owner)) this.setData({ loading: false });
    }
  },
  inputTitle(event) {
    const title = Array.from(String(event.detail.value || "")).slice(0, 160).join("");
    this.setData({ title });
    return title;
  },
  inputKeyword(event) {
    const keyword = Array.from(String(event.detail.value || "")).slice(0, 80).join("");
    this.setData({ keyword });
    return keyword;
  },
  searchByTitle() { this.loadMaterials(); },
  async choosePdf() {
    if (!this.data.isHq || this.data.busy) return;
    try {
      const result = await wxCall((resolve, reject) => wx.chooseMessageFile({
        count: 1, type: "file", extension: ["pdf"], success: resolve, fail: reject
      }));
      const file = result.tempFiles?.[0];
      const path = String(file?.path || file?.tempFilePath || "");
      const name = String(file?.name || "资料.pdf");
      const bytes = Number(file?.size || 0);
      if (!path || !/\.pdf$/i.test(name)) throw new Error("请选择 PDF 文件");
      if (!Number.isSafeInteger(bytes) || bytes < 8 || bytes > MAX_PDF_BYTES) throw new Error("PDF 不能超过 100 MB");
      this.setData({ selectedFile: { path, name, bytes, sizeLabel: readableBytes(bytes) }, message: "已选择 PDF，请确认标题后上传。", error: false });
    } catch (error) {
      if (/cancel/i.test(String(error.errMsg || error.message || ""))) return;
      this.setData({ message: userFacingError(error, "PDF 选择失败"), error: true });
    }
  },
  async uploadPdf() {
    if (!this.data.isHq || this.data.busy) return;
    const title = String(this.data.title || "").trim();
    const file = this.data.selectedFile;
    if (!title) return this.setData({ message: "请先填写资料标题", error: true });
    if (!file?.path) return this.setData({ message: "请先选择 PDF 文件", error: true });
    this.setData({ busy: true, message: "正在建立后台上传任务…", error: false });
    const clientRequestId = uploadRequestId();
    const filePath = pendingFilePath(clientRequestId);
    try {
      await unlinkFile(filePath).catch(() => {});
      await copyFile(file.path, filePath);
      const info = await fileInfo(filePath);
      if (Number(info?.size || 0) !== Number(file.bytes)) throw new Error("PDF 本地任务文件保存不完整");
      uploadQueue.enqueue({
        clientRequestId, ownerStaffId: String(this.data.session.staffId || ""), title, category: "",
        originalName: file.name, bytes: file.bytes, filePath
      });
      this.setData({ title: "", selectedFile: null, message: "已开始后台上传；可以离开本页。", error: false });
      this.syncPendingTasks();
    } catch (error) {
      await unlinkFile(filePath).catch(() => {});
      this.setData({ message: userFacingError(error, "后台上传任务建立失败"), error: true });
    } finally { this.setData({ busy: false }); }
  },
  retryUpload(event) {
    const id = String(event.currentTarget.dataset.id || "");
    if (id && uploadQueue.retry(id)) {
      this.syncPendingTasks();
      this.setData({ message: "已重新开始后台上传。", error: false });
    }
  },
  async removeFailedUpload(event) {
    if (!this.data.isHq) return;
    const id = String(event.currentTarget.dataset.id || "");
    if (!this.data.failedTasks.some((task) => task.id === id)) return;
    const confirmed = await wxCall((resolve) => wx.showModal({
      title: "移除失败任务", content: "仅停止这条任务的重试，已发布资料不受影响。", confirmText: "移除",
      success: (value) => resolve(Boolean(value.confirm)), fail: () => resolve(false)
    }));
    if (!confirmed) return;
    const removed = await uploadQueue.dismissFailed(id);
    if (this._unloaded) return;
    this.syncPendingTasks();
    this.setData({ message: removed ? "失败任务已移除。" : "任务已继续上传，请稍后再操作。", error: !removed });
  },
  async openMaterial(event) {
    const id = String(event.currentTarget.dataset.id || "");
    if (!id || this.data.openingId || this.data.busy || this.data.materials.find((item) => item.id === id)?.status === "ARCHIVED") return;
    this.setData({ openingId: id, message: "正在打开全屏 PDF…", error: false });
    wx.showLoading({ title: "正在打开", mask: true });
    const owner = { ...this.data.session };
    let stage = "ACCESS";
    const assertCurrentReader = () => {
      let current;
      if (!this._unloaded) {
        try { const data = getApp().globalData; current = data.startupReady === true ? data.session : null; } catch (_) {}
      }
      if (!current || !["hq", "teacher"].includes(current.role) || current.staffId !== owner.staffId || current.uid !== owner.uid || current.role !== owner.role || current.loginAt !== owner.loginAt) {
        const error = new Error("阅读已取消");
        error.code = "READER_CANCELLED";
        throw error;
      }
    };
    try {
      let material = this.data.materials.find((item) => item.id === id);
      if (!material) throw new Error("未找到培训资料");
      assertCurrentReader();
      // A local file is not permission: recheck publication and the current UID
      // before using it. The signed URL itself is never persisted or logged.
      const authorizeOnly = Boolean(materialCache.hasEntry?.(material));
      const [result, cachedPath] = await Promise.all([
        callStaff("getTrainingMaterialAccess", { materialId: id, authorizeOnly }),
        materialCache.find(material)
      ]);
      assertCurrentReader();
      let url = String(result.access?.url || "");
      let filePath = cachedPath;
      if (result.access?.material) {
        const latest = materialView(result.access.material);
        if (latest.id !== id || latest.status !== "PUBLISHED") throw new Error("没有取得有效的资料信息");
        if (latest.bytes !== material.bytes || latest.publishedAt !== material.publishedAt || latest.createdAt !== material.createdAt) filePath = "";
        material = latest;
      }
      assertCurrentReader();
      const fromCache = Boolean(filePath);
      const readFreshFile = async () => {
        if (!/^https:\/\//.test(url)) {
          stage = "ACCESS";
          const fresh = await callStaff("getTrainingMaterialAccess", { materialId: id });
          assertCurrentReader();
          url = String(fresh.access?.url || "");
          if (!/^https:\/\//.test(url)) throw new Error("没有取得有效的临时阅读地址");
          if (fresh.access?.material) {
            const latest = materialView(fresh.access.material);
            if (latest.id !== id || latest.status !== "PUBLISHED") throw new Error("没有取得有效的资料信息");
            material = latest;
          }
        }
        stage = "DOWNLOAD";
        wx.showLoading({ title: "读取 PDF", mask: true });
        let lastProgress = -1;
        const downloaded = await wxCall((resolve, reject) => {
          this._downloadTask = wx.downloadFile({ url, timeout: 300000, success: resolve, fail: reject });
          this._downloadTask?.onProgressUpdate?.((progress) => {
            const percent = Number(progress?.progress);
            if (this._unloaded || !Number.isFinite(percent) || percent < 0 || percent > 100 || percent === lastProgress) return;
            try { assertCurrentReader(); } catch (_) { return; }
            lastProgress = percent;
            wx.showLoading({ title: `读取 PDF ${Math.floor(percent)}%`, mask: true });
          });
        });
        this._downloadTask = null;
        assertCurrentReader();
        if (Number(downloaded.statusCode) < 200 || Number(downloaded.statusCode) >= 300 || !downloaded.tempFilePath) {
          throw new Error("PDF 临时读取失败");
        }
        stage = "VALIDATE";
        const info = await fileInfo(downloaded.tempFilePath);
        assertCurrentReader();
        if (!Number.isSafeInteger(material.bytes) || material.bytes < 8 || material.bytes > MAX_PDF_BYTES || Number(info.size) !== material.bytes) throw new Error("PDF 文件不完整");
        // Only a byte-verified temporary file may be the fallback when local
        // cache storage is full/unavailable. Never open a partial transfer.
        return downloaded.tempFilePath;
      };
      const openFile = async (path) => {
        assertCurrentReader();
        stage = "OPEN";
        wx.hideLoading();
        await wxCall((resolve, reject) => wx.openDocument({ filePath: path, fileType: "pdf", showMenu: false, success: resolve, fail: reject }));
      };
      if (!filePath) filePath = await readFreshFile();
      try { await openFile(filePath); }
      catch (error) {
        if (error.code === "READER_CANCELLED") throw error;
        await materialCache.invalidate(id);
        if (!fromCache) throw error;
        assertCurrentReader();
        filePath = await readFreshFile();
        try { await openFile(filePath); }
        catch (retryError) { await materialCache.invalidate(id); throw retryError; }
      }
      if (this._unloaded) return;
      assertCurrentReader();
      // Open the complete native temporary file first. Copying a 100MB PDF
      // into private cache must not sit on the reader's critical path.
      if (!fromCache || filePath !== cachedPath) void materialCache.store(filePath, material).catch(() => {});
      this.setData({ message: "", error: false });
    } catch (error) {
      wx.hideLoading();
      if (this._unloaded || error.code === "READER_CANCELLED") return;
      if (["NOT_FOUND", "FORBIDDEN"].includes(String(error.code || "").toUpperCase())) await materialCache.invalidate(id);
      if (!this._unloaded) this.setData({ message: readingError(error, stage), error: true });
    } finally {
      this._downloadTask = null;
      if (!this._unloaded) this.setData({ openingId: "" });
    }
  },
  async archiveMaterial(event) {
    if (!this.data.isHq || this.data.busy || this.data.openingId || this._deleteConfirming) return;
    const id = String(event.currentTarget.dataset.id || "");
    const material = this.data.materials.find((item) => item.id === id);
    if (!material) return;
    this._deleteConfirming = true;
    const confirmed = await wxCall((resolve) => wx.showModal({
      title: "删除资料",
      content: `确定删除《${material.title}》？云端 PDF 和资料记录将一起删除，无法恢复。`,
      confirmText: "删除",
      cancelText: "取消",
      success: (value) => resolve(Boolean(value.confirm)), fail: () => resolve(false)
    }));
    this._deleteConfirming = false;
    if (!confirmed || this._unloaded || !this.data.isHq || this.data.busy) return;
    this.setData({ busy: true, message: "正在删除资料…", error: false });
    try {
      const result = await callStaff("setTrainingMaterialStatus", { materialId: id, status: "ARCHIVED", confirmDeletion: true });
      if (result.material?.id !== id || result.material?.deleted !== true) throw new Error("删除结果未确认，请重试");
      await materialCache.invalidate(id).catch(() => {});
      this._epoch = Number(this._epoch || 0) + 1;
      if (!this._unloaded) this.setData({ materials: this.data.materials.filter((item) => item.id !== id), loading: false, message: "资料已删除。", error: false });
    } catch (error) {
      if (!this._unloaded) {
        await this.loadMaterials();
        this.setData({ message: userFacingError(error, "删除失败，请重试"), error: true });
      }
    } finally { if (!this._unloaded) this.setData({ busy: false }); }
  },
  back() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: "/pages/home/index" });
  }
});
