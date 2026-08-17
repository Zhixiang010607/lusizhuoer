(() => {
  "use strict";

  const VERSION = "0.15.3";
  const TEACHER_PAGE_SIZE = 5;
  const CUSTOMER_PAGE_SIZE = 10;
  const params = new URLSearchParams(location.search);
  const storeRef = String(params.get("authUid") || params.get("storeId") || "").trim();
  const formatDateTime = window.AppDateTime.format;
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"
  })[char]);
  const info = (items) => items.map(([label, value]) =>
    `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`
  ).join("");
  const state = { teacherRows: [], customerRows: [], teacherPage: 1, customerPage: 1, customerTotal: 0 };

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

  async function loadCurrentStoreDashboard(customerPage = 1) {
    if (!window.cloudbase || !window.CloudBaseAuthConfig || !window.registerFunctions) {
      throw new Error("门店首页数据库组件尚未加载，请刷新页面后重试。");
    }
    registerCloudBaseComponent(window.registerAuth, "auth");
    registerCloudBaseComponent(window.registerFunctions, "functions");
    const result = await window.cloudbase.init(window.CloudBaseAuthConfig).callFunction({
      name: "faceRecognition",
      data: { action: "getStoreDashboard", customerPage }
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
      target.innerHTML = '<tr><td colspan="5" class="query-empty">暂无项目业务数据</td></tr>';
      return;
    }
    target.innerHTML = rows.map((row) => {
      const name = firstValue(row, ["product_name", "project_name", "name"]);
      const code = firstValue(row, ["product_code", "project_code", "code"], "");
      const label = code ? `${name} · ${code}` : name;
      const status = firstValue(row, ["product_status", "project_status", "status"]) === "ARCHIVED" ? "封存" : "活跃";
      return `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(firstValue(row, ["recharge_count", "total_recharge_count", "purchased_count"], 0))}</td><td>${escapeHtml(firstValue(row, ["verification_count", "total_verification_count", "used_count"], 0))}</td><td>${escapeHtml(firstValue(row, ["remaining_count", "balance"], 0))}</td><td>${escapeHtml(status)}</td></tr>`;
    }).join("");
  }

  function renderTeachers() {
    const target = $("storeTeacherBody");
    if (!target) return;
    const total = state.teacherRows.length;
    const pages = Math.max(1, Math.ceil(total / TEACHER_PAGE_SIZE));
    state.teacherPage = Math.min(Math.max(1, state.teacherPage), pages);
    const rows = state.teacherRows.slice((state.teacherPage - 1) * TEACHER_PAGE_SIZE, state.teacherPage * TEACHER_PAGE_SIZE);
    if (!rows.length) {
      target.innerHTML = '<tr><td colspan="4" class="query-empty">暂无老师核销数据</td></tr>';
    } else {
      target.innerHTML = rows.map((row) => {
        const name = firstValue(row, ["teacher_name", "staff_name", "name"]);
        const code = firstValue(row, ["teacher_code", "staff_code", "code"], "");
        const id = firstValue(row, ["teacher_id", "staff_id", "id"], "");
        const ref = id || code;
        const label = code ? `${name} · ${code}` : name;
        const teacher = ref ? `<a class="record-link" href="teacher-detail.html?teacherId=${encodeURIComponent(ref)}">${escapeHtml(label)}</a>` : escapeHtml(label);
        const project = firstValue(row, ["product_name", "project_name", "product", "project"]);
        const status = firstValue(row, ["teacher_status", "staff_status", "status"]) === "ARCHIVED" ? "封存" : "活跃";
        return `<tr><td>${teacher}</td><td>${escapeHtml(project)}</td><td>${escapeHtml(firstValue(row, ["valid_verification_count", "verification_count", "total_verification_count"], 0))}</td><td>${escapeHtml(status)}</td></tr>`;
      }).join("");
    }
    renderPager("storeTeacherPagination", total, state.teacherPage, TEACHER_PAGE_SIZE, "teacher");
  }

  function renderCustomers() {
    const target = $("storeCustomerBody");
    if (!target) return;
    const total = state.customerTotal;
    const pages = Math.max(1, Math.ceil(total / CUSTOMER_PAGE_SIZE));
    state.customerPage = Math.min(Math.max(1, state.customerPage), pages);
    const rows = state.customerRows;
    if (!rows.length) {
      target.innerHTML = '<tr><td colspan="8" class="query-empty">暂无门店客户</td></tr>';
    } else {
      target.innerHTML = rows.map((row) => {
        const id = firstValue(row, ["customer_id", "id"], "");
        const code = firstValue(row, ["customer_code", "code"], "");
        const name = firstValue(row, ["customer_name", "name"]);
        const reference = code || id;
        const label = code ? `${name} · ${code}` : name;
        const customer = reference ? `<a class="record-link" href="customer-detail.html?customerId=${encodeURIComponent(reference)}">${escapeHtml(label)}</a>` : escapeHtml(label);
        const status = firstValue(row, ["customer_status", "status"]) === "ARCHIVED" ? "封存" : "活跃";
        return `<tr><td>${customer}</td><td>${escapeHtml(formatBirthday(firstValue(row, ["birthday", "birth_date"], "")))}</td><td>${escapeHtml(firstValue(row, ["product_count", "held_product_count"], 0))}</td><td>${escapeHtml(firstValue(row, ["total_recharge_count", "purchase_count"], 0))}</td><td>${escapeHtml(firstValue(row, ["total_verification_count", "verification_count"], 0))}</td><td>${escapeHtml(firstValue(row, ["remaining_count", "balance"], 0))}</td><td>${escapeHtml(formatDateTime(firstValue(row, ["last_business_at", "last_recharge_at", "updated_at"])))}</td><td>${escapeHtml(status)}</td></tr>`;
      }).join("");
    }
    if ($("storeCustomerCount")) $("storeCustomerCount").textContent = `${total}位客户`;
    renderPager("storeCustomerPagination", total, state.customerPage, CUSTOMER_PAGE_SIZE, "customer");
  }

  function renderEmptyRows(message = "暂无业务数据") {
    if ($("storeProjectBody")) $("storeProjectBody").innerHTML = `<tr><td colspan="5" class="query-empty">${escapeHtml(message)}</td></tr>`;
    state.teacherRows = [];
    state.customerRows = [];
    state.customerTotal = 0;
    renderTeachers();
    renderCustomers();
  }

  function renderError(message) {
    $("storeHero").innerHTML = `<div><span class="profile-type">门店详情</span><h2>无法读取门店</h2><p>${escapeHtml(message)}</p></div>`;
    $("storeBasicGrid").innerHTML = "";
    renderEmptyRows("暂无数据");
  }

  function renderStore(store) {
    const authUid = String(store.auth_uid || "").trim();
    const storeCode = String(store.store_code || "").trim();
    const status = store.store_status === "ARCHIVED" ? "封存" : "活跃";
    const locationText = [store.province, store.city, store.district].filter(Boolean).join(" · ") || "未填写";

    $("storeHero").innerHTML = `<div class="profile-avatar store-profile-avatar">店</div><div><span class="profile-type">门店账号</span><h2>${escapeHtml(store.store_name)}</h2><p>${escapeHtml(authUid)} · ${escapeHtml(status)}</p></div>`;
    if ($("storeHeaderStatus")) $("storeHeaderStatus").innerHTML = `<span></span>${status === "封存" ? "已封存" : "正常营业"}`;
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
    state.teacherRows = Array.isArray(store.teachers) ? store.teachers : (Array.isArray(store.teacher_stats) ? store.teacher_stats : []);
    state.customerRows = Array.isArray(store.customers) ? store.customers : [];
    state.teacherPage = 1;
    state.customerTotal = Number(store.customer_total ?? state.customerRows.length);
    state.customerPage = Number(store.customer_page || 1);
    renderTeachers();
    renderCustomers();
  }

  async function loadCustomerPage(page) {
    const target = $("storeCustomerBody");
    if (target) target.innerHTML = '<tr><td colspan="8" class="query-empty">正在读取客户数据…</td></tr>';
    try {
      renderStore(await loadCurrentStoreDashboard(page));
    } catch (error) {
      if (target) target.innerHTML = `<tr><td colspan="8" class="query-empty">${escapeHtml(error?.message || "客户数据读取失败")}</td></tr>`;
    }
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-page-target]");
    if (!button || button.disabled) return;
    const page = Number(button.dataset.page);
    if (button.dataset.pageTarget === "teacher") {
      state.teacherPage = page;
      renderTeachers();
    } else {
      void loadCustomerPage(page);
    }
  });

  async function load() {
    document.documentElement.dataset.prototypeVersion = VERSION;
    if (!storeRef) {
      renderError("缺少门店唯一身份 ID。");
      return;
    }
    try {
      let session = null;
      try { session = JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); } catch (_) { session = null; }
      if (session?.role === "store") {
        renderStore(await loadCurrentStoreDashboard());
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
      renderStore(store);
    } catch (error) {
      renderError(error?.message || "门店资料读取失败，请稍后重试。");
    }
  }

  void load();
})();
