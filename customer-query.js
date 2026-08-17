(() => {
  "use strict";
  const VERSION = "0.14.20", $ = (id) => document.getElementById(id);
  const formatBirthday = (value, fallback = "") => {
    const raw = String(value ?? "").trim();
    if (!raw) return fallback;
    const match = raw.match(/^(\d{4})[-年](\d{1,2})[-月](\d{1,2})(?:日|[T\s].*)?$/);
    return match ? `${match[1]}年${match[2].padStart(2, "0")}月${match[3].padStart(2, "0")}日` : raw;
  };
  let loginSession = null;
  try { loginSession = JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); } catch (_) { loginSession = null; }
  const scopedStoreId = loginSession?.role === "store" ? loginSession.store : "";
  let createdStores = [];
  try { createdStores = JSON.parse(sessionStorage.getItem("prototypeCreatedStores") || "[]"); } catch (_) { createdStores = []; }
  const stores = createdStores.map((store) => ({ id: store.id, name: store.name || store.id }));
  let customerOverrides = {};
  try { customerOverrides = JSON.parse(sessionStorage.getItem("prototypeCustomerOverrides") || "{}"); } catch (_) { customerOverrides = {}; }
  const baseCustomers = [];
  let createdCustomers = [];
  try { createdCustomers = JSON.parse(sessionStorage.getItem("prototypeCreatedCustomers") || "[]"); } catch (_) { createdCustomers = []; }
  const customers = [...baseCustomers, ...createdCustomers.map((customer) => ({ ...customer, ...(customerOverrides[customer.id] || {}), store: stores.find((store) => store.id === customer.storeId) || { id: customer.storeId, name: customer.storeId }, createdDate: customer.createdDate || new Date().toISOString().slice(0, 10), recharge: 0, verification: 0 }))];
  const categoryOf = (customer) => customer.recharge === 0 ? "registered" : customer.verification === 0 ? "charged" : "consumed";
  const categoryLabels = { all: "全部客户", registered: "有信息但没有充值", charged: "已充值但没有消费", consumed: "已充值并已有消费" };
  let archived = new Set(), pendingAction = null, lookupMode = "select";
  try { archived = new Set(JSON.parse(sessionStorage.getItem("prototypeArchivedCustomers") || "[]")); } catch (_) { archived = new Set(); }

  function saveArchive(action) {
    try {
      sessionStorage.setItem("prototypeArchivedCustomers", JSON.stringify([...archived]));
      const audit = JSON.parse(sessionStorage.getItem("prototypeCustomerStatusAudit") || "[]");
      audit.push(action); sessionStorage.setItem("prototypeCustomerStatusAudit", JSON.stringify(audit));
    } catch (_) { /* 静态演示状态仅在当前会话有效；正式系统必须服务端审计。 */ }
  }
  function allowedCustomers() { return scopedStoreId ? customers.filter((customer) => customer.store.id === scopedStoreId) : customers; }
  function renderStoreContext() {
    const store = stores.find((item) => String(item.id) === String(scopedStoreId));
    const customerStore = customers.find((item) => String(item.store?.id) === String(scopedStoreId))?.store;
    const storeName = String(loginSession?.storeName || store?.name || customerStore?.name || (scopedStoreId ? `门店 ${scopedStoreId}` : "当前账号全部门店"));
    const storeCode = String(loginSession?.storeCode || store?.id || customerStore?.code || customerStore?.id || scopedStoreId || "全部门店");
    $("customerStoreName").textContent = storeName;
    $("customerStoreCode").textContent = `门店编号：${storeCode}`;
  }
  function customersForSelectedStore() {
    return allowedCustomers().sort((a, b) => a.name.localeCompare(b.name, "zh-CN") || a.id.localeCompare(b.id));
  }
  function updateSelectedCustomer() {
    const customer = customersForSelectedStore().find((item) => item.id === $("customerSelect").value);
    $("customerSelectBirthday").value = formatBirthday(customer?.birthday);
  }
  function fillCustomerSelect() {
    const previous = $("customerSelect").value, visible = customersForSelectedStore();
    $("customerSelect").innerHTML = `<option value="">请选择本门店客户</option><option value="all">全部本门店客户</option>${visible.map((customer) => `<option value="${customer.id}">${customer.name}（${customer.id}）</option>`).join("")}`;
    $("customerSelect").value = visible.some((customer) => customer.id === previous) ? previous : "all";
    updateSelectedCustomer();
  }
  function setLookupMode(mode, { clearOpposite = true } = {}) {
    const changed = lookupMode !== mode;
    lookupMode = mode;
    if (clearOpposite && changed && mode === "select") {
      $("customerName").value = ""; $("customerBirthday").value = ""; $("customerBirthday").syncChineseBirthday?.();
      if (!$("customerSelect").value) $("customerSelect").value = "all";
      updateSelectedCustomer();
    } else if (clearOpposite && changed) {
      $("customerSelect").value = ""; $("customerSelectBirthday").value = "";
    }
    document.querySelectorAll("[data-customer-query-mode]").forEach((button) => { const selected = button.dataset.customerQueryMode === mode; button.classList.toggle("active", selected); button.setAttribute("aria-pressed", String(selected)); });
    document.querySelectorAll("[data-customer-query-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.customerQueryPanel === mode));
    render();
  }
  const isoDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  function applyTimeRange() {
    const range = $("customerTimeRange").value, today = new Date(), start = new Date(today);
    if (range === "sevenDays") start.setDate(today.getDate() - 6);
    else if (range === "month") start.setMonth(today.getMonth() - 1);
    else if (range === "quarter") start.setMonth(Math.floor(today.getMonth() / 3) * 3, 1);
    else if (range === "year") start.setMonth(0, 1);
    else start.setFullYear(today.getFullYear() - 1);
    if (range !== "custom" || !$("customerDateStart").value || !$("customerDateEnd").value) { $("customerDateStart").value = isoDate(start); $("customerDateEnd").value = isoDate(today); }
    $("customerDateStart").disabled = range !== "custom"; $("customerDateEnd").disabled = range !== "custom";
  }
  function matchesBaseFilters(customer, includeCategory = true) {
    const category = $("customerCategory").value, state = $("customerArchive").value;
    const selectedId = $("customerSelect").value, name = $("customerName").value.trim(), birthday = $("customerBirthday").value, isArchived = archived.has(customer.id), start = $("customerDateStart").value, end = $("customerDateEnd").value;
    const customerMatch = lookupMode === "select" ? selectedId === "all" || customer.id === selectedId : (!name || customer.name.includes(name)) && (!birthday || customer.birthday === birthday);
    return customerMatch && (!includeCategory || category === "all" || categoryOf(customer) === category) && (state === "all" || (state === "archived") === isArchived) && (!start || customer.createdDate >= start) && (!end || customer.createdDate <= end);
  }
  function selectedCustomers() { return allowedCustomers().filter((customer) => matchesBaseFilters(customer)); }
  function renderCategories() {
    const source = allowedCustomers().filter((customer) => matchesBaseFilters(customer, false));
    $("customerCategoryGrid").innerHTML = Object.entries(categoryLabels).map(([key, label]) => {
      const count = key === "all" ? source.length : source.filter((customer) => categoryOf(customer) === key).length;
      return `<button class="customer-category-card ${$("customerCategory").value === key ? "selected" : ""}" data-category="${key}"><span>${label}</span><strong>${count}</strong><small>当前客户状态范围</small></button>`;
    }).join("");
    document.querySelectorAll("[data-category]").forEach((button) => button.addEventListener("click", () => { $("customerCategory").value = button.dataset.category; render(); }));
  }
  function render() {
    const selected = selectedCustomers(), activeCount = selected.filter((customer) => !archived.has(customer.id)).length;
    $("customerSummary").textContent = `共 ${selected.length} 位客户；活跃 ${activeCount} 位，封存 ${selected.length - activeCount} 位`;
    $("customerQueryBody").innerHTML = selected.map((customer) => {
      const isArchived = archived.has(customer.id), detail = `customer-detail.html?customerId=${encodeURIComponent(customer.id)}&customerName=${encodeURIComponent(customer.name)}&storeId=${encodeURIComponent(customer.store.id)}`;
      return `<tr><td><a class="record-link" href="${detail}">${customer.id}</a></td><td>${customer.name}</td><td>${formatBirthday(customer.birthday)}</td><td>${customer.store.name}（${customer.store.id}）</td><td>${categoryLabels[categoryOf(customer)]}</td><td>${customer.recharge}</td><td>${customer.verification}</td><td><span class="record-status ${isArchived ? "status-已作废" : "status-正常"}">${isArchived ? "封存" : "活跃"}</span></td><td><button class="archive-customer-button" data-archive-id="${customer.id}" type="button">${isArchived ? "恢复为活跃" : "封存客户"}</button></td></tr>`;
    }).join("") || `<tr><td colspan="9" class="query-empty">没有符合条件的客户</td></tr>`;
    document.querySelectorAll("[data-archive-id]").forEach((button) => button.addEventListener("click", () => openArchive(button.dataset.archiveId)));
    renderCategories();
  }
  function openArchive(id) {
    const customer = allowedCustomers().find((item) => item.id === id); if (!customer) return;
    const restoring = archived.has(id); pendingAction = { id, restoring };
    $("customerActionTitle").textContent = restoring ? "恢复为活跃" : "设为存档";
    $("customerActionText").textContent = restoring ? `将 ${customer.name}（${id}）恢复为活跃后，可再次被充值和核销办理检索找到。` : `将 ${customer.name}（${id}）设为存档后，不再进入充值或核销办理客户范围，但全部历史记录继续保留。`;
    $("customerActionDialog").showModal();
  }
  function confirmArchive() {
    if (!pendingAction) return;
    const { id, restoring } = pendingAction, customer = allowedCustomers().find((item) => item.id === id); if (!customer) return;
    if (restoring) archived.delete(id); else archived.add(id);
    saveArchive({ customerId: id, storeId: customer.store.id, account: loginSession?.account || "unknown", from: restoring ? "archived" : "active", to: restoring ? "active" : "archived", changedAt: new Date().toISOString() });
    pendingAction = null; $("customerActionDialog").close(); render();
  }

  document.documentElement.dataset.prototypeVersion = VERSION; renderStoreContext(); fillCustomerSelect(); applyTimeRange(); setLookupMode("select", { clearOpposite: false });
  $("customerSelect").addEventListener("focus", () => setLookupMode("select"));
  $("customerSelect").addEventListener("change", () => { setLookupMode("select"); updateSelectedCustomer(); render(); });
  ["customerCategory", "customerArchive", "customerDateStart", "customerDateEnd"].forEach((id) => $(id).addEventListener("change", render)); $("customerTimeRange").addEventListener("change", () => { applyTimeRange(); render(); });
  ["customerName", "customerBirthday"].forEach((id) => { $(id).addEventListener("focus", () => setLookupMode("manual")); $(id).addEventListener("input", () => { setLookupMode("manual"); render(); }); $(id).addEventListener("change", () => { setLookupMode("manual"); render(); }); });
  document.querySelectorAll("[data-customer-query-mode]").forEach((button) => button.addEventListener("click", () => setLookupMode(button.dataset.customerQueryMode)));
  document.querySelectorAll("[data-customer-query-panel]").forEach((panel) => panel.addEventListener("click", () => setLookupMode(panel.dataset.customerQueryPanel)));
  $("resetCustomerQuery").addEventListener("click", () => { $("customerCategory").value = "all"; $("customerArchive").value = "all"; $("customerName").value = ""; $("customerBirthday").value = ""; $("customerBirthday").syncChineseBirthday?.(); $("customerTimeRange").value = "custom"; applyTimeRange(); fillCustomerSelect(); $("customerSelect").value = "all"; updateSelectedCustomer(); setLookupMode("select"); });
  $("closeCustomerAction").addEventListener("click", () => $("customerActionDialog").close()); $("cancelCustomerAction").addEventListener("click", () => $("customerActionDialog").close()); $("confirmCustomerAction").addEventListener("click", confirmArchive);
})();
