(() => {
  "use strict";

  const VERSION = "0.16.3";
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
    dashboardStoreId: "", analyticsLoading: false, statusLoading: false,
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

  function projectCount(row, field, fallback = 0) {
    const value = row?.[field];
    const count = Number(value);
    return Number.isFinite(count) ? Math.trunc(count) : fallback;
  }

  function projectHasField(row, field) {
    return Object.prototype.hasOwnProperty.call(row || {}, field)
      && row[field] !== null
      && row[field] !== undefined;
  }

  function formatProjectCount(value, { signed = false } = {}) {
    const count = Number(value);
    if (!Number.isFinite(count)) return "—";
    const normalized = Math.trunc(count);
    return `${signed && normalized > 0 ? "+" : ""}${normalized.toLocaleString("zh-CN")}`;
  }

  function projectBreakdownAvailable(row) {
    return [
      "refund_before_consumption_count",
      "refund_after_consumption_count",
      "refund_before_consumption_customer_count",
      "refund_after_consumption_customer_count",
      "refund_from_remaining_count",
      "refund_after_consumption_balance_count",
      "refund_breakdown_unknown_count"
    ].every((field) => projectHasField(row, field));
  }

  function projectBalanceExplanationAvailable(row) {
    return ["total_legacy_void_count", "raw_remaining_count", "balance_floor_adjustment"]
      .every((field) => projectHasField(row, field));
  }

  function renderProjectRefundBreakdown(row, totalRefund) {
    if (!projectBreakdownAvailable(row)) {
      return totalRefund === 0
        ? '<span class="record-status">无退费</span>'
        : '<div class="refund-balance-summary"><strong>退费分类待加载</strong><br><small>部署新版统计服务后，会显示退费前有无付费核销以及余额实际扣减情况。</small></div>';
    }
    const beforeConsumption = projectCount(row, "refund_before_consumption_count");
    const afterConsumption = projectCount(row, "refund_after_consumption_count");
    const beforeConsumptionCustomers = projectCount(row, "refund_before_consumption_customer_count");
    const afterConsumptionCustomers = projectCount(row, "refund_after_consumption_customer_count");
    const deductedFromRemaining = projectCount(row, "refund_from_remaining_count");
    const insufficientBalance = projectCount(row, "refund_after_consumption_balance_count");
    const unknown = projectCount(row, "refund_breakdown_unknown_count");
    return `<div class="refund-balance-summary"><strong>退费合计：${formatProjectCount(totalRefund)}</strong><br><span>退费前无付费核销：${formatProjectCount(beforeConsumption)}（${formatProjectCount(beforeConsumptionCustomers)}位客户）</span><br><span>已有付费核销后退费：${formatProjectCount(afterConsumption)}（${formatProjectCount(afterConsumptionCustomers)}位客户）</span><br><small>实际扣余：${formatProjectCount(deductedFromRemaining)}；余额不足未扣余：${formatProjectCount(insufficientBalance)}${unknown ? `；待判定：${formatProjectCount(unknown)}` : ""}</small></div>`;
  }

  function renderProjectBalanceExplanation(row) {
    if (!projectBalanceExplanationAvailable(row)) {
      return '<span>新版统计服务会返回：充值 − 付费核销 − 退费 − 历史冲销，再加客户级归零调整。</span>';
    }
    const rawRemaining = projectCount(row, "raw_remaining_count");
    const legacyVoid = projectCount(row, "total_legacy_void_count");
    const floorAdjustment = projectCount(row, "balance_floor_adjustment");
    return `<strong>应计余额：${formatProjectCount(rawRemaining)}</strong><br><small>公式：充值 − 付费核销 − 退费 − 历史冲销${legacyVoid ? `（${formatProjectCount(legacyVoid)}）` : ""}</small><br><small>客户级归零调整：${formatProjectCount(floorAdjustment, { signed: true })}</small>`;
  }

  function renderProjects(rows) {
    const target = $("storeProjectBody");
    if (!target) return;
    if (!rows.length) {
      target.innerHTML = '<tr><td colspan="7" class="query-empty">暂无项目业务数据</td></tr>';
      return;
    }
    target.innerHTML = rows.map((row) => {
      const name = firstValue(row, ["product_name", "project_name", "name"]);
      const recharge = projectCount(row, "total_recharge_count", projectCount(row, "recharge_count", projectCount(row, "purchased_count")));
      const verification = projectCount(row, "total_verification_count", projectCount(row, "verification_count", projectCount(row, "used_count")));
      const experience = projectCount(row, "total_experience_count", projectCount(row, "experience_count"));
      const refund = projectCount(row, "total_refund_count", projectCount(row, "refund_count"));
      const remaining = projectCount(row, "remaining_count", projectCount(row, "balance"));
      return `<tr><td>${escapeHtml(name)}</td><td>${formatProjectCount(recharge)}</td><td>${formatProjectCount(verification)}</td><td><strong>${formatProjectCount(experience)}</strong><br><small>不扣客户余额</small></td><td>${renderProjectRefundBreakdown(row, refund)}</td><td>${renderProjectBalanceExplanation(row)}</td><td><strong>${formatProjectCount(remaining)}</strong><br><small>客户余额不可跨人抵扣</small></td></tr>`;
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
    if ($("storeProjectBody")) $("storeProjectBody").innerHTML = `<tr><td colspan="7" class="query-empty">${escapeHtml(message)}</td></tr>`;
    state.customerRows = [];
    state.customerTotal = 0;
    renderCustomers();
  }

  function renderError(message) {
    $("storeHero").innerHTML = `<div><span class="profile-type">门店详情</span><h2>无法读取门店</h2><p>${escapeHtml(message)}</p></div>`;
    if ($("storeHeaderStatus")) {
      $("storeHeaderStatus").textContent = "读取失败";
      $("storeHeaderStatus").classList.remove("store-status-active", "store-status-archived");
    }
    $("storeBasicGrid").innerHTML = "";
    renderEmptyRows("暂无数据");
  }

  function archivedStore(store) {
    return [store?.store_status, store?.account_status, store?.status]
      .some((value) => String(value || "").toUpperCase() === "ARCHIVED");
  }

  function setStoreStatusMessage(message = "", tone = "") {
    const target = $("storeStatusMessage");
    if (!target) return;
    target.textContent = String(message || "");
    if (tone) target.dataset.tone = tone;
    else delete target.dataset.tone;
  }

  function storeStatusFailureMessage(error, action) {
    const fallback = `${action}门店失败，门店状态没有改变。`;
    const message = String(error?.message || fallback).trim();
    const diagnostic = [error?.code, error?.stage, error?.requestId].filter(Boolean).join(" · ");
    const unsupported = /不支持的操作|unsupported action/i.test(message);
    const permission = String(error?.code || "").toUpperCase() === "AUTH_ARCHIVE_FAILED"
      || String(error?.stage || "").toUpperCase() === "AUTH_ARCHIVE";
    const guidance = unsupported
      ? "当前 staffAccount 云函数版本不支持门店主页状态操作，请先发布最新版后重试。"
      : permission
        ? "CloudBase 登录账号未能同步封存，业务主档没有修改；请检查 staffAccount 的用户管理权限后重试。"
        : "请保留页面上的错误编号后重试。";
    const detail = diagnostic && !message.includes(diagnostic) ? `${message}（${diagnostic}）` : message;
    return `${detail || fallback} ${guidance}`;
  }

  function renderStoreStatusAction(store) {
    const button = $("storeStatusAction");
    if (!button) return;
    const account = state.storeAccount || {};
    const master = store || state.currentStore || {};
    const manageable = state.sessionRole === "hq"
      && /^\d+$/.test(String(master.id || state.dashboardStoreId || "").trim());
    if (!manageable) {
      button.hidden = true;
      return;
    }
    const archived = archivedStore(master) || archivedStore(account);
    button.hidden = false;
    button.disabled = state.statusLoading;
    button.textContent = state.statusLoading
      ? `正在${archived ? "激活" : "封存"}…`
      : (archived ? "激活门店" : "封存门店");
    button.classList.toggle("danger-button", !archived);
    button.classList.toggle("status-activate-button", archived);
  }

  function renderStore(store) {
    state.currentStore = store;
    state.dashboardStoreId = String(store.id || state.dashboardStoreId || "").trim();
    const authUid = String(store.auth_uid || "").trim();
    const storeCode = String(store.store_code || "").trim();
    const effectiveStatus = archivedStore(state.storeAccount || store) || archivedStore(store) ? "ARCHIVED" : "ACTIVE";
    const status = effectiveStatus === "ARCHIVED" ? "封存" : "活跃";
    const locationText = [store.province, store.city, store.district].filter(Boolean).join(" · ") || "未填写";

    $("storeHero").innerHTML = `<div class="profile-avatar store-profile-avatar">店</div><div><span class="profile-type">门店账号</span><div class="store-profile-title"><h2>${escapeHtml(store.store_name)}</h2><span class="store-status-badge ${effectiveStatus === "ARCHIVED" ? "archived" : "active"}">${escapeHtml(status)}</span></div><p>${escapeHtml(authUid || storeCode || "未绑定登录账号")}</p></div>`;
    if ($("storeHeaderStatus")) {
      $("storeHeaderStatus").innerHTML = `<span></span>${status === "封存" ? "已封存" : "正常营业"}`;
      $("storeHeaderStatus").classList.toggle("store-status-archived", effectiveStatus === "ARCHIVED");
      $("storeHeaderStatus").classList.toggle("store-status-active", effectiveStatus !== "ARCHIVED");
    }
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
    try {
      const range = validateAnalyticsRange();
      const data = await window.StoreAnalyticsData.load({ storeId: state.dashboardStoreId, ...range });
      renderAnalytics(data);
      $("storeAnalyticsMessage").textContent = "";
    } catch (error) {
      $("storeAnalyticsHead").innerHTML = "";
      $("storeAnalyticsBody").innerHTML = `<tr><td class="query-empty">${escapeHtml(error?.message || "业务统计读取失败")}</td></tr>`;
      $("storeAnalyticsMessage").textContent = error?.message || "业务统计读取失败";
    } finally {
      state.analyticsLoading = false;
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
      setStoreStatusMessage("门店状态服务尚未加载，请刷新页面后重试。", "error");
      return;
    }
    state.statusLoading = true;
    setStoreStatusMessage(`正在${action}门店并同步登录账号…`, "pending");
    renderStoreStatusAction(store);
    try {
      const storeId = String(store.id || account.id || state.dashboardStoreId || "").trim();
      if (!/^\d+$/.test(storeId)) throw new Error("门店资料缺少有效数据库编号，无法更新状态。");
      const result = await window.CloudBasePhoneAuth.setMasterStatus({ storeId, status: next });
      if (String(result?.status || "").toUpperCase() !== next) {
        throw new Error("门店状态服务未确认保存结果，请刷新页面核对后重试。");
      }
      state.storeAccount = { ...account, store_status: next, account_status: next };
      renderStore({ ...store, store_status: next });
      const successMessage = next === "ARCHIVED"
        ? "门店已封存，关联账号已停止业务登录；历史业务与统计继续保留。"
        : "门店已激活，关联账号可以重新登录。";
      setStoreStatusMessage(result?.warning ? `${successMessage} ${result.warning}` : successMessage,
        result?.warning ? "warning" : "success");
    } catch (error) {
      setStoreStatusMessage(storeStatusFailureMessage(error, action), "error");
    } finally {
      state.statusLoading = false;
      renderStoreStatusAction(state.currentStore);
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
