(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>\"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"
  })[char]);
  let products = [];
  let loading = false;

  function setMessage(message = "", isError = false) {
    const node = $("retailProductMessage");
    node.textContent = message;
    node.classList.toggle("error", Boolean(message && isError));
  }

  function productView(item) {
    const status = String(item?.product_status || "").toUpperCase() === "ARCHIVED" ? "ARCHIVED" : "ACTIVE";
    return {
      id: String(item?.id || "").trim(),
      ref: String(item?.product_code || item?.id || "").trim(),
      code: String(item?.product_code || "").trim(),
      name: String(item?.product_name || "").trim(),
      status
    };
  }

  function render() {
    $("retailProductCount").textContent = `${products.length} 个产品`;
    if (!products.length) {
      $("retailProductBody").innerHTML = `<tr><td colspan="4" class="query-empty">${loading ? "正在读取产品数据…" : "暂无产品，请先新增产品。"}</td></tr>`;
      return;
    }
    $("retailProductBody").innerHTML = products.map((product) => {
      const archived = product.status === "ARCHIVED";
      return `<tr>
        <td><strong>${escapeHtml(product.name)}</strong></td>
        <td>${escapeHtml(product.code)}</td>
        <td><span class="retail-product-status ${archived ? "archived" : "active"}">${archived ? "封存" : "活跃"}</span></td>
        <td><button class="secondary retail-product-status-button ${archived ? "" : "danger-button"}" type="button" data-product-ref="${escapeHtml(product.ref)}" data-next-status="${archived ? "ACTIVE" : "ARCHIVED"}">${archived ? "重新激活" : "封存产品"}</button></td>
      </tr>`;
    }).join("");
  }

  async function loadProducts(options = {}) {
    if (loading) return;
    if (!window.CloudBasePhoneAuth?.listRetailProducts) {
      setMessage("产品数据库服务尚未加载，请刷新页面后重试。", true);
      return;
    }
    loading = true;
    products = [];
    render();
    try {
      const records = await window.CloudBasePhoneAuth.listRetailProducts();
      products = records.map(productView).filter((item) => item.ref && item.name && item.code);
      if (!options.keepMessage) setMessage("");
    } catch (error) {
      setMessage(error?.message || "产品数据库读取失败，请刷新页面后重试。", true);
    } finally {
      loading = false;
      render();
    }
  }

  async function toggleStatus(event) {
    const button = event.target.closest("[data-product-ref]");
    if (!button || button.disabled) return;
    const productRef = button.dataset.productRef || "";
    const status = button.dataset.nextStatus || "";
    const product = products.find((item) => item.ref === productRef);
    if (!product) return;
    const action = status === "ARCHIVED" ? "封存" : "重新激活";
    if (!window.confirm(`确认${action}产品“${product.name}”（${product.code}）？`)) return;
    button.disabled = true;
    setMessage(`正在${action}产品…`);
    try {
      await window.CloudBasePhoneAuth.setRetailProductStatus({ productRef, status });
      setMessage(`产品已${status === "ARCHIVED" ? "封存" : "重新激活"}。`);
      await loadProducts({ keepMessage: true });
    } catch (error) {
      setMessage(error?.message || `产品${action}失败，请稍后重试。`, true);
      button.disabled = false;
    }
  }

  $("retailProductBody").addEventListener("click", toggleStatus);
  const createdCode = new URLSearchParams(location.search).get("created") || "";
  if (createdCode) {
    setMessage(`产品 ${createdCode} 已新增。`);
    history.replaceState({}, "", "retail-product-management.html");
  }
  loadProducts({ keepMessage: Boolean(createdCode) });
})();
