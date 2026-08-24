const { callFace } = require("../../services/api");
const { requireSession } = require("../../services/session");

Page({
  data: { customerCode: "", profile: null, balances: [], recharges: [], verifications: [], experiences: [], historyType: "RECHARGE", visibleHistory: [], photoUrl: "", photoLoading: false, photoSaving: false, loading: false, notes: "", originalNotes: "", savingNotes: false, message: "", error: false },
  onLoad(options) {
    if (!requireSession()) return;
    this.setData({ customerCode: decodeURIComponent(options.customerCode || "") });
    this.load();
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  async load() {
    if (!this.data.customerCode) return this.setData({ message: "缺少客户编号", error: true });
    this.setData({ loading: true, message: "", error: false });
    try {
      const result = await callFace("getCustomerProfile", { customerCode: this.data.customerCode, historyLimit: 20 });
      const profile = result.customer;
      this.setData({ profile, balances: result.balances || [], recharges: result.recharges || [], verifications: result.verifications || [], experiences: result.experiences || [], notes: String(profile.notes || ""), originalNotes: String(profile.notes || "") });
      this.syncHistory();
      await this.loadPhoto();
    } catch (error) { this.setData({ message: error.message || "客户主页读取失败", error: true }); }
    finally { this.setData({ loading: false }); }
  },
  async loadPhoto() {
    if (this.data.photoLoading) return;
    this.setData({ photoLoading: true });
    try {
      const result = await callFace("getCustomerPhotoUrl", { customerCode: this.data.customerCode });
      if (!/^https:\/\//i.test(String(result.photoUrl || ""))) throw new Error("服务端未返回有效的照片临时地址");
      this.setData({ photoUrl: result.photoUrl, message: "", error: false });
    } catch (error) { this.setData({ message: error.message || "客户照片读取失败，点击照片区域可重试", error: true }); }
    finally { this.setData({ photoLoading: false }); }
  },
  reloadPhoto() { this.setData({ photoUrl: "" }); this.loadPhoto(); },
  photoFailed() { this.setData({ photoUrl: "", message: "照片临时地址已失效或网络中断，请点击“重读原图”单独重取这一张。", error: true }); },
  previewPhoto() { if (this.data.photoUrl) wx.previewImage({ current: this.data.photoUrl, urls: [this.data.photoUrl] }); },
  async savePhoto() {
    if (!this.data.photoUrl || this.data.photoSaving) return;
    this.setData({ photoSaving: true, message: "正在下载高清原图…", error: false });
    try {
      const downloaded = await new Promise((resolve, reject) => wx.downloadFile({ url: this.data.photoUrl, success: resolve, fail: reject }));
      if (downloaded.statusCode !== 200 || !downloaded.tempFilePath) throw new Error("原图下载失败");
      await new Promise((resolve, reject) => wx.saveImageToPhotosAlbum({ filePath: downloaded.tempFilePath, success: resolve, fail: reject }));
      this.setData({ message: "高清原图已保存到系统相册，未压缩。", error: false });
    } catch (error) { this.setData({ message: error.errMsg || error.message || "照片保存失败，请检查相册权限后重试", error: true }); }
    finally { this.setData({ photoSaving: false }); }
  },
  inputNotes(event) { this.setData({ notes: event.detail.value }); },
  async saveNotes() {
    this.setData({ savingNotes: true, message: "正在保存备注…", error: false });
    try {
      const result = await callFace("updateCustomerNotes", { customerCode: this.data.customerCode, expectedNotes: this.data.originalNotes, notes: this.data.notes });
      const saved = String(result.notes !== undefined ? result.notes : this.data.notes);
      this.setData({ notes: saved, originalNotes: saved, message: "备注已保存", error: false });
    } catch (error) { this.setData({ message: error.message || "备注保存失败", error: true }); }
    finally { this.setData({ savingNotes: false }); }
  },
  changeHistory(event) { this.setData({ historyType: event.currentTarget.dataset.type }); this.syncHistory(); },
  syncHistory() {
    const map = { RECHARGE: this.data.recharges, VERIFICATION: this.data.verifications, EXPERIENCE: this.data.experiences };
    this.setData({ visibleHistory: map[this.data.historyType] || [] });
  }
});
