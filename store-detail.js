(() => {
  "use strict";

  const VERSION = "0.16.1";
  const CUSTOMER_PAGE_SIZE = 10;
  const params = new URLSearchParams(location.search);
  const storeRef = String(params.get("authUid") || params.get("storeId") || "").trim();
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"
  })[char]);
  const info = (items) => items.map(([label, value]) =>
    `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`
  ).join("");
  const analyticsMetrics = Object.freeze([
    { key: "recharge", label: "充值" },
    { key: "verification", label: "核销" },
    { key: "experience", label: "体验" },
    { key: "refund", label: "退费" }
  ]);
  const state = {
    customerRows: [], customerPage: 1, customerTotal: 0,
    dashboardStoreId: "", analytics: null, analyticsLoading: false,
    storeAccount: null, currentStore: null, sessionRole: ""
  };

  function parsedObject(value) {
    if (value && typeof value === "object") return value;
    if (typeof value !== "string") return null;
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" ? parsed : null; } catch (_) { return null; }
  }

  function cloudFunctionData(result) {
    return [result?.result, result?.data?.result, result?.data, result]
      .map(parsedObject)
      .find((candidate) => candidate && (
        Object.prototype.hasOwnProperty.call(candidate, "ok") ||
        Object.prototype.hasOwnProperty.call(candidate, "message") ||
        Object.prototype.hasOwnProperty.call(candidate, "code")
      )) || {};
  }

  function registerCloudBaseComponent(register, componentName) {
    if (typeof register !== "function") return;
    try { register(window.cloudbase); }
    catch (error) {
      const detail = String(error?.message || error || "").toLowerCase();
      if (!(detail.includes("duplicate component") && detail.includes(componentName))) throw error;
    }
  }

  async function loadCurrentStoreDashboard(customerPage = 1, storeId = "") {
    if (!window.cloudbase || !window.CloudBaseAuthConfig || !window.registerFunctions) {
      throw new Error("门店首页数据库组件尚未加载，请刷新页面后重试。");
    }
    registerCloudBaseComponent(window.registerAuth, "auth");
    registerCloudBaseComponent(window.registerFunctions, "functions");
    const request = { action: "getStoreDashboard", customerPage };
    if (storeId) request.storeId = String(storeId);
    const result = await window.cloudbase.init(window.CloudBaseAuthConfig).callFunction({
      name: "faceRecognition",
      data: request
    });
    const data = cloudFunctionData(result);
    if (!data.ok || !data.store) throw new Error(data.message || "门店首页数据库没有返回有效数据。");
    return data.store;
  }

  function firstValue(object, keys, fallback = "—") {
    for (const key of keys) {
      const value = object?.[key];
      if (value !== undefined && value !== null && String(value).trim() !== "") return value;
    }
    return fallback;
  }

  function formatBirthday(value) {
    const text = String(value || "").slice(0, 10);
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? `${match[1]}年${match[2]}月${match[3]}日` : (text || "—");
  }

  function renderPager(targetId, total, page, pageSize, dataPage) {
    const target = $(targetId);
    if (!target) return;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    if (total <= pageSize) {
      target.innerHTML = "";
      return;
    }
    target.innerHTML = `<button type="button" data-page-target="${dataPage}" data-page="${page - 1}" ${page <= 1 ? "disabled" : ""}>上一页</button><span>第 ${page} / ${pages} 页</span><button type="button" data-page-target="${dataPage}" data-page="${page + 1}" ${page >= pages ? "disabled" : ""}>下一页</button>`;
  }

  function renderProjects(rows) {
    const target = $("storeProjectBody");
    if (!target) return;
    if (!rows.length) {
      target.innerHTML = '<tr><td colspan="6" class="query-empty">暂无项目业务数据</td></tr>';
      return;
    }
    target.innerHTML = rows.map((row) => {
      const name = firstValue(row, ["product_name", "project_name", "name"]);
      return `<tr><td>${escapeHtml(name)}</td><td>${escapeHtml(firstValue(row, ["total_recharge_count", "recharge_count", "purchased_count"], 0))}</td><td>${escapeHtml(firstValue(row, ["total_verification_count", "verification_count", "used_count"], 0))}</td><td>${escapeHtml(firstValue(row, ["total_experience_count", "experience_count"], 0))}</td><td>${escapeHtml(firstValue(row, ["total_refund_count", "refund_count"], 0))}</td><td>${escapeHtml(firstValue(row, ["remaining_count", "balance"], 0))}</td></tr>`;
    }).join("");
  }

  function renderCustomers() {
    const target = $("storeCustomerBody");
    if (!target) return;
    const total = state.customerTotal;
    const pages = Math.max(1, Math.ceil(total / CUSTOMER_PAGE_SIZE));
    state.customerPage = Math.min(Math.max(1, state.customerPage), pages);
    const rows = state.customerRows;
    if (!rows.length) {
      target.innerHTML = '<tr><td colspan="6" class="query-empty">暂无活跃客户</td></tr>';
    } else {
      target.innerHTML = rows.map((row) => {
        const id = firstValue(row, ["customer_id", "id"], "");
        const code = firstValue(row, ["customer_code", "code"], "");
        const name = firstValue(row, ["customer_name", "name"]);
        const reference = code || id;
        const label = code ? `${name} · ${code}` : name;
        const customer = reference ? `<a class="record-link" href="customer-detail.html?customerId=${encodeURIComponent(reference)}">${escapeHtml(label)}</a>` : escapeHtml(label);
        return `<tr><td>${customer}</td><td>${escapeHtml(formatBirthday(firstValue(row, ["birthday", "birth_date"], "")))}</td><td>${escapeHtml(firstValue(row, ["product_count", "held_product_count"], 0))}</td><td>${escapeHtml(firstValue(row, ["total_recharge_count", "purchase_count"], 0))}</td><td>${escapeHtml(firstValue(row, ["total_verification_count", "verification_count"], 0))}</td><td>${escapeHtml(firstValue(row, ["remaining_count", "balance"], 0))}</td></tr>`;
      }).join("");
    }
    if ($("storeCustomerCount")) $("storeCustomerCount").textContent = `${total}位客户`;
    renderPager("storeCustomerPagination", total, state.customerPage, CUSTOMER_PAGE_SIZE, "customer");
  }

  function renderEmptyRows(message = "暂无业务数据") {
    if ($("storeProjectBody")) $("storeProjectBody").innerHTML = `<tr><td colspan="6" class="query-empty">${escapeHtml(message)}</td></tr>`;
    state.customerRows = [];
    state.customerTotal = 0;
    renderCustomers();
  }

  function renderError(message) {
    $("storeHero").innerHTML = `<div><span class="profile-type">门店详情</span><h2>无法读取门店</h2><p>${escapeHtml(message)}</p></div>`;
    if ($("storeHeaderStatus")) $("storeHeaderStatus").textContent = "读取失败";
    $("storeBasicGrid").innerHTML = "";
    renderEmptyRows("暂无数据");
  }

  function archivedStore(store) {
    return [store?.store_status, store?.account_status, store?.status]
      .some((value) => String(value || "").toUpperCase() === "ARCHIVED");
  }

  function storeAccountPhone(store) {
    return String(store?.phone || store?.contact_phone || "").trim();
  }

  function renderStoreStatusAction(store) {
    const button = $("storeStatusAction");
    if (!button) return;
    const account = state.storeAccount || {};
    const master = store || state.currentStore || {};
    const manageable = state.sessionRole === "hq" && Boolean(String(master.id || state.dashboardStoreId || "").trim());
    if (!manageable) {
      button.hidden = true;
      return;
    }
    const archived = archivedStore(master) || archivedStore(account);
    button.hidden = false;
    button.disabled = false;
    button.textContent = archived ? "激活门店账号" : "封存门店账号";
    button.classList.toggle("danger-button", !archived);
  }

  function renderStore(store) {
    state.currentStore = store;
    state.dashboardStoreId = String(store.id || state.dashboardStoreId || "").trim();
    const authUid = String(store.auth_uid || "").trim();
    const storeCode = String(store.store_code || "").trim();
    const effectiveStatus = archivedStore(state.storeAccount || store) || archivedStore(store) ? "ARCHIVED" : "ACTIVE";
    const status = effectiveStatus === "ARCHIVED" ? "封存" : "活跃";
    const locationText = [store.province, store.city, store.district].filter(Boolean).join(" · ") || "未填写";

    $("storeHero").innerHTML = `<div class="profile-avatar store-profile-avatar">店</div><div><span class="profile-type">门店账号</span><h2>${escapeHtml(store.store_name)}</h2><p>${escapeHtml(authUid)} · ${escapeHtml(status)}</p></div>`;
    if ($("storeHeaderStatus")) $("storeHeaderStatus").innerHTML = `<span></span>${status === "封存" ? "已封存" : "正常营业"}`;
    renderStoreStatusAction({ ...store, store_status: effectiveStatus });
    $("storeBasicGrid").innerHTML = info([
      ["唯一身份 ID", authUid],
      ["业务编号", storeCode],
      ["门店名称", store.store_name],
      ["地区", locationText],
      ["详细地址", store.address_detail || "未填写"],
      ["门店状态", status],
      ["联系人", store.contact_name || "未填写"],
      ["联系电话", store.contact_phone || "未填写"]
    ]);
    renderProjects(Array.isArray(store.projects) ? store.projects : (Array.isArray(store.project_stats) ? store.project_stats : []));
    state.customerRows = (Array.isArray(store.customers) ? store.customers : []).filter((row) =>
      String(firstValue(row, ["customer_status", "status"], "")).trim().toUpperCase() === "ACTIVE"
    );
    state.customerTotal = Number(store.customer_total ?? state.customerRows.length);
    state.customerPage = Number(store.customer_page || 1);
    renderCustomers();
  }

  function analyticsQuery(metric = "") {
    const startDate = $("storeAnalyticsStart")?.value || "";
    const endDate = $("storeAnalyticsEnd")?.value || "";
    const query = new URLSearchParams({ storeId: state.dashboardStoreId, startDate, endDate });
    if (metric) query.set("metric", metric);
    return query.toString();
  }

  function setAnalyticsPeriod(period) {
    const range = window.StoreAnalyticsData.periodRange(period);
    if (range && $("storeAnalyticsStart")) $("storeAnalyticsStart").value = range.startDate;
    if (range && $("storeAnalyticsEnd")) $("storeAnalyticsEnd").value = range.endDate;
    const custom = period === "custom";
    if ($("storeAnalyticsStart")) $("storeAnalyticsStart").disabled = !custom;
    if ($("storeAnalyticsEnd")) $("storeAnalyticsEnd").disabled = !custom;
  }

  function renderAnalytics(data) {
    const products = Array.isArray(data.products) ? data.products : [];
    const totalColumns = products.length + 2;
    const productHeaders = products.map((product) => `<th>${escapeHtml(product.productName || "未命名项目")}</th>`).join("");
    $("storeAnalyticsHead").innerHTML = `<tr><th>业务类型</th>${productHeaders}<th>汇总</th></tr>`;
    $("storeAnalyticsBody").innerHTML = analyticsMetrics.map((metric) => {
      const cells = products.map((product) => `<td>${Number(product[metric.key] || 0)}</td>`).join("");
      const href = `store-analysis.html?${analyticsQuery(metric.key)}`;
      return `<tr><th><a class="record-link" href="${escapeHtml(href)}">${metric.label}</a></th>${cells}<td><strong>${Number(data.totals?.[metric.key] || 0)}</strong></td></tr>`;
    }).join("") || `<tr><td colspan="${totalColumns}" class="query-empty">暂无业务数据</td></tr>`;
    $("storeAnalyticsScope").textContent = `${data.range?.startDate || "—"} 至 ${data.range?.endDate || "—"} · 项目按本期业务量排序`;
    $("exportStoreAnalyticsPdf").disabled = false;
  }

  function validateAnalyticsRange() {
    const startDate = $("storeAnalyticsStart").value;
    const endDate = $("storeAnalyticsEnd").value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) throw new Error("请选择完整的开始和结束日期。");
    if (startDate > endDate) throw new Error("开始日期不能晚于结束日期。");
    const days = Math.floor((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000) + 1;
    if (days > 366) throw new Error("单次最多统计 366 天。");
    return { startDate, endDate };
  }

  async function loadAnalytics() {
    if (state.analyticsLoading || !state.dashboardStoreId) return;
    state.analyticsLoading = true;
    $("storeAnalyticsMessage").textContent = "正在统计…";
    $("exportStoreAnalyticsPdf").disabled = true;
    try {
      const range = validateAnalyticsRange();
      const data = await window.StoreAnalyticsData.load({ storeId: state.dashboardStoreId, ...range });
      state.analytics = data;
      renderAnalytics(data);
      $("storeAnalyticsMessage").textContent = "";
    } catch (error) {
      state.analytics = null;
      $("storeAnalyticsHead").innerHTML = "";
      $("storeAnalyticsBody").innerHTML = `<tr><td class="query-empty">${escapeHtml(error?.message || "业务统计读取失败")}</td></tr>`;
      $("storeAnalyticsMessage").textContent = error?.message || "业务统计读取失败";
    } finally {
      state.analyticsLoading = false;
    }
  }

  async function exportAnalyticsPdf() {
    if (!state.analytics) return;
    const button = $("exportStoreAnalyticsPdf");
    button.disabled = true;
    $("storeAnalyticsMessage").textContent = "正在生成表格版 PDF…";
    try {
      const result = await window.StoreDashboardExport.exportReport({ data: state.analytics });
      $("storeAnalyticsMessage").textContent = `已导出 ${result.pages} 页 PDF`;
    } catch (error) {
      $("storeAnalyticsMessage").textContent = error?.message || "PDF 导出失败";
    } finally {
      button.disabled = false;
    }
  }

  async function loadCustomerPage(page) {
    const target = $("storeCustomerBody");
    if (target) target.innerHTML = '<tr><td colspan="6" class="query-empty">正在读取客户数据…</td></tr>';
    try {
      renderStore(await loadCurrentStoreDashboard(page, state.dashboardStoreId));
    } catch (error) {
      if (target) target.innerHTML = `<tr><td colspan="6" class="query-empty">${escapeHtml(error?.message || "客户数据读取失败")}</td></tr>`;
    }
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-page-target]");
    if (!button || button.disabled) return;
    const page = Number(button.dataset.page);
    if (button.dataset.pageTarget === "customer") void loadCustomerPage(page);
  });

  $("storeAnalyticsPeriod")?.addEventListener("change", (event) => setAnalyticsPeriod(event.target.value));
  $("applyStoreAnalytics")?.addEventListener("click", () => void loadAnalytics());
  $("exportStoreAnalyticsPdf")?.addEventListener("click", () => void exportAnalyticsPdf());
  $("storeStatusAction")?.addEventListener("click", async () => {
    const account = state.storeAccount || {};
    const store = state.currentStore;
    if (!store || state.sessionRole !== "hq") return;
    const archived = archivedStore(store) || archivedStore(account);
    const next = archived ? "ACTIVE" : "ARCHIVED";
    const action = archived ? "激活" : "封存";
    const name = String(store.store_name || account.store_name || "该门店").trim();
    const message = archived
      ? `确认激活门店“${name}”？激活后关联门店账号可以再次登录。`
      : `确认封存门店“${name}”？门店账号将无法登录，充值、退费、核销、体验均不能再选择该门店；历史业务和统计会完整保留。`;
    if (!window.confirm(message)) return;
    if (!window.CloudBasePhoneAuth?.setMasterStatus) {
      window.alert("门店状态服务尚未加载，请刷新页面后重试。");
      return;
    }
    const button = $("storeStatusAction");
    button.disabled = true;
    try {
      const storeId = String(store.id || state.dashboardStoreId || "").trim();
      if (!storeId) throw new Error("门店资料缺少数据库编号，无法更新状态。");
      await window.CloudBasePhoneAuth.setMasterStatus({ storeId, status: next });
      state.storeAccount = { ...account, store_status: next, account_status: next };
      renderStore({ ...store, store_status: next });
    } catch (error) {
      window.alert(error?.message || `${action}门店失败，请稍后重试。`);
    } finally {
      const currentButton = $("storeStatusAction");
      if (currentButton && !currentButton.hidden) currentButton.disabled = false;
    }
  });

  async function load() {
    document.documentElement.dataset.prototypeVersion = VERSION;
    setAnalyticsPeriod("today");
    if (!storeRef) {
      renderError("缺少门店唯一身份 ID。");
      return;
    }
    try {
      let session = null;
      try { session = JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); } catch (_) { session = null; }
      state.sessionRole = String(session?.role || "");
      if (session?.role === "store") {
        state.dashboardStoreId = "";
        renderStore(await loadCurrentStoreDashboard());
        await loadAnalytics();
        return;
      }
      if (!window.CloudBasePhoneAuth?.listStores) {
        renderError("门店数据库服务尚未加载，请刷新页面后重试。");
        return;
      }
      const stores = await window.CloudBasePhoneAuth.listStores();
      const store = stores.find((item) => [item.auth_uid, item.id, item.store_code]
        .map((value) => String(value || "").trim()).includes(storeRef));
      if (!store) {
        renderError("未找到该门店账号，或门店尚未绑定有效认证身份。");
        return;
      }
      state.storeAccount = store;
      const targetStoreId = String(store.id || "").trim();
      if (!/^\d+$/.test(targetStoreId)) {
        renderError("所选门店缺少有效数据库编号，请刷新门店列表后重试。");
        return;
      }
      state.dashboardStoreId = targetStoreId;
      renderStore(await loadCurrentStoreDashboard(1, targetStoreId));
      await loadAnalytics();
    } catch (error) {
      renderError(error?.message || "门店资料读取失败，请稍后重试。");
    }
  }

  void load();
})();
