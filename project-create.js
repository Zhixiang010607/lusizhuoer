(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const pendingRequestKey = "pendingProductCreateRequestId";

  function createRequestId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `product_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
  }

  function pendingRequestId() {
    let requestId = sessionStorage.getItem(pendingRequestKey) || "";
    if (!requestId) {
      requestId = createRequestId();
      sessionStorage.setItem(pendingRequestKey, requestId);
    }
    return requestId;
  }

  async function submitProject(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('[type="submit"]');
    const message = $("projectCreateMessage");
    const productName = $("projectCreateName").value.trim();
    const productType = $("projectCreateType").value.trim();
    const description = $("projectCreateDescription").value.trim();

    if (!productName || !productType || !description) {
      message.textContent = "请完整填写产品名称、产品类别和产品介绍";
      return;
    }
    if (!window.CloudBasePhoneAuth?.createProduct) {
      message.textContent = "产品数据库服务尚未加载，请刷新页面后重试";
      return;
    }

    submit.disabled = true;
    message.textContent = "正在写入产品数据库…";
    try {
      const result = await window.CloudBasePhoneAuth.createProduct({
        productName,
        productType,
        description,
        clientRequestId: pendingRequestId()
      });
      const productCode = String(result?.product?.product_code || "").trim();
      if (!productCode) throw new Error("产品已写入，但服务未返回产品编号");
      sessionStorage.removeItem(pendingRequestKey);
      location.href = `project-management.html?created=${encodeURIComponent(productCode)}`;
    } catch (error) {
      if (error?.code === "IDEMPOTENCY_CONFLICT") {
        sessionStorage.removeItem(pendingRequestKey);
        message.textContent = "创建内容已经改变，请再次点击“创建产品”。";
      } else {
        message.textContent = error?.message || "产品创建失败，请稍后重试";
      }
    } finally {
      submit.disabled = false;
    }
  }

  $("generatedProjectCode").textContent = "产品编号由数据库自动生成";
  $("projectCreateForm").addEventListener("submit", submitProject);
})();
