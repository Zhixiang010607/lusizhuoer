const { callStaff } = require("../../services/api");
const { requireSession } = require("../../services/session");
const { displayDateTime } = require("../../services/query-tools");
const { saveImageToAlbum } = require("../../services/photo-album");
const {
  createProductSampleDocument,
  createProductSamplePhotos,
  renderReceiptCanvas,
  exportReceiptJpegs,
  createPdfBytes: jpegPdf,
  safeFilename
} = require("../../services/order-receipt");

const PREVIEWS = Object.freeze([
  { value: "verification-pdf", label: "核销 PDF", hint: "正常核销与体验核销共用 · 300 DPI A4 分页" },
  { value: "verification-image", label: "核销图片", hint: "正常核销与体验核销共用 · 2480 像素高清长图" },
  { value: "recharge-pdf", label: "充值 PDF", hint: "充值与退费共用 · 300 DPI A4 分页" },
  { value: "recharge-image", label: "充值图片", hint: "充值与退费共用 · 2480 像素高清长图" }
]);
const MAX_LOGO_BYTES = 8 * 1024 * 1024;
const FUNCTION_LOGO_BYTES = 3 * 1024 * 1024;

function text(value) { return String(value === undefined || value === null ? "" : value).trim(); }
function normalizedInstructions(value) { return String(value === undefined || value === null ? "" : value).replace(/\r\n?/g, "\n").trim(); }
function previewOption(value) { return PREVIEWS.find((item) => item.value === value) || PREVIEWS[0]; }
function formatTime(value) {
  const source = text(value);
  if (!source) return "未保存";
  const formatted = displayDateTime(source);
  return formatted === "—" ? source : formatted;
}
function templateView(candidate) {
  if (!candidate || typeof candidate !== "object") throw new Error("服务器没有返回项目模板");
  const logo = candidate.logo && typeof candidate.logo === "object" ? { ...candidate.logo } : null;
  const verificationInstructions = normalizedInstructions(candidate.verificationInstructions);
  const rechargeInstructions = normalizedInstructions(candidate.rechargeInstructions);
  const productStatus = text(candidate.productStatus).toUpperCase() === "ARCHIVED" ? "ARCHIVED" : "ACTIVE";
  return {
    id: text(candidate.id), productCode: text(candidate.productCode), productName: text(candidate.productName) || "项目单据模板",
    productType: text(candidate.productType) || "未分类", description: text(candidate.description), productStatus, logo,
    verificationInstructions, rechargeInstructions, updatedAt: candidate.updatedAt || "", updatedByName: text(candidate.updatedByName),
    statusText: productStatus === "ARCHIVED" ? "封存" : "活跃",
    updatedText: formatTime(candidate.updatedAt),
    ready: Boolean(logo && verificationInstructions && rechargeInstructions)
  };
}
function assertUrlProduct(candidate, requested) {
  const result = templateView(candidate);
  const ref = text(requested);
  const matches = /^\d+$/.test(ref) ? result.id === ref : result.productCode.toUpperCase() === ref.toUpperCase();
  if (!ref || !matches) throw new Error(`页面项目与读取结果不一致（请求 ${ref || "—"}，返回 ${result.productCode || result.id || "无编号"}）`);
  return result;
}
function assertRoundTrip(candidate, expected, verificationInstructions, rechargeInstructions) {
  const result = templateView(candidate);
  if ((expected.id && result.id !== expected.id) || (expected.productCode && result.productCode !== expected.productCode)) {
    throw new Error("保存后的模板与当前项目不一致，已停止显示成功状态");
  }
  if (result.verificationInstructions !== verificationInstructions || result.rechargeInstructions !== rechargeInstructions) {
    throw new Error("文字说明写入后回读不一致，请重新保存");
  }
  return result;
}
function currentLoad(page, request) {
  return Boolean(request) && !page._unloaded
    && request.epoch === page._loadRequestEpoch
    && request.productRef === text(page.data.productRef);
}
function wxCall(invoke) { return new Promise((resolve, reject) => invoke(resolve, reject)); }
function openPdfDocument(filePath) {
  if (typeof wx.openDocument !== "function") {
    return Promise.reject(new Error("当前微信版本无法打开 PDF，请升级微信后重试"));
  }
  return wxCall((resolve, reject) => wx.openDocument({
    filePath,
    fileType: "pdf",
    showMenu: true,
    success: resolve,
    fail: reject
  }));
}
function readFile(filePath, encoding) {
  return wxCall((resolve, reject) => wx.getFileSystemManager().readFile({ filePath, ...(encoding ? { encoding } : {}), success: resolve, fail: reject }));
}
function fileInfo(filePath) {
  return wxCall((resolve, reject) => wx.getFileSystemManager().getFileInfo({ filePath, success: resolve, fail: reject }));
}
function imageInfo(src) { return wxCall((resolve, reject) => wx.getImageInfo({ src, success: resolve, fail: reject })); }
function concatBytes(parts) {
  const total = parts.reduce((sum, item) => sum + item.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  parts.forEach((item) => { const bytes = item instanceof Uint8Array ? item : new Uint8Array(item); output.set(bytes, offset); offset += bytes.byteLength; });
  return output;
}

Page({
  data: {
    productRef: "", loading: true, mutating: false, logoLoading: false, exporting: false,
    template: null, logoPreview: "", selectedLogo: false, message: "", error: false,
    verificationInstructions: "", rechargeInstructions: "", verificationCount: 0, rechargeCount: 0,
    previews: PREVIEWS.map((item, index) => ({ ...item, active: index === 0 })), activePreview: PREVIEWS[0].value,
    previewTitle: PREVIEWS[0].label, previewHint: PREVIEWS[0].hint, isVerification: true, isPdf: true,
    previewLoading: false, previewError: "", previewImages: [], previewPageCount: 0
  },
  onLoad(options) {
    if (!requireSession(["hq"])) return;
    this._unloaded = false;
    const productRef = text(options.productRef);
    this._created = String(options.created || "") === "1";
    this.setData({ productRef });
    wx.setNavigationBarTitle({ title: "露思卓儿" });
    this.load();
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  onUnload() {
    this._unloaded = true;
    this._loadRequestEpoch = Number(this._loadRequestEpoch || 0) + 1;
    this._previewEpoch = Number(this._previewEpoch || 0) + 1;
  },
  back() { wx.redirectTo({ url: "/pages/product-management/index" }); },
  async load() {
    const request = Object.freeze({
      epoch: Number(this._loadRequestEpoch || 0) + 1,
      productRef: text(this.data.productRef),
      created: this._created === true
    });
    this._loadRequestEpoch = request.epoch;
    this._previewEpoch = Number(this._previewEpoch || 0) + 1;
    const currentPreview = previewOption(this.data.activePreview);
    this._selectedLogo = null;
    if (!request.productRef) {
      if (!this._unloaded) this.setData({
        loading: false, logoLoading: false, template: null, logoPreview: "", selectedLogo: false,
        verificationInstructions: "", rechargeInstructions: "", verificationCount: 0, rechargeCount: 0,
        previewLoading: false, previewError: "", previewImages: [], previewPageCount: 0,
        previewHint: currentPreview.hint, message: "缺少项目编号", error: true
      });
      return;
    }
    this.setData({
      loading: true, logoLoading: false, template: null, logoPreview: "", selectedLogo: false,
      verificationInstructions: "", rechargeInstructions: "", verificationCount: 0, rechargeCount: 0,
      previewLoading: false, previewError: "", previewImages: [], previewPageCount: 0,
      previewHint: currentPreview.hint, message: "", error: false
    });
    try {
      const response = await callStaff("getProductReceiptTemplate", Object.freeze({ productRef: request.productRef }));
      if (!currentLoad(this, request)) return;
      const template = assertUrlProduct(response.template, request.productRef);
      this.applyTemplate(template);
      this.setData({ message: request.created ? "项目已创建，请继续配置 LOGO 和两组单据说明。" : "模板文字已读取，正在读取 LOGO 原图…", error: false });
      await this.loadLogoOriginal(template, request);
      if (!currentLoad(this, request)) return;
      await this.renderPreview(request);
      if (!currentLoad(this, request)) return;
      this._created = false;
    } catch (error) {
      if (!currentLoad(this, request)) return;
      this._selectedLogo = null;
      this.setData({
        template: null, logoPreview: "", selectedLogo: false, logoLoading: false,
        verificationInstructions: "", rechargeInstructions: "", verificationCount: 0, rechargeCount: 0,
        previewLoading: false, previewImages: [], previewPageCount: 0, previewError: "", previewHint: currentPreview.hint,
        message: error.message || "项目模板读取失败", error: true
      });
    } finally {
      if (currentLoad(this, request)) this.setData({ loading: false });
    }
  },
  applyTemplate(template, preserveInstructions = false) {
    const changes = { template };
    if (!preserveInstructions) {
      changes.verificationInstructions = template.verificationInstructions;
      changes.rechargeInstructions = template.rechargeInstructions;
      changes.verificationCount = template.verificationInstructions.length;
      changes.rechargeCount = template.rechargeInstructions.length;
    }
    if (!this._selectedLogo) changes.logoPreview = template.logo && template.logo.url || "";
    this.setData(changes);
  },
  async getLogoData(template, loadRequest = null) {
    const productRef = loadRequest ? loadRequest.productRef : text(this.data.productRef);
    const expectedReference = text(template.logo && template.logo.reference);
    let response = await callStaff("getProductReceiptLogoData", Object.freeze({ productRef, expectedReference }));
    if (loadRequest && !currentLoad(this, loadRequest)) return null;
    let logo = response.logo || {};
    if (logo.chunked && !logo.base64) {
      const bytes = Number(logo.bytes || 0);
      const chunkSize = Number(logo.chunkSize || 0);
      if (!bytes || !chunkSize) throw new Error("LOGO 分块信息不完整");
      const chunks = [];
      for (let offset = 0; offset < bytes; offset += chunkSize) {
        const chunkLength = Math.min(chunkSize, bytes - offset);
        response = await callStaff("getProductReceiptLogoData", Object.freeze({
          productRef, expectedReference, chunkOffset: offset, chunkLength
        }));
        if (loadRequest && !currentLoad(this, loadRequest)) return null;
        const part = response.logo || {};
        if (Number(part.chunkOffset) !== offset || Number(part.chunkBytes) !== chunkLength || !part.base64) throw new Error("LOGO 分块读取不完整");
        chunks.push(new Uint8Array(wx.base64ToArrayBuffer(part.base64)));
      }
      const merged = concatBytes(chunks);
      if (merged.byteLength !== bytes) throw new Error("LOGO 原图大小不一致");
      logo = { ...logo, base64: wx.arrayBufferToBase64(merged.buffer) };
    }
    if (!logo.base64 || Number(logo.bytes || 0) !== Number(template.logo.bytes || 0)) throw new Error("LOGO 原图读取不完整");
    return `data:${text(logo.mimeType) || text(template.logo.mimeType)};base64,${logo.base64}`;
  },
  async loadLogoOriginal(template = this.data.template, loadRequest = null) {
    const isCurrent = () => !loadRequest || currentLoad(this, loadRequest);
    if (!isCurrent()) return;
    if (!template || !template.logo) {
      if (isCurrent()) this.setData({ logoLoading: false, logoPreview: "", message: "模板读取完成。", error: false });
      return;
    }
    this.setData({ logoLoading: true });
    try {
      const logoPreview = await this.getLogoData(template, loadRequest);
      if (!isCurrent()) return;
      this.setData({ logoPreview, message: "模板与 LOGO 原图读取完成。", error: false });
    } catch (error) {
      if (isCurrent()) this.setData({ message: `模板文字已读取；LOGO 原图暂时不可用：${error.message || "请稍后重试"}`, error: true });
    } finally {
      if (isCurrent()) this.setData({ logoLoading: false });
    }
  },
  logoError() {
    if (this.data.template && this.data.template.logo && !this.data.logoLoading && !this._selectedLogo) {
      this.loadLogoOriginal().then(() => this.renderPreview()).catch(() => {});
    }
  },
  inputInstructions(event) {
    const field = event.currentTarget.dataset.field;
    const value = event.detail.value;
    const current = previewOption(this.data.activePreview);
    this.setData({
      [field]: value,
      [`${field === "verificationInstructions" ? "verification" : "recharge"}Count`]: value.length,
      previewHint: `${current.hint} · 文字已修改，刷新后生效`
    });
  },
  async chooseLogo() {
    if (this.data.mutating) return;
    try {
      const chosen = await wxCall((resolve, reject) => wx.chooseMedia({
        count: 1, mediaType: ["image"], sourceType: ["album", "camera"], sizeType: ["original"], success: resolve, fail: reject
      }));
      const file = chosen.tempFiles && chosen.tempFiles[0];
      const path = file && file.tempFilePath;
      if (!path) throw new Error("没有取得 LOGO 原图");
      const [info, dimensions] = await Promise.all([fileInfo(path), imageInfo(path)]);
      const bytes = Number(info.size || file.size || 0);
      const type = text(dimensions.type).toLowerCase();
      const mimeType = type === "png" ? "image/png" : type === "webp" ? "image/webp" : type === "jpeg" || type === "jpg" ? "image/jpeg" : "";
      if (!mimeType) throw new Error("仅支持 PNG、JPEG 或 WebP");
      if (bytes < 8 || bytes > MAX_LOGO_BYTES) throw new Error("LOGO 原图必须小于 8 MB");
      if (!dimensions.width || !dimensions.height || dimensions.width > 12000 || dimensions.height > 12000) throw new Error("LOGO 图片尺寸无效");
      this._selectedLogo = {
        path, originalName: text(file.name) || `product-logo.${type === "jpeg" ? "jpg" : type}`,
        mimeType, bytes, width: Number(dimensions.width), height: Number(dimensions.height)
      };
      this.setData({ selectedLogo: true, logoPreview: path, message: "已选择原图，点击“上传并保存”。", error: false });
      await this.renderPreview();
    } catch (error) {
      if (/cancel/i.test(String(error.errMsg || error.message || ""))) return;
      this.setData({ message: error.message || error.errMsg || "LOGO 选择失败", error: true });
    }
  },
  async signedUpload(upload, path, mimeType) {
    const source = await readFile(path);
    const response = await wxCall((resolve, reject) => wx.request({
      url: upload.url, method: upload.method || "PUT", data: source.data,
      header: { ...(upload.headers || {}), "Content-Type": mimeType }, responseType: "text",
      success: resolve, fail: reject, timeout: 180000
    }));
    if (Number(response.statusCode) < 200 || Number(response.statusCode) >= 300) throw new Error(`LOGO 原图上传失败（HTTP ${response.statusCode || "—"}）`);
  },
  async discardLogo(reference) {
    if (!reference) return;
    try { await callStaff("discardProductLogoUpload", { productRef: this.data.productRef, reference }); } catch (_) {}
  },
  async functionUpload(input) {
    if (input.bytes > FUNCTION_LOGO_BYTES) throw new Error("签名直传失败；当前安全备用通道支持不超过 3 MB 的原图");
    const source = await readFile(this._selectedLogo.path, "base64");
    return callStaff("uploadProductLogoByFunction", { ...input, imageBase64: `data:${input.mimeType};base64,${source.data}` });
  },
  async uploadLogo() {
    if (!this._selectedLogo || this.data.mutating) return;
    this.setData({ mutating: true, message: "正在取得私有存储上传地址…", error: false });
    const input = { productRef: this.data.productRef, ...this._selectedLogo };
    delete input.path;
    let reference = "";
    let stage = "BEGIN";
    try {
      let response;
      try {
        const pending = await callStaff("beginProductLogoUpload", input);
        reference = text(pending.reference);
        stage = "UPLOAD";
        this.setData({ message: "正在上传 LOGO 原图，请勿关闭页面…" });
        await this.signedUpload(pending.upload || {}, this._selectedLogo.path, input.mimeType);
        stage = "CONFIRM";
        this.setData({ message: "上传完成，正在由服务器核对原图…" });
        response = await callStaff("confirmProductLogoUpload", { ...input, reference });
        reference = "";
      } catch (error) {
        const fallback = error.code === "PRODUCT_LOGO_UPLOAD_SIGN_FAILED" || stage === "UPLOAD";
        if (!fallback) throw error;
        await this.discardLogo(reference);
        reference = "";
        this.setData({ message: "签名直传不可用，正在通过安全备用通道上传原图…" });
        response = await this.functionUpload(input);
      }
      const template = assertUrlProduct(response.template, this.data.productRef);
      if (!template.logo || Number(template.logo.bytes || 0) !== Number(input.bytes)) throw new Error("LOGO 已保存，但数据库回读校验失败");
      this._selectedLogo = null;
      this.setData({ selectedLogo: false });
      this.applyTemplate(template, true);
      await this.loadLogoOriginal(template);
      if (!this.data.logoPreview) throw new Error("LOGO 已保存，但原图回读失败");
      await this.renderPreview();
      this.setData({ message: "LOGO 原图已上传、回读核对并保存。", error: false });
    } catch (error) {
      await this.discardLogo(reference);
      this.setData({ message: error.message || "LOGO 上传失败", error: true });
    } finally { this.setData({ mutating: false }); }
  },
  async removeLogo() {
    if (this.data.mutating || !this.data.template || !this.data.template.logo) return;
    const confirmed = await wxCall((resolve) => wx.showModal({ title: "移除项目 LOGO", content: "确定移除该项目的共用 LOGO 吗？", confirmText: "移除", success: (value) => resolve(value.confirm), fail: () => resolve(false) }));
    if (!confirmed) return;
    this.setData({ mutating: true, message: "正在移除项目 LOGO…", error: false });
    try {
      const response = await callStaff("removeProductReceiptLogo", { productRef: this.data.productRef });
      const template = assertUrlProduct(response.template, this.data.productRef);
      this._selectedLogo = null;
      this.applyTemplate(template, true);
      this.setData({ selectedLogo: false, logoPreview: "", message: "项目 LOGO 已移除。", error: false });
      await this.renderPreview();
    } catch (error) {
      this.setData({ message: error.message || "项目 LOGO 移除失败", error: true });
    } finally { this.setData({ mutating: false }); }
  },
  async saveInstructions() {
    if (this.data.mutating || !this.data.template) return;
    const expected = { id: this.data.template.id, productCode: this.data.template.productCode, productName: this.data.template.productName };
    const verificationInstructions = normalizedInstructions(this.data.verificationInstructions);
    const rechargeInstructions = normalizedInstructions(this.data.rechargeInstructions);
    this.setData({ mutating: true, message: "正在保存两组文字说明…", error: false });
    try {
      const saved = await callStaff("saveProductReceiptTemplate", { productRef: this.data.productRef, verificationInstructions, rechargeInstructions });
      assertRoundTrip(saved.template, expected, verificationInstructions, rechargeInstructions);
      const reread = await callStaff("getProductReceiptTemplate", { productRef: this.data.productRef });
      const template = assertRoundTrip(reread.template, expected, verificationInstructions, rechargeInstructions);
      this.applyTemplate(template);
      await this.renderPreview();
      this.setData({ message: `${expected.productName}${expected.productCode ? `（${expected.productCode}）` : ""}的两组文字说明已保存并从数据库复核。`, error: false });
    } catch (error) {
      this.setData({ message: error.message || "文字说明保存失败", error: true });
    } finally { this.setData({ mutating: false }); }
  },
  async toggleStatus() {
    if (this.data.mutating || !this.data.template) return;
    const next = this.data.template.productStatus === "ARCHIVED" ? "ACTIVE" : "ARCHIVED";
    const action = next === "ARCHIVED" ? "封存" : "激活";
    const confirmed = await wxCall((resolve) => wx.showModal({
      title: `${action}项目`, content: next === "ARCHIVED" ? "历史单据和模板会继续保留。确认封存？" : "确认重新激活该项目？",
      confirmText: action, success: (value) => resolve(value.confirm), fail: () => resolve(false)
    }));
    if (!confirmed) return;
    this.setData({ mutating: true, message: `正在${action}项目…`, error: false });
    try {
      await callStaff("setProductStatus", { productRef: this.data.productRef, status: next });
      const reread = await callStaff("getProductReceiptTemplate", { productRef: this.data.productRef });
      const template = assertUrlProduct(reread.template, this.data.productRef);
      if (template.productStatus !== next) throw new Error(`${action}结果未能由数据库确认，请刷新后核对`);
      this.applyTemplate(template, true);
      this.setData({ message: next === "ARCHIVED" ? "项目已封存，历史单据和模板继续保留。" : "项目已激活。", error: false });
    } catch (error) {
      this.setData({ message: error.message || `项目${action}失败`, error: true });
    } finally { this.setData({ mutating: false }); }
  },
  choosePreview(event) {
    const value = text(event.currentTarget.dataset.value);
    const current = previewOption(value);
    this.setData({
      activePreview: current.value, previewTitle: current.label, previewHint: current.hint,
      previews: PREVIEWS.map((item) => ({ ...item, active: item.value === current.value })),
      isVerification: current.value.startsWith("verification"), isPdf: current.value.endsWith("pdf")
    }, () => this.renderPreview());
  },
  refreshPreview() {
    return this.renderPreview();
  },
  sampleDocument(kind = this.data.activePreview) {
    return createProductSampleDocument({
      template: this.data.template,
      kind,
      verificationInstructions: normalizedInstructions(this.data.verificationInstructions),
      rechargeInstructions: normalizedInstructions(this.data.rechargeInstructions),
      logoRequired: Boolean(this._selectedLogo || this.data.template && this.data.template.logo)
    });
  },
  samplePhotos(kind = this.data.activePreview) {
    return createProductSamplePhotos(kind);
  },
  nextViewTick() {
    return new Promise((resolve) => {
      if (typeof wx.nextTick === "function") wx.nextTick(resolve); else resolve();
    });
  },
  queueReceiptRender(task) {
    const previous = this._receiptRenderQueue || Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    this._receiptRenderQueue = current.catch(() => {});
    return current;
  },
  canvasNode() {
    return new Promise((resolve, reject) => this.createSelectorQuery().select("#receiptCanvas").fields({ node: true, size: true }).exec((items) => {
      if (!items || !items[0] || !items[0].node) reject(new Error("样例画布尚未准备完成")); else resolve(items[0].node);
    }));
  },
  async renderReceiptArtifacts(kind = this.data.activePreview) {
    const current = previewOption(kind);
    const documentData = this.sampleDocument(current.value);
    const photos = this.samplePhotos(current.value);
    await this.nextViewTick();
    const canvas = await this.canvasNode();
    const receipt = await renderReceiptCanvas({
      canvas,
      documentData,
      photos,
      logoSource: this.data.logoPreview,
      paginate: current.value.endsWith("pdf")
    });
    const images = await exportReceiptJpegs(receipt, this);
    return {
      kind: current.value,
      documentData,
      images,
      width: receipt.width,
      height: receipt.height,
      pageCount: receipt.pageCount,
      paginate: receipt.paginate
    };
  },
  async renderPreview(loadRequest = null) {
    if ((loadRequest && !currentLoad(this, loadRequest)) || !this.data.template || this._unloaded) return;
    const current = previewOption(this.data.activePreview);
    const epoch = Number(this._previewEpoch || 0) + 1;
    this._previewEpoch = epoch;
    this.setData({
      previewLoading: true,
      previewError: "",
      previewHint: "正在生成高清预览…"
    });
    try {
      const artifact = await this.queueReceiptRender(async () => {
        if (this._unloaded || epoch !== this._previewEpoch || loadRequest && !currentLoad(this, loadRequest)) return null;
        return this.renderReceiptArtifacts(current.value);
      });
      if (!artifact || this._unloaded || epoch !== this._previewEpoch || loadRequest && !currentLoad(this, loadRequest) || current.value !== this.data.activePreview) return;
      this.setData({
        previewImages: artifact.images.map((item) => ({
          ...item,
          key: `${artifact.kind}-${item.pageNumber}`,
          label: artifact.paginate ? `第 ${item.pageNumber} / ${artifact.pageCount} 页` : "高清长图"
        })),
        previewPageCount: artifact.pageCount,
        previewHint: current.hint,
        previewLoading: false,
        previewError: ""
      });
    } catch (error) {
      if (this._unloaded || epoch !== this._previewEpoch || loadRequest && !currentLoad(this, loadRequest)) return;
      this.setData({
        previewImages: [], previewPageCount: 0, previewLoading: false,
        previewError: error.message || error.errMsg || "预览生成失败",
        previewHint: error.message || error.errMsg || "预览生成失败"
      });
    }
  },
  async downloadPreview() {
    if (this.data.exporting || !this.data.template) return;
    const current = previewOption(this.data.activePreview);
    this.setData({ exporting: true, message: "正在生成高清样例…", error: false });
    try {
      const artifact = await this.queueReceiptRender(() => this.renderReceiptArtifacts(current.value));
      const baseName = safeFilename(artifact.documentData.filename);
      if (current.value.endsWith("pdf")) {
        const pages = [];
        for (const image of artifact.images) {
          const source = await readFile(image.path);
          pages.push({ width: image.width, height: image.height, bytes: new Uint8Array(source.data) });
        }
        const pdf = jpegPdf(pages);
        const filePath = `${wx.env.USER_DATA_PATH}/${baseName}.pdf`;
        await wxCall((resolve, reject) => wx.getFileSystemManager().writeFile({ filePath, data: pdf, success: resolve, fail: reject }));
        await openPdfDocument(filePath);
      } else {
        await saveImageToAlbum(artifact.images[0].path);
      }
      this.setData({
        message: current.value.endsWith("pdf") ? "PDF 样例已打开，可通过右上角菜单分享或保存。" : "图片样例已保存到相册。",
        error: false
      });
    } catch (error) {
      if (/cancel/i.test(String(error.errMsg || error.message || ""))) this.setData({ message: "已取消保存样例。", error: false });
      else this.setData({ message: error.message || error.errMsg || "样例生成失败", error: true });
    } finally { this.setData({ exporting: false }); }
  }
});
