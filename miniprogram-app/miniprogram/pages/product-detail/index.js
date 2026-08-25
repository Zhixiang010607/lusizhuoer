const { callStaff } = require("../../services/api");
const { requireSession } = require("../../services/session");

const PREVIEWS = Object.freeze([
  { value: "verification-pdf", label: "核销 PDF", hint: "正常核销与体验核销共用 · A4 分页" },
  { value: "verification-image", label: "核销图片", hint: "正常核销与体验核销共用 · 高清长图" },
  { value: "recharge-pdf", label: "充值 PDF", hint: "充值与退费共用 · A4 分页" },
  { value: "recharge-image", label: "充值图片", hint: "充值与退费共用 · 高清长图" }
]);
const MAX_LOGO_BYTES = 8 * 1024 * 1024;
const FUNCTION_LOGO_BYTES = 3 * 1024 * 1024;

function text(value) { return String(value === undefined || value === null ? "" : value).trim(); }
function normalizedInstructions(value) { return String(value === undefined || value === null ? "" : value).replace(/\r\n?/g, "\n").trim(); }
function previewOption(value) { return PREVIEWS.find((item) => item.value === value) || PREVIEWS[0]; }
function formatTime(value) {
  const source = text(value);
  if (!source) return "未保存";
  const date = new Date(source);
  if (Number.isNaN(date.getTime())) return source;
  const parts = [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()];
  return `${parts[0]}-${String(parts[1]).padStart(2, "0")}-${String(parts[2]).padStart(2, "0")} ${String(parts[3]).padStart(2, "0")}:${String(parts[4]).padStart(2, "0")}:${String(parts[5]).padStart(2, "0")}`;
}
function templateView(candidate) {
  if (!candidate || typeof candidate !== "object") throw new Error("服务器没有返回产品模板");
  const logo = candidate.logo && typeof candidate.logo === "object" ? { ...candidate.logo } : null;
  const verificationInstructions = normalizedInstructions(candidate.verificationInstructions);
  const rechargeInstructions = normalizedInstructions(candidate.rechargeInstructions);
  const productStatus = text(candidate.productStatus).toUpperCase() === "ARCHIVED" ? "ARCHIVED" : "ACTIVE";
  return {
    id: text(candidate.id), productCode: text(candidate.productCode), productName: text(candidate.productName) || "产品单据模板",
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
  if (!ref || !matches) throw new Error(`页面产品与读取结果不一致（请求 ${ref || "—"}，返回 ${result.productCode || result.id || "无编号"}）`);
  return result;
}
function assertRoundTrip(candidate, expected, verificationInstructions, rechargeInstructions) {
  const result = templateView(candidate);
  if ((expected.id && result.id !== expected.id) || (expected.productCode && result.productCode !== expected.productCode)) {
    throw new Error("保存后的模板与当前产品不一致，已停止显示成功状态");
  }
  if (result.verificationInstructions !== verificationInstructions || result.rechargeInstructions !== rechargeInstructions) {
    throw new Error("文字说明写入后回读不一致，请重新保存");
  }
  return result;
}
function wxCall(invoke) { return new Promise((resolve, reject) => invoke(resolve, reject)); }
function readFile(filePath, encoding) {
  return wxCall((resolve, reject) => wx.getFileSystemManager().readFile({ filePath, ...(encoding ? { encoding } : {}), success: resolve, fail: reject }));
}
function fileInfo(filePath) {
  return wxCall((resolve, reject) => wx.getFileSystemManager().getFileInfo({ filePath, success: resolve, fail: reject }));
}
function imageInfo(src) { return wxCall((resolve, reject) => wx.getImageInfo({ src, success: resolve, fail: reject })); }
function ascii(value) {
  const output = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) output[index] = value.charCodeAt(index) & 255;
  return output;
}
function concatBytes(parts) {
  const total = parts.reduce((sum, item) => sum + item.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  parts.forEach((item) => { const bytes = item instanceof Uint8Array ? item : new Uint8Array(item); output.set(bytes, offset); offset += bytes.byteLength; });
  return output;
}
function jpegPdf(jpegBuffer, width, height) {
  const image = new Uint8Array(jpegBuffer);
  const pageWidth = 595;
  const pageHeight = Math.max(842, Math.round(pageWidth * Number(height || 1) / Math.max(1, Number(width || 1))));
  const content = ascii(`q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/Im0 Do\nQ\n`);
  const parts = [ascii("%PDF-1.4\n%LUSIZHUOER\n")];
  const offsets = [0];
  let size = parts[0].byteLength;
  function object(number, segments) {
    offsets[number] = size;
    const value = [ascii(`${number} 0 obj\n`), ...segments, ascii("\nendobj\n")];
    value.forEach((segment) => { parts.push(segment); size += segment.byteLength; });
  }
  object(1, [ascii("<< /Type /Catalog /Pages 2 0 R >>")]);
  object(2, [ascii("<< /Type /Pages /Kids [3 0 R] /Count 1 >>")]);
  object(3, [ascii(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`)]);
  object(4, [ascii(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.byteLength} >>\nstream\n`), image, ascii("\nendstream")]);
  object(5, [ascii(`<< /Length ${content.byteLength} >>\nstream\n`), content, ascii("endstream")]);
  const xrefOffset = size;
  let xref = "xref\n0 6\n0000000000 65535 f \n";
  for (let index = 1; index <= 5; index += 1) xref += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  xref += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  parts.push(ascii(xref));
  return concatBytes(parts).buffer;
}
function safeFilename(value) { return text(value).replace(/[\\/:*?"<>|]/g, "-").slice(0, 80) || "产品单据样例"; }

Page({
  data: {
    productRef: "", loading: true, mutating: false, logoLoading: false, exporting: false,
    template: null, logoPreview: "", selectedLogo: false, message: "", error: false,
    verificationInstructions: "", rechargeInstructions: "", verificationCount: 0, rechargeCount: 0,
    previews: PREVIEWS.map((item, index) => ({ ...item, active: index === 0 })), activePreview: PREVIEWS[0].value,
    previewTitle: PREVIEWS[0].label, previewHint: PREVIEWS[0].hint, isVerification: true, isPdf: true
  },
  onLoad(options) {
    if (!requireSession(["hq"])) return;
    const productRef = text(options.productRef);
    this._created = String(options.created || "") === "1";
    this.setData({ productRef });
    wx.setNavigationBarTitle({ title: "露思卓儿" });
    this.load();
  },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  back() { wx.redirectTo({ url: "/pages/product-management/index" }); },
  async load() {
    if (!this.data.productRef) {
      this.setData({ loading: false, message: "缺少产品编号", error: true });
      return;
    }
    this.setData({ loading: true, message: "", error: false, logoPreview: "", selectedLogo: false });
    this._selectedLogo = null;
    try {
      const response = await callStaff("getProductReceiptTemplate", { productRef: this.data.productRef });
      const template = assertUrlProduct(response.template, this.data.productRef);
      this.applyTemplate(template);
      this.setData({ message: this._created ? "产品已创建，请继续配置 LOGO 和两组单据说明。" : "模板文字已读取，正在读取 LOGO 原图…", error: false });
      await this.loadLogoOriginal(template);
      this._created = false;
    } catch (error) {
      this.setData({ template: null, message: error.message || "产品模板读取失败", error: true });
    } finally { this.setData({ loading: false }); }
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
  async getLogoData(template) {
    const expectedReference = text(template.logo && template.logo.reference);
    let response = await callStaff("getProductReceiptLogoData", { productRef: this.data.productRef, expectedReference });
    let logo = response.logo || {};
    if (logo.chunked && !logo.base64) {
      const bytes = Number(logo.bytes || 0);
      const chunkSize = Number(logo.chunkSize || 0);
      if (!bytes || !chunkSize) throw new Error("LOGO 分块信息不完整");
      const chunks = [];
      for (let offset = 0; offset < bytes; offset += chunkSize) {
        const chunkLength = Math.min(chunkSize, bytes - offset);
        response = await callStaff("getProductReceiptLogoData", {
          productRef: this.data.productRef, expectedReference, chunkOffset: offset, chunkLength
        });
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
  async loadLogoOriginal(template = this.data.template) {
    if (!template || !template.logo) {
      this.setData({ logoLoading: false, logoPreview: "", message: "模板读取完成。", error: false });
      return;
    }
    this.setData({ logoLoading: true });
    try {
      const logoPreview = await this.getLogoData(template);
      this.setData({ logoPreview, message: "模板与 LOGO 原图读取完成。", error: false });
    } catch (error) {
      this.setData({ message: `模板文字已读取；LOGO 原图暂时不可用：${error.message || "请稍后重试"}`, error: true });
    } finally { this.setData({ logoLoading: false }); }
  },
  logoError() {
    if (this.data.template && this.data.template.logo && !this.data.logoLoading && !this._selectedLogo) this.loadLogoOriginal();
  },
  inputInstructions(event) {
    const field = event.currentTarget.dataset.field;
    const value = event.detail.value;
    this.setData({ [field]: value, [`${field === "verificationInstructions" ? "verification" : "recharge"}Count`]: value.length });
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
      this.setData({ message: "LOGO 原图已上传、回读核对并保存。", error: false });
    } catch (error) {
      await this.discardLogo(reference);
      this.setData({ message: error.message || "LOGO 上传失败", error: true });
    } finally { this.setData({ mutating: false }); }
  },
  async removeLogo() {
    if (this.data.mutating || !this.data.template || !this.data.template.logo) return;
    const confirmed = await wxCall((resolve) => wx.showModal({ title: "移除产品 LOGO", content: "确定移除该产品的共用 LOGO 吗？", confirmText: "移除", success: (value) => resolve(value.confirm), fail: () => resolve(false) }));
    if (!confirmed) return;
    this.setData({ mutating: true, message: "正在移除产品 LOGO…", error: false });
    try {
      const response = await callStaff("removeProductReceiptLogo", { productRef: this.data.productRef });
      const template = assertUrlProduct(response.template, this.data.productRef);
      this._selectedLogo = null;
      this.applyTemplate(template, true);
      this.setData({ selectedLogo: false, logoPreview: "", message: "产品 LOGO 已移除。", error: false });
    } catch (error) {
      this.setData({ message: error.message || "产品 LOGO 移除失败", error: true });
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
      title: `${action}产品`, content: next === "ARCHIVED" ? "历史单据和模板会继续保留。确认封存？" : "确认重新激活该产品？",
      confirmText: action, success: (value) => resolve(value.confirm), fail: () => resolve(false)
    }));
    if (!confirmed) return;
    this.setData({ mutating: true, message: `正在${action}产品…`, error: false });
    try {
      await callStaff("setProductStatus", { productRef: this.data.productRef, status: next });
      const reread = await callStaff("getProductReceiptTemplate", { productRef: this.data.productRef });
      const template = assertUrlProduct(reread.template, this.data.productRef);
      if (template.productStatus !== next) throw new Error(`${action}结果未能由数据库确认，请刷新后核对`);
      this.applyTemplate(template, true);
      this.setData({ message: next === "ARCHIVED" ? "产品已封存，历史单据和模板继续保留。" : "产品已激活。", error: false });
    } catch (error) {
      this.setData({ message: error.message || `产品${action}失败`, error: true });
    } finally { this.setData({ mutating: false }); }
  },
  choosePreview(event) {
    const value = text(event.currentTarget.dataset.value);
    const current = previewOption(value);
    this.setData({
      activePreview: current.value, previewTitle: current.label, previewHint: current.hint,
      previews: PREVIEWS.map((item) => ({ ...item, active: item.value === current.value })),
      isVerification: current.value.startsWith("verification"), isPdf: current.value.endsWith("pdf")
    });
  },
  refreshPreview() {
    const current = previewOption(this.data.activePreview);
    this.setData({ previewHint: `${current.hint} · 已按当前文字刷新` });
  },
  canvasNode() {
    return new Promise((resolve, reject) => this.createSelectorQuery().select("#receiptCanvas").fields({ node: true, size: true }).exec((items) => {
      if (!items || !items[0] || !items[0].node) reject(new Error("样例画布尚未准备完成")); else resolve(items[0].node);
    }));
  },
  loadCanvasImage(canvas, source) {
    return new Promise((resolve, reject) => {
      const image = canvas.createImage();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("产品 LOGO 无法写入样例"));
      image.src = source;
    });
  },
  drawWrapped(context, value, x, y, maxWidth, lineHeight, maxLines = 50) {
    const characters = Array.from(String(value || ""));
    let line = "";
    let lines = 0;
    characters.forEach((character) => {
      const test = line + character;
      if ((character === "\n" || context.measureText(test).width > maxWidth) && line) {
        if (lines < maxLines) context.fillText(line, x, y + lines * lineHeight);
        lines += 1;
        line = character === "\n" ? "" : character;
      } else if (character !== "\n") line = test;
    });
    if (line && lines < maxLines) context.fillText(line, x, y + lines * lineHeight);
    return y + (Math.min(maxLines, lines + (line ? 1 : 0)) * lineHeight);
  },
  async drawReceipt() {
    if (this.data.template && this.data.template.logo && (!this.data.logoPreview || this.data.logoLoading)) throw new Error("产品 LOGO 原图尚未读取完成，本次没有生成文件");
    const canvas = await this.canvasNode();
    const verification = this.data.isVerification;
    const width = 750;
    const height = verification ? 1480 : 1120;
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    context.fillStyle = "#fffdf9";
    context.fillRect(0, 0, width, height);
    context.strokeStyle = "#cdb68f";
    context.lineWidth = 3;
    context.strokeRect(28, 28, width - 56, height - 56);
    context.fillStyle = "#786a57";
    context.font = "18px sans-serif";
    context.fillText(verification ? "正常核销 / 体验核销" : "充值 / 退费", 58, 78);
    context.fillStyle = "#2f2921";
    context.font = "bold 38px sans-serif";
    context.fillText(verification ? "核销单 SAMPLE001" : "充值单 SAMPLE001", 58, 126);
    context.font = "18px sans-serif";
    context.fillStyle = "#756958";
    context.fillText("门店详细地址：示例省示例市示例区示例路 1 号", 58, 160);
    if (this.data.logoPreview) {
      const logo = await this.loadCanvasImage(canvas, this.data.logoPreview);
      context.drawImage(logo, 584, 58, 108, 108);
    } else {
      context.fillStyle = "#f1e4cf"; context.fillRect(584, 58, 108, 108);
      context.fillStyle = "#7b684b"; context.font = "bold 20px sans-serif"; context.fillText("LOGO", 610, 120);
    }
    context.strokeStyle = "#d8c6a7"; context.lineWidth = 2;
    context.beginPath(); context.moveTo(58, 194); context.lineTo(692, 194); context.stroke();
    const facts = [["门店", "示例门店"], ["客户", "示例客户"], ["项目", this.data.template.productName], ["业务老师", "示例老师"], ["提交时间", "2026-08-19 12:34:56"]];
    let y = 218;
    facts.forEach(([label, value], index) => {
      const column = index % 2;
      const row = Math.floor(index / 2);
      const x = 58 + column * 322;
      const top = y + row * 84;
      context.fillStyle = "#faf7f1"; context.fillRect(x, top, 306, 70);
      context.fillStyle = "#817463"; context.font = "17px sans-serif"; context.fillText(label, x + 14, top + 24);
      context.fillStyle = "#302a22"; context.font = "bold 20px sans-serif"; context.fillText(String(value), x + 14, top + 52);
    });
    y += 3 * 84 + 22;
    if (verification) {
      context.fillStyle = "#2f2921"; context.font = "bold 24px sans-serif"; context.fillText("核销照片凭证", 58, y);
      context.fillStyle = "#756958"; context.font = "16px sans-serif"; context.fillText("客户档案照、本次现场照与三个补充照片位", 58, y + 27);
      y += 48;
      [["客户建档照片", 58], ["本次核销人脸照", 380]].forEach(([label, x]) => {
        context.fillStyle = "#f1eadf"; context.fillRect(x, y, 306, 190);
        context.fillStyle = "#817463"; context.font = "19px sans-serif"; context.fillText(label, x + 84, y + 100);
      });
      y += 204;
      ["补充照片 1", "补充照片 2", "补充照片 3"].forEach((label, index) => {
        const x = 58 + index * 214;
        context.fillStyle = "#f1eadf"; context.fillRect(x, y, 198, 148);
        context.fillStyle = "#817463"; context.font = "17px sans-serif"; context.fillText(label, x + 47, y + 80);
      });
      y += 178;
    } else {
      context.fillStyle = "#2f2921"; context.font = "bold 24px sans-serif"; context.fillText("充值信息", 58, y); y += 20;
      [["充值次数", "10 次"], ["提交时间", "2026-08-19 12:34:56"], ["审核时间", "2026-08-19 12:36:10"]].forEach(([label, value], index) => {
        const top = y + 20 + index * 68;
        context.fillStyle = "#faf7f1"; context.fillRect(58, top, 634, 56);
        context.fillStyle = "#817463"; context.font = "17px sans-serif"; context.fillText(label, 74, top + 23);
        context.fillStyle = "#302a22"; context.font = "bold 19px sans-serif"; context.fillText(value, 220, top + 36);
      });
      y += 236;
    }
    context.font = "bold 24px sans-serif"; context.fillStyle = "#302a22"; context.fillText("产品说明", 58, y); y += 38;
    context.fillStyle = "#faf7f1"; context.fillRect(58, y - 8, 634, height - y - 56);
    context.font = "21px sans-serif"; context.fillStyle = "#5f5548";
    const instructions = verification ? normalizedInstructions(this.data.verificationInstructions) : normalizedInstructions(this.data.rechargeInstructions);
    this.drawWrapped(context, instructions || "尚未填写单据说明", 76, y + 24, 598, 31, verification ? 13 : 11);
    const output = await wxCall((resolve, reject) => wx.canvasToTempFilePath({ canvas, fileType: "jpg", quality: 1, success: resolve, fail: reject }));
    return { path: output.tempFilePath, width, height };
  },
  async downloadPreview() {
    if (this.data.exporting || !this.data.template) return;
    this.setData({ exporting: true, message: "正在生成高清样例…", error: false });
    try {
      const image = await this.drawReceipt();
      const kind = this.data.isVerification ? "核销单" : "充值单";
      const baseName = safeFilename(`${this.data.template.productName}-${kind}-样例`);
      if (this.data.isPdf) {
        const source = await readFile(image.path);
        const pdf = jpegPdf(source.data, image.width, image.height);
        const filePath = `${wx.env.USER_DATA_PATH}/${baseName}.pdf`;
        await wxCall((resolve, reject) => wx.getFileSystemManager().writeFile({ filePath, data: pdf, success: resolve, fail: reject }));
        if (typeof wx.shareFileMessage === "function") {
          await wxCall((resolve, reject) => wx.shareFileMessage({ filePath, fileName: `${baseName}.pdf`, success: resolve, fail: reject }));
        } else {
          await wxCall((resolve, reject) => wx.openDocument({ filePath, fileType: "pdf", showMenu: true, success: resolve, fail: reject }));
        }
      } else {
        await wxCall((resolve, reject) => wx.saveImageToPhotosAlbum({ filePath: image.path, success: resolve, fail: reject }));
      }
      this.setData({ message: this.data.isPdf ? "PDF 样例已生成。" : "图片样例已保存到相册。", error: false });
    } catch (error) {
      if (/cancel/i.test(String(error.errMsg || error.message || ""))) this.setData({ message: "已取消保存样例。", error: false });
      else this.setData({ message: error.message || error.errMsg || "样例生成失败", error: true });
    } finally { this.setData({ exporting: false }); }
  }
});
