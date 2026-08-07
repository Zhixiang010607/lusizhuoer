(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const type = document.body.dataset.teacherService;
  let session = null;
  try { session = JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); } catch (_) { session = null; }
  if (!session || session.role !== "teacher" || !["verification", "recharge"].includes(type)) return;

  const hash = Array.from(String(session.cloudbaseUserId || session.account || "teacher")).reduce((total, char) => (total * 31 + char.charCodeAt(0)) >>> 0, 7);
  const teacherId = `T${String(hash % 900 + 100).padStart(3, "0")}`;
  const teacherName = session.staffName || "当前登录老师";
  const regions = window.ChinaRegions || {};
  const projects = ["普拉提", "体态评估", "康复训练", "瑜伽", "力量训练", "产后恢复"].map((name, index) => ({ id: `P${String(index + 1).padStart(3, "0")}`, name }));
  const seedRegions = [["北京市", "北京市", "朝阳区"], ["上海市", "上海市", "浦东新区"], ["广东省", "广州市", "天河区"], ["广东省", "深圳市", "南山区"], ["浙江省", "杭州市", "西湖区"], ["四川省", "成都市", "武侯区"]];
  const read = (key) => { try { return JSON.parse(sessionStorage.getItem(key) || "[]"); } catch (_) { return []; } };
  const write = (key, rows) => sessionStorage.setItem(key, JSON.stringify(rows));
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const storedStores = read("prototypeCreatedStores");
  const stores = [...Array.from({ length: 16 }, (_, index) => {
    const id = `S${String(index + 1).padStart(3, "0")}`, region = seedRegions[index % seedRegions.length];
    return { id, name: `${region[1]}门店 ${index + 1}`, province: region[0], city: region[1], district: region[2], address: `${["建国路", "世纪大道", "天河路", "深南大道", "文三路", "人民南路"][index % 6]} ${100 + index}号`, contacts: [{ name: `联系人 ${index + 1}`, phone: `13${String(100000000 + index).slice(-9)}` }] };
  }), ...storedStores.map((store) => ({ id: store.id, name: store.name, province: store.province, city: store.city, district: store.district, address: store.address, contacts: store.contacts || [] }))];
  let selectedStore = null, candidateCustomer = null, selectedCustomer = null, faceVerified = false;

  function options(values, placeholder) { return `<option value="">${placeholder}</option>${values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join("")}`; }
  function fillCities() {
    const province = $("teacherStoreProvince").value, cities = province ? Object.keys(regions[province] || {}) : [];
    $("teacherStoreCity").innerHTML = options(cities, province ? "请选择城市" : "请先选择省"); $("teacherStoreCity").disabled = !province; fillDistricts();
  }
  function fillDistricts() {
    const province = $("teacherStoreProvince").value, city = $("teacherStoreCity").value, districts = province && city ? regions[province]?.[city] || [] : [];
    $("teacherStoreDistrict").innerHTML = options(districts, city ? "请选择区" : "请先选择城市"); $("teacherStoreDistrict").disabled = !city;
  }
  function lookupStore() {
    const name = $("teacherStoreName").value.trim(), province = $("teacherStoreProvince").value, city = $("teacherStoreCity").value, district = $("teacherStoreDistrict").value;
    if (!name || !province || !city || !district) { $("teacherStoreMessage").textContent = "请填写门店名称并依次选择省、市、区。"; return; }
    const matches = stores.filter((store) => store.name === name && store.province === province && store.city === city && store.district === district);
    if (!matches.length) { $("teacherStoreMessage").textContent = "未找到匹配门店，请核对名称、省、市、区。"; return; }
    if (matches.length > 1) { $("teacherStoreMessage").textContent = "存在同名同地区门店，请联系总部确认门店编号。"; return; }
    openStorePreview(matches[0]);
  }
  function openStorePreview(store) {
    $("teacherStorePreview").innerHTML = [["门店名称", store.name], ["所在地区", `${store.province} · ${store.city} · ${store.district}`], ["详细地址", store.address || "未填写"], ["联系人", store.contacts.map((contact) => `${contact.name} · ${contact.phone}`).join("；") || "未填写"]].map(([label, value]) => `<article class="panel info-card"><span>${label}</span><strong>${escapeHtml(value)}</strong></article>`).join("");
    $("confirmTeacherStore").dataset.storeId = store.id; $("teacherStoreDialog").showModal();
  }
  function storeCustomers() {
    if (!selectedStore) return [];
    const names = ["张静", "王芳", "李娜", "陈晨", "刘敏", "赵悦"];
    const seeded = Array.from({ length: 24 }, (_, index) => ({ id: `C${selectedStore.id.slice(1)}${String(index + 1).padStart(4, "0")}`, name: names[index % names.length], birthday: `${1986 + index % 22}-${String(index % 12 + 1).padStart(2, "0")}-${String(index % 27 + 1).padStart(2, "0")}` }));
    const created = read("prototypeCreatedCustomers").filter((customer) => customer.storeId === selectedStore.id).map((customer) => ({ id: customer.id, name: customer.name, birthday: customer.birthday }));
    return [...seeded, ...created];
  }
  function resetCustomer() { candidateCustomer = null; selectedCustomer = null; $("teacherConfirmCustomer").disabled = true; $("teacherCustomerPreview").innerHTML = `<div class="lookup-placeholder"><strong>等待查询客户</strong><span>请查询并核对客户姓名、生日与编号。</span></div>`; $("teacherServiceForm").classList.add("teacher-step-disabled"); }
  function fillCustomerSelect() { const customers = storeCustomers(); $("teacherCustomerSelect").innerHTML = `<option value="">请选择客户</option>${customers.map((customer) => `<option value="${customer.id}">${customer.name}（${customer.id}）</option>`).join("")}`; }
  function previewCustomer(customer) { candidateCustomer = customer; $("teacherCustomerPreview").innerHTML = `<div class="customer-core-card"><div class="customer-core-heading"><span>客户身份确认</span><strong>${escapeHtml(customer.name)}</strong></div><div class="customer-core-facts"><div><span>姓名</span><strong>${escapeHtml(customer.name)}</strong></div><div><span>生日</span><strong>${escapeHtml(customer.birthday)}</strong></div><div><span>客户编号</span><strong>${escapeHtml(customer.id)}</strong></div></div></div>`; $("teacherConfirmCustomer").disabled = false; }
  function findSelectedCustomer() { const id = $("teacherCustomerSelect").value, birthday = $("teacherSelectBirthday").value, customer = storeCustomers().find((item) => item.id === id && item.birthday === birthday); if (!customer) { resetCustomer(); $("teacherCustomerPreview").innerHTML = `<div class="lookup-placeholder error"><strong>未能确认客户</strong><span>请选择客户并核对生日。</span></div>`; return; } previewCustomer(customer); }
  function findManualCustomer() { const name = $("teacherCustomerName").value.trim(), birthday = $("teacherCustomerBirthday").value, rows = storeCustomers().filter((item) => item.name === name && item.birthday === birthday); if (rows.length === 1) previewCustomer(rows[0]); else { resetCustomer(); $("teacherCustomerPreview").innerHTML = `<div class="lookup-placeholder error"><strong>未能确认客户</strong><span>${rows.length ? "发现同名同生日客户，请改用现有客户方式核对编号。" : "未找到该门店客户，请核对姓名和生日。"}</span></div>`; } }
  function confirmCustomer() { if (!candidateCustomer) return; selectedCustomer = candidateCustomer; $("teacherSelectedCustomer").textContent = `已确认：${selectedCustomer.name}（${selectedCustomer.id}）`; $("teacherConfirmCustomer").textContent = `已确认 ${selectedCustomer.name}（${selectedCustomer.id}）`; $("teacherServiceForm").classList.remove("teacher-step-disabled"); }
  function confirmStore() { selectedStore = stores.find((store) => store.id === $("confirmTeacherStore").dataset.storeId) || null; if (!selectedStore) return; $("teacherStoreDialog").close(); $("teacherStoreState").textContent = "已核对"; $("teacherStoreMessage").textContent = "门店已核对。现在可以查询该门店客户。"; $("teacherCustomerStep").classList.remove("teacher-step-disabled"); fillCustomerSelect(); resetCustomer(); }
  function submitService(event) {
    event.preventDefault(); const project = projects.find((item) => item.id === $("teacherProject").value), note = $("teacherNote").value.trim();
    if (!selectedStore || !selectedCustomer || !project) { $("teacherServiceMessage").textContent = "请先完成门店核对、客户确认并选择项目。"; return; }
    if (type === "verification" && !faceVerified) { $("teacherServiceMessage").textContent = "必须先完成客户人脸识别核验。"; return; }
    const key = type === "verification" ? "prototypeTeacherVerificationRecords" : "prototypeTeacherRechargeRecords", prefix = type === "verification" ? "VE" : "RC";
    const records = read(key), id = `${prefix}-${teacherId}-${Date.now()}`;
    records.push({ id, teacherId, teacherName, storeId: selectedStore.id, customerId: selectedCustomer.id, customer: selectedCustomer.name, projectId: project.id, project: project.name, count: type === "recharge" ? Number($("teacherRechargeCount").value) : 1, face: type === "verification" ? "人脸核验通过" : "", status: "normal", note, time: new Date().toISOString() }); write(key, records);
    $("teacherServiceMessage").textContent = type === "verification" ? "核销已成功提交，并已绑定本次核对的门店与当前老师。" : "充值申请已成功提交，并已绑定本次核对的门店与当前老师。";
    $("teacherServiceForm").reset(); $("teacherName").value = teacherName; $("teacherProject").innerHTML = `<option value="">请选择项目</option>${projects.map((item) => `<option value="${item.id}">${item.name}</option>`).join("")}`; if (type === "verification") { faceVerified = false; $("teacherFaceStatus").className = "capture-status pending"; $("teacherFaceStatus").textContent = "尚未核验"; } resetCustomer();
  }

  $("teacherStoreSelect").innerHTML = `<option value="">请选择门店</option>${stores.map((store) => `<option value="${store.id}">${escapeHtml(store.name)} · ${escapeHtml(store.province)} · ${escapeHtml(store.city)} · ${escapeHtml(store.district)}</option>`).join("")}`;
  $("teacherStoreProvince").innerHTML = options(Object.keys(regions), "请选择省"); $("teacherStoreProvince").addEventListener("change", fillCities); $("teacherStoreCity").addEventListener("change", fillDistricts); $("teacherLookupStore").addEventListener("click", lookupStore); $("teacherSelectStore").addEventListener("click", () => { const store = stores.find((item) => item.id === $("teacherStoreSelect").value); if (!store) { $("teacherStoreMessage").textContent = "请先选择门店。"; return; } openStorePreview(store); }); $("closeTeacherStoreDialog").addEventListener("click", () => $("teacherStoreDialog").close()); $("confirmTeacherStore").addEventListener("click", confirmStore);
  document.querySelectorAll("[data-store-mode]").forEach((button) => button.addEventListener("click", () => { const manual = button.dataset.storeMode === "manual"; document.querySelectorAll("[data-store-mode]").forEach((item) => item.classList.toggle("active", item === button)); $("teacherSelectStoreFields").hidden = manual; $("teacherManualStoreFields").hidden = !manual; $("teacherStoreMessage").textContent = ""; }));
  $("teacherCustomerSelect").addEventListener("change", () => { const customer = storeCustomers().find((item) => item.id === $("teacherCustomerSelect").value); $("teacherSelectBirthday").value = customer?.birthday || ""; resetCustomer(); }); $("teacherSelectCustomer").addEventListener("click", findSelectedCustomer); $("teacherManualCustomer").addEventListener("click", findManualCustomer); $("teacherConfirmCustomer").addEventListener("click", confirmCustomer);
  document.querySelectorAll("[data-customer-mode]").forEach((button) => button.addEventListener("click", () => { const manual = button.dataset.customerMode === "manual"; document.querySelectorAll("[data-customer-mode]").forEach((item) => item.classList.toggle("active", item === button)); $("teacherSelectCustomerFields").hidden = manual; $("teacherManualCustomerFields").hidden = !manual; resetCustomer(); }));
  $("teacherProject").innerHTML = `<option value="">请选择项目</option>${projects.map((item) => `<option value="${item.id}">${item.name}</option>`).join("")}`; $("teacherName").value = teacherName;
  if (type === "verification") $("teacherCaptureFace").addEventListener("click", () => { faceVerified = true; $("teacherFaceStatus").className = "capture-status complete"; $("teacherFaceStatus").textContent = "活体检测与人脸比对通过"; });
  $("teacherServiceForm").addEventListener("submit", submitService);
})();
