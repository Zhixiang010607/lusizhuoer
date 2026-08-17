(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const projectRef = new URLSearchParams(location.search).get("projectId") || "";
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);

  function emptyTable(target, colspan, message = "暂无真实业务数据") {
    $(target).innerHTML = `<tr><td colspan="${colspan}" class="query-empty">${escapeHtml(message)}</td></tr>`;
  }

  function formatTimestamp(value) {
    return window.AppDateTime.format(value, "未记录");
  }

  function renderMissing(message) {
    $("projectHero").innerHTML = `<div><span class="profile-type">产品详情</span><h2>未找到产品</h2><p>${escapeHtml(message)}</p></div>`;
    $("projectBasicGrid").innerHTML = "";
    emptyTable("projectStoreBody", 4);
    emptyTable("projectTeacherBody", 2);
  }

  function renderProduct(product) {
    const code = String(product.product_code || "");
    const status = product.product_status === "ARCHIVED" ? "封存" : "活跃";
    $("projectHero").innerHTML = `<div class="profile-avatar project-profile-avatar">产</div><div><span class="profile-type">产品编号</span><h2>${escapeHtml(product.product_name)}</h2><p>${escapeHtml(code)} · ${escapeHtml(status)}</p></div>`;
    const fields = [
      ["产品编号", code],
      ["产品名称", product.product_name],
      ["产品类别", product.product_type || "未填写"],
      ["产品介绍", product.description || "未填写"],
      ["状态", status],
      ["创建时间", formatTimestamp(product.created_at)],
      ["最后更新时间", formatTimestamp(product.updated_at)]
    ];
    $("projectBasicGrid").innerHTML = fields.map(([key, value]) => `<article><span>${key}</span><strong>${escapeHtml(value)}</strong></article>`).join("");
    emptyTable("projectStoreBody", 4, "该产品当前没有真实充值或核销数据");
    emptyTable("projectTeacherBody", 2, "该产品当前没有真实老师核销数据");
  }

  async function loadProduct() {
    if (!projectRef) {
      renderMissing("缺少产品编号。");
      return;
    }
    if (!window.CloudBasePhoneAuth?.listProducts) {
      renderMissing("产品数据库服务尚未加载，请刷新页面后重试。");
      return;
    }
    $("projectHero").innerHTML = `<div><span class="profile-type">产品详情</span><h2>正在读取产品…</h2><p>正在从腾讯云数据库加载</p></div>`;
    try {
      const products = await window.CloudBasePhoneAuth.listProducts();
      const product = products.find((item) => String(item.product_code) === projectRef || String(item.id) === projectRef);
      if (!product) {
        renderMissing("该产品不存在，或当前账号无权查看。");
        return;
      }
      renderProduct(product);
    } catch (error) {
      renderMissing(error?.message || "产品资料读取失败，请稍后重试。");
    }
  }

  $("storePeriod").addEventListener("change", () => emptyTable("projectStoreBody", 4, "该产品当前没有真实充值或核销数据"));
  $("teacherPeriod").addEventListener("change", () => emptyTable("projectTeacherBody", 2, "该产品当前没有真实老师核销数据"));
  void loadProduct();
})();
