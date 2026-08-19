(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const projectRef = new URLSearchParams(location.search).get("projectId") || "";
  const previewLabels = {
    "verification-pdf": ["核销 PDF", "正常核销与体验核销共用 · A4 分页"],
    "verification-image": ["核销图片", "正常核销与体验核销共用 · 高清长图"],
    "recharge-pdf": ["充值 PDF", "充值与退费共用 · A4 分页"],
    "recharge-image": ["充值图片", "充值与退费共用 · 高清长图"]
  };
  let template = null;
  let logoBlob = null;
  let selectedLogo = null;
  let selectedLogoMeta = null;
  let activePreview = "verification-pdf";
  let previewObjectUrl = "";
  let previewBusy = false;
  let previewQueued = false;
  const localPreviewMode = ["127.0.0.1", "localhost"].includes(location.hostname)
    && new URLSearchParams(location.search).get("preview") === "1";

  function setMessage(value, tone = "") {
    const target = $("productTemplateMessage");
    target.textContent = value || "";
    target.dataset.tone = tone;
  }

  function currentProductRef() {
    if (!template || !projectRef) throw new Error("产品模板尚未读取完成，请刷新页面重试");
    return projectRef;
  }

  function assertUrlProduct(candidate) {
    if (!candidate || typeof candidate !== "object") throw new Error("服务器没有返回产品模板");
    const requested = String(projectRef || "").trim();
    const candidateId = String(candidate.id || "").trim();
    const candidateCode = String(candidate.productCode || "").trim();
    const matches = /^\d+$/.test(requested)
      ? candidateId === requested
      : candidateCode.toUpperCase() === requested.toUpperCase();
    if (!requested || !matches) {
      throw new Error(`页面产品与读取结果不一致（请求 ${requested || "—"}，返回 ${candidateCode || candidateId || "无编号"}）`);
    }
    return candidate;
  }

  function normalizedInstructions(value) {
    return String(value ?? "").replace(/\r\n?/g, "\n").trim();
  }

  function expectedTemplateIdentity() {
    return {
      id: String(template?.id || "").trim(),
      productCode: String(template?.productCode || "").trim(),
      productName: String(template?.productName || "产品").trim() || "产品"
    };
  }

  function assertTemplateRoundTrip(candidate, expected, verificationInstructions, rechargeInstructions) {
    if (!candidate || typeof candidate !== "object") throw new Error("服务器没有返回保存后的产品模板");
    const candidateId = String(candidate.id || "").trim();
    const candidateCode = String(candidate.productCode || "").trim();
    if ((expected.id && candidateId !== expected.id)
        || (expected.productCode && candidateCode !== expected.productCode)) {
      throw new Error("保存后的模板与当前产品不一致，已停止显示成功状态");
    }
    if (normalizedInstructions(candidate.verificationInstructions) !== verificationInstructions
        || normalizedInstructions(candidate.rechargeInstructions) !== rechargeInstructions) {
      throw new Error("文字说明写入后回读不一致，请重新保存");
    }
    return candidate;
  }

  function setTemplateControlsReady(ready) {
    $("chooseProductLogo").disabled = !ready;
    $("verificationReceiptInstructions").disabled = !ready;
    $("rechargeReceiptInstructions").disabled = !ready;
    $("saveProductTemplate").disabled = !ready || localPreviewMode;
    $("toggleProductStatus").disabled = !ready || localPreviewMode;
    $("refreshProductPreview").disabled = !ready;
    document.querySelectorAll("[data-preview-kind]").forEach((button) => { button.disabled = !ready; });
  }

  function formatBytes(value) {
    const bytes = Number(value || 0);
    if (!bytes) return "0 B";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }

  function formatTime(value) {
    return value ? window.AppDateTime.format(value, "未记录") : "未保存";
  }

  function base64Blob(payload) {
    const binary = atob(String(payload?.base64 || ""));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    if (!bytes.length || bytes.length !== Number(payload?.bytes || bytes.length)) throw new Error("LOGO 原图读取不完整");
    return new Blob([bytes], { type: payload?.mimeType || "application/octet-stream" });
  }

  async function fetchLogoBlob(current) {
    if (!current?.logo) return null;
    if (current.logo.url) {
      try {
        const response = await fetch(current.logo.url, { mode: "cors", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        if (!blob.size || !String(blob.type || "").startsWith("image/")) throw new Error("返回内容不是图片");
        if (Number(current.logo.bytes || 0) && blob.size !== Number(current.logo.bytes)) throw new Error("原图大小不一致");
        return blob;
      } catch (_) { /* use the authenticated original-byte fallback below */ }
    }
    return base64Blob(await window.CloudBasePhoneAuth.getProductReceiptLogoData({ productRef: projectRef }));
  }

  function renderLogo() {
    const target = $("productLogoPreview");
    const source = selectedLogo || logoBlob;
    if (!(source instanceof Blob)) {
      target.innerHTML = "<span>LOGO</span>";
    } else {
      const url = URL.createObjectURL(source);
      const image = document.createElement("img");
      image.alt = `${template?.productName || "产品"} LOGO`;
      image.src = url;
      image.addEventListener("load", () => URL.revokeObjectURL(url), { once: true });
      image.addEventListener("error", () => URL.revokeObjectURL(url), { once: true });
      target.replaceChildren(image);
    }
    const meta = selectedLogoMeta || template?.logo;
    $("productLogoMeta").textContent = meta
      ? `${meta.originalName || "LOGO"} · ${formatBytes(meta.bytes)} · ${meta.width} × ${meta.height}`
      : "尚未上传";
    $("uploadProductLogo").disabled = localPreviewMode || !(selectedLogo && selectedLogoMeta);
    $("removeProductLogo").disabled = localPreviewMode || !template?.logo;
  }

  function updateCounts() {
    $("verificationInstructionCount").textContent = $("verificationReceiptInstructions").value.length;
    $("rechargeInstructionCount").textContent = $("rechargeReceiptInstructions").value.length;
  }

  function renderTemplate() {
    $("productTemplateType").textContent = template.productType || "未分类";
    $("productTemplateName").textContent = template.productName || "产品单据模板";
    $("productTemplateMeta").textContent = `${template.productCode || "未编号"} · ${template.productStatus === "ARCHIVED" ? "封存" : "活跃"} · 模板更新：${formatTime(template.updatedAt)}${template.updatedByName ? ` · ${template.updatedByName}` : ""}`;
    const ready = Boolean(template.logo && template.verificationInstructions && template.rechargeInstructions);
    $("productTemplateState").textContent = ready ? "模板已配置" : "模板待配置";
    $("productTemplateState").classList.toggle("is-ready", ready);
    $("toggleProductStatus").textContent = template.productStatus === "ARCHIVED" ? "激活产品" : "封存产品";
    $("verificationReceiptInstructions").value = template.verificationInstructions || "";
    $("rechargeReceiptInstructions").value = template.rechargeInstructions || "";
    setTemplateControlsReady(true);
    updateCounts();
    renderLogo();
  }

  function sampleDocument(kind) {
    const verification = kind.startsWith("verification");
    const productTemplate = {
      productName: template?.productName || "示例产品",
      productType: template?.productType || "产品类别",
      instructions: verification
        ? $("verificationReceiptInstructions").value.trim()
        : $("rechargeReceiptInstructions").value.trim(),
      logoRequired: Boolean(selectedLogo || template?.logo),
      logoBlob: selectedLogo || logoBlob
    };
    const facts = [
      { label: "门店", value: "示例门店" },
      { label: "客户", value: "示例客户" },
      { label: "项目", value: template?.productName || "示例产品" },
      { label: "业务老师", value: "示例老师" }
    ];
    if (verification) facts.push({ label: "提交时间", value: "2026-08-19 12:34:56" });
    return {
      filename: `${template?.productName || "产品"}-${verification ? "核销单" : "充值单"}-样例`,
      kind: verification ? "正常核销 / 体验核销" : "充值 / 退费",
      title: `${verification ? "核销单" : "充值单"} SAMPLE001`,
      subtitle: "门店详细地址：示例省示例市示例区示例路 1 号",
      facts, compactVerification: verification, customerFacing: true,
      detailTitle: "充值信息", detailSubtitle: "充值次数与办理时间",
      details: verification ? [] : [
        { label: "充值次数", value: "10 次" },
        { label: "提交时间", value: "2026-08-19 12:34:56" },
        { label: "审核时间", value: "2026-08-19 12:36:10" }
      ],
      messages: [], productTemplate
    };
  }

  function samplePhotos(kind) {
    if (!kind.startsWith("verification")) return [];
    return ["客户建档照片", "本次核销人脸照", "补充照片 1", "补充照片 2", "补充照片 3"]
      .map((label) => ({ label, required: false, placeholder: "照片区域", meta: "样例照片位" }));
  }

  function clearPreviewUrl() {
    if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = "";
  }

  async function renderPreview() {
    if (!template || !window.OrderExporter) return;
    if (previewBusy) {
      previewQueued = true;
      return;
    }
    previewBusy = true;
    previewQueued = false;
    const previewKind = activePreview;
    $("downloadProductPreview").disabled = true;
    const [title, hint] = previewLabels[previewKind];
    $("productPreviewTitle").textContent = title;
    $("productPreviewHint").textContent = "正在生成高清预览…";
    $("productPreviewFrame").innerHTML = '<div class="product-preview-loading">正在生成…</div>';
    clearPreviewUrl();
    try {
      const options = { documentData: sampleDocument(previewKind), photos: samplePhotos(previewKind) };
      if (previewKind.endsWith("pdf")) {
        const blob = await window.OrderExporter.createOrderPdfBlob(options);
        previewObjectUrl = URL.createObjectURL(blob);
        const frame = document.createElement("iframe");
        frame.title = `${title} 预览`;
        frame.src = `${previewObjectUrl}#toolbar=0&navpanes=0&view=FitH`;
        $("productPreviewFrame").replaceChildren(frame);
      } else {
        const canvas = await window.OrderExporter.renderOrderCanvas({ ...options, paginate: false });
        canvas.setAttribute("aria-label", `${title} 预览`);
        $("productPreviewFrame").replaceChildren(canvas);
      }
      $("productPreviewHint").textContent = hint;
      $("downloadProductPreview").disabled = false;
    } catch (error) {
      $("productPreviewHint").textContent = error?.message || "预览生成失败";
      $("productPreviewFrame").innerHTML = '<div class="product-preview-loading is-error">预览生成失败</div>';
    } finally {
      previewBusy = false;
      if (previewQueued) void renderPreview();
    }
  }

  async function downloadPreview() {
    if (!template || previewBusy) return;
    const pdf = activePreview.endsWith("pdf");
    const options = { documentData: sampleDocument(activePreview), photos: samplePhotos(activePreview) };
    $("downloadProductPreview").disabled = true;
    try {
      const blob = pdf
        ? await window.OrderExporter.createOrderPdfBlob(options)
        : await window.OrderExporter.createOrderImageBlob(options);
      const filename = `${window.OrderExporter.safeFilename(options.documentData.filename)}.${pdf ? "pdf" : "jpg"}`;
      window.OrderExporter.downloadBlob(blob, filename);
      $("productPreviewHint").textContent = `已下载 ${filename}`;
    } catch (error) {
      $("productPreviewHint").textContent = error?.message || "样例下载失败";
    } finally {
      $("downloadProductPreview").disabled = false;
    }
  }

  function imageDimensions(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const image = new Image();
      image.addEventListener("load", () => { const result = { width: image.naturalWidth, height: image.naturalHeight }; URL.revokeObjectURL(url); resolve(result); }, { once: true });
      image.addEventListener("error", () => { URL.revokeObjectURL(url); reject(new Error("无法读取 LOGO 图片")); }, { once: true });
      image.src = url;
    });
  }

  async function selectLogo(file) {
    if (!file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) throw new Error("仅支持 PNG、JPEG 或 WebP");
    if (file.size < 8 || file.size > 8 * 1024 * 1024) throw new Error("LOGO 原图必须小于 8 MB");
    const dimensions = await imageDimensions(file);
    if (!dimensions.width || !dimensions.height || dimensions.width > 12000 || dimensions.height > 12000) throw new Error("LOGO 图片尺寸无效");
    selectedLogo = file;
    selectedLogoMeta = { originalName: file.name, mimeType: file.type, bytes: file.size, ...dimensions };
    renderLogo();
    setMessage("已选择原图，点击“上传并保存”。");
    void renderPreview();
  }

  function uploadToSignedUrl(upload, file) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(upload.method || "PUT", upload.url, true);
      xhr.timeout = 180000;
      xhr.setRequestHeader("Content-Type", upload.contentType || file.type);
      xhr.upload.addEventListener("progress", (event) => { if (event.lengthComputable) $("productLogoProgress").value = Math.round(event.loaded / event.total * 100); });
      xhr.addEventListener("load", () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`LOGO 上传失败（HTTP ${xhr.status}）`)));
      xhr.addEventListener("error", () => reject(new Error("LOGO 网络上传失败，请检查 CloudBase 存储 CORS 配置")));
      xhr.addEventListener("timeout", () => reject(new Error("LOGO 上传超时，请重试")));
      xhr.send(file);
    });
  }

  function originalFileDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => {
        const value = String(reader.result || "");
        if (!value.startsWith(`data:${file.type};base64,`)) reject(new Error("无法读取 LOGO 原图字节"));
        else resolve(value);
      }, { once: true });
      reader.addEventListener("error", () => reject(new Error("无法读取 LOGO 原图字节")), { once: true });
      reader.readAsDataURL(file);
    });
  }

  async function uploadLogoByFunction(input, file, reason) {
    if (file.size > 3 * 1024 * 1024) {
      throw new Error(`${reason?.message || "签名直传不可用"}；当前安全备用通道支持不超过 3 MB 的原图`);
    }
    if (!window.CloudBasePhoneAuth?.uploadProductLogoByFunction) {
      throw reason || new Error("产品 LOGO 安全备用上传服务尚未加载");
    }
    setMessage("签名直传不可用，正在通过安全备用通道上传原图…");
    const imageBase64 = await originalFileDataUrl(file);
    return window.CloudBasePhoneAuth.uploadProductLogoByFunction({ ...input, imageBase64 });
  }

  async function discardUnboundLogo(productRef, reference) {
    if (!reference || !window.CloudBasePhoneAuth?.discardProductLogoUpload) return;
    try { await window.CloudBasePhoneAuth.discardProductLogoUpload({ productRef, reference }); }
    catch (_) { /* cleanup is best-effort; preserve the original upload error */ }
  }

  async function uploadLogo() {
    if (localPreviewMode) {
      setMessage("本地预览模式不会上传或修改腾讯云数据。", "success");
      return;
    }
    if (!selectedLogo || !selectedLogoMeta) return;
    $("uploadProductLogo").disabled = true;
    $("chooseProductLogo").disabled = true;
    $("productLogoProgress").hidden = false;
    $("productLogoProgress").value = 0;
    setMessage("正在取得私有存储上传地址…");
    let unboundReference = "";
    let unboundProductRef = "";
    try {
      const input = { productRef: currentProductRef(), ...selectedLogoMeta };
      let uploadMode = "SIGNED";
      let signedStage = "BEGIN";
      try {
        const pending = await window.CloudBasePhoneAuth.beginProductLogoUpload(input);
        unboundReference = pending.reference;
        unboundProductRef = input.productRef;
        signedStage = "UPLOAD";
        setMessage("正在上传 LOGO 原图，请勿关闭页面…");
        await uploadToSignedUrl(pending.upload, selectedLogo);
        signedStage = "CONFIRM";
        setMessage("上传完成，正在由服务器核对原图…");
        template = await window.CloudBasePhoneAuth.confirmProductLogoUpload({ ...input, reference: pending.reference });
        unboundReference = "";
      } catch (error) {
        const canUseFunctionFallback = error?.code === "PRODUCT_LOGO_UPLOAD_SIGN_FAILED" || signedStage === "UPLOAD";
        if (!canUseFunctionFallback) throw error;
        await discardUnboundLogo(unboundProductRef, unboundReference);
        unboundReference = "";
        uploadMode = "FUNCTION";
        template = await uploadLogoByFunction(input, selectedLogo, error);
      }
      selectedLogo = null;
      selectedLogoMeta = null;
      logoBlob = await fetchLogoBlob(template);
      if (!(logoBlob instanceof Blob) || logoBlob.size !== Number(template.logo?.bytes || 0)) throw new Error("LOGO 已保存，但回读校验失败");
      renderTemplate();
      setMessage(uploadMode === "FUNCTION"
        ? "LOGO 原图已通过安全备用通道上传、回读核对并保存。"
        : "LOGO 原图已上传、回读核对并保存。", "success");
      void renderPreview();
    } catch (error) {
      await discardUnboundLogo(unboundProductRef, unboundReference);
      setMessage(error?.message || "LOGO 上传失败", "error");
      renderLogo();
    } finally {
      $("chooseProductLogo").disabled = false;
      $("productLogoProgress").hidden = true;
    }
  }

  async function saveInstructions() {
    if (localPreviewMode) {
      setMessage("本地预览模式不会上传或修改腾讯云数据。", "success");
      return;
    }
    $("saveProductTemplate").disabled = true;
    $("verificationReceiptInstructions").disabled = true;
    $("rechargeReceiptInstructions").disabled = true;
    setMessage("正在保存两组文字说明…");
    try {
      const expected = expectedTemplateIdentity();
      const productRef = currentProductRef();
      const verificationInstructions = normalizedInstructions($("verificationReceiptInstructions").value);
      const rechargeInstructions = normalizedInstructions($("rechargeReceiptInstructions").value);
      const saved = await window.CloudBasePhoneAuth.saveProductReceiptTemplate({
        productRef,
        verificationInstructions,
        rechargeInstructions
      });
      assertTemplateRoundTrip(saved, expected, verificationInstructions, rechargeInstructions);
      const reread = await window.CloudBasePhoneAuth.getProductReceiptTemplate({ productRef });
      template = assertTemplateRoundTrip(reread, expected, verificationInstructions, rechargeInstructions);
      renderTemplate();
      setMessage(`${expected.productName}${expected.productCode ? `（${expected.productCode}）` : ""}的两组文字说明已保存并从数据库复核。`, "success");
      void renderPreview();
    } catch (error) {
      setMessage(error?.message || "文字说明保存失败", "error");
    } finally {
      $("saveProductTemplate").disabled = localPreviewMode;
      $("verificationReceiptInstructions").disabled = false;
      $("rechargeReceiptInstructions").disabled = false;
    }
  }

  async function removeLogo() {
    if (localPreviewMode) {
      setMessage("本地预览模式不会上传或修改腾讯云数据。", "success");
      return;
    }
    if (!template?.logo || !window.confirm("确定移除该产品的共用 LOGO 吗？")) return;
    $("removeProductLogo").disabled = true;
    setMessage("正在移除产品 LOGO…");
    try {
      template = await window.CloudBasePhoneAuth.removeProductReceiptLogo({ productRef: currentProductRef() });
      logoBlob = null;
      selectedLogo = null;
      selectedLogoMeta = null;
      renderTemplate();
      setMessage("产品 LOGO 已移除。", "success");
      void renderPreview();
    } catch (error) {
      setMessage(error?.message || "产品 LOGO 移除失败", "error");
    }
  }

  async function toggleStatus() {
    if (localPreviewMode) {
      setMessage("本地预览模式不会上传或修改腾讯云数据。", "success");
      return;
    }
    if (!template) {
      setMessage("产品模板尚未读取完成，请刷新页面重试", "error");
      return;
    }
    const next = template.productStatus === "ARCHIVED" ? "ACTIVE" : "ARCHIVED";
    $("toggleProductStatus").disabled = true;
    try {
      await window.CloudBasePhoneAuth.setProductStatus({ productRef: currentProductRef(), status: next });
      template.productStatus = next;
      renderTemplate();
      setMessage(next === "ARCHIVED" ? "产品已封存，历史单据和模板继续保留。" : "产品已激活。", "success");
    } catch (error) {
      setMessage(error?.message || "产品状态更新失败", "error");
    } finally {
      $("toggleProductStatus").disabled = localPreviewMode;
    }
  }

  async function loadTemplate() {
    if (!projectRef) throw new Error("缺少产品编号");
    if (localPreviewMode) {
      template = {
        id: projectRef, productCode: projectRef, productName: "海洋之蕴",
        productType: "皮肤护理", productStatus: "ACTIVE", logo: null,
        verificationInstructions: "使用前请向门店工作人员确认服务内容；本单据由系统自动生成。",
        rechargeInstructions: "充值及退费次数以审核完成后的系统记录为准；请妥善保存本单据。",
        updatedAt: new Date().toISOString(), updatedByName: "本地预览"
      };
      logoBlob = null;
      renderTemplate();
      setMessage("本地预览模式：仅验证排版，不会写入腾讯云。", "success");
      await renderPreview();
      return;
    }
    if (!window.CloudBasePhoneAuth?.getProductReceiptTemplate) throw new Error("产品模板服务尚未加载");
    template = assertUrlProduct(await window.CloudBasePhoneAuth.getProductReceiptTemplate({ productRef: projectRef }));
    if (!template) throw new Error("未找到该产品");
    logoBlob = await fetchLogoBlob(template);
    renderTemplate();
    setMessage(new URLSearchParams(location.search).get("created") === "1" ? "产品已创建，请继续配置 LOGO 和两组单据说明。" : "模板读取完成。", "success");
    await renderPreview();
  }

  document.querySelectorAll("[data-preview-kind]").forEach((button) => button.addEventListener("click", () => {
    activePreview = button.dataset.previewKind;
    document.querySelectorAll("[data-preview-kind]").forEach((item) => item.classList.toggle("active", item === button));
    void renderPreview();
  }));
  $("chooseProductLogo").addEventListener("click", () => $("productLogoFile").click());
  $("productLogoFile").addEventListener("change", (event) => selectLogo(event.target.files?.[0]).catch((error) => setMessage(error.message, "error")));
  $("uploadProductLogo").addEventListener("click", uploadLogo);
  $("removeProductLogo").addEventListener("click", removeLogo);
  $("saveProductTemplate").addEventListener("click", saveInstructions);
  $("toggleProductStatus").addEventListener("click", toggleStatus);
  $("refreshProductPreview").addEventListener("click", renderPreview);
  $("downloadProductPreview").addEventListener("click", downloadPreview);
  ["verificationReceiptInstructions", "rechargeReceiptInstructions"].forEach((id) => $(id).addEventListener("input", updateCounts));
  window.addEventListener("beforeunload", clearPreviewUrl);

  loadTemplate().catch((error) => {
    setTemplateControlsReady(false);
    $("productTemplateName").textContent = "模板读取失败";
    $("productTemplateMeta").textContent = error?.message || "请刷新页面重试";
    $("productTemplateState").textContent = "读取失败";
    $("productPreviewHint").textContent = "产品模板读取失败";
    $("productPreviewFrame").innerHTML = '<div class="product-preview-loading is-error">请刷新页面重试</div>';
    setMessage(error?.message || "模板读取失败", "error");
  });
})();
