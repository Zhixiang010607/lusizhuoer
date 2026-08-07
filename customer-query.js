(() => {
  "use strict";
  const VERSION = "0.14.19", $ = (id) => document.getElementById(id);
  let loginSession = null;
  try { loginSession = JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); } catch (_) { loginSession = null; }
  const scopedStoreId = loginSession?.role === "store" ? loginSession.store : "";
  const stores = Array.from({ length: 16 }, (_, i) => ({ id: `S${String(i + 1).padStart(3, "0")}`, name: `${["悉尼", "墨尔本", "布里斯班", "珀斯"][i % 4]}门店 ${i + 1}` }));
  const names = ["张静", "王芳", "李娜", "陈晨", "刘敏", "赵悦", "张静", "王芳"];
  let customerOverrides = {};
  try { customerOverrides = JSON.parse(sessionStorage.getItem("prototypeCustomerOverrides") || "{}"); } catch (_) { customerOverrides = {}; }
  const baseCustomers = Array.from({ length: 96 }, (_, i) => {
    const store = stores[i % stores.length], phase = i % 3, id = `C${store.id.slice(1)}${String(i + 1).padStart(4, "0")}`, saved = customerOverrides[id] || {};
    return { id, name: saved.name || names[i % names.length], birthday: saved.birthday || `${1986 + i % 22}-${String(i % 12 + 1).padStart(2, "0")}-${String(i % 27 + 1).padStart(2, "0")}`, store, createdDate: `2026-${String(i % 8 + 1).padStart(2, "0")}-${String(i % 27 + 1).padStart(2, "0")}`, recharge: phase === 0 ? 0 : 8 + i % 28, verification: phase === 2 ? 1 + i % 16 : 0 };
  });
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
  function fillStore() {
    const visible = scopedStoreId ? stores.filter((store) => store.id === scopedStoreId) : stores;
    $("customerStore").innerHTML = `${scopedStoreId ? "" : '<option value="all">全部门店</option>'}${visible.map((store) => `<option value="${store.id}">${store.name}（${store.id}）</option>`).join("")}`;
    if (scopedStoreId) { $("customerStore").value = scopedStoreId; $("customerStore").disabled = true; }
  }
  function customersForSelectedStore() {
    const storeId = scopedStoreId || $("customerStore").value;
    return allowedCustomers().filter((customer) => storeId === "all" || customer.store.id === storeId).sort((a, b) => a.name.localeCompare(b.name, "zh-CN") || a.id.localeCompare(b.id));
  }
  function updateSelectedCustomer() {
    const customer = customersForSelectedStore().find((item) => item.id === $("customerSelect").value);
    $("customerSelectBirthday").value = customer?.birthday || "";
  }
  function fillCustomerSelect() {
    const previous = $("customerSelect").value, visible = customersForSelectedStore();
    $("customerSelect").innerHTML = `<option value="all">全部现有客户</option>${visible.map((customer) => `<option value="${customer.id}">${customer.name}（${customer.id}）</option>`).join("")}`;
    $("customerSelect").value = visible.some((customer) => customer.id === previous) ? previous : "all";
    updateSelectedCustomer();
  }
  function setLookupMode(mode) {
    lookupMode = mode;
    $("customerSelectField").hidden = mode !== "select"; $("customerSelectBirthdayField").hidden = mode !== "select";
    $("customerManualNameField").hidden = mode !== "manual"; $("customerManualBirthdayField").hidden = mode !== "manual";
    document.querySelectorAll("[data-customer-query-mode]").forEach((button) => button.classList.toggle("active", button.dataset.customerQueryMode === mode));
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
    const storeId = scopedStoreId || $("customerStore").value, category = $("customerCategory").value, state = $("customerArchive").value;
    const selectedId = $("customerSelect").value, name = $("customerName").value.trim(), birthday = $("customerBirthday").value, isArchived = archived.has(customer.id), start = $("customerDateStart").value, end = $("customerDateEnd").value;
    const customerMatch = lookupMode === "select" ? selectedId === "all" || customer.id === selectedId : (!name || customer.name.includes(name)) && (!birthday || customer.birthday === birthday);
    return (storeId === "all" || customer.store.id === storeId) && customerMatch && (!includeCategory || category === "all" || categoryOf(customer) === category) && (state === "all" || (state === "archived") === isArchived) && (!start || customer.createdDate >= start) && (!end || customer.createdDate <= end);
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
      return `<tr><td><a class="record-link" href="${detail}">${customer.id}</a></td><td>${customer.name}</td><td>${customer.birthday}</td><td>${customer.store.name}（${customer.store.id}）</td><td>${categoryLabels[categoryOf(customer)]}</td><td>${customer.recharge}</td><td>${customer.verification}</td><td><span class="record-status ${isArchived ? "status-已作废" : "status-正常"}">${isArchived ? "封存" : "活跃"}</span></td><td><button class="archive-customer-button" data-archive-id="${customer.id}" type="button">${isArchived ? "恢复为活跃" : "封存客户"}</button></td></tr>`;
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

  document.documentElement.dataset.prototypeVersion = VERSION; fillStore(); fillCustomerSelect(); applyTimeRange(); setLookupMode("select");
  $("customerStore").addEventListener("change", () => { fillCustomerSelect(); render(); }); $("customerSelect").addEventListener("change", () => { updateSelectedCustomer(); render(); });
  ["customerCategory", "customerArchive", "customerBirthday", "customerDateStart", "customerDateEnd"].forEach((id) => $(id).addEventListener("change", render)); $("customerName").addEventListener("input", render); $("customerTimeRange").addEventListener("change", () => { applyTimeRange(); render(); });
  document.querySelectorAll("[data-customer-query-mode]").forEach((button) => button.addEventListener("click", () => setLookupMode(button.dataset.customerQueryMode)));
  $("resetCustomerQuery").addEventListener("click", () => { $("customerStore").value = scopedStoreId || "all"; $("customerCategory").value = "all"; $("customerArchive").value = "all"; $("customerName").value = ""; $("customerBirthday").value = ""; $("customerTimeRange").value = "custom"; applyTimeRange(); fillCustomerSelect(); $("customerSelect").value = "all"; updateSelectedCustomer(); setLookupMode("select"); });
  $("closeCustomerAction").addEventListener("click", () => $("customerActionDialog").close()); $("cancelCustomerAction").addEventListener("click", () => $("customerActionDialog").close()); $("confirmCustomerAction").addEventListener("click", confirmArchive);
})();
