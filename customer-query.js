(() => {
  "use strict";

  const VERSION = "0.15.3";
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
  const localDateText = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const stage = {
    INFORMATION_ONLY: "有信息但没有充值",
    RECHARGED_NO_CONSUMPTION: "已充值但没有消费",
    RECHARGED_WITH_CONSUMPTION: "已充值并已有消费"
  };
  const processByCategory = {
    all: "ALL",
    registered: "INFORMATION_ONLY",
    charged: "RECHARGED_NO_CONSUMPTION",
    consumed: "RECHARGED_WITH_CONSUMPTION"
  };

  let loginSession = null;
  try { loginSession = JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); }
  catch (_) { loginSession = null; }
  const isHq = loginSession?.role === "hq";
  const canQuery = ["store", "hq"].includes(loginSession?.role);
  let mode = "select";
  let rows = [];
  let summary = emptySummary();
  let pending = null;
  let cursors = [null];
  let pageIndex = 0;
  let nextCursor = null;
  let hasMore = false;
  let requestSequence = 0;

  document.documentElement.dataset.prototypeVersion = VERSION;

  function emptySummary() {
    return {
      total: 0,
      selectedTotal: 0,
      active: 0,
      archived: 0,
      informationOnly: 0,
      rechargedNoConsumption: 0,
      rechargedWithConsumption: 0
    };
  }

  function resultData(response) {
    for (const candidate of [response?.result, response?.data?.result, response?.data, response]) {
      if (candidate && typeof candidate === "object" && ("ok" in candidate || "message" in candidate)) return candidate;
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === "object") return parsed;
      } catch (_) { /* keep looking */ }
    }
    return {};
  }

  function register(registerComponent) {
    try { registerComponent?.(window.cloudbase); }
    catch (error) {
      if (!String(error?.message || "").toLowerCase().includes("duplicate component")) throw error;
    }
  }

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
    $("customerQueryNotice").textContent = message;
    $("customerQueryNotice").classList.toggle("error", error);
  }

  function scopeLabel() {
    if (!isHq) return "本门店";
    const selected = $("customerStoreScope").selectedOptions[0];
    return $("customerStoreScope").value === "ALL" ? "全部门店" : (selected?.textContent || "所选门店");
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
    $("customerStoreScope").innerHTML = `<option value="ALL">全部门店</option>${options}`;
    $("customerStoreScope").value = "ALL";
  }

  function queryPayload() {
    const data = {
      action: "queryStoreCustomers",
      mode: mode === "manual" ? "manual" : "browse",
      limit: 100
    };
    if (isHq && $("customerStoreScope").value !== "ALL") data.storeId = $("customerStoreScope").value;
    if (mode === "manual") {
      data.name = $("customerName").value.trim();
      data.birthDate = $("customerBirthday").value;
    } else {
      data.processStatus = processByCategory[$("customerCategory").value] || "ALL";
      data.customerStatus = $("customerArchive").value;
      data.startDate = $("customerDateStart").value;
      data.endDate = $("customerDateEnd").value;
    }
    const cursor = cursors[pageIndex];
    if (cursor) {
      data.cursorCreatedAt = cursor.createdAt;
      data.cursorId = cursor.id;
    }
    return data;
  }

  function selectedTotal() {
    if (Number.isFinite(Number(summary.selectedTotal))) return Number(summary.selectedTotal);
    if (mode !== "select") return Number(summary.total || 0);
    return {
      all: summary.total,
      registered: summary.informationOnly,
      charged: summary.rechargedNoConsumption,
      consumed: summary.rechargedWithConsumption
    }[$("customerCategory").value] || 0;
  }

  function renderRows() {
    $("customerQueryBody").innerHTML = rows.map((customer) => {
      const archived = customer.customerStatus === "ARCHIVED";
      const birthday = String(customer.birthDate || "").replace(/^(\d{4})-(\d{2})-(\d{2}).*/, "$1年$2月$3日");
      const link = `customer-detail.html?customerId=${encodeURIComponent(customer.customerCode)}&customerName=${encodeURIComponent(customer.customerName)}&storeId=${encodeURIComponent(customer.storeId || "")}`;
      return `<tr><td><a class="record-link" href="${link}">${escapeHtml(customer.customerCode)}</a></td><td>${escapeHtml(customer.customerName)}</td><td>${birthday || "—"}</td><td>${escapeHtml([customer.storeName, customer.storeCode].filter(Boolean).join(" · ") || "—")}</td><td>${escapeHtml(stage[customer.customerProcessStatus] || "—")}</td><td>${Number(customer.totalRechargeCount || 0)}</td><td>${Number(customer.totalVerificationCount || 0)}</td><td><span class="record-status ${archived ? "status-已作废" : "status-正常"}">${archived ? "封存" : "活跃"}</span></td><td><button class="archive-customer-button" data-code="${escapeHtml(customer.customerCode)}" data-status="${customer.customerStatus}">${archived ? "恢复为活跃" : "封存客户"}</button></td></tr>`;
    }).join("") || '<tr><td colspan="9" class="query-empty">没有符合条件的客户</td></tr>';
    document.querySelectorAll("[data-code]").forEach((button) => {
      button.onclick = () => openStatus(button.dataset.code, button.dataset.status);
    });

    const total = selectedTotal();
    $("customerSummary").textContent = `当前条件 ${total} 位；本页 ${rows.length} 位；活跃 ${Number(summary.active || 0)} 位，封存 ${Number(summary.archived || 0)} 位`;
    $("customerPageLabel").textContent = `第 ${pageIndex + 1} / ${Math.max(1, Math.ceil(total / 100))} 页`;
    $("customerPreviousPage").disabled = pageIndex === 0;
    $("customerNextPage").disabled = !hasMore;
  }

  function renderCategories() {
    const counts = {
      all: summary.total,
      registered: summary.informationOnly,
      charged: summary.rechargedNoConsumption,
      consumed: summary.rechargedWithConsumption
    };
    const labels = {
      all: "全部客户",
      registered: "有信息但没有充值",
      charged: "已充值但没有消费",
      consumed: "已充值并已有消费"
    };
    $("customerCategoryGrid").innerHTML = Object.entries(labels).map(([key, label]) => `<button class="customer-category-card ${mode === "select" && $("customerCategory").value === key ? "selected" : ""}" data-category="${key}"><span>${label}</span><strong>${Number(counts[key] || 0)}</strong><small>数据库汇总</small></button>`).join("");
    document.querySelectorAll("[data-category]").forEach((button) => {
      button.onclick = () => {
        $("customerCategory").value = button.dataset.category;
        setMode("select");
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
    notice(`正在从数据库读取${currentScope}客户…`);
    $("customerQueryBody").innerHTML = `<tr><td colspan="9" class="query-empty">正在从数据库读取${escapeHtml(currentScope)}客户…</td></tr>`;
    $("runCustomerQuery").disabled = true;
    $("customerPreviousPage").disabled = true;
    $("customerNextPage").disabled = true;
    try {
      const data = await call(queryPayload());
      if (sequence !== requestSequence) return false;
      rows = Array.isArray(data.customers) ? data.customers : [];
      summary = { ...emptySummary(), ...(data.summary || {}) };
      hasMore = data.hasMore === true;
      nextCursor = data.nextCursor || null;
      if (!isHq) $("customerStoreName").textContent = [data.storeName || "当前门店", data.storeCode || ""].filter(Boolean).join(" · ");
      renderCategories();
      renderRows();
      notice(`${currentScope}数据库查询完成，共找到 ${selectedTotal()} 位客户。`);
      return true;
    } catch (error) {
      if (sequence !== requestSequence) return false;
      rows = [];
      summary = emptySummary();
      hasMore = false;
      nextCursor = null;
      $("customerSummary").textContent = "数据库读取失败";
      $("customerQueryBody").innerHTML = `<tr><td colspan="9" class="query-empty">${escapeHtml(error.message)}</td></tr>`;
      $("customerCategoryGrid").innerHTML = "";
      $("customerPreviousPage").disabled = pageIndex === 0;
      $("customerNextPage").disabled = true;
      notice(error.message || "数据库读取失败", true);
      return false;
    } finally {
      if (sequence === requestSequence) $("runCustomerQuery").disabled = false;
    }
  }

  function setMode(next) {
    const normalized = next === "manual" ? "manual" : "select";
    if (normalized !== mode) {
      if (normalized === "select") {
        $("customerName").value = "";
        $("customerBirthday").value = "";
        $("customerBirthday").syncChineseBirthday?.();
      } else {
        $("customerCategory").value = "all";
        $("customerArchive").value = "all";
      }
    }
    mode = normalized;
    document.querySelectorAll("[data-customer-query-mode]").forEach((node) => node.classList.toggle("active", node.dataset.customerQueryMode === mode));
    document.querySelectorAll("[data-customer-query-panel]").forEach((node) => node.classList.toggle("active", node.dataset.customerQueryPanel === mode));
    renderCategories();
  }

  function openStatus(code, status) {
    pending = { code, status };
    const archived = status === "ARCHIVED";
    $("customerActionTitle").textContent = archived ? "恢复为活跃" : "设为存档";
    $("customerActionText").textContent = archived ? `将客户 ${code} 恢复为活跃。` : `将客户 ${code} 设为存档。`;
    $("customerActionDialog").showModal();
  }

  async function confirmStatus() {
    if (!pending) return;
    try {
      await call({
        action: "updateCustomerStatus",
        customerCode: pending.code,
        expectedStatus: pending.status,
        targetStatus: pending.status === "ARCHIVED" ? "ACTIVE" : "ARCHIVED"
      });
      $("customerActionDialog").close();
      await load({ resetPage: true });
    } catch (error) {
      $("customerActionText").textContent = error.message;
    }
  }

  function applyTimeRange() {
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const range = $("customerTimeRange").value;
    if (range === "all") {
      $("customerDateStart").value = "";
      $("customerDateEnd").value = "";
    } else {
      if (range === "sevenDays") start.setDate(today.getDate() - 6);
      else if (range === "month") start.setMonth(today.getMonth() - 1);
      else if (range === "quarter") start.setMonth(Math.floor(today.getMonth() / 3) * 3, 1);
      else if (range === "year") start.setMonth(0, 1);
      if (range !== "custom" || !$("customerDateStart").value) {
        $("customerDateStart").value = localDateText(start);
        $("customerDateEnd").value = localDateText(today);
      }
    }
    const custom = range === "custom";
    $("customerDateStart").disabled = !custom;
    $("customerDateEnd").disabled = !custom;
    $("customerDateStart").syncChineseDate?.();
    $("customerDateEnd").syncChineseDate?.();
  }

  function configureRoleUi() {
    if (!isHq) return;
    document.querySelector(".topbar .subtitle").textContent = "筛选全部门店或指定门店的客户，或按姓名和生日查询";
    document.querySelector(".topbar .status").innerHTML = "<span></span>数据库记录";
    $("customerScopeBadge").textContent = "总部可选范围";
    $("customerScopeLabel").textContent = "门店范围";
    $("customerStoreName").hidden = true;
    $("customerStoreScope").hidden = false;
    $("customerBrowseTitle").textContent = "筛选全部门店或指定门店的客户";
    $("customerPermissionTitle").textContent = "总部权限";
    $("customerPermissionText").textContent = "可查看全部门店或指定门店客户，并将客户档案存档或恢复为活跃。";
  }

  function bindEvents() {
    document.querySelectorAll("[data-customer-query-mode]").forEach((node) => {
      node.onclick = () => {
        setMode(node.dataset.customerQueryMode);
        load({ resetPage: true });
      };
    });
    ["customerCategory", "customerArchive", "customerDateStart", "customerDateEnd"].forEach((id) => {
      $(id).onchange = () => { setMode("select"); load({ resetPage: true }); };
    });
    $("customerTimeRange").onchange = () => { applyTimeRange(); setMode("select"); load({ resetPage: true }); };
    $("customerName").oninput = () => setMode("manual");
    $("customerBirthday").onchange = () => { setMode("manual"); load({ resetPage: true }); };
    $("runCustomerQuery").onclick = () => load({ resetPage: true });
    if (isHq) $("customerStoreScope").onchange = () => load({ resetPage: true });
    $("resetCustomerQuery").onclick = () => {
      if (isHq) $("customerStoreScope").value = "ALL";
      $("customerCategory").value = "all";
      $("customerArchive").value = "all";
      $("customerName").value = "";
      $("customerBirthday").value = "";
      $("customerBirthday").syncChineseBirthday?.();
      $("customerTimeRange").value = "all";
      applyTimeRange();
      setMode("select");
      load({ resetPage: true });
    };
    $("customerPreviousPage").onclick = () => {
      if (pageIndex === 0) return;
      pageIndex -= 1;
      load({ resetPage: false });
    };
    $("customerNextPage").onclick = () => {
      if (!hasMore || !nextCursor) return;
      cursors[pageIndex + 1] = nextCursor;
      pageIndex += 1;
      load({ resetPage: false });
    };
    $("closeCustomerAction").onclick = $("cancelCustomerAction").onclick = () => $("customerActionDialog").close();
    $("confirmCustomerAction").onclick = confirmStatus;
  }

  async function initialize() {
    configureRoleUi();
    applyTimeRange();
    bindEvents();
    setMode("select");
    if (!canQuery) {
      notice("当前身份未开放总部或门店客户查询。", true);
      $("customerQueryBody").innerHTML = '<tr><td colspan="9" class="query-empty">当前身份无权查询客户</td></tr>';
      $("runCustomerQuery").disabled = true;
      $("customerPreviousPage").disabled = true;
      $("customerNextPage").disabled = true;
      return;
    }
    let storeOptionsError = "";
    if (isHq) {
      try { await loadStoreOptions(); }
      catch (error) { storeOptionsError = error.message || "门店列表读取失败"; }
    }
    const loaded = await load({ resetPage: true });
    if (loaded && storeOptionsError) notice(`已显示全部门店客户；${storeOptionsError}`, true);
  }

  initialize();
})();
