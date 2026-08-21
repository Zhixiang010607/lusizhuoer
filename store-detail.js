(() => {
  "use strict";

  const VERSION = "0.16.5";
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
  const PRESET_LABELS = Object.freeze({ TODAY: "今天", WEEK: "本周", MONTH: "本月", QUARTER: "本季度", YEAR: "本年", ALL: "全部", CUSTOM: "自定义" });
  const businessTypes = Object.freeze(["VERIFICATION", "RECHARGE", "EXPERIENCE", "REFUND"]);
  const businessTypeMeta = Object.freeze({
    VERIFICATION: Object.freeze({ label: "核销", totalId: "storeVerificationTotal", recordType: "VERIFICATION", verificationType: "NORMAL" }),
    RECHARGE: Object.freeze({ label: "充值", totalId: "storeRechargeTotal", recordType: "RECHARGE", rechargeType: "NEW" }),
    EXPERIENCE: Object.freeze({ label: "体验", totalId: "storeExperienceTotal", recordType: "VERIFICATION", verificationType: "EXPERIENCE" }),
    REFUND: Object.freeze({ label: "退费", totalId: "storeRefundTotal", recordType: "RECHARGE", rechargeType: "REFUND" })
  });
  const emptyBusinessTypeMap = (factory) => Object.fromEntries(businessTypes.map((type) => [type, factory(type)]));
  const state = {
    activeCustomerRows: [], activeCustomerPage: 1, activeCustomerTotal: 0,
    archivedCustomerRows: [], archivedCustomerPage: 1, archivedCustomerTotal: 0,
    dashboardStoreId: "", analyticsLoading: false, analyticsPreset: "MONTH", statusLoading: false,
    businessActiveType: "VERIFICATION", businessRangeEpoch: 0,
    businessRecords: emptyBusinessTypeMap(() => []),
    businessCursors: emptyBusinessTypeMap(() => null),
    businessHasMore: emptyBusinessTypeMap(() => false),
    businessLoaded: emptyBusinessTypeMap(() => false),
    businessLoading: emptyBusinessTypeMap(() => false),
    businessRequestIds: emptyBusinessTypeMap(() => 0),
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

  async function loadCurrentStoreDashboard(activeCustomerPage = 1, storeId = "", archivedCustomerPage = 1) {
    if (!window.cloudbase || !window.CloudBaseAuthConfig || !window.registerFunctions) {
      throw new Error("门店首页数据库组件尚未加载，请刷新页面后重试。");
    }
    registerCloudBaseComponent(window.registerAuth, "auth");
    registerCloudBaseComponent(window.registerFunctions, "functions");
    const request = { action: "getStoreDashboard", activeCustomerPage, archivedCustomerPage };
    if (storeId) request.storeId = String(storeId);
    const result = await window.cloudbase.init(window.CloudBaseAuthConfig).callFunction({
      name: "faceRecognition",
      data: request
    });
    const data = cloudFunctionData(result);
    if (!data.ok || !data.store) throw new Error(data.message || "门店首页数据库没有返回有效数据。");
    return data.store;
  }

  async function callFaceRecognition(action, data = {}) {
    if (!window.cloudbase || !window.CloudBaseAuthConfig || !window.registerFunctions) {
      throw new Error("门店业务数据库组件尚未加载，请刷新页面后重试。");
    }
    registerCloudBaseComponent(window.registerAuth, "auth");
    registerCloudBaseComponent(window.registerFunctions, "functions");
    const result = await window.cloudbase.init(window.CloudBaseAuthConfig).callFunction({
      name: "faceRecognition",
      data: { action, ...data }
    });
    const response = cloudFunctionData(result);
    if (!response.ok) throw new Error(response.message || "门店业务明细读取失败。");
    return response;
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

  function renderCustomers(status) {
    const archived = status === "ARCHIVED";
    const prefix = archived ? "Archived" : "Active";
    const target = $(`store${prefix}CustomerBody`);
    if (!target) return;
    const total = archived ? state.archivedCustomerTotal : state.activeCustomerTotal;
    const currentPage = archived ? state.archivedCustomerPage : state.activeCustomerPage;
    const pages = Math.max(1, Math.ceil(total / CUSTOMER_PAGE_SIZE));
    const page = Math.min(Math.max(1, currentPage), pages);
    if (archived) state.archivedCustomerPage = page;
    else state.activeCustomerPage = page;
    const rows = archived ? state.archivedCustomerRows : state.activeCustomerRows;
    if (!rows.length) {
      target.innerHTML = `<tr><td colspan="6" class="query-empty">暂无${archived ? "封存" : "活跃"}客户</td></tr>`;
    } else {
      target.innerHTML = rows.map((row) => {
        const id = firstValue(row, ["customer_id", "id"], "");
        const code = firstValue(row, ["customer_code", "code"], "");
        const name = firstValue(row, ["customer_name", "name"]);
        const reference = code || id;
        const label = code ? `${name} · ${code}` : name;
        const customer = reference ? `<a class="record-link" href="customer-detail.html?customerId=${encodeURIComponent(reference)}">${escapeHtml(label)}</a>` : escapeHtml(label);
        return `<tr><td data-label="客户">${customer}</td><td data-label="生日">${escapeHtml(formatBirthday(firstValue(row, ["birthday", "birth_date"], "")))}</td><td data-label="持有项目">${escapeHtml(firstValue(row, ["product_count", "held_product_count"], 0))}</td><td data-label="总购买">${escapeHtml(firstValue(row, ["total_recharge_count", "purchase_count"], 0))}</td><td data-label="总核销">${escapeHtml(firstValue(row, ["total_verification_count", "verification_count"], 0))}</td><td data-label="剩余次数">${escapeHtml(firstValue(row, ["remaining_count", "balance"], 0))}</td></tr>`;
      }).join("");
    }
    if ($(`store${prefix}CustomerCount`)) $(`store${prefix}CustomerCount`).textContent = `${total} 位用户`;
    renderPager(`store${prefix}CustomerPagination`, total, page, CUSTOMER_PAGE_SIZE, archived ? "archivedCustomer" : "activeCustomer");
  }

  function renderEmptyRows(message = "暂无业务数据") {
    state.activeCustomerRows = [];
    state.activeCustomerTotal = 0;
    state.archivedCustomerRows = [];
    state.archivedCustomerTotal = 0;
    renderCustomers("ACTIVE");
    renderCustomers("ARCHIVED");
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
    state.activeCustomerRows = (Array.isArray(store.customers) ? store.customers : []).filter((row) =>
      String(firstValue(row, ["customer_status", "status"], "")).trim().toUpperCase() === "ACTIVE"
    );
    state.activeCustomerTotal = Number(store.customer_total ?? state.activeCustomerRows.length);
    state.activeCustomerPage = Number(store.customer_page || 1);
    state.archivedCustomerRows = (Array.isArray(store.archived_customers) ? store.archived_customers : []).filter((row) =>
      String(firstValue(row, ["customer_status", "status"], "")).trim().toUpperCase() === "ARCHIVED"
    );
    state.archivedCustomerTotal = Number(store.archived_customer_total ?? state.archivedCustomerRows.length);
    state.archivedCustomerPage = Number(store.archived_customer_page || 1);
    renderCustomers("ACTIVE");
    renderCustomers("ARCHIVED");
  }

  function analyticsRangeLabel() {
    if (state.analyticsPreset === "ALL") return "全部时间";
    const startDate = $("storeAnalyticsStart")?.value || "";
    const endDate = $("storeAnalyticsEnd")?.value || "";
    const dates = startDate === endDate ? startDate : `${startDate} 至 ${endDate}`;
    return `${PRESET_LABELS[state.analyticsPreset] || "自定义"} · ${dates}`;
  }

  function setAnalyticsPeriod(period, { load = false } = {}) {
    state.analyticsPreset = PRESET_LABELS[period] ? period : "MONTH";
    const range = window.StoreAnalyticsData.periodRange(state.analyticsPreset);
    if (range && $("storeAnalyticsStart")) $("storeAnalyticsStart").value = range.startDate;
    if (range && $("storeAnalyticsEnd")) $("storeAnalyticsEnd").value = range.endDate;
    document.querySelectorAll("[data-store-range-preset]").forEach((button) => button.classList.toggle("active", button.dataset.storeRangePreset === state.analyticsPreset));
    if ($("storeCustomRange")) $("storeCustomRange").hidden = state.analyticsPreset !== "CUSTOM";
    if ($("storeAnalyticsScope")) $("storeAnalyticsScope").textContent = analyticsRangeLabel();
    if (load && state.analyticsPreset !== "CUSTOM") void loadAnalytics();
  }

  function renderAnalytics(data) {
    const products = Array.isArray(data.products) ? data.products : [];
    const metricCell = (value) => `<td><strong>${Number(value || 0).toLocaleString("zh-CN")}</strong><span>次</span></td>`;
    const rows = products.map((product) => `<tr>
      <th scope="row"><strong>${escapeHtml(product.productName || "未命名项目")}</strong><small>${escapeHtml(product.productCode || "—")}</small></th>
      ${metricCell(product.verification)}${metricCell(product.recharge)}${metricCell(product.experience)}${metricCell(product.refund)}
    </tr>`).join("");
    const totals = data.totals || {};
    $("storeAnalyticsBody").innerHTML = products.length
      ? `${rows}<tr class="teacher-summary-total"><th scope="row">合计</th>${metricCell(totals.verification)}${metricCell(totals.recharge)}${metricCell(totals.experience)}${metricCell(totals.refund)}</tr>`
      : '<tr><td colspan="5" class="teacher-empty">所选时间内暂无有效业务</td></tr>';
    $("storeAnalyticsScope").textContent = analyticsRangeLabel();
    for (const [type, metric] of [["VERIFICATION", "verification"], ["RECHARGE", "recharge"], ["EXPERIENCE", "experience"], ["REFUND", "refund"]]) {
      const target = $(businessTypeMeta[type].totalId);
      if (target) target.textContent = `${Number(data.totals?.[metric] || 0).toLocaleString("zh-CN")} 次`;
    }
  }

  function renderBusinessTabs() {
    document.querySelectorAll("[data-store-record-type]").forEach((button) => {
      const active = button.dataset.storeRecordType === state.businessActiveType;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
  }

  function formatBusinessDateTime(value) {
    return window.AppDateTime?.formatDateTime?.(value, "—") || window.AppDateTime?.formatDate?.(value, "—") || "—";
  }

  function renderBusinessDetails() {
    const type = state.businessActiveType;
    const rows = state.businessRecords[type];
    const meta = businessTypeMeta[type];
    if ($("storeBusinessDetailHead")) $("storeBusinessDetailHead").innerHTML = "<tr><th>单号</th><th>门店</th><th>客户</th><th>项目</th><th>次数</th><th>提交时间</th></tr>";
    if (state.businessLoading[type] && !rows.length) {
      $("storeBusinessDetailBody").innerHTML = `<tr><td colspan="6" class="teacher-empty">正在读取${meta.label}明细…</td></tr>`;
    } else {
      $("storeBusinessDetailBody").innerHTML = rows.length ? rows.map((row) => {
        const verification = type === "VERIFICATION" || type === "EXPERIENCE";
        const detailParams = new URLSearchParams({ recordId: String(row.id || ""), recordCode: String(row.recordCode || ""), source: "store" });
        const detailHref = `${verification ? "verification" : "recharge"}-detail.html?${detailParams.toString()}`;
        const customerParams = new URLSearchParams({ customerId: String(row.customerCode || ""), source: "store" });
        const customerHref = `customer-detail.html?${customerParams.toString()}`;
        const count = Number(row.unitCount || 0).toLocaleString("zh-CN");
        const amount = type === "REFUND" ? `−${count} 次` : type === "RECHARGE" ? `+${count} 次` : `${count} 次`;
        return `<tr>
          <td data-label="单号"><a class="teacher-order-link" href="${escapeHtml(detailHref)}">${escapeHtml(row.recordCode || "—")}</a></td>
          <td data-label="门店">${escapeHtml(row.storeName || "—")} · ${escapeHtml(row.storeCode || "—")}</td>
          <td data-label="客户"><a class="teacher-order-link" href="${escapeHtml(customerHref)}">${escapeHtml(row.customerName || "—")} · ${escapeHtml(row.customerCode || "—")}</a></td>
          <td data-label="项目">${escapeHtml(row.productName || "—")}</td>
          <td data-label="次数"><strong>${amount}</strong></td>
          <td data-label="提交时间">${escapeHtml(formatBusinessDateTime(row.submittedAt))}</td>
        </tr>`;
      }).join("") : `<tr><td colspan="6" class="teacher-empty">所选时间内暂无本门店有效${meta.label}记录</td></tr>`;
    }
    $("storeBusinessLoadedCount").textContent = `已加载 ${rows.length} 条`;
    $("storeBusinessLoadMore").hidden = !state.businessHasMore[type];
    $("storeBusinessLoadMore").disabled = state.businessLoading[type];
  }

  function mergeBusinessPage(type, result, append) {
    if (!append) state.businessRecords[type] = [];
    const known = new Set(state.businessRecords[type].map((row) => String(row.id)));
    for (const row of Array.isArray(result?.records) ? result.records : []) {
      if (!known.has(String(row.id))) state.businessRecords[type].push(row);
    }
    state.businessCursors[type] = result?.nextCursor || null;
    state.businessHasMore[type] = Boolean(result?.hasMore && result?.nextCursor);
    state.businessLoaded[type] = true;
  }

  async function loadBusinessType(type, { append = false } = {}) {
    if (!businessTypes.includes(type) || state.businessLoading[type] || !state.dashboardStoreId) return;
    const cursor = append ? state.businessCursors[type] : null;
    if (append && !cursor) return;
    const epoch = state.businessRangeEpoch;
    const requestId = ++state.businessRequestIds[type];
    const meta = businessTypeMeta[type];
    state.businessLoading[type] = true;
    if (!append) { state.businessRecords[type] = []; state.businessLoaded[type] = false; }
    renderBusinessDetails();
    $("storeBusinessDetailMessage").textContent = append ? "正在继续读取…" : "";
    try {
      const range = validateAnalyticsRange();
      const result = await callFaceRecognition("queryStoreBusinessRecords", {
        storeId: state.dashboardStoreId,
        mode: "browse",
        statusCategory: "APPROVED",
        recordType: meta.recordType,
        ...(meta.verificationType ? { verificationType: meta.verificationType } : {}),
        ...(meta.rechargeType ? { rechargeType: meta.rechargeType } : {}),
        ...range,
        limit: 50,
        ...(cursor ? { cursorSubmittedAt: cursor.submittedAt, cursorId: cursor.id } : {})
      });
      if (epoch !== state.businessRangeEpoch || requestId !== state.businessRequestIds[type]) return;
      mergeBusinessPage(type, result, append);
      $("storeBusinessDetailMessage").textContent = "";
    } catch (error) {
      if (epoch !== state.businessRangeEpoch || requestId !== state.businessRequestIds[type]) return;
      if (!append) state.businessLoaded[type] = true;
      $("storeBusinessDetailMessage").textContent = error?.message || "门店业务明细读取失败。";
    } finally {
      if (epoch === state.businessRangeEpoch && requestId === state.businessRequestIds[type]) {
        state.businessLoading[type] = false;
        renderBusinessDetails();
      }
    }
  }

  function resetBusinessDetails() {
    state.businessRangeEpoch += 1;
    for (const type of businessTypes) {
      state.businessRecords[type] = [];
      state.businessCursors[type] = null;
      state.businessHasMore[type] = false;
      state.businessLoaded[type] = false;
      state.businessLoading[type] = false;
      state.businessRequestIds[type] += 1;
    }
    renderBusinessDetails();
  }

  function setBusinessType(type) {
    if (!businessTypes.includes(type)) return;
    state.businessActiveType = type;
    renderBusinessTabs();
    renderBusinessDetails();
    if (!state.businessLoaded[type]) void loadBusinessType(type);
  }

  function validateAnalyticsRange() {
    if (state.analyticsPreset === "ALL") return {};
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
      resetBusinessDetails();
      $("storeAnalyticsMessage").textContent = "";
      void loadBusinessType(state.businessActiveType);
    } catch (error) {
      $("storeAnalyticsBody").innerHTML = `<tr><td colspan="5" class="teacher-empty">${escapeHtml(error?.message || "业务统计读取失败")}</td></tr>`;
      $("storeAnalyticsMessage").textContent = error?.message || "业务统计读取失败";
    } finally {
      state.analyticsLoading = false;
    }
  }

  async function loadCustomerPage(kind, page) {
    const archived = kind === "archivedCustomer";
    const target = $(archived ? "storeArchivedCustomerBody" : "storeActiveCustomerBody");
    if (target) target.innerHTML = '<tr><td colspan="6" class="query-empty">正在读取客户数据…</td></tr>';
    try {
      const activePage = archived ? state.activeCustomerPage : page;
      const archivedPage = archived ? page : state.archivedCustomerPage;
      renderStore(await loadCurrentStoreDashboard(activePage, state.dashboardStoreId, archivedPage));
    } catch (error) {
      if (target) target.innerHTML = `<tr><td colspan="6" class="query-empty">${escapeHtml(error?.message || "客户数据读取失败")}</td></tr>`;
    }
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-page-target]");
    if (!button || button.disabled) return;
    const page = Number(button.dataset.page);
    if (["activeCustomer", "archivedCustomer"].includes(button.dataset.pageTarget)) {
      void loadCustomerPage(button.dataset.pageTarget, page);
    }
  });

  document.querySelectorAll("[data-store-range-preset]").forEach((button) => button.addEventListener("click", () => setAnalyticsPeriod(button.dataset.storeRangePreset, { load: true })));
  $("applyStoreAnalytics")?.addEventListener("click", () => void loadAnalytics());
  document.querySelectorAll("[data-store-record-type]").forEach((button) => button.addEventListener("click", () => setBusinessType(button.dataset.storeRecordType)));
  $("storeBusinessLoadMore")?.addEventListener("click", () => void loadBusinessType(state.businessActiveType, { append: true }));
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
    setAnalyticsPeriod("MONTH");
    renderBusinessTabs();
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
