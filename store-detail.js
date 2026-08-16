(() => {
  "use strict";

  const VERSION = "0.14.21";
  const params = new URLSearchParams(location.search);
  const storeRef = String(params.get("authUid") || params.get("storeId") || "").trim();
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"
  })[char]);
  const info = (items) => items.map(([label, value]) =>
    `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`
  ).join("");

  function renderEmptyRows(message = "暂无业务数据") {
    ["storeProjectBody", "storeTeacherBody", "storeCustomerBody"].forEach((target) => {
      if ($(target)) $(target).innerHTML = `<tr><td colspan="8" class="query-empty">${escapeHtml(message)}</td></tr>`;
    });
    if ($("storeCustomerCount")) $("storeCustomerCount").textContent = "0位客户";
  }

  function renderError(message) {
    $("storeHero").innerHTML = `<div><span class="profile-type">门店详情</span><h2>无法读取门店</h2><p>${escapeHtml(message)}</p></div>`;
    $("storeBasicGrid").innerHTML = "";
    $("storeAccountInfo").innerHTML = "";
    $("storeAuditTimeline").innerHTML = `<p class="query-empty">暂无操作记录</p>`;
    renderEmptyRows("暂无数据");
  }

  function renderStore(store) {
    const authUid = String(store.auth_uid || "").trim();
    const storeCode = String(store.store_code || "").trim();
    const status = store.store_status === "ARCHIVED" ? "封存" : "活跃";
    const locationText = [store.province, store.city, store.district].filter(Boolean).join(" · ") || "未填写";
    const contactName = String(store.contact_name || "").trim() || "未填写";
    const contactPhone = String(store.contact_phone || "").trim() || "未填写";

    $("storeHero").innerHTML = `<div class="profile-avatar store-profile-avatar">店</div><div><span class="profile-type">门店账号</span><h2>${escapeHtml(store.store_name)}</h2><p>${escapeHtml(authUid)} · ${escapeHtml(status)}</p></div>`;
    $("storeBasicGrid").innerHTML = info([
      ["唯一身份 ID", authUid],
      ["业务编号", storeCode],
      ["门店名称", store.store_name],
      ["地区", locationText],
      ["详细地址", store.address_detail || "未填写"],
      ["门店状态", status]
    ]);
    $("storeAccountInfo").innerHTML = info([
      ["唯一身份 ID", authUid],
      ["登录联系人", contactName],
      ["登录手机号", contactPhone],
      ["账号状态", status]
    ]);
    $("storeAuditTimeline").innerHTML = `<p class="query-empty">暂无操作记录</p>`;
    renderEmptyRows();
  }

  async function load() {
    document.documentElement.dataset.prototypeVersion = VERSION;
    if (!storeRef) {
      renderError("缺少门店唯一身份 ID。");
      return;
    }
    if (!window.CloudBasePhoneAuth?.listStores) {
      renderError("门店数据库服务尚未加载，请刷新页面后重试。");
      return;
    }
    try {
      const stores = await window.CloudBasePhoneAuth.listStores();
      const store = stores.find((item) => [item.auth_uid, item.id, item.store_code]
        .map((value) => String(value || "").trim()).includes(storeRef));
      if (!store) {
        renderError("未找到该门店账号，或门店尚未绑定有效认证身份。");
        return;
      }
      renderStore(store);
    } catch (error) {
      renderError(error?.message || "门店资料读取失败，请稍后重试。");
    }
  }

  void load();
})();
