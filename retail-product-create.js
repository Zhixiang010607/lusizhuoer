(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const PENDING_KEY = "pendingRetailProductCreateRequestId";

  function createRequestId() {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
    return `retail_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
  }

  function pendingRequestId() {
    let requestId = sessionStorage.getItem(PENDING_KEY) || "";
    if (!requestId) {
      requestId = createRequestId();
      sessionStorage.setItem(PENDING_KEY, requestId);
    }
    return requestId;
  }

  async function submitProduct(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = form.querySelector('[type="submit"]');
    const message = $("retailProductCreateMessage");
    const productName = $("retailProductCreateName").value.trim();
    if (!productName) {
      message.textContent = "请填写产品名称。";
      return;
    }
    if (!window.CloudBasePhoneAuth?.createRetailProduct) {
      message.textContent = "产品数据库服务尚未加载，请刷新页面后重试。";
      return;
    }

    submit.disabled = true;
    message.textContent = "正在写入产品数据库…";
    try {
      const result = await window.CloudBasePhoneAuth.createRetailProduct({
        productName,
        clientRequestId: pendingRequestId()
      });
      const productCode = String(result?.product?.product_code || "").trim();
      if (!productCode) throw new Error("产品已写入，但数据库没有返回产品编号");
      sessionStorage.removeItem(PENDING_KEY);
      location.href = `retail-product-management.html?created=${encodeURIComponent(productCode)}`;
    } catch (error) {
      if (error?.code === "IDEMPOTENCY_CONFLICT") {
        sessionStorage.removeItem(PENDING_KEY);
        message.textContent = "创建内容已经改变，请再次点击“创建产品”。";
      } else {
        message.textContent = error?.message || "产品创建失败，请稍后重试。";
      }
    } finally {
      submit.disabled = false;
    }
  }

  $("retailProductCreateForm").addEventListener("submit", submitProduct);
})();
