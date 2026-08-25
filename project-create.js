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

    if (!productName || !productType) {
      message.textContent = "请填写项目名称和项目类别";
      return;
    }
    if (!window.CloudBasePhoneAuth?.createProduct) {
      message.textContent = "项目数据库服务尚未加载，请刷新页面后重试";
      return;
    }

    submit.disabled = true;
    message.textContent = "正在写入项目数据库…";
    try {
      const result = await window.CloudBasePhoneAuth.createProduct({
        productName,
        productType,
        description,
        clientRequestId: pendingRequestId()
      });
      const productCode = String(result?.product?.product_code || "").trim();
      if (!productCode) throw new Error("项目已写入，但服务未返回项目编号");
      sessionStorage.removeItem(pendingRequestKey);
      location.href = `project-detail.html?projectId=${encodeURIComponent(productCode)}&created=1`;
    } catch (error) {
      if (error?.code === "IDEMPOTENCY_CONFLICT") {
        sessionStorage.removeItem(pendingRequestKey);
        message.textContent = "创建内容已经改变，请再次点击“创建项目”。";
      } else {
        message.textContent = error?.message || "项目创建失败，请稍后重试";
      }
    } finally {
      submit.disabled = false;
    }
  }

  $("projectCreateForm").addEventListener("submit", submitProject);
})();
