(() => {
  "use strict";
  const VERSION = "0.16.1";
  const CUSTOMER_PAGE_SIZE = 10;
  const TYPES = Object.freeze(["VERIFICATION", "RECHARGE", "EXPERIENCE", "REFUND"]);
  const TYPE_META = Object.freeze({
    VERIFICATION: Object.freeze({ label: "核销", totalId: "teacherVerificationTotal", empty: "核销" }),
    RECHARGE: Object.freeze({ label: "充值", totalId: "teacherRechargeTotal", empty: "充值" }),
    EXPERIENCE: Object.freeze({ label: "体验", totalId: "teacherExperienceTotal", empty: "体验" }),
    REFUND: Object.freeze({ label: "退费", totalId: "teacherRefundTotal", empty: "退费" })
  });
  const PRESET_LABELS = Object.freeze({ TODAY: "今天", WEEK: "本周", MONTH: "本月", QUARTER: "本季度", YEAR: "本年", ALL: "全部", CUSTOM: "自定义" });
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const formatDateTime = (value) => window.AppDateTime?.formatDateTime?.(value, "—") || window.AppDateTime?.formatDate?.(value, "—") || "—";
  const formatCount = (value) => Number(value || 0).toLocaleString("zh-CN");
  let session = null;
  try { session = JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); } catch (_) { session = null; }
  if (!session || session.role !== "teacher") return;

  const emptyTypeMap = (factory) => Object.fromEntries(TYPES.map((type) => [type, factory(type)]));
  const state = {
    activeType: "VERIFICATION",
    preset: "MONTH",
    range: { startDate: "", endDate: "" },
    rangeEpoch: 0,
    records: emptyTypeMap(() => []),
    cursors: emptyTypeMap(() => null),
    hasMore: emptyTypeMap(() => false),
    loaded: emptyTypeMap(() => false),
    loading: emptyTypeMap(() => false),
    requestIds: emptyTypeMap(() => 0),
    totals: { verification: 0, recharge: 0, experience: 0, refund: 0 },
    customerLoading: false,
    customers: {
      ACTIVE: { records: [], total: 0, page: 1, pageSize: CUSTOMER_PAGE_SIZE },
      ARCHIVED: { records: [], total: 0, page: 1, pageSize: CUSTOMER_PAGE_SIZE }
    }
  };

  function parsedObject(value) {
    if (value && typeof value === "object") return value;
    if (typeof value !== "string") return null;
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" ? parsed : null; } catch (_) { return null; }
  }
  function responseData(result) {
    return [result?.result, result?.data?.result, result?.data, result]
      .map(parsedObject)
      .find((candidate) => candidate && (Object.prototype.hasOwnProperty.call(candidate, "ok") || Object.prototype.hasOwnProperty.call(candidate, "code"))) || {};
  }
  function register(registerFn, name) {
    if (typeof registerFn !== "function") return;
    try { registerFn(window.cloudbase); } catch (error) {
      const message = String(error?.message || error || "").toLowerCase();
      if (!(message.includes("duplicate component") && message.includes(name))) throw error;
    }
  }
  async function callFaceFunction(action, data) {
    if (!window.cloudbase || !window.CloudBaseAuthConfig || !window.registerFunctions) throw new Error("数据库组件尚未加载，请刷新重试。");
    register(window.registerAuth, "auth");
    register(window.registerFunctions, "functions");
    const raw = await window.cloudbase.init(window.CloudBaseAuthConfig).callFunction({ name: "faceRecognition", data: { action, ...data } });
    const result = responseData(raw);
    if (!result.ok) throw new Error(result.message || "无法读取老师工作台。");
    return result;
  }
  const callWorkspace = (data) => callFaceFunction("getTeacherWorkspace", data);

  function businessToday() {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
    }).formatToParts(new Date());
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return `${value.year}-${value.month}-${value.day}`;
  }
  function calendarDate(text) {
    const [year, month, day] = text.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day));
  }
  function dateText(date) { return date.toISOString().slice(0, 10); }
  function addDays(text, days) { const date = calendarDate(text); date.setUTCDate(date.getUTCDate() + days); return dateText(date); }
  function presetRange(preset) {
    const today = businessToday();
    const date = calendarDate(today);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    if (preset === "ALL") return { startDate: "", endDate: "" };
    if (preset === "TODAY") return { startDate: today, endDate: today };
    if (preset === "WEEK") {
      const weekday = date.getUTCDay() || 7;
      return { startDate: addDays(today, 1 - weekday), endDate: today };
    }
    if (preset === "MONTH") return { startDate: dateText(new Date(Date.UTC(year, month, 1))), endDate: today };
    if (preset === "QUARTER") return { startDate: dateText(new Date(Date.UTC(year, Math.floor(month / 3) * 3, 1))), endDate: today };
    if (preset === "YEAR") return { startDate: `${year}-01-01`, endDate: today };
    return { ...state.range };
  }
  function validDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")); }
  function rangeLabel() {
    if (state.preset === "ALL") return "全部时间";
    const dates = state.range.startDate === state.range.endDate ? state.range.startDate : `${state.range.startDate} 至 ${state.range.endDate}`;
    return `${PRESET_LABELS[state.preset] || "自定义"} · ${dates}`;
  }
  function rangePayload() {
    return state.range.startDate ? { startDate: state.range.startDate, endDate: state.range.endDate } : {};
  }

  function renderProfile(profile = {}) {
    const values = [
      ["老师姓名", profile.teacherName || session.staffName || "—"],
      ["老师短编号", profile.teacherCode || session.staffCode || "—"],
      ["登录手机号", session.phone || session.account || "—"]
    ];
    $("teacherProfileInfo").innerHTML = values.map(([label, value]) => `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`).join("");
  }

  function renderExperienceBalances(items = []) {
    const balances = Array.isArray(items) ? items : [];
    $("teacherQuotaCount").textContent = `${balances.length} 个项目`;
    $("teacherExperienceBalances").innerHTML = balances.length ? balances.map((item) => `
      <article class="teacher-quota-card">
        <div><strong>${escapeHtml(item.productName || "未命名项目")}</strong><small>${escapeHtml(item.productCode || "—")}</small></div>
        <p><b>${formatCount(item.availableCount)}</b><span>次可用</span></p>
        <dl><div><dt>每月基础</dt><dd>${formatCount(item.monthlyAllowance)} 次</dd></div><div><dt>本月已用</dt><dd>${formatCount(item.usedCount)} 次</dd></div></dl>
      </article>`).join("") : '<article class="teacher-quota-empty">暂未配置体验项目</article>';
  }

  function renderSummary(summary = {}) {
    const products = Array.isArray(summary.products) ? summary.products : [];
    state.totals = { verification: 0, recharge: 0, experience: 0, refund: 0, ...(summary.totals || {}) };
    const metricCell = (value) => `<td><strong>${formatCount(value)}</strong><span>次</span></td>`;
    const rows = products.map((product) => `<tr>
      <th scope="row"><strong>${escapeHtml(product.productName || "未命名项目")}</strong><small>${escapeHtml(product.productCode || "—")}</small></th>
      ${metricCell(product.verification)}${metricCell(product.recharge)}${metricCell(product.experience)}${metricCell(product.refund)}
    </tr>`).join("");
    const total = state.totals;
    $("teacherSummaryBody").innerHTML = products.length ? `${rows}<tr class="teacher-summary-total"><th scope="row">合计</th>${metricCell(total.verification)}${metricCell(total.recharge)}${metricCell(total.experience)}${metricCell(total.refund)}</tr>` : '<tr><td colspan="5" class="teacher-empty">所选时间内暂无有效业务</td></tr>';
    for (const [type, metric] of [["VERIFICATION", "verification"], ["RECHARGE", "recharge"], ["EXPERIENCE", "experience"], ["REFUND", "refund"]]) {
      $(TYPE_META[type].totalId).textContent = `${formatCount(total[metric])} 次`;
    }
  }

  function renderRangeControls() {
    document.querySelectorAll("[data-range-preset]").forEach((button) => button.classList.toggle("active", button.dataset.rangePreset === state.preset));
    $("teacherCustomRange").hidden = state.preset !== "CUSTOM";
    $("teacherRangeLabel").textContent = rangeLabel();
  }

  function renderTabs() {
    document.querySelectorAll("[data-record-type]").forEach((button) => {
      const active = button.dataset.recordType === state.activeType;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
    });
  }

  function formatBirthday(value) {
    const text = String(value || "").slice(0, 10);
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return match ? `${match[1]}年${match[2]}月${match[3]}日` : (text || "—");
  }

  function renderCustomerPager(status) {
    const archived = status === "ARCHIVED";
    const prefix = archived ? "Archived" : "Active";
    const group = state.customers[status];
    const target = $(`teacher${prefix}CustomerPagination`);
    const pages = Math.max(1, Math.ceil(group.total / group.pageSize));
    if (group.total <= group.pageSize) { target.innerHTML = ""; return; }
    target.innerHTML = `<button type="button" data-teacher-customer-status="${status}" data-page="${group.page - 1}" ${group.page <= 1 ? "disabled" : ""}>上一页</button><span>第 ${group.page} / ${pages} 页</span><button type="button" data-teacher-customer-status="${status}" data-page="${group.page + 1}" ${group.page >= pages ? "disabled" : ""}>下一页</button>`;
  }

  function renderBusinessCustomers(status) {
    const archived = status === "ARCHIVED";
    const prefix = archived ? "Archived" : "Active";
    const group = state.customers[status];
    $(`teacher${prefix}CustomerCount`).textContent = `${formatCount(group.total)} 位客户`;
    const target = $(`teacher${prefix}CustomerBody`);
    target.innerHTML = group.records.length ? group.records.map((row) => {
      const customerParams = new URLSearchParams({ customerId: String(row.customerCode || ""), source: "teacher" });
      const href = `customer-detail.html?${customerParams.toString()}`;
      const label = `${row.customerName || "未命名客户"} · ${row.customerCode || "—"}`;
      return `<tr>
        <td data-label="客户"><a class="teacher-order-link" href="${escapeHtml(href)}">${escapeHtml(label)}</a></td>
        <td data-label="生日">${escapeHtml(formatBirthday(row.birthDate))}</td>
        <td data-label="核销项目">${formatCount(row.productCount)} 个</td>
        <td data-label="正常核销">${formatCount(row.verificationCount)} 次</td>
        <td data-label="体验核销">${formatCount(row.experienceCount)} 次</td>
        <td data-label="合计"><strong>${formatCount(row.totalCount)} 次</strong></td>
      </tr>`;
    }).join("") : `<tr><td colspan="6" class="teacher-empty">暂无核销过的${archived ? "封存" : "活跃"}客户</td></tr>`;
    renderCustomerPager(status);
  }

  async function loadBusinessCustomers(activePage = state.customers.ACTIVE.page, archivedPage = state.customers.ARCHIVED.page) {
    if (state.customerLoading) return;
    state.customerLoading = true;
    try {
      const result = await callFaceFunction("getTeacherBusinessCustomers", { activePage, archivedPage });
      for (const [status, key] of [["ACTIVE", "active"], ["ARCHIVED", "archived"]]) {
        const group = result[key] || {};
        state.customers[status] = {
          records: Array.isArray(group.records) ? group.records : [],
          total: Number(group.total || 0),
          page: Number(group.page || 1),
          pageSize: Number(group.pageSize || CUSTOMER_PAGE_SIZE)
        };
        renderBusinessCustomers(status);
      }
    } catch (error) {
      for (const [status, prefix] of [["ACTIVE", "Active"], ["ARCHIVED", "Archived"]]) {
        if (!state.customers[status].records.length) {
          $(`teacher${prefix}CustomerBody`).innerHTML = `<tr><td colspan="6" class="teacher-empty">${escapeHtml(error?.message || "客户数据读取失败")}</td></tr>`;
        }
      }
    } finally {
      state.customerLoading = false;
    }
  }

  function renderRecords() {
    const type = state.activeType;
    const rows = state.records[type];
    const meta = TYPE_META[type];
    $("teacherRecordsHead").innerHTML = "<tr><th>单号</th><th>门店</th><th>客户</th><th>项目</th><th>次数</th><th>提交时间</th></tr>";
    if (state.loading[type] && !rows.length) {
      $("teacherOrdersBody").innerHTML = `<tr><td colspan="6" class="teacher-empty">正在读取${meta.label}明细…</td></tr>`;
    } else {
      $("teacherOrdersBody").innerHTML = rows.length ? rows.map((row) => {
        const verification = type === "VERIFICATION" || type === "EXPERIENCE";
        const detailParams = new URLSearchParams({ recordId: String(row.id), recordCode: String(row.recordCode || ""), source: "teacher" });
        const detail = `${verification ? "verification" : "recharge"}-detail.html?${detailParams.toString()}`;
        const customerParams = new URLSearchParams({ customerId: String(row.customerCode || ""), source: "teacher" });
        const customerDetail = `customer-detail.html?${customerParams.toString()}`;
        const amount = type === "REFUND" ? `−${formatCount(row.unitCount)} 次` : type === "RECHARGE" ? `+${formatCount(row.unitCount)} 次` : `${formatCount(row.unitCount)} 次`;
        return `<tr>
          <td data-label="单号"><a class="teacher-order-link" href="${detail}">${escapeHtml(row.recordCode || "—")}</a></td>
          <td data-label="门店">${escapeHtml(row.storeName || "—")} · ${escapeHtml(row.storeCode || "—")}</td>
          <td data-label="客户"><a class="teacher-order-link" href="${customerDetail}">${escapeHtml(row.customerName || "—")} · ${escapeHtml(row.customerCode || "—")}</a></td>
          <td data-label="项目">${escapeHtml(row.productName || "—")}</td>
          <td data-label="次数"><strong>${amount}</strong></td>
          <td data-label="提交时间">${escapeHtml(formatDateTime(row.submittedAt))}</td>
        </tr>`;
      }).join("") : `<tr><td colspan="6" class="teacher-empty">所选时间内暂无本人有效${meta.empty}记录</td></tr>`;
    }
    $("teacherLoadedCount").textContent = `已加载 ${rows.length} 条`;
    $("teacherLoadMore").hidden = !state.hasMore[type];
    $("teacherLoadMore").disabled = state.loading[type];
  }

  function mergePage(type, page, append) {
    if (!append) state.records[type] = [];
    const known = new Set(state.records[type].map((row) => String(row.id)));
    for (const row of Array.isArray(page?.records) ? page.records : []) {
      if (!known.has(String(row.id))) state.records[type].push(row);
    }
    state.cursors[type] = page?.nextCursor || null;
    state.hasMore[type] = Boolean(page?.hasMore && page?.nextCursor);
    state.loaded[type] = true;
  }

  async function loadType(type, { append = false, includeOverview = false } = {}) {
    if (state.loading[type]) return;
    const cursor = append ? state.cursors[type] : null;
    if (append && !cursor) return;
    const epoch = state.rangeEpoch;
    const requestId = ++state.requestIds[type];
    state.loading[type] = true;
    if (!append) { state.records[type] = []; state.loaded[type] = false; }
    renderRecords();
    $("teacherWorkspaceMessage").textContent = append ? "正在继续读取…" : "";
    try {
      const result = await callWorkspace({
        recordType: type,
        limit: 50,
        includeOverview,
        ...rangePayload(),
        ...(cursor ? { cursorSubmittedAt: cursor.submittedAt, cursorId: cursor.id } : {})
      });
      if (epoch !== state.rangeEpoch || requestId !== state.requestIds[type]) return;
      renderProfile(result.profile || {});
      mergePage(type, result.page, append);
      if (includeOverview) {
        renderExperienceBalances(result.experienceBalances);
        renderSummary(result.summary);
      }
      $("teacherWorkspaceMessage").textContent = "";
    } catch (error) {
      if (epoch !== state.rangeEpoch || requestId !== state.requestIds[type]) return;
      if (!append) state.loaded[type] = true;
      $("teacherWorkspaceMessage").textContent = error?.message || "老师工作台读取失败。";
    } finally {
      if (epoch === state.rangeEpoch && requestId === state.requestIds[type]) {
        state.loading[type] = false;
        renderRecords();
      }
    }
  }

  function resetRangeData() {
    state.rangeEpoch += 1;
    for (const type of TYPES) {
      state.records[type] = [];
      state.cursors[type] = null;
      state.hasMore[type] = false;
      state.loaded[type] = false;
      state.loading[type] = false;
      state.requestIds[type] += 1;
    }
    $("teacherSummaryBody").innerHTML = '<tr><td colspan="5" class="teacher-empty">正在计算业务汇总…</td></tr>';
    renderRecords();
  }

  function applyRange(preset, customRange = null) {
    state.preset = preset;
    state.range = customRange || presetRange(preset);
    renderRangeControls();
    resetRangeData();
    loadType(state.activeType, { includeOverview: true });
  }

  function setType(type) {
    if (!TYPES.includes(type)) return;
    state.activeType = type;
    renderTabs();
    renderRecords();
    if (!state.loaded[type]) loadType(type);
  }

  function bindEvents() {
    document.querySelectorAll("[data-record-type]").forEach((button) => button.addEventListener("click", () => setType(button.dataset.recordType)));
    document.querySelectorAll("[data-range-preset]").forEach((button) => button.addEventListener("click", () => {
      const preset = button.dataset.rangePreset;
      if (preset === "CUSTOM") {
        state.preset = "CUSTOM";
        const fallback = presetRange("MONTH");
        $("teacherRangeStart").value = state.range.startDate || fallback.startDate;
        $("teacherRangeEnd").value = state.range.endDate || fallback.endDate;
        renderRangeControls();
        $("teacherRangeStart").focus();
        return;
      }
      applyRange(preset);
    }));
    $("teacherApplyCustomRange").addEventListener("click", () => {
      const startDate = $("teacherRangeStart").value;
      const endDate = $("teacherRangeEnd").value;
      if (!validDate(startDate) || !validDate(endDate)) { $("teacherWorkspaceMessage").textContent = "请选择完整的自定义开始日期和结束日期。"; return; }
      if (startDate > endDate) { $("teacherWorkspaceMessage").textContent = "开始日期不能晚于结束日期。"; return; }
      $("teacherWorkspaceMessage").textContent = "";
      applyRange("CUSTOM", { startDate, endDate });
    });
    $("teacherLoadMore").addEventListener("click", () => loadType(state.activeType, { append: true }));
    document.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-teacher-customer-status]");
      if (!button || button.disabled) return;
      const status = button.dataset.teacherCustomerStatus;
      const page = Number(button.dataset.page);
      if (!["ACTIVE", "ARCHIVED"].includes(status) || !Number.isInteger(page) || page < 1) return;
      const activePage = status === "ACTIVE" ? page : state.customers.ACTIVE.page;
      const archivedPage = status === "ARCHIVED" ? page : state.customers.ARCHIVED.page;
      void loadBusinessCustomers(activePage, archivedPage);
    });
  }

  function init() {
    renderProfile({});
    renderTabs();
    bindEvents();
    applyRange("MONTH");
    void loadBusinessCustomers();
    document.documentElement.dataset.prototypeVersion = VERSION;
  }
  init();
})();
