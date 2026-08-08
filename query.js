(() => {
  "use strict";
  const VERSION = "0.14.19", type = document.body.dataset.query, $ = (id) => document.getElementById(id);
  let loginSession = null;
  try { loginSession = JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); } catch (_) { loginSession = null; }
  const scopedStoreId = loginSession?.role === "store" ? loginSession.store : "";
  const stores = [];
  const projects = [];
  const teachers = [];
  let customerOverrides = {}, lookupMode = "select";
  try { customerOverrides = JSON.parse(sessionStorage.getItem("prototypeCustomerOverrides") || "{}"); } catch (_) { customerOverrides = {}; }
  const customers = [];
  const records = [];
  const statusTag = (status) => `<span class="record-status status-${status}">${status}</span>`;
  const selectedStoreId = () => scopedStoreId || $("queryStore").value;
  const isoDate = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  function applyTimeRange() {
    const range = $("queryTimeRange").value, today = new Date(), start = new Date(today);
    if (range === "sevenDays") start.setDate(today.getDate() - 6);
    else if (range === "month") start.setMonth(today.getMonth() - 1);
    else if (range === "quarter") { start.setMonth(Math.floor(today.getMonth() / 3) * 3, 1); }
    else if (range === "year") { start.setMonth(0, 1); }
    else { start.setFullYear(today.getFullYear() - 1); }
    if (range !== "custom" || !$("queryDateStart").value || !$("queryDateEnd").value) { $("queryDateStart").value = isoDate(start); $("queryDateEnd").value = isoDate(today); }
    $("queryDateStart").disabled = range !== "custom"; $("queryDateEnd").disabled = range !== "custom";
  }
  function availableCustomers() {
    const storeId = selectedStoreId(), byId = new Map();
    records.filter((record) => storeId === "all" || record.store.id === storeId).forEach((record) => byId.set(record.customer.id, record.customer));
    return [...byId.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, "zh-CN"));
  }
  function fillCustomerSelect() {
    const previous = $("queryCustomerSelect").value, visible = availableCustomers();
    $("queryCustomerSelect").innerHTML = `<option value="all">全部现有客户</option>${visible.map((customer) => `<option value="${customer.id}">${customer.displayName}（${customer.id}）</option>`).join("")}`;
    $("queryCustomerSelect").value = visible.some((customer) => customer.id === previous) ? previous : "all";
    updateSelectedBirthday();
  }
  function updateSelectedBirthday() {
    const customer = availableCustomers().find((item) => item.id === $("queryCustomerSelect").value);
    $("querySelectBirthday").value = customer?.birthday || "";
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
      $("queryCustomerMatches").innerHTML = customer ? `<strong>${customer.displayName}</strong><span>${customer.id} · ${customer.birthday}</span>` : "选择具体客户可按客户编号精确查询。";
      return;
    }
    const term = $("queryCustomerManual").value.trim(), birthday = $("queryCustomerBirthday").value;
    if (!term) { $("queryCustomerMatches").textContent = "请输入客户姓名；同名客户会全部列出并同时显示客户编号。"; return; }
    const matches = availableCustomers().filter((customer) => customer.name.includes(term) && (!birthday || customer.birthday === birthday));
    $("queryCustomerMatches").innerHTML = matches.length ? `<strong>匹配 ${matches.length} 位客户：</strong>${matches.map((customer) => `<span>${customer.displayName}（${customer.id}）· ${customer.birthday}</span>`).join("")}` : "未找到姓名和生日匹配的客户。";
  }
  function setLookupMode(mode) {
    lookupMode = mode; $("querySelectCustomerField").hidden = mode !== "select"; $("querySelectBirthdayField").hidden = mode !== "select"; $("queryManualCustomerField").hidden = mode !== "manual"; $("queryManualBirthdayField").hidden = mode !== "manual";
    document.querySelectorAll("[data-query-mode]").forEach((button) => button.classList.toggle("active", button.dataset.queryMode === mode)); renderCustomerMatches(); render();
  }
  function render() {
    const storeId = selectedStoreId(), selectedId = $("queryCustomerSelect").value, manualName = $("queryCustomerManual").value.trim(), manualBirthday = $("queryCustomerBirthday").value;
    const start = $("queryDateStart").value, end = $("queryDateEnd").value;
    const selected = records.filter((record) => (storeId === "all" || record.store.id === storeId) && (lookupMode === "select" ? selectedId === "all" || record.customer.id === selectedId : (!manualName || record.customer.name.includes(manualName)) && (!manualBirthday || record.customer.birthday === manualBirthday)) && ($("queryProject").value === "all" || record.project.id === $("queryProject").value) && (!start || record.dateKey >= start) && (!end || record.dateKey <= end));
    $("querySummary").textContent = `共 ${selected.length} 条记录，涉及 ${new Set(selected.map((record) => record.customer.id)).size} 位客户；${lookupMode === "select" ? "现有客户按编号精确筛选" : "手动姓名匹配会保留全部同名客户"}`;
    $("queryBody").innerHTML = selected.map((record) => {
      const date = `2026-${String(record.month).padStart(2, "0")}-${String(record.day).padStart(2, "0")} ${String(9 + record.day % 10).padStart(2, "0")}:${String(10 + record.month).padStart(2, "0")}:${String(5 + record.day).padStart(2, "0")}`, detailPage = type === "recharge" ? "recharge-detail.html" : "verification-detail.html";
      const detail = `${detailPage}?recordId=${encodeURIComponent(record.id)}&customerId=${encodeURIComponent(record.customer.id)}&customerName=${encodeURIComponent(record.customer.displayName)}&storeId=${encodeURIComponent(record.store.id)}${type === "verification" ? `&kind=${encodeURIComponent(record.status)}` : ""}`;
      const recordLink = `<a class="record-link" href="${detail}">${record.id}</a>`, customerLink = `<a class="record-link" href="customer-detail.html?customerId=${record.customer.id}&customerName=${encodeURIComponent(record.customer.displayName)}&storeId=${record.store.id}">${record.customer.id}</a>`;
      const canOpenAggregates = loginSession?.role === "hq";
      const teacherLink = canOpenAggregates ? `<a class="record-link" href="teacher-detail.html?teacherId=${encodeURIComponent(record.teacher.id)}">${record.teacher.name}（${record.teacher.id}）</a>` : `${record.teacher.name}（${record.teacher.id}）`, storeLink = canOpenAggregates ? `<a class="record-link" href="store-detail.html?storeId=${encodeURIComponent(record.store.id)}">${record.store.name}</a>` : record.store.name, projectLink = canOpenAggregates ? `<a class="record-link" href="project-detail.html?projectId=${encodeURIComponent(record.project.id)}">${record.project.name}</a>` : record.project.name;
      return type === "recharge" ? `<tr><td>${recordLink}</td><td>${customerLink}</td><td>${record.customer.displayName}</td><td>${record.customer.birthday}</td><td>${storeLink}</td><td>${projectLink}</td><td>+${record.amount}</td><td>${date}</td><td>${statusTag(record.status)}</td><td>${statusTag(record.reviewProgress)}</td></tr>` : `<tr><td>${recordLink}</td><td>${customerLink}</td><td>${record.customer.displayName}</td><td>${record.customer.birthday}</td><td>${storeLink}</td><td>${projectLink}</td><td>${teacherLink}</td><td>${date}</td><td><span class="photo-required-status">已拍摄</span></td><td>${statusTag(record.status)}</td><td>${statusTag(record.reviewProgress)}</td></tr>`;
    }).join("") || `<tr><td colspan="${type === "recharge" ? 10 : 11}" class="query-empty">当前组合条件下没有记录</td></tr>`;
  }
  document.documentElement.dataset.prototypeVersion = VERSION; fillFilters(); applyTimeRange();
  $("queryStore").addEventListener("change", () => { fillCustomerSelect(); renderCustomerMatches(); render(); }); $("queryCustomerSelect").addEventListener("change", () => { updateSelectedBirthday(); renderCustomerMatches(); render(); }); $("queryCustomerManual").addEventListener("input", () => { renderCustomerMatches(); render(); }); $("queryCustomerBirthday").addEventListener("change", () => { renderCustomerMatches(); render(); }); $("queryProject").addEventListener("change", render); $("queryTimeRange").addEventListener("change", () => { applyTimeRange(); render(); }); ["queryDateStart", "queryDateEnd"].forEach((id) => $(id).addEventListener("change", render));
  document.querySelectorAll("[data-query-mode]").forEach((button) => button.addEventListener("click", () => setLookupMode(button.dataset.queryMode)));
  $("resetQuery").addEventListener("click", () => { $("queryStore").value = scopedStoreId || "all"; $("queryProject").value = "all"; $("queryCustomerManual").value = ""; $("queryCustomerBirthday").value = ""; $("queryTimeRange").value = "custom"; applyTimeRange(); fillCustomerSelect(); $("queryCustomerSelect").value = "all"; updateSelectedBirthday(); setLookupMode("select"); }); setLookupMode("select");
})();
