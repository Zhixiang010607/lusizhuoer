(() => {
  "use strict";

  const VERSION = "0.14.23";
  const type = document.body.dataset.management;
  const $ = (id) => document.getElementById(id);
  const fmt = new Intl.NumberFormat("zh-CN");
  const escapeHtml = (value) => String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
  const formatDateTime = window.AppDateTime.formatDate;
  const formatBirthday = (value, fallback = "—") => {
    const raw = String(value ?? "").trim();
    if (!raw) return fallback;
    const match = raw.match(/^(\d{4})[-年](\d{1,2})[-月](\d{1,2})(?:日|[T\s].*)?$/);
    return match ? `${match[1]}年${match[2].padStart(2, "0")}月${match[3].padStart(2, "0")}日` : raw;
  };
  // 产品只来自 CloudBase / PostgreSQL；不再读取浏览器临时产品数据。
  const projects = [];
  let productListMessage = "正在读取产品数据…";
  const chinaRegions = window.ChinaRegions || {};
  // 门店只来自 CloudBase / PostgreSQL；不再读取浏览器中的临时门店数据。
  const stores = [];
  // People management only renders records returned by the backend. No sample staff data is shown.
  const teachers = [];
  const operations = [];
  const headquarters = [];
  const entitySets = { store: stores, project: projects, teacher: teachers, operation: operations, hq: headquarters };
  const labels = { store: "门店", project: "项目", teacher: "老师", operation: "运营", hq: "总部" };
  const searchListTypes = new Set(["store", "teacher", "operation", "hq"]);
  let peopleSearchApplied = false;
  let peopleSearch = { name: "", phone: "", selectedId: "" };
  let peopleDataLoadPromise = Promise.resolve();
  let peopleDataLoadError = "";

  function periodFactor() {
    return ({ last30: .22, q1: .65, q2: .72, q3: .58, q4: .2, ytd: 1 })[$("managePeriod")?.value] || 1;
  }

  function entityIndex(entity) {
    return Number(entity.id.replace(/\D/g, "")) || 1;
  }

  function visibleEntities() {
    if (searchListTypes.has(type) && !peopleSearchApplied) return [];
    const legacySearch = $("entitySearch")?.value.trim().toUpperCase() || "";
    const nameSearch = searchListTypes.has(type) ? peopleSearch.name : ($("entityNameSearch")?.value.trim().toUpperCase() || legacySearch);
    const phoneSearch = searchListTypes.has(type) ? peopleSearch.phone : ($("entityPhoneSearch")?.value.replace(/\D/g, "") || "");
    return entitySets[type].filter((item) => {
      if (searchListTypes.has(type) && peopleSearch.selectedId) return item.id === peopleSearch.selectedId;
      const matchesName = !nameSearch || [item.name, item.originalName, item.displayName]
        .some((value) => String(value || "").toUpperCase().includes(nameSearch));
      const contactPhones = Array.isArray(item.contacts) ? item.contacts.map((contact) => contact.phone).join(" ") : "";
      const matchesPhone = !phoneSearch || `${item.phone || ""} ${contactPhones}`.replace(/\D/g, "").includes(phoneSearch);
      return matchesName && matchesPhone;
    });
  }

  function activeEntity() {
    if (type === "store" && !$("entitySelect").value) return null;
    return visibleEntities().find((item) => item.id === $("entitySelect").value) || visibleEntities()[0] || null;
  }

  function storeSelectionName(item) {
    const sameName = stores.filter((store) => store.name === item.name);
    return sameName.length > 1 ? `${item.name}${sameName.indexOf(item) + 1}` : item.name;
  }

  function fillOptions(select, values, placeholder) { select.innerHTML = `<option value="">${placeholder}</option>${values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("")}`; }
  function populateManualCities() {
    const province = $("manualStoreProvince")?.value, cities = province ? Object.keys(chinaRegions[province]) : [];
    if (!$("manualStoreCity")) return;
    fillOptions($("manualStoreCity"), cities, province ? "请选择城市" : "请先选择省");
    $("manualStoreCity").disabled = !province;
    populateManualDistricts();
  }
  function populateManualDistricts() {
    const province = $("manualStoreProvince")?.value, city = $("manualStoreCity")?.value;
    if (!$("manualStoreDistrict")) return;
    fillOptions($("manualStoreDistrict"), province && city ? chinaRegions[province][city] : [], city ? "请选择区" : "请先选择城市");
    $("manualStoreDistrict").disabled = !city;
  }
  function lookupManualStore() {
    const name = $("manualStoreName").value.trim(), province = $("manualStoreProvince").value, city = $("manualStoreCity").value, district = $("manualStoreDistrict").value;
    if (!name || !province || !city || !district) { window.alert("请填写门店名称并依次选择省、市、区"); return; }
    const store = stores.find((item) => (item.name === name || storeSelectionName(item) === name) && item.province === province && item.city === city && item.district === district);
    if (!store) { window.alert("未找到匹配门店，请核对名称、省、市、区"); return; }
    $("storeLookupPreview").innerHTML = [["门店名称", storeSelectionName(store)], ["所在地区", `${store.province} · ${store.city} · ${store.district}`], ["详细地址", store.extra || "未填写"], ["联系人", store.contacts?.map((contact) => `${contact.name} · ${contact.phone}`).join("；") || "未填写"]].map(([label, value]) => `<article class="panel info-card"><span>${label}</span><strong>${escapeHtml(value)}</strong></article>`).join("");
    $("confirmStoreLookup").dataset.storeId = store.id;
    $("storeLookupDialog").showModal();
  }

  function refillSelect(selectedId) {
    const select = $("entitySelect"), items = searchListTypes.has(type) ? entitySets[type] : visibleEntities();
    const options = items.map((item) => type === "store"
      ? `<option value="${item.id}">${escapeHtml(storeSelectionName(item))}（${escapeHtml(item.id)}） · ${escapeHtml(item.province)} · ${escapeHtml(item.city)} · ${escapeHtml(item.district)}${item.status === "活跃" ? "" : " · 封存"}</option>`
      : `<option value="${item.id}">${escapeHtml(item.displayName || item.name)}（${item.id}）${item.phone ? ` · ${escapeHtml(item.phone)}` : ""}${item.status === "活跃" ? "" : " · 封存"}</option>`).join("");
    const placeholder = `请选择${labels[type] || "对象"}`;
    select.innerHTML = searchListTypes.has(type) ? `<option value="">${placeholder}</option>${options}` : options;
    select.disabled = !items.length;
    select.value = selectedId && items.some((item) => item.id === selectedId)
      ? selectedId
      : (searchListTypes.has(type) ? "" : (items[0]?.id || ""));
  }

  function assignedTeachers(store) {
    const start = (entityIndex(store) * 3) % teachers.length;
    return Array.from({ length: 8 }, (_, i) => teachers[(start + i * 3) % teachers.length]);
  }

  function verification(store, teacher, project) {
    const raw = 8 + ((entityIndex(store) * 17 + entityIndex(teacher) * 11 + entityIndex(project) * 13) % 94);
    return Math.round(raw * periodFactor());
  }

  function renderSummary(entity) {
    if (type === "store") {
      const contacts = entity.contacts?.length ? entity.contacts.map((contact) => `${contact.name} · ${contact.phone}`).join("；") : "未填写";
      const captions = ["门店编号", "门店名称", "所在地区", "地址", "联系人", "门店账号", "状态", "创建人员", "最后修改人员"];
      const values = [entity.id, entity.name, [entity.province, entity.city, entity.district].filter(Boolean).join(" · ") || "未填写", entity.extra || "未填写", contacts, entity.account, entity.status, entity.createdBy ? `${entity.createdBy.account} · ${entity.createdBy.name}` : "HQ001 · 总部管理员", "HQ001 · 总部管理员"];
      $("entityInfo").innerHTML = values.map((value, i) => `<article class="panel info-card"><span>${captions[i]}</span><strong>${escapeHtml(value)}</strong></article>`).join("");
      return;
    }
    if (type === "teacher") {
      const captions = ["老师编号", "老师姓名", "显示名称", "联系电话", "状态", "创建人员", "最后修改人员"];
      const values = [entity.id, entity.name, entity.displayName || entity.name, entity.phone || "未填写", entity.status, entity.createdBy ? `${entity.createdBy.account} · ${entity.createdBy.name}` : "未记录", "未记录"];
      $("entityInfo").innerHTML = values.map((value, i) => `<article class="panel info-card"><span>${captions[i]}</span><strong>${escapeHtml(value)}</strong></article>`).join("");
      return;
    }
    if (type === "operation") {
      const captions = ["运营编号", "姓名", "显示名称", "联系电话", "状态", "创建人员", "最后修改人员"];
      const values = [entity.account || entity.id, entity.name, entity.displayName || entity.name, entity.phone || "未填写", entity.status, entity.createdBy ? `${entity.createdBy.account} · ${entity.createdBy.name}` : "未记录", "未记录"];
      $("entityInfo").innerHTML = values.map((value, i) => `<article class="panel info-card"><span>${captions[i]}</span><strong>${escapeHtml(value)}</strong></article>`).join("");
      return;
    }
    if (type === "hq") {
      const captions = ["总部编号", "姓名", "联系电话", "状态", "创建人员", "最后修改人员"];
      const values = [entity.account || entity.id, entity.name, entity.phone || "未填写", entity.status, entity.createdBy ? `${entity.createdBy.account} · ${entity.createdBy.name}` : "未记录", "未记录"];
      $("entityInfo").innerHTML = values.map((value, i) => `<article class="panel info-card"><span>${captions[i]}</span><strong>${escapeHtml(value)}</strong></article>`).join("");
      return;
    }
    const captions = ["产品名称", "产品类别", "产品介绍", "状态", "创建日期", "最后更新日期"];
    const values = [entity.name, entity.productType || "未填写", entity.extra || "未填写", entity.status, formatDateTime(entity.createdAt, "未记录"), formatDateTime(entity.updatedAt, "未记录")];
    $("entityInfo").innerHTML = values.map((value, i) => `<article class="panel info-card"><span>${captions[i]}</span><strong>${escapeHtml(value)}</strong></article>`).join("");
  }

  function renderStoreTables(store) {
    const storeTeachers = assignedTeachers(store).filter((teacher) => teacher.status === "活跃");
    $("teacherVerificationHead").innerHTML = `<tr><th>老师（编号）</th><th>总核销</th>${projects.map((project) => `<th>${project.name}</th>`).join("")}</tr>`;
    $("teacherVerificationBody").innerHTML = storeTeachers.map((teacher) => {
      const values = projects.map((project) => verification(store, teacher, project));
      return `<tr><td><a class="record-link" href="teacher-detail.html?teacherId=${encodeURIComponent(teacher.id)}">${teacher.displayName || teacher.name}（${teacher.id}）</a></td><td><strong>${fmt.format(values.reduce((a, b) => a + b, 0))}</strong></td>${values.map((value) => `<td>${fmt.format(value)}</td>`).join("")}</tr>`;
    }).join("");

    $("projectVerificationHead").innerHTML = `<tr><th>项目</th><th>总核销</th>${storeTeachers.map((teacher) => `<th>${teacher.displayName || teacher.name}</th>`).join("")}</tr>`;
    $("projectVerificationBody").innerHTML = projects.map((project) => {
      const values = storeTeachers.map((teacher) => verification(store, teacher, project));
      return `<tr><td><a class="record-link" href="project-detail.html?projectId=${encodeURIComponent(project.id)}">${project.name}</a></td><td><strong>${fmt.format(values.reduce((a, b) => a + b, 0))}</strong></td>${values.map((value) => `<td>${fmt.format(value)}</td>`).join("")}</tr>`;
    }).join("");

    const customers = Array.from({ length: 18 }, (_, i) => ({ id: `C${store.id.slice(1)}${String(i + 1).padStart(3, "0")}`, name: `客户 ${String(i + 1).padStart(2, "0")}`, birthday: `${1985 + i % 18}-${String(i % 12 + 1).padStart(2, "0")}-${String(i % 27 + 1).padStart(2, "0")}` }));
    const rows = [];
    customers.forEach((customer, ci) => projects.slice(0, 2 + ci % 4).forEach((project, pi) => {
      const purchased = 12 + ((ci * 9 + pi * 7 + entityIndex(store)) % 64);
      const used = Math.min(purchased, 3 + ((ci * 5 + pi * 11) % purchased));
      const recentRecharge = `2026-${String(ci % 8 + 1).padStart(2, "0")}-${String(ci % 27 + 1).padStart(2, "0")}`;
      const recentVerification = `2026-${String((ci + pi) % 8 + 1).padStart(2, "0")}-${String((ci * 2 + pi) % 27 + 1).padStart(2, "0")}`;
      const customerUrl = `customer-detail.html?customerId=${encodeURIComponent(customer.id)}&storeId=${encodeURIComponent(store.id)}`;
      rows.push(`<tr><td><a class="record-link" href="${customerUrl}">${customer.id}</a></td><td>${customer.name}</td><td>${formatBirthday(customer.birthday)}</td><td>${store.name}</td><td>${project.id}</td><td>${project.name}</td><td>${purchased}</td><td>${used}</td><td><strong>${purchased - used}</strong></td><td>${recentRecharge}</td><td>${recentVerification}</td><td>正常</td></tr>`);
    }));
    $("customerBody").innerHTML = rows.join("");
    $("customerCount").textContent = `${customers.length}位客户`;
  }

  function renderProjectTable(project) {
    $("simpleStatsBody").innerHTML = `<tr><td colspan="5" class="query-empty">该产品当前没有真实充值或核销数据</td></tr>`;
  }

  function renderProjectList() {
    if (!projects.length) {
      $("projectList").innerHTML = `<section class="panel query-empty">${escapeHtml(productListMessage || "暂无产品数据，请先新增产品。")}</section>`;
      return;
    }
    $("projectList").innerHTML = projects.map((project) => `<button type="button" data-project-id="${project.id}"><strong>${escapeHtml(project.name)}</strong><span>${escapeHtml(project.productType || "未分类")} · ${escapeHtml(project.status)}</span></button>`).join("");
    $("projectList").querySelectorAll("[data-project-id]").forEach((button) => button.addEventListener("click", () => {
      $("entitySelect").value = button.dataset.projectId;
      $("projectManagementContent").hidden = false;
      render();
    }));
  }

  function renderTeacherTable(teacher) {
    const rows = [];
    stores.filter((store) => assignedTeachers(store).some((item) => item.id === teacher.id)).forEach((store) => {
      const total = projects.reduce((sum, project) => sum + verification(store, teacher, project), 0) || 1;
      projects.forEach((project) => {
        const value = verification(store, teacher, project);
        rows.push(`<tr><td><a class="record-link" href="store-detail.html?storeId=${encodeURIComponent(store.id)}">${store.name}（${store.id}）</a></td><td>${project.name}</td><td>${fmt.format(value)}</td><td>${(value / total * 100).toFixed(1)}%</td><td>${teacher.status}</td></tr>`);
      });
    });
    $("simpleStatsBody").innerHTML = rows.join("") || `<tr><td colspan="5">该老师当前没有关联门店数据</td></tr>`;
  }

  function render() {
    if (searchListTypes.has(type)) {
      renderPeopleResults();
      return;
    }
    const entity = activeEntity();
    if (!entity) {
      const message = entitySets[type].length
        ? "未找到匹配的姓名或联系电话"
        : `暂无${labels[type]}数据，请先新增${labels[type]}。`;
      $("entityInfo").innerHTML = `<article class="panel info-card"><span>查询结果</span><strong>${message}</strong></article>`;
      $("simpleStatsBody") && ($("simpleStatsBody").innerHTML = "");
      return;
    }
    renderSummary(entity);
    if (type === "project" && $("deleteEntity")) {
      $("deleteEntity").textContent = entity.status === "活跃" ? "封存产品" : "激活产品";
      $("deleteEntity").classList.toggle("danger-button", entity.status === "活跃");
    }
    if (type === "store") renderStoreTables(entity);
    if (type === "project") renderProjectTable(entity);
    if (type === "teacher") renderTeacherTable(entity);
  }

  function renderPeopleResults() {
    const target = $("entityInfo");
    if (!peopleSearchApplied) {
      target.replaceChildren();
      $("simpleStatsBody") && ($("simpleStatsBody").innerHTML = "");
      return;
    }
    const results = visibleEntities();
    if (!results.length) {
      target.innerHTML = `<article class="panel info-card"><span>查询结果</span><strong>没有符合条件的${labels[type]}。</strong></article>`;
      $("simpleStatsBody") && ($("simpleStatsBody").innerHTML = "");
      return;
    }
    target.innerHTML = `<section class="panel people-result-panel"><div class="panel-heading"><div><h2>查询结果</h2><p>共 ${results.length} 条。总部可进入该账号自身范围内的全局视图。</p></div></div><div class="people-result-list">${results.map((person) => { const detail = type === "store" ? `store-detail.html?authUid=${encodeURIComponent(person.id)}` : `staff-detail.html?role=${encodeURIComponent(type)}&id=${encodeURIComponent(person.id)}`; const location = type === "store" ? [person.province, person.city, person.district].filter(Boolean).join(" · ") : person.phone || "未填写"; return `<article class="people-result-row"><div><strong>${escapeHtml(person.name)}</strong><span>${escapeHtml(person.id)} · ${escapeHtml(location)} · ${escapeHtml(person.status)}</span></div><a class="button-link secondary-button" href="${detail}">进入全局视图</a></article>`; }).join("")}</div></section>`;
    $("simpleStatsBody") && ($("simpleStatsBody").innerHTML = "");
  }

  async function searchPeopleByFields() {
    const searchButton = $("searchPeople");
    if (searchButton) searchButton.disabled = true;
    try {
      await peopleDataLoadPromise;
    } finally {
      if (searchButton) searchButton.disabled = false;
    }
    if (peopleDataLoadError) {
      window.alert(peopleDataLoadError);
      return;
    }
    const name = $("entityNameSearch")?.value.trim().toUpperCase() || "";
    const phone = $("entityPhoneSearch")?.value.replace(/\D/g, "") || "";
    const selectedId = $("entitySelect")?.value || "";
    if (name || phone) {
      // Text criteria take precedence. This keeps it independent from a
      // previous direct selection while retaining one shared search button.
      peopleSearchApplied = true;
      peopleSearch = { name, phone, selectedId: "" };
      render();
      return;
    }
    if (selectedId) {
      peopleSearchApplied = true;
      peopleSearch = { name: "", phone: "", selectedId };
      render();
      return;
    }
    peopleSearchApplied = false;
    $("entityInfo").replaceChildren();
  }

  function addEntity(event) {
    event.preventDefault();
    const code = $("entityCode").value.trim().toUpperCase();
    const name = $("entityName").value.trim();
    if (!code || !name) {
      window.alert(`${labels[type]}编号和名称不能为空`);
      return;
    }
    if (entitySets[type].some((item) => item.id === code)) {
      window.alert(`${labels[type]}编号已经存在`);
      return;
    }
    entitySets[type].push({ id: code, name, extra: $("entityExtra").value.trim(), status: "活跃" });
    refillSelect(code);
    $("entityDialog").close();
    $("entityForm").reset();
    render();
  }

  async function deactivateEntity() {
    const entity = activeEntity();
    if (!entity) return;
    const activatingProject = type === "project" && entity.status !== "活跃";
    if (entity.status !== "活跃" && !activatingProject) return;
    const actionText = activatingProject ? "激活" : "封存";
    const confirmText = activatingProject
      ? `确认激活产品“${entity.name}”？`
      : `确认封存${labels[type]}“${entity.name}”？历史充值、核销和客户引用仍会保留，且不删除任何资料。`;
    if (!window.confirm(confirmText)) return;
    if (type === "project") {
      try {
        if (!window.CloudBasePhoneAuth?.setProductStatus) {
          throw new Error("产品数据库服务尚未加载，请刷新页面后重试。");
        }
        await window.CloudBasePhoneAuth.setProductStatus({
          productRef: entity.id,
          status: activatingProject ? "ACTIVE" : "ARCHIVED"
        });
        await syncRemoteProducts(entity.id);
        return;
      } catch (error) {
        window.alert(error?.message || `产品${actionText}失败；数据库状态未修改。`);
        return;
      }
    }
    if (["teacher", "operation", "hq", "store"].includes(type) && entity.authUid) {
      try {
        await window.CloudBasePhoneAuth?.setStaffStatus({ uid: entity.authUid || "", phone: entity.phone || "", status: "ARCHIVED" });
      } catch (error) {
        window.alert(error?.message || "账号封存失败；为避免人员仍可登录，未修改页面状态。");
        return;
      }
    }
    entity.status = "封存";
    refillSelect(entity.id);
    render();
  }

  async function syncRemotePeople() {
    if (!["teacher", "operation", "hq"].includes(type)) return;
    if (!window.CloudBasePhoneAuth?.listStaff) {
      peopleDataLoadError = "人员数据库服务尚未加载，请刷新页面后重试。";
      return;
    }
    try {
      const remote = await window.CloudBasePhoneAuth.listStaff(type);
      const records = remote.map((person) => ({
        id: String(person.auth_uid || "").trim(),
        databaseId: String(person.id || "").trim(),
        businessCode: person.person_code || `${type.toUpperCase()}${person.id}`,
        account: person.person_code || `${type.toUpperCase()}${person.id}`,
        name: person.staff_name,
        displayName: person.staff_name,
        phone: person.phone || "未填写",
        authUid: person.auth_uid || "",
        status: person.account_status === "ARCHIVED" ? "封存" : "活跃"
      })).filter((person) => person.id && person.name);
      entitySets[type].splice(0, entitySets[type].length, ...records);
      peopleDataLoadError = "";
      refillSelect();
      render();
    } catch (error) {
      peopleDataLoadError = error?.message || "人员数据读取失败，请刷新页面后重试。";
      console.warn("人员列表读取失败", error);
      entitySets[type].splice(0, entitySets[type].length);
      refillSelect();
      render();
    }
  }

  async function syncRemoteStores(selectedId = "") {
    if (type !== "store") return;
    if (!window.CloudBasePhoneAuth?.listStores) {
      peopleDataLoadError = "门店数据库服务尚未加载，请刷新页面后重试。";
      refillSelect();
      render();
      return;
    }
    try {
      const remote = await window.CloudBasePhoneAuth.listStores();
      const records = remote.map((store) => {
        const contactName = String(store.contact_name || store.staff_name || "").trim();
        const contactPhone = String(store.contact_phone || store.phone || "").trim();
        return {
          id: String(store.auth_uid || "").trim(),
          databaseId: String(store.id || "").trim(),
          businessCode: String(store.store_code || "").trim(),
          name: String(store.store_name || store.name || "").trim(),
          province: String(store.province || "").trim(),
          city: String(store.city || "").trim(),
          district: String(store.district || "").trim(),
          status: store.store_status === "ARCHIVED" ? "封存" : (store.store_status ? "活跃" : ""),
          extra: String(store.address_detail || store.address || "").trim(),
          contacts: contactName || contactPhone ? [{ name: contactName, phone: contactPhone }] : [],
          account: String(store.store_code || "").trim(),
          authUid: String(store.auth_uid || "").trim(),
          phone: contactPhone
        };
      }).filter((store) => store.id && store.name);
      stores.splice(0, stores.length, ...records);
      peopleDataLoadError = "";
      const selected = records.find((store) => [store.id, store.databaseId, store.businessCode].includes(String(selectedId || "")));
      refillSelect(selected?.id || "");
      render();
    } catch (error) {
      // 读取失败时保持空列表；绝不回退到本地演示数据。
      peopleDataLoadError = error?.message || "门店数据读取失败，请刷新页面后重试。";
      console.warn("门店列表读取失败", error);
      stores.splice(0, stores.length);
      refillSelect();
      render();
    }
  }

  async function syncRemoteProducts(selectedId = "") {
    if (type !== "project") return;
    projects.splice(0, projects.length);
    productListMessage = "正在读取产品数据…";
    renderProjectList();
    if (!window.CloudBasePhoneAuth?.listProducts) {
      productListMessage = "产品数据库服务尚未加载，请刷新页面后重试。";
      renderProjectList();
      return;
    }
    try {
      const remote = await window.CloudBasePhoneAuth.listProducts();
      const records = remote.map((product) => ({
        id: String(product.product_code || "").trim(),
        databaseId: String(product.id || "").trim(),
        name: String(product.product_name || "").trim(),
        productType: String(product.product_type || "").trim(),
        extra: String(product.description || "").trim(),
        status: product.product_status === "ARCHIVED" ? "封存" : "活跃",
        createdAt: String(product.created_at || "").trim(),
        updatedAt: String(product.updated_at || "").trim()
      })).filter((product) => product.id && product.name);
      projects.splice(0, projects.length, ...records);
      productListMessage = records.length ? "" : "暂无产品数据，请先新增产品。";
      refillSelect(String(selectedId || ""));
      renderProjectList();
      const selected = projects.some((product) => product.id === String(selectedId || ""));
      $("projectManagementContent").hidden = !selected;
      if (selected) render();
    } catch (error) {
      console.warn("产品列表读取失败", error);
      projects.splice(0, projects.length);
      productListMessage = error?.message || "产品数据库读取失败，请刷新页面后重试。";
      refillSelect();
      renderProjectList();
      $("projectManagementContent").hidden = true;
    }
  }

  function init() {
    document.documentElement.dataset.prototypeVersion = VERSION;
    const pageParams = new URLSearchParams(location.search);
    refillSelect(pageParams.get("created"));
    $("entitySelect").addEventListener("change", () => {
      if (searchListTypes.has(type)) {
        // Choosing a person switches to the direct-view mode; clear stale
        // field criteria so the two lookup methods cannot conflict.
        $("entityNameSearch").value = "";
        $("entityPhoneSearch").value = "";
      } else if (type !== "store") {
        render();
      }
    });
    ["entitySearch", "entityNameSearch", "entityPhoneSearch"].forEach((id) => $(id)?.addEventListener("input", (event) => {
      if (searchListTypes.has(type)) {
        if (id !== "entitySearch" && event.currentTarget.value.trim()) $("entitySelect").value = "";
      } else {
        refillSelect();
        render();
      }
    }));
    $("searchPeople")?.addEventListener("click", () => void searchPeopleByFields());
    ["entityNameSearch", "entityPhoneSearch"].forEach((id) => $(id)?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      void searchPeopleByFields();
    }));
    $("managePeriod")?.addEventListener("change", render);
    $("addEntity").addEventListener("click", () => { if (type === "store") location.href = "store-create.html"; else if (type === "project") location.href = "project-create.html"; else if (type === "teacher") location.href = "teacher-create.html"; else if (type === "operation") location.href = "operation-account-create.html"; else if (type === "hq") location.href = "hq-account-create.html"; else $("entityDialog").showModal(); });
    $("deleteEntity")?.addEventListener("click", deactivateEntity);
    $("confirmStore")?.addEventListener("click", () => {
      if (!activeEntity()) { window.alert("请先选择门店"); return; }
      $("storeManagementContent").hidden = false;
      render();
    });
    if (type === "project" && $("viewProject")) $("viewProject").addEventListener("click", () => {
      const project = activeEntity();
      if (project) window.location.href = `project-detail.html?projectId=${encodeURIComponent(project.id)}`;
    });
    $("cancelEntity")?.addEventListener("click", () => $("entityDialog").close());
    $("entityForm")?.addEventListener("submit", addEntity);
    if (type !== "store" && type !== "project") render();
    if (pageParams.get("mode") === "create") {
      if (type === "store") location.replace("store-create.html");
      else if (type === "project") location.replace("project-create.html");
      else if (type === "teacher") location.replace("teacher-create.html");
      else if (type === "operation") location.replace("operation-account-create.html");
      else if (type === "hq") location.replace("hq-account-create.html");
      else window.setTimeout(() => $("entityDialog").showModal(), 0);
    }
    if (type === "store") peopleDataLoadPromise = syncRemoteStores(pageParams.get("created") || "");
    else if (type === "project") void syncRemoteProducts(pageParams.get("created") || "");
    else peopleDataLoadPromise = syncRemotePeople();
  }

  init();
})();
