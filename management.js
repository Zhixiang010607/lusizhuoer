(() => {
  "use strict";

  const VERSION = "0.14.19";
  const type = document.body.dataset.management;
  const $ = (id) => document.getElementById(id);
  const fmt = new Intl.NumberFormat("zh-CN");
  const escapeHtml = (value) => String(value).replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
  let passwordOverrides = {};
  try { passwordOverrides = JSON.parse(sessionStorage.getItem("prototypeAccountPasswordOverrides") || "{}"); } catch (_) { passwordOverrides = {}; }
  const passwordFor = (scope, id, fallback) => passwordOverrides[`${scope}:${id}`] || fallback;
  let createdProjects = [];
  try { createdProjects = JSON.parse(sessionStorage.getItem("prototypeCreatedProjects") || "[]"); } catch (_) { createdProjects = []; }
  const projects = [...["普拉提", "体态评估", "康复训练", "瑜伽", "力量训练", "产后恢复"].map((name, i) => ({ id: `P${String(i + 1).padStart(3, "0")}`, name, status: "正常", extra: `${name}课程与训练服务` })), ...createdProjects.map((project) => ({ id: project.id, name: project.name, status: project.status || "正常", extra: project.description || "" }))];
  let createdStores = [];
  try { createdStores = JSON.parse(sessionStorage.getItem("prototypeCreatedStores") || "[]"); } catch (_) { createdStores = []; }
  const storeRegions = [["北京市", "北京市", "朝阳区"], ["上海市", "上海市", "浦东新区"], ["广东省", "广州市", "天河区"], ["广东省", "深圳市", "南山区"], ["浙江省", "杭州市", "西湖区"], ["四川省", "成都市", "武侯区"]];
  const chinaRegions = window.ChinaRegions || {};
  const stores = [...Array.from({ length: 16 }, (_, i) => { const id = `S${String(i + 1).padStart(3, "0")}`, region = storeRegions[i % storeRegions.length]; return { id, name: `${region[1]}门店 ${i + 1}`, province: region[0], city: region[1], district: region[2], status: "正常", extra: `${["建国路", "世纪大道", "天河路", "深南大道", "文三路", "人民南路"][i % 6]} ${100 + i}号`, contacts: [{ name: `联系人 ${i + 1}`, phone: `13${String(100000000 + i).slice(-9)}` }], account: `STORE${id.slice(1)}`, password: passwordFor("store", id, `1${String(i + 1).padStart(11, "0")}`) }; }), ...createdStores.map((store) => ({ id: store.id, name: store.name, province: store.province || "未填写", city: store.city || "未填写", district: store.district || "未填写", status: store.status || "正常", extra: store.address || "", contacts: store.contacts || [], account: store.account || `STORE${String(store.id).slice(1)}`, password: passwordFor("store", store.id, store.password || `1${String(store.id).replace(/\D/g, "").padStart(11, "0")}`), createdBy: store.createdBy }))];
  let createdTeachers = [], createdOperations = [];
  try { createdTeachers = JSON.parse(sessionStorage.getItem("prototypeCreatedTeachers") || "[]"); createdOperations = JSON.parse(sessionStorage.getItem("prototypeCreatedOperations") || "[]"); } catch (_) { createdTeachers = []; createdOperations = []; }
  const teachers = [...Array.from({ length: 32 }, (_, i) => { const id = `T${String(i + 1).padStart(3, "0")}`; const name = `业务老师 ${String(i + 1).padStart(2, "0")}`; return { id, name, displayName: name, status: "正常", extra: name, identityNumber: `1101011990${String(i + 1).padStart(8, "0")}`, phone: `04${String(20000000 + i).slice(-8)}` }; }), ...createdTeachers.map((teacher) => ({ id: teacher.id, name: teacher.originalName || teacher.name, displayName: teacher.displayName || teacher.name, status: teacher.status || "正常", extra: teacher.displayName || teacher.name, identityNumber: teacher.identityNumber || "", phone: teacher.phone || "未填写", createdBy: teacher.createdBy }))];
  const operations = [...Array.from({ length: 8 }, (_, i) => { const id = `OP${String(i + 1).padStart(3, "0")}`; const name = `运营人员${i + 1}`; return { id, name, displayName: name, status: "正常", extra: name, identityNumber: `1101011988${String(i + 1).padStart(8, "0")}`, phone: `04${String(30000000 + i).slice(-8)}`, account: id, password: passwordFor("operation", id, `2${String(i + 1).padStart(11, "0")}`) }; }), ...createdOperations.map((operation) => ({ id: operation.id, name: operation.originalName || operation.name, displayName: operation.displayName || operation.name, status: operation.status || "正常", extra: operation.displayName || operation.name, identityNumber: operation.identityNumber || "", phone: operation.phone || "未填写", account: operation.account || operation.id, password: passwordFor("operation", operation.id, operation.password || ""), createdBy: operation.createdBy }))];
  const entitySets = { store: stores, project: projects, teacher: teachers, operation: operations };
  const labels = { store: "门店", project: "项目", teacher: "老师账号", operation: "运营账号" };

  function periodFactor() {
    return ({ last30: .22, q1: .65, q2: .72, q3: .58, q4: .2, ytd: 1 })[$("managePeriod").value] || 1;
  }

  function entityIndex(entity) {
    return Number(entity.id.replace(/\D/g, "")) || 1;
  }

  function visibleEntities() {
    const search = $("entitySearch")?.value.trim().toUpperCase() || "";
    if (!search) return entitySets[type];
    return entitySets[type].filter((item) => [item.name, item.originalName, item.displayName, item.identityNumber]
      .some((value) => String(value || "").toUpperCase().includes(search)));
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
    const select = $("entitySelect"), items = visibleEntities();
    const showIdentity = Boolean($("entitySearch")?.value.trim());
    const options = items.map((item) => type === "store"
      ? `<option value="${item.id}">${escapeHtml(storeSelectionName(item))} · ${escapeHtml(item.province)} · ${escapeHtml(item.city)} · ${escapeHtml(item.district)}${item.status === "正常" ? "" : " · 已封存"}</option>`
      : `<option value="${item.id}">${escapeHtml(item.displayName || item.name)}（${item.id}）${showIdentity ? ` · 身份证 ${escapeHtml(item.identityNumber || "未填写")}` : ""}${item.status === "正常" ? "" : " · 已封存"}</option>`).join("");
    select.innerHTML = type === "store" ? `<option value="">请选择门店</option>${options}` : options;
    select.disabled = !items.length;
    select.value = selectedId && items.some((item) => item.id === selectedId) ? selectedId : (type === "store" ? "" : (items[0]?.id || ""));
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
      const captions = ["门店编号", "门店名称", "所在地区", "地址", "联系人", "门店账号", "账号密码", "状态", "创建人员", "最后修改人员"];
      const values = [entity.id, entity.name, [entity.province, entity.city, entity.district].filter(Boolean).join(" · ") || "未填写", entity.extra || "未填写", contacts, entity.account, entity.password, entity.status, entity.createdBy ? `${entity.createdBy.account} · ${entity.createdBy.name}` : "HQ001 · 总部管理员", "HQ001 · 总部管理员"];
      $("entityInfo").innerHTML = values.map((value, i) => i === 6 ? passwordCard(value, entity) : `<article class="panel info-card"><span>${captions[i]}</span><strong>${escapeHtml(value)}</strong></article>`).join("");
      bindPasswordEditor(entity);
      return;
    }
    if (type === "teacher") {
      const captions = ["老师编号", "老师姓名", "显示名称", "身份证号码", "联系电话", "状态", "创建人员", "最后修改人员"];
      const values = [entity.id, entity.name, entity.displayName || entity.name, entity.identityNumber, entity.phone || "未填写", entity.status, entity.createdBy ? `${entity.createdBy.account} · ${entity.createdBy.name}` : "HQ001 · 总部管理员", "HQ001 · 总部管理员"];
      $("entityInfo").innerHTML = values.map((value, i) => `<article class="panel info-card"><span>${captions[i]}</span><strong>${escapeHtml(value)}</strong></article>`).join("");
      return;
    }
    if (type === "operation") {
      const captions = ["运营账号", "姓名", "显示名称", "身份证号码", "联系电话", "账号密码", "状态", "创建人员", "最后修改人员"];
      const values = [entity.account || entity.id, entity.name, entity.displayName || entity.name, entity.identityNumber, entity.phone || "未填写", entity.password, entity.status, entity.createdBy ? `${entity.createdBy.account} · ${entity.createdBy.name}` : "HQ001 · 总部管理员", "HQ001 · 总部管理员"];
      $("entityInfo").innerHTML = values.map((value, i) => i === 5 ? passwordCard(value, entity) : `<article class="panel info-card"><span>${captions[i]}</span><strong>${escapeHtml(value)}</strong></article>`).join("");
      bindPasswordEditor(entity);
      return;
    }
    const captions = {
      project: ["项目编号", "产品名称", "产品介绍", "状态"],
    }[type];
    captions.push("创建人员", "最后修改人员");
    const values = [entity.id, entity.name, entity.extra || "未填写", entity.status, "HQ001 · 总部管理员", "OP001 · 运营管理员"];
    $("entityInfo").innerHTML = values.map((value, i) => `<article class="panel info-card"><span>${captions[i]}</span><strong>${escapeHtml(value)}</strong></article>`).join("");
  }

  function passwordCard(password, entity) {
    return `<article class="panel info-card password-card"><span>账号密码（总部可见）</span><strong>${escapeHtml(password)}</strong><button id="editAccountPassword" type="button">修改密码</button></article>`;
  }
  function bindPasswordEditor(entity) {
    $("editAccountPassword")?.addEventListener("click", () => {
      const card = $("editAccountPassword").closest("article");
      card.innerHTML = `<span>账号密码（12位数字）</span><input id="accountPasswordInput" inputmode="numeric" maxlength="12" value="${escapeHtml(entity.password)}"><div><button id="saveAccountPassword" type="button">保存</button><button id="cancelAccountPassword" type="button">取消</button></div>`;
      $("cancelAccountPassword").addEventListener("click", render);
      $("saveAccountPassword").addEventListener("click", () => {
        const value = $("accountPasswordInput").value.trim();
        if (!/^\d{12}$/.test(value)) { $("accountPasswordInput").setCustomValidity("密码必须为12位数字"); $("accountPasswordInput").reportValidity(); return; }
        entity.password = value; passwordOverrides[`${type}:${entity.id}`] = value;
        try { sessionStorage.setItem("prototypeAccountPasswordOverrides", JSON.stringify(passwordOverrides)); } catch (_) { /* static prototype */ }
        render();
      });
    });
  }

  function renderStoreTables(store) {
    const storeTeachers = assignedTeachers(store).filter((teacher) => teacher.status === "正常");
    $("teacherVerificationHead").innerHTML = `<tr><th>老师（编号）</th><th>总核销</th>${projects.map((project) => `<th>${project.name}</th>`).join("")}</tr>`;
    $("teacherVerificationBody").innerHTML = storeTeachers.map((teacher) => {
      const values = projects.map((project) => verification(store, teacher, project));
      return `<tr><td><a class="record-link" href="teacher-detail.html?teacherId=${encodeURIComponent(teacher.id)}">${teacher.displayName || teacher.name}（${teacher.id}）</a></td><td><strong>${fmt.format(values.reduce((a, b) => a + b, 0))}</strong></td>${values.map((value) => `<td>${fmt.format(value)}</td>`).join("")}</tr>`;
    }).join("");

    $("projectVerificationHead").innerHTML = `<tr><th>项目（编号）</th><th>总核销</th>${storeTeachers.map((teacher) => `<th>${teacher.displayName || teacher.name}</th>`).join("")}</tr>`;
    $("projectVerificationBody").innerHTML = projects.map((project) => {
      const values = storeTeachers.map((teacher) => verification(store, teacher, project));
      return `<tr><td><a class="record-link" href="project-detail.html?projectId=${encodeURIComponent(project.id)}">${project.name}（${project.id}）</a></td><td><strong>${fmt.format(values.reduce((a, b) => a + b, 0))}</strong></td>${values.map((value) => `<td>${fmt.format(value)}</td>`).join("")}</tr>`;
    }).join("");

    const customers = Array.from({ length: 18 }, (_, i) => ({ id: `C${store.id.slice(1)}${String(i + 1).padStart(3, "0")}`, name: `客户 ${String(i + 1).padStart(2, "0")}`, birthday: `${1985 + i % 18}-${String(i % 12 + 1).padStart(2, "0")}-${String(i % 27 + 1).padStart(2, "0")}` }));
    const rows = [];
    customers.forEach((customer, ci) => projects.slice(0, 2 + ci % 4).forEach((project, pi) => {
      const purchased = 12 + ((ci * 9 + pi * 7 + entityIndex(store)) % 64);
      const used = Math.min(purchased, 3 + ((ci * 5 + pi * 11) % purchased));
      const recentRecharge = `2026-${String(ci % 8 + 1).padStart(2, "0")}-${String(ci % 27 + 1).padStart(2, "0")}`;
      const recentVerification = `2026-${String((ci + pi) % 8 + 1).padStart(2, "0")}-${String((ci * 2 + pi) % 27 + 1).padStart(2, "0")}`;
      const customerUrl = `customer-detail.html?customerId=${encodeURIComponent(customer.id)}&storeId=${encodeURIComponent(store.id)}`;
      rows.push(`<tr><td><a class="record-link" href="${customerUrl}">${customer.id}</a></td><td>${customer.name}</td><td>${customer.birthday}</td><td>${store.name}</td><td>${project.id}</td><td>${project.name}</td><td>${purchased}</td><td>${used}</td><td><strong>${purchased - used}</strong></td><td>${recentRecharge}</td><td>${recentVerification}</td><td>正常</td></tr>`);
    }));
    $("customerBody").innerHTML = rows.join("");
    $("customerCount").textContent = `${customers.length}位客户`;
  }

  function renderProjectTable(project) {
    $("simpleStatsBody").innerHTML = stores.slice(0, 12).map((store) => {
      const storeTeachers = assignedTeachers(store);
      const used = storeTeachers.reduce((sum, teacher) => sum + verification(store, teacher, project), 0);
      const recharge = Math.round(used * (1.25 + entityIndex(store) % 3 * .1));
      return `<tr><td><a class="record-link" href="store-detail.html?storeId=${encodeURIComponent(store.id)}">${store.name}（${store.id}）</a></td><td>${fmt.format(recharge)}</td><td>${fmt.format(used)}</td><td>${storeTeachers.length}</td><td>${project.status}</td></tr>`;
    }).join("");
  }

  function renderProjectList() {
    $("projectList").innerHTML = projects.map((project) => `<button type="button" data-project-id="${project.id}"><strong>${escapeHtml(project.name)}</strong><span>${escapeHtml(project.id)} · ${escapeHtml(project.status)}</span></button>`).join("");
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
    const entity = activeEntity();
    if (!entity) {
      $("entityInfo").innerHTML = `<article class="panel info-card"><span>查询结果</span><strong>未找到匹配的姓名或身份证号码</strong></article>`;
      $("simpleStatsBody") && ($("simpleStatsBody").innerHTML = "");
      return;
    }
    renderSummary(entity);
    if (type === "store") renderStoreTables(entity);
    if (type === "project") renderProjectTable(entity);
    if (type === "teacher") renderTeacherTable(entity);
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
    entitySets[type].push({ id: code, name, extra: $("entityExtra").value.trim(), status: "正常" });
    refillSelect(code);
    $("entityDialog").close();
    $("entityForm").reset();
    render();
  }

  function deactivateEntity() {
    const entity = activeEntity();
    if (entity.status !== "正常") return;
    if (!window.confirm(`确认封存${labels[type]}“${entity.name}”？历史充值、核销和客户引用仍会保留，且不删除任何资料。`)) return;
    entity.status = "已封存";
    refillSelect(entity.id);
    render();
  }

  function init() {
    document.documentElement.dataset.prototypeVersion = VERSION;
    const pageParams = new URLSearchParams(location.search);
    refillSelect(pageParams.get("created"));
    $("entitySelect").addEventListener("change", () => { if (type !== "store") render(); });
    $("entitySearch")?.addEventListener("input", () => { refillSelect(); render(); });
    $("managePeriod").addEventListener("change", render);
    $("addEntity").addEventListener("click", () => { if (type === "store") location.href = "store-create.html"; else if (type === "project") location.href = "project-create.html"; else if (type === "teacher") location.href = "teacher-create.html"; else if (type === "operation") location.href = "operation-account-create.html"; else $("entityDialog").showModal(); });
    $("deleteEntity").addEventListener("click", deactivateEntity);
    $("confirmStore")?.addEventListener("click", () => {
      if (!activeEntity()) { window.alert("请先选择门店"); return; }
      $("storeManagementContent").hidden = false;
      render();
    });
    if (type === "store") {
      fillOptions($("manualStoreProvince"), Object.keys(chinaRegions), "请选择省");
      $("manualStoreProvince").addEventListener("change", populateManualCities);
      $("manualStoreCity").addEventListener("change", populateManualDistricts);
      $("lookupManualStore").addEventListener("click", lookupManualStore);
      $("closeStoreLookup").addEventListener("click", () => $("storeLookupDialog").close());
      $("confirmStoreLookup").addEventListener("click", () => { const id = $("confirmStoreLookup").dataset.storeId; if (id) location.href = `store-detail.html?storeId=${encodeURIComponent(id)}`; });
    }
    if (type === "project") renderProjectList();
    if (type === "store" && $("viewStore")) $("viewStore").addEventListener("click", () => { window.location.href = `store-detail.html?storeId=${encodeURIComponent(activeEntity().id)}`; });
    if (type === "project" && $("viewProject")) $("viewProject").addEventListener("click", () => { window.location.href = `project-detail.html?projectId=${encodeURIComponent(activeEntity().id)}`; });
    if (type === "teacher" && $("viewTeacher")) $("viewTeacher").addEventListener("click", () => { window.location.href = `teacher-detail.html?teacherId=${encodeURIComponent(activeEntity().id)}`; });
    $("cancelEntity")?.addEventListener("click", () => $("entityDialog").close());
    $("entityForm")?.addEventListener("submit", addEntity);
    if (type !== "store" && type !== "project") render();
    if (pageParams.get("mode") === "create") {
      if (type === "store") location.replace("store-create.html");
      else if (type === "project") location.replace("project-create.html");
      else if (type === "teacher") location.replace("teacher-create.html");
      else if (type === "operation") location.replace("operation-account-create.html");
      else window.setTimeout(() => $("entityDialog").showModal(), 0);
    }
  }

  init();
})();
