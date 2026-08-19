(() => {
  "use strict";

  const VERSION = "0.15.6";
  const type = document.body.dataset.query;
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
  const formatBirthday = (value, fallback = "—") => {
    const raw = String(value ?? "").trim();
    if (!raw) return fallback;
    const match = raw.match(/^(\d{4})[-年](\d{1,2})[-月](\d{1,2})(?:日|[T\s].*)?$/);
    return match ? `${match[1]}年${match[2].padStart(2, "0")}月${match[3].padStart(2, "0")}日` : fallback;
  };
  const formatDateTime = (value) => window.AppDateTime?.formatDate(value, "—") || "—";
  let loginSession = null;
  try { loginSession = JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); } catch (_) { loginSession = null; }

  document.documentElement.dataset.prototypeVersion = VERSION;
  if (["store", "hq"].includes(loginSession?.role)) initializeScopedRecordQuery();
  else initializeLegacyRecordQuery();

  function initializeScopedRecordQuery() {
    const isHq = loginSession?.role === "hq";
    document.body.classList.add("store-record-query");
    document.body.setAttribute("data-customer-query", "");
    document.querySelector(".topbar .subtitle").textContent = isHq
      ? `筛选全部门店或指定门店的${type === "verification" ? "核销" : "充值"}记录，或按姓名和生日查询`
      : `筛选本门店全部${type === "verification" ? "核销" : "充值"}记录，或按姓名和生日查询`;
    document.querySelector(".topbar .status").innerHTML = "<span></span>数据库记录";
    $("legacyRecordQueryMain").hidden = true;
    $("storeRecordQueryMain").hidden = false;

    const recordType = type === "verification" ? "VERIFICATION" : "RECHARGE";
    const noun = recordType === "RECHARGE" ? "充值" : "核销";
    const columnCount = recordType === "RECHARGE" ? 10 : 11;
    let mode = "browse";
    let rows = [];
    let summary = { total: 0, pending: 0, approved: 0, closed: 0, voidPending: 0 };
    let cursors = [null];
    let pageIndex = 0;
    let nextCursor = null;
    let hasMore = false;
    let requestSequence = 0;
    const statusCategoryValue = () => $("recordStatusCategory")?.value || "ALL";

    if (isHq) {
      $("recordScopeBadge").textContent = "总部可选范围";
      $("recordScopeLabel").textContent = "门店范围";
      $("recordStoreName").hidden = true;
      $("recordStoreScope").hidden = false;
      $("recordBrowseTitle").textContent = `筛选全部门店或指定门店的${noun}记录`;
      $("recordPermissionTitle").textContent = "总部范围";
      $("recordPermissionText").textContent = `可读取全部门店或指定门店的数据库${noun}单；封存门店与封存客户的历史记录仍会保留。`;
    }

    const resultData = (response) => {
      for (const candidate of [response?.result, response?.data?.result, response?.data, response]) {
        if (candidate && typeof candidate === "object" && ("ok" in candidate || "message" in candidate)) return candidate;
        try {
          const parsed = JSON.parse(candidate);
          if (parsed && typeof parsed === "object") return parsed;
        } catch (_) { /* keep looking */ }
      }
      return {};
    };
    const register = (registerComponent) => {
      try { registerComponent?.(window.cloudbase); }
      catch (error) {
        if (!String(error?.message || "").toLowerCase().includes("duplicate component")) throw error;
      }
    };
    async function call(data) {
      if (!window.cloudbase || !window.CloudBaseAuthConfig || !window.registerFunctions) {
        throw new Error("数据库组件未加载，请刷新页面后重试。");
      }
      register(window.registerAuth);
      register(window.registerFunctions);
      let response;
      try {
        response = await window.cloudbase.init(window.CloudBaseAuthConfig).callFunction({ name: "faceRecognition", data });
      } catch (error) {
        throw new Error(error?.message || "数据库查询失败，请检查网络和登录状态。");
      }
      const dataResult = resultData(response);
      if (!dataResult.ok) throw new Error(dataResult.message || "数据库没有返回有效结果。");
      return dataResult;
    }
    function notice(message = "", error = false) {
      $("recordQueryNotice").textContent = message;
      $("recordQueryNotice").classList.toggle("error", error);
    }
    function scopeLabel() {
      if (!isHq) return "本门店";
      const selected = $("recordStoreScope").selectedOptions[0];
      return $("recordStoreScope").value === "ALL" ? "全部门店" : (selected?.textContent || "所选门店");
    }
    async function loadStoreOptions() {
      if (!isHq) return;
      if (typeof window.CloudBasePhoneAuth?.listStores !== "function") {
        throw new Error("门店列表组件未加载，请刷新页面后重试。");
      }
      const stores = await window.CloudBasePhoneAuth.listStores();
      const options = (Array.isArray(stores) ? stores : []).map((store) => {
        const id = String(store.id ?? store.store_id ?? "");
        if (!/^\d+$/.test(id)) return "";
        const name = String(store.store_name || store.storeName || "未命名门店");
        const code = String(store.store_code || store.storeCode || "");
        const archived = String(store.store_status || store.storeStatus || "").toUpperCase() === "ARCHIVED";
        const label = [name, code].filter(Boolean).join(" · ") + (archived ? "（已封存）" : "");
        return `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`;
      }).join("");
      $("recordStoreScope").innerHTML = `<option value="ALL">全部门店</option>${options}`;
      $("recordStoreScope").value = "ALL";
    }
    function localDateText(date) {
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    }
    function applyTimeRange() {
      const range = $("recordTimeRange").value;
      const today = new Date();
      const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      if (range === "all") {
        $("recordDateStart").value = "";
        $("recordDateEnd").value = "";
      } else if (range !== "custom") {
        if (range === "sevenDays") start.setDate(today.getDate() - 6);
        else if (range === "month") start.setMonth(today.getMonth() - 1);
        else if (range === "quarter") start.setMonth(Math.floor(today.getMonth() / 3) * 3, 1);
        else if (range === "year") start.setMonth(0, 1);
        $("recordDateStart").value = localDateText(start);
        $("recordDateEnd").value = localDateText(today);
      }
      const custom = range === "custom";
      $("recordDateStart").disabled = !custom;
      $("recordDateEnd").disabled = !custom;
      $("recordDateStart").syncChineseDate?.();
      $("recordDateEnd").syncChineseDate?.();
    }
    function setMode(next) {
      mode = next === "manual" ? "manual" : "browse";
      if (mode === "browse") {
        $("recordCustomerName").value = "";
        $("recordCustomerBirthday").value = "";
        $("recordCustomerBirthday").syncChineseBirthday?.();
      }
      document.querySelectorAll("[data-record-query-mode]").forEach((node) => {
        node.classList.toggle("active", node.dataset.recordQueryMode === mode);
      });
      document.querySelectorAll("[data-record-query-panel]").forEach((node) => {
        node.classList.toggle("active", node.dataset.recordQueryPanel === mode);
      });
      renderCategories();
    }
    function queryPayload() {
      const cursor = cursors[pageIndex];
      const data = {
        action: "queryStoreBusinessRecords",
        recordType,
        mode,
        limit: 100
      };
      if (isHq && $("recordStoreScope").value !== "ALL") data.storeId = $("recordStoreScope").value;
      if (mode === "manual") {
        data.customerName = $("recordCustomerName").value.trim();
        data.birthDate = $("recordCustomerBirthday").value;
      } else {
        data.productId = $("recordProduct").value;
        data.statusCategory = statusCategoryValue();
        data.startDate = $("recordDateStart").value;
        data.endDate = $("recordDateEnd").value;
        if (recordType === "VERIFICATION") data.verificationType = $("recordVerificationType").value;
      }
      if (cursor) {
        data.cursorSubmittedAt = cursor.submittedAt;
        data.cursorId = cursor.id;
      }
      return data;
    }
    function fillProducts(products) {
      const target = $("recordProduct");
      const selected = target.value || "ALL";
      target.innerHTML = `<option value="ALL">全部项目</option>${(Array.isArray(products) ? products : []).map((product) => {
        const archived = String(product.productStatus || "").toUpperCase() === "ARCHIVED" ? "（已封存）" : "";
        return `<option value="${escapeHtml(product.productId)}">${escapeHtml((product.productName || "未命名项目") + archived)}</option>`;
      }).join("")}`;
      target.value = Array.from(target.options).some((option) => option.value === selected) ? selected : "ALL";
    }
    function statusTag(code) {
      const states = {
        PENDING: ["待审核", "status-审核中"],
        APPROVED: ["已通过", "status-正常"],
        REJECTED: ["已驳回", "status-已驳回"],
        VOIDED: ["已作废", "status-已作废"]
      };
      const [label, className] = states[String(code || "").toUpperCase()] || ["未记录", ""];
      return `<span class="record-status ${className}">${label}</span>`;
    }
    function voidStatusTag(code) {
      const states = {
        NONE: ["未申请", ""],
        PENDING: ["作废待审核", "status-审核中"],
        REJECTED: ["作废已驳回", "status-已驳回"],
        APPROVED: ["作废已通过", "status-已作废"]
      };
      const [label, className] = states[String(code || "NONE").toUpperCase()] || ["未记录", ""];
      return `<span class="record-status ${className}">${label}</span>`;
    }
    function verificationTypeTag(code) {
      const states = {
        NORMAL: ["正常核销", "status-正常"],
        SUPPLEMENT: ["补录核销", "status-补录"],
        EXPERIENCE: ["体验核销", ""]
      };
      const [label, className] = states[String(code || "").toUpperCase()] || ["未记录", ""];
      return `<span class="record-status ${className}">${label}</span>`;
    }
    function selectedRecordTotal() {
      return mode === "browse"
        ? ({ ALL: summary.total, PENDING: summary.pending, APPROVED: summary.approved, CLOSED: summary.closed }[statusCategoryValue()] ?? summary.total)
        : summary.total;
    }
    function renderRows() {
      const detailPage = recordType === "RECHARGE" ? "recharge-detail.html" : "verification-detail.html";
      $("recordQueryBody").innerHTML = rows.map((record) => {
        const detailLink = `${detailPage}?recordId=${encodeURIComponent(record.id)}&recordCode=${encodeURIComponent(record.recordCode)}&source=query&storeId=${encodeURIComponent(record.storeId)}`;
        const customerLink = `customer-detail.html?customerId=${encodeURIComponent(record.customerCode)}&customerName=${encodeURIComponent(record.customerName)}&storeId=${encodeURIComponent(record.storeId)}`;
        const store = [record.storeName, record.storeCode].filter(Boolean).join(" · ") || "—";
        const product = record.productName || "—";
        const commonStart = `<tr><td><a class="record-link" href="${detailLink}">${escapeHtml(record.recordCode)}</a></td><td><a class="record-link" href="${customerLink}">${escapeHtml(record.customerCode)}</a></td><td>${escapeHtml(record.customerName)}</td><td>${escapeHtml(formatBirthday(record.birthDate))}</td><td>${escapeHtml(store)}</td><td>${escapeHtml(product)}</td>`;
        if (recordType === "RECHARGE") {
          const signedUnits = String(record.originalType || "").toUpperCase() === "VOID" ? `−${Number(record.unitCount || 0)}` : `+${Number(record.unitCount || 0)}`;
          return `${commonStart}<td>${signedUnits}</td><td>${escapeHtml(formatDateTime(record.submittedAt))}</td><td>${statusTag(record.recordStatus)}</td><td>${voidStatusTag(record.voidRequestStatus)}</td></tr>`;
        }
        const teacher = [record.teacherName, record.teacherCode].filter(Boolean).join(" · ") || "未记录";
        const face = record.hasFaceRequest
          ? '<span class="photo-required-status">已核验</span>'
          : '<span class="record-status">未记录</span>';
        return `${commonStart}<td>${escapeHtml(teacher)}</td><td>${verificationTypeTag(record.originalType)}</td><td>${escapeHtml(formatDateTime(record.submittedAt))}</td><td>${face}</td><td>${statusTag(record.recordStatus)}</td></tr>`;
      }).join("") || `<tr><td colspan="${columnCount}" class="query-empty">没有符合条件的${noun}记录</td></tr>`;

      const selectedCount = selectedRecordTotal();
      const customerCount = new Set(rows.map((record) => record.customerCode)).size;
      $("recordSummary").textContent = `当前条件 ${selectedCount} 条；本页 ${rows.length} 条，涉及 ${customerCount} 位客户`;
      $("recordPageLabel").textContent = `第 ${pageIndex + 1} / ${Math.max(1, Math.ceil(selectedCount / 100))} 页`;
      $("recordPreviousPage").disabled = pageIndex === 0;
      $("recordNextPage").disabled = !hasMore;
    }
    function renderCategories() {
      if (!$("recordStatusCategory")) {
        $("recordCategoryGrid").hidden = true;
        $("recordCategoryGrid").innerHTML = "";
        return;
      }
      $("recordCategoryGrid").hidden = false;
      const labels = {
        ALL: `全部${noun}单`,
        PENDING: "待审核",
        APPROVED: "已通过",
        CLOSED: "已驳回／已作废"
      };
      const counts = { ALL: summary.total, PENDING: summary.pending, APPROVED: summary.approved, CLOSED: summary.closed };
      const selected = mode === "browse" ? statusCategoryValue() : "";
      $("recordCategoryGrid").innerHTML = Object.entries(labels).map(([key, label]) => `<button class="customer-category-card ${selected === key ? "selected" : ""}" data-record-category="${key}"><span>${label}</span><strong>${Number(counts[key] || 0)}</strong><small>数据库汇总</small></button>`).join("");
      document.querySelectorAll("[data-record-category]").forEach((button) => {
        button.onclick = () => {
          $("recordStatusCategory").value = button.dataset.recordCategory;
          setMode("browse");
          load({ resetPage: true });
        };
      });
    }
    async function load({ resetPage = true } = {}) {
      if (resetPage) {
        cursors = [null];
        pageIndex = 0;
      }
      const sequence = ++requestSequence;
      const currentScope = scopeLabel();
      notice(`正在从数据库读取${currentScope}${noun}记录…`);
      $("recordQueryBody").innerHTML = `<tr><td colspan="${columnCount}" class="query-empty">正在从数据库读取${escapeHtml(currentScope)}${noun}记录…</td></tr>`;
      $("runRecordQuery").disabled = true;
      $("recordPreviousPage").disabled = true;
      $("recordNextPage").disabled = true;
      try {
        const data = await call(queryPayload());
        if (sequence !== requestSequence) return false;
        rows = Array.isArray(data.records) ? data.records : [];
        summary = { total: 0, pending: 0, approved: 0, closed: 0, voidPending: 0, ...(data.summary || {}) };
        hasMore = data.hasMore === true;
        nextCursor = data.nextCursor || null;
        fillProducts(data.products);
        if (!isHq) $("recordStoreName").textContent = [data.storeName || "当前门店", data.storeCode || ""].filter(Boolean).join(" · ");
        renderCategories();
        renderRows();
        const canIncludeVoidSummary = recordType === "RECHARGE" && (mode !== "browse" || ["ALL", "APPROVED"].includes(statusCategoryValue()));
        const voidNotice = canIncludeVoidSummary && Number(summary.voidPending || 0) > 0
          ? `，其中 ${Number(summary.voidPending)} 条正在等待作废审核`
          : "";
        notice(`${currentScope}数据库查询完成，共 ${Number(selectedRecordTotal() || 0)} 条${noun}记录${voidNotice}。`);
        return true;
      } catch (error) {
        if (sequence !== requestSequence) return false;
        rows = [];
        summary = { total: 0, pending: 0, approved: 0, closed: 0, voidPending: 0 };
        hasMore = false;
        nextCursor = null;
        $("recordSummary").textContent = "数据库读取失败";
        $("recordQueryBody").innerHTML = `<tr><td colspan="${columnCount}" class="query-empty">${escapeHtml(error.message)}</td></tr>`;
        $("recordCategoryGrid").innerHTML = "";
        $("recordPreviousPage").disabled = pageIndex === 0;
        $("recordNextPage").disabled = true;
        notice(error.message || "数据库读取失败", true);
        return false;
      } finally {
        if (sequence === requestSequence) $("runRecordQuery").disabled = false;
      }
    }

    applyTimeRange();
    document.querySelectorAll("[data-record-query-mode]").forEach((button) => {
      button.onclick = () => {
        setMode(button.dataset.recordQueryMode);
        load({ resetPage: true });
      };
    });
    ["recordProduct", "recordStatusCategory"].forEach((id) => {
      if ($(id)) $(id).onchange = () => { setMode("browse"); load({ resetPage: true }); };
    });
    if (recordType === "VERIFICATION") {
      $("recordVerificationType").onchange = () => { setMode("browse"); load({ resetPage: true }); };
    }
    $("recordTimeRange").onchange = () => { applyTimeRange(); setMode("browse"); load({ resetPage: true }); };
    ["recordDateStart", "recordDateEnd"].forEach((id) => {
      $(id).onchange = () => { setMode("browse"); load({ resetPage: true }); };
    });
    $("recordCustomerName").oninput = () => setMode("manual");
    $("recordCustomerBirthday").onchange = () => { setMode("manual"); load({ resetPage: true }); };
    $("runRecordQuery").onclick = () => load({ resetPage: true });
    if (isHq) {
      $("recordStoreScope").onchange = () => {
        $("recordProduct").value = "ALL";
        load({ resetPage: true });
      };
    }
    $("resetRecordQuery").onclick = () => {
      if (isHq) $("recordStoreScope").value = "ALL";
      $("recordProduct").value = "ALL";
      if ($("recordStatusCategory")) $("recordStatusCategory").value = "ALL";
      if (recordType === "VERIFICATION") $("recordVerificationType").value = "ALL";
      $("recordCustomerName").value = "";
      $("recordCustomerBirthday").value = "";
      $("recordCustomerBirthday").syncChineseBirthday?.();
      $("recordTimeRange").value = "all";
      applyTimeRange();
      setMode("browse");
      load({ resetPage: true });
    };
    $("recordPreviousPage").onclick = () => {
      if (pageIndex === 0) return;
      pageIndex -= 1;
      load({ resetPage: false });
    };
    $("recordNextPage").onclick = () => {
      if (!hasMore || !nextCursor) return;
      cursors[pageIndex + 1] = nextCursor;
      pageIndex += 1;
      load({ resetPage: false });
    };
    setMode("browse");
    if (isHq) {
      loadStoreOptions()
        .then(() => load({ resetPage: true }))
        .catch(async (error) => {
          const loaded = await load({ resetPage: true });
          if (loaded) notice(`已显示全部门店${noun}记录；${error.message || "门店列表读取失败"}`, true);
        });
    } else {
      load({ resetPage: true });
    }
  }

  // Operation keeps its existing shell. The database query contract above is
  // deliberately limited to HQ and store identities on both client and server.
  function initializeLegacyRecordQuery() {
    $("storeRecordQueryMain").hidden = true;
    $("legacyRecordQueryMain").hidden = false;
    const scopedStoreId = loginSession?.role === "store" ? loginSession.store : "";
    const stores = [];
    const projects = [];
    const records = [];
    let lookupMode = "select";
    const customers = [];
    const statusTag = (status) => `<span class="record-status status-${status}">${status}</span>`;
    const selectedStoreId = () => scopedStoreId || $("queryStore").value;
    const isoDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    function applyTimeRange() {
      const range = $("queryTimeRange").value;
      const today = new Date();
      const start = new Date(today);
      if (range === "sevenDays") start.setDate(today.getDate() - 6);
      else if (range === "month") start.setMonth(today.getMonth() - 1);
      else if (range === "quarter") start.setMonth(Math.floor(today.getMonth() / 3) * 3, 1);
      else if (range === "year") start.setMonth(0, 1);
      else start.setFullYear(today.getFullYear() - 1);
      if (range !== "custom" || !$("queryDateStart").value || !$("queryDateEnd").value) {
        $("queryDateStart").value = isoDate(start);
        $("queryDateEnd").value = isoDate(today);
      }
      $("queryDateStart").disabled = range !== "custom";
      $("queryDateEnd").disabled = range !== "custom";
      $("queryDateStart").syncChineseDate?.();
      $("queryDateEnd").syncChineseDate?.();
    }
    function availableCustomers() {
      const storeId = selectedStoreId();
      const byId = new Map();
      records.filter((record) => storeId === "all" || record.store.id === storeId).forEach((record) => byId.set(record.customer.id, record.customer));
      customers.forEach((customer) => byId.set(customer.id, customer));
      return [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, "zh-CN"));
    }
    function updateSelectedBirthday() {
      const customer = availableCustomers().find((item) => item.id === $("queryCustomerSelect").value);
      $("querySelectBirthday").value = formatBirthday(customer?.birthday, "");
    }
    function fillCustomerSelect() {
      const previous = $("queryCustomerSelect").value;
      const visible = availableCustomers();
      $("queryCustomerSelect").innerHTML = `<option value="all">全部现有客户</option>${visible.map((customer) => `<option value="${customer.id}">${customer.displayName}（${customer.id}）</option>`).join("")}`;
      $("queryCustomerSelect").value = visible.some((customer) => customer.id === previous) ? previous : "all";
      updateSelectedBirthday();
    }
    function fillFilters() {
      const visibleStores = scopedStoreId ? stores.filter((store) => store.id === scopedStoreId) : stores;
      $("queryStore").innerHTML = `${scopedStoreId ? "" : '<option value="all">全部门店</option>'}${visibleStores.map((store) => `<option value="${store.id}">${store.name}（${store.id}）</option>`).join("")}`;
      if (scopedStoreId) { $("queryStore").value = scopedStoreId; $("queryStore").disabled = true; }
      $("queryProject").innerHTML = `<option value="all">全部项目</option>${projects.map((project) => `<option value="${project.id}">${project.name}（${project.id}）</option>`).join("")}`;
      fillCustomerSelect();
    }
    function renderCustomerMatches() {
      if (lookupMode === "select") {
        const customer = availableCustomers().find((item) => item.id === $("queryCustomerSelect").value);
        $("queryCustomerMatches").innerHTML = customer ? `<strong>${customer.displayName}</strong><span>${customer.id} · ${formatBirthday(customer.birthday)}</span>` : "选择具体客户可按客户编号精确查询。";
        return;
      }
      const term = $("queryCustomerManual").value.trim();
      const birthday = $("queryCustomerBirthday").value;
      if (!term) { $("queryCustomerMatches").textContent = "请输入客户姓名；同名客户会全部列出并同时显示客户编号。"; return; }
      const matches = availableCustomers().filter((customer) => customer.name.includes(term) && (!birthday || customer.birthday === birthday));
      $("queryCustomerMatches").innerHTML = matches.length ? `<strong>匹配 ${matches.length} 位客户：</strong>${matches.map((customer) => `<span>${customer.displayName}（${customer.id}）· ${formatBirthday(customer.birthday)}</span>`).join("")}` : "未找到姓名和生日匹配的客户。";
    }
    function render() {
      const storeId = selectedStoreId();
      const selectedId = $("queryCustomerSelect").value;
      const manualName = $("queryCustomerManual").value.trim();
      const manualBirthday = $("queryCustomerBirthday").value;
      const start = $("queryDateStart").value;
      const end = $("queryDateEnd").value;
      const selected = records.filter((record) => (storeId === "all" || record.store.id === storeId) && (lookupMode === "select" ? selectedId === "all" || record.customer.id === selectedId : (!manualName || record.customer.name.includes(manualName)) && (!manualBirthday || record.customer.birthday === manualBirthday)) && ($("queryProject").value === "all" || record.project.id === $("queryProject").value) && (!start || record.dateKey >= start) && (!end || record.dateKey <= end));
      $("querySummary").textContent = `共 ${selected.length} 条记录，涉及 ${new Set(selected.map((record) => record.customer.id)).size} 位客户；${lookupMode === "select" ? "现有客户按编号精确筛选" : "手动姓名匹配会保留全部同名客户"}`;
      $("queryBody").innerHTML = selected.map((record) => {
        const date = `2026-${String(record.month).padStart(2, "0")}-${String(record.day).padStart(2, "0")} ${String(9 + record.day % 10).padStart(2, "0")}:${String(10 + record.month).padStart(2, "0")}:${String(5 + record.day).padStart(2, "0")}`;
        const detailPage = type === "recharge" ? "recharge-detail.html" : "verification-detail.html";
        const detail = `${detailPage}?recordId=${encodeURIComponent(record.id)}&customerId=${encodeURIComponent(record.customer.id)}&customerName=${encodeURIComponent(record.customer.displayName)}&storeId=${encodeURIComponent(record.store.id)}`;
        const recordLink = `<a class="record-link" href="${detail}">${record.id}</a>`;
        const customerLink = `<a class="record-link" href="customer-detail.html?customerId=${record.customer.id}&customerName=${encodeURIComponent(record.customer.displayName)}&storeId=${record.store.id}">${record.customer.id}</a>`;
        const canOpenAggregates = loginSession?.role === "hq";
        const teacherLink = canOpenAggregates ? `<a class="record-link" href="teacher-detail.html?teacherId=${encodeURIComponent(record.teacher.id)}">${record.teacher.name}（${record.teacher.id}）</a>` : `${record.teacher.name}（${record.teacher.id}）`;
        const storeLink = canOpenAggregates ? `<a class="record-link" href="store-detail.html?storeId=${encodeURIComponent(record.store.id)}">${record.store.name}</a>` : record.store.name;
        const projectLink = canOpenAggregates ? `<a class="record-link" href="project-detail.html?projectId=${encodeURIComponent(record.project.id)}">${record.project.name}</a>` : record.project.name;
        return type === "recharge" ? `<tr><td>${recordLink}</td><td>${customerLink}</td><td>${record.customer.displayName}</td><td>${formatBirthday(record.customer.birthday)}</td><td>${storeLink}</td><td>${projectLink}</td><td>+${record.amount}</td><td>${date}</td><td>${statusTag(record.status)}</td><td>${statusTag(record.reviewProgress)}</td></tr>` : `<tr><td>${recordLink}</td><td>${customerLink}</td><td>${record.customer.displayName}</td><td>${formatBirthday(record.customer.birthday)}</td><td>${storeLink}</td><td>${projectLink}</td><td>${teacherLink}</td><td>${date}</td><td><span class="photo-required-status">已拍摄</span></td><td>${statusTag(record.status)}</td><td>${statusTag(record.reviewProgress)}</td></tr>`;
      }).join("") || `<tr><td colspan="${type === "recharge" ? 10 : 11}" class="query-empty">当前组合条件下没有记录</td></tr>`;
    }
    function setLookupMode(next) {
      lookupMode = next;
      $("querySelectCustomerField").hidden = next !== "select";
      $("querySelectBirthdayField").hidden = next !== "select";
      $("queryManualCustomerField").hidden = next !== "manual";
      $("queryManualBirthdayField").hidden = next !== "manual";
      document.querySelectorAll("[data-query-mode]").forEach((button) => button.classList.toggle("active", button.dataset.queryMode === next));
      renderCustomerMatches();
      render();
    }

    fillFilters();
    applyTimeRange();
    $("queryStore").addEventListener("change", () => { fillCustomerSelect(); renderCustomerMatches(); render(); });
    $("queryCustomerSelect").addEventListener("change", () => { updateSelectedBirthday(); renderCustomerMatches(); render(); });
    $("queryCustomerManual").addEventListener("input", () => { renderCustomerMatches(); render(); });
    $("queryCustomerBirthday").addEventListener("change", () => { renderCustomerMatches(); render(); });
    $("queryProject").addEventListener("change", render);
    $("queryTimeRange").addEventListener("change", () => { applyTimeRange(); render(); });
    ["queryDateStart", "queryDateEnd"].forEach((id) => $(id).addEventListener("change", render));
    document.querySelectorAll("[data-query-mode]").forEach((button) => button.addEventListener("click", () => setLookupMode(button.dataset.queryMode)));
    $("resetQuery").addEventListener("click", () => {
      $("queryStore").value = scopedStoreId || "all";
      $("queryProject").value = "all";
      $("queryCustomerManual").value = "";
      $("queryCustomerBirthday").value = "";
      $("queryTimeRange").value = "custom";
      applyTimeRange();
      fillCustomerSelect();
      $("queryCustomerSelect").value = "all";
      updateSelectedBirthday();
      setLookupMode("select");
    });
    setLookupMode("select");
  }
})();
