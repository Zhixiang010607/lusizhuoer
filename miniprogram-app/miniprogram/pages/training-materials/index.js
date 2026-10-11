"use strict";

const { callStaff } = require("../../services/api");
const { requireSession } = require("../../services/session");
const uploadQueue = require("../../services/training-material-upload-queue");
const materialCache = require("../../services/training-material-cache");

const MAX_PDF_BYTES = 100 * 1024 * 1024;

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

Page({
  data: {
    session: {}, isHq: false, loading: true, busy: false, openingId: "", keyword: "",
    title: "", selectedFile: null, materials: [], pendingTasks: [],
    message: "", error: false
  },
  onLoad() {
    let session;
    try { session = requireSession(["hq", "teacher"]); }
    catch (_) { return wx.reLaunch({ url: "/pages/home/index" }); }
    this.setData({ session, isHq: session.role === "hq" });
    if (session.role === "hq") {
      this._unsubscribe = uploadQueue.subscribe((event) => this.onUploadQueueEvent(event));
      this.syncPendingTasks();
      void uploadQueue.resume({ retryFailed: true, ownerStaffId: session.staffId });
    }
    this.loadMaterials();
  },
  onShow() {
    if (this.data.isHq) { this.syncPendingTasks(); void uploadQueue.resume({ ownerStaffId: this.data.session.staffId }); }
  },
  onUnload() {
    this._epoch = Number(this._epoch || 0) + 1;
    this._unsubscribe?.();
    this._unsubscribe = null;
  },
  syncPendingTasks() {
    this.setData({ pendingTasks: uploadQueue.allTasks().filter((task) => task.ownerStaffId === String(this.data.session.staffId || "")).map((task) => ({
      ...task,
      stateLabel: task.state === "FAILED" ? "等待重试" : task.state === "UPLOADING" ? "后台上传中" : "等待上传",
      sizeLabel: readableBytes(task.bytes)
    })) });
  },
  async onUploadQueueEvent(event = {}) {
    if (!this.data.isHq) return;
    this.syncPendingTasks();
    if (event.type === "committed") {
      await this.loadMaterials();
      this.setData({ message: `《${event.task?.title || "培训资料"}》已在后台上传并发布。`, error: false });
    } else if (event.type === "failed") {
      this.setData({ message: `《${event.task?.title || "培训资料"}》后台上传暂未完成，将自动重试。`, error: true });
    }
  },
  async loadMaterials() {
    const epoch = Number(this._epoch || 0) + 1;
    this._epoch = epoch;
    this.setData({ loading: true, message: "", error: false });
    try {
      const result = await callStaff("listTrainingMaterials", { keyword: String(this.data.keyword || "").trim() });
      if (epoch !== this._epoch) return;
      this.setData({ materials: (result.materials || []).map(materialView) });
    } catch (error) {
      if (epoch === this._epoch) this.setData({ message: userFacingError(error, "培训资料读取失败，请稍后重试"), error: true });
    } finally {
      if (epoch === this._epoch) this.setData({ loading: false });
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
      const info = await wxCall((resolve, reject) => wx.getFileSystemManager().getFileInfo({ filePath, success: resolve, fail: reject }));
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
  async openMaterial(event) {
    const id = String(event.currentTarget.dataset.id || "");
    if (!id || this.data.openingId) return;
    this.setData({ openingId: id, message: "正在打开全屏 PDF…", error: false });
    wx.showLoading({ title: "正在打开", mask: true });
    try {
      const material = this.data.materials.find((item) => item.id === id);
      if (!material) throw new Error("未找到培训资料");
      let filePath = await materialCache.find(material);
      if (!filePath) {
        const result = await callStaff("getTrainingMaterialAccess", { materialId: id });
        const url = String(result.access?.url || "");
        if (!/^https:\/\//.test(url)) throw new Error("没有取得有效的临时阅读地址");
        const downloaded = await wxCall((resolve, reject) => wx.downloadFile({ url, timeout: 300000, success: resolve, fail: reject }));
        if (Number(downloaded.statusCode) < 200 || Number(downloaded.statusCode) >= 300 || !downloaded.tempFilePath) {
          throw new Error("PDF 临时读取失败");
        }
        filePath = await materialCache.store(downloaded.tempFilePath, material).catch(() => downloaded.tempFilePath);
      }
      wx.hideLoading();
      await wxCall((resolve, reject) => wx.openDocument({
        filePath, fileType: "pdf", showMenu: false,
        success: resolve, fail: reject
      }));
      this.setData({ message: "", error: false });
    } catch (error) {
      wx.hideLoading();
      this.setData({ message: userFacingError(error, "PDF 打开失败"), error: true });
    } finally { this.setData({ openingId: "" }); }
  },
  async archiveMaterial(event) {
    if (!this.data.isHq || this.data.busy) return;
    const id = String(event.currentTarget.dataset.id || "");
    const confirmed = await wxCall((resolve) => wx.showModal({
      title: "删除资料",
      content: "删除后这份资料将下架，不再显示。",
      confirmText: "删除",
      success: (value) => resolve(Boolean(value.confirm)), fail: () => resolve(false)
    }));
    if (!confirmed) return;
    this.setData({ busy: true, message: "正在更新资料状态…", error: false });
    try {
      await callStaff("setTrainingMaterialStatus", { materialId: id, status: "ARCHIVED" });
      await materialCache.invalidate(id);
      await this.loadMaterials();
      this.setData({ message: "资料已删除。", error: false });
    } catch (error) {
      this.setData({ message: userFacingError(error, "资料状态更新失败"), error: true });
    } finally { this.setData({ busy: false }); }
  },
  back() {
    if (getCurrentPages().length > 1) wx.navigateBack();
    else wx.reLaunch({ url: "/pages/home/index" });
  }
});
