(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
  const MAX_PDF_BYTES = 100 * 1024 * 1024;
  let materials = [];
  let busy = false;

  function requestId() {
    const random = window.crypto?.getRandomValues ? Array.from(window.crypto.getRandomValues(new Uint32Array(3)), (value) => value.toString(36)).join("") : Math.random().toString(36).slice(2);
    return `training-${Date.now().toString(36)}-${random}`.slice(0, 64);
  }

  function readableBytes(value) {
    const bytes = Number(value || 0);
    return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
  }

  function readableDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ""));
    return match ? `${match[1]}-${match[2]}-${match[3]}` : "—";
  }

  function setMessage(message = "", isError = false) {
    $("trainingMessage").textContent = message;
    $("trainingMessage").classList.toggle("error", Boolean(message && isError));
  }

  function render() {
    $("trainingCount").textContent = `${materials.length} 份`;
    if (!materials.length) {
      $("trainingList").innerHTML = "";
      $("trainingList").classList.add("is-empty");
      return;
    }
    $("trainingList").classList.remove("is-empty");
    $("trainingList").innerHTML = materials.map((material) => {
      return `<article class="training-row">
        <div class="training-row-main"><strong class="training-row-title">${escapeHtml(material.title)}</strong><span class="training-row-meta">${escapeHtml(readableDate(material.publishedAt || material.createdAt))} · ${escapeHtml(readableBytes(material.bytes))}</span></div>
        <div class="training-row-actions"><button class="training-read" type="button" data-read-id="${escapeHtml(material.id)}" ${material.status === "ARCHIVED" ? "disabled" : ""}>${material.status === "ARCHIVED" ? "待清理" : "阅读全文"}</button><button class="training-status" type="button" data-status-id="${escapeHtml(material.id)}">删除</button></div>
      </article>`;
    }).join("");
  }

  async function loadMaterials() {
    setMessage("");
    $("trainingList").classList.remove("is-empty");
    $("trainingList").innerHTML = '<div class="training-empty">正在读取培训资料…</div>';
    try {
      const result = await window.CloudBasePhoneAuth.listTrainingMaterials({ keyword: $("trainingKeyword").value.trim() });
      materials = result.materials || [];
      render();
    } catch (error) {
      materials = [];
      render();
      setMessage(error?.message || "培训资料读取失败", true);
    }
  }

  function uploadToSignedUrl(upload, file) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(upload.method || "PUT", upload.url, true);
      xhr.timeout = 180000;
      Object.entries(upload.headers || {}).forEach(([name, value]) => xhr.setRequestHeader(name, value));
      xhr.setRequestHeader("Content-Type", "application/pdf");
      xhr.upload.addEventListener("progress", (event) => { if (event.lengthComputable) $("trainingUploadProgress").value = Math.round(event.loaded / event.total * 100); });
      xhr.addEventListener("load", () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`PDF 上传失败（HTTP ${xhr.status}）`)));
      xhr.addEventListener("error", () => reject(new Error("PDF 上传失败，请检查网络")));
      xhr.addEventListener("timeout", () => reject(new Error("PDF 上传超时，请重试")));
      xhr.send(file);
    });
  }

  async function uploadMaterial(event) {
    event.preventDefault();
    if (busy) return;
    const title = $("trainingTitle").value.trim();
    const file = $("trainingFile").files?.[0];
    if (!title || !file) return;
    if (!/\.pdf$/i.test(file.name) || (file.type && !["application/pdf", "application/octet-stream"].includes(file.type))) return setMessage("请选择 PDF 文件", true);
    if (file.size < 8 || file.size > MAX_PDF_BYTES) return setMessage("PDF 不能超过 100 MB", true);
    const clientRequestId = requestId();
    const input = { clientRequestId, title, category: "", originalName: file.name, mimeType: "application/pdf", bytes: file.size };
    busy = true;
    $("trainingUploadButton").disabled = true;
    $("trainingUploadProgress").hidden = false;
    $("trainingUploadProgress").value = 0;
    setMessage("正在上传…");
    let reference = "";
    try {
      const pending = await window.CloudBasePhoneAuth.beginTrainingMaterialUpload(input);
      reference = pending.reference;
      await uploadToSignedUrl(pending.upload, file);
      await window.CloudBasePhoneAuth.confirmTrainingMaterialUpload({ ...input, reference });
      $("trainingUploadForm").reset();
      $("trainingFilePicker").textContent = "选择 PDF";
      await loadMaterials();
      setMessage("资料已发布。");
    } catch (error) {
      if (reference) await window.CloudBasePhoneAuth.discardTrainingMaterialUpload({ reference }).catch(() => {});
      setMessage(error?.message || "PDF 上传失败", true);
    } finally {
      busy = false;
      $("trainingUploadButton").disabled = false;
      $("trainingUploadProgress").hidden = true;
    }
  }

  async function handleListAction(event) {
    const readButton = event.target.closest("[data-read-id]");
    const statusButton = event.target.closest("[data-status-id]");
    if (readButton) {
      const pdfWindow = window.open("about:blank", "_blank");
      if (!pdfWindow) return setMessage("浏览器拦截了 PDF 页面，请允许弹出窗口后重试", true);
      pdfWindow.opener = null;
      readButton.disabled = true;
      try {
        const result = await window.CloudBasePhoneAuth.getTrainingMaterialAccess({ materialId: readButton.dataset.readId });
        const url = String(result.access?.url || "");
        if (!/^https:\/\//i.test(url)) throw new Error("没有取得有效的 PDF 阅读地址");
        pdfWindow.location.replace(url);
      } catch (error) {
        pdfWindow.close();
        setMessage(error?.message || "PDF 打开失败", true);
      } finally { readButton.disabled = false; }
      return;
    }
    if (!statusButton || busy) return;
    const material = materials.find((item) => String(item.id) === statusButton.dataset.statusId);
    if (!material || !window.confirm(`确定删除《${material.title}》？云端 PDF 和资料记录将一起删除，无法恢复。`)) return;
    busy = true;
    statusButton.disabled = true;
    try {
      const id = String(material.id);
      const result = await window.CloudBasePhoneAuth.setTrainingMaterialStatus({ materialId: id, status: "ARCHIVED", confirmDeletion: true });
      if (String(result.material?.id) !== id || result.material?.deleted !== true) throw new Error("删除结果未确认，请重试");
      materials = materials.filter((item) => String(item.id) !== id);
      render();
      setMessage("资料已删除。");
    } catch (error) {
      await loadMaterials();
      setMessage(error?.message || "删除失败", true);
    } finally { busy = false; statusButton.disabled = false; }
  }

  $("trainingUploadForm").addEventListener("submit", uploadMaterial);
  $("trainingFile").addEventListener("change", () => {
    const file = $("trainingFile").files?.[0];
    $("trainingFilePicker").textContent = file?.name || "选择 PDF";
  });
  $("trainingSearchForm").addEventListener("submit", (event) => { event.preventDefault(); void loadMaterials(); });
  $("trainingList").addEventListener("click", handleListAction);
  void loadMaterials();
})();
