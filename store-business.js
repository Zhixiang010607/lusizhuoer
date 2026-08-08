(() => {
  "use strict";
  const VERSION = "0.14.19", page = document.body.dataset.storeBusiness, $ = (id) => document.getElementById(id);
  let session = null;
  try { session = JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); } catch (_) { session = null; }
  const storeId = session?.store || "", storeNo = Number(storeId.replace(/\D/g, "")) || 1;
  const storeName = `${["悉尼", "墨尔本", "布里斯班", "珀斯"][(storeNo - 1) % 4]}门店 ${storeNo}`;
  const projects = ["普拉提", "体态评估", "康复训练", "瑜伽", "力量训练", "产后恢复"].map((name, i) => ({ id: `P${String(i + 1).padStart(3, "0")}`, name }));
  const teachers = Array.from({ length: 8 }, (_, i) => ({ id: `T${String((storeNo * 3 + i) % 72 + 1).padStart(3, "0")}`, name: `业务老师 ${String((storeNo * 3 + i) % 72 + 1).padStart(2, "0")}` }));
  const names = ["张静", "王芳", "李娜", "陈晨", "刘敏", "赵悦", "张静", "王芳"];
  let customerOverrides = {};
  try { customerOverrides = JSON.parse(sessionStorage.getItem("prototypeCustomerOverrides") || "{}"); } catch (_) { customerOverrides = {}; }
  const baseCustomers = Array.from({ length: 96 }, (_, i) => { const sid = `S${String(i % 16 + 1).padStart(3, "0")}`, id = `C${sid.slice(1)}${String(i + 1).padStart(4, "0")}`, current = customerOverrides[id] || {}; return { id, name: current.name || names[i % names.length], birthday: current.birthday || `${1986 + i % 22}-${String(i % 12 + 1).padStart(2, "0")}-${String(i % 27 + 1).padStart(2, "0")}`, storeId: sid, profilePhotoId: `PH-${id}` }; });
  let created = [], archived = new Set(), candidateCustomer = null, selectedCustomer = null, faceCaptured = false, photoCaptured = false, rechargeEvidenceCaptured = false;
  try { created = JSON.parse(sessionStorage.getItem("prototypeCreatedCustomers") || "[]").map((customer) => ({ ...customer, ...(customerOverrides[customer.id] || {}) })); archived = new Set(JSON.parse(sessionStorage.getItem("prototypeArchivedCustomers") || "[]")); } catch (_) { created = []; archived = new Set(); }
  const allCustomers = () => [...baseCustomers, ...created].filter((customer) => customer.storeId === storeId);
  const saveList = (key, value) => { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* 当前静态会话不可持久化时不保存演示数据。 */ } };
  const addCommunication = (recordType, recordId, message) => {
    if (!message.trim()) return;
    let rows = []; try { rows = JSON.parse(sessionStorage.getItem("prototypeCommunications") || "[]"); } catch (_) { rows = []; }
    rows.push({ recordType, recordId, role: "门店", account: session.account, name: "门店人员", message: message.trim(), time: new Date().toISOString() }); saveList("prototypeCommunications", rows);
  };
  const fillProjects = (id) => { $(id).innerHTML = `<option value="">请选择项目</option>${projects.map((project) => `<option value="${project.id}">${project.name}（${project.id}）</option>`).join("")}`; };
  const projectBalances = (customer) => { const seed = [...customer.id].reduce((sum, char) => sum + char.charCodeAt(0), 0); return projects.map((project, i) => ({ ...project, remaining: customer.id.includes("N") ? 0 : 3 + (seed * (i + 3) + i * 11) % 38 })); };

  function setupCustomerCreate() {
    $("captureFace").addEventListener("click", () => { faceCaptured = true; $("faceCaptureStatus").className = "capture-status complete"; $("faceCaptureStatus").textContent = "建档照片已保存 · 面容检查通过"; });
    $("customerCreateForm").addEventListener("submit", (event) => {
      event.preventDefault(); const name = $("createCustomerName").value.trim(), birthday = $("createCustomerBirthday").value, notes = $("createCustomerNotes").value.trim() || "无";
      if (!name || !birthday) { $("customerCreateMessage").textContent = "姓名和生日必须填写"; return; }
      if (!faceCaptured || !$("faceConsent").checked) { $("customerCreateMessage").textContent = "必须完成面容录入并确认客户授权"; return; }
      const duplicate = allCustomers().find((customer) => customer.name === name && customer.birthday === birthday && !archived.has(customer.id));
      if (duplicate) { $("customerCreateMessage").textContent = `发现本门店同名同生日客户 ${duplicate.id}，请先核对，不能重复建档`; return; }
      const id = `C${storeId.slice(1)}N${String(created.length + 1).padStart(4, "0")}`;
      created.push({ id, name, birthday, notes, storeId, faceStatus: "已录入", profilePhotoId: `PH-${id}`, profilePhotoStatus: "已保存", createdBy: session.account }); saveList("prototypeCreatedCustomers", created);
      $("customerCreateMessage").textContent = `客户 ${name}（${id}）建立成功，建档照片已关联并绑定 ${storeName}`; event.target.reset(); faceCaptured = false; $("faceCaptureStatus").className = "capture-status pending"; $("faceCaptureStatus").textContent = "尚未拍摄";
    });
  }
  function setupLookup() {
    const activeCustomers = allCustomers().filter((customer) => !archived.has(customer.id));
    $("serviceCustomerSelect").innerHTML = `<option value="">请选择现有客户</option>${activeCustomers.map((customer) => `<option value="${customer.id}">${customer.name}（${customer.id}）</option>`).join("")}`;
    $("serviceCustomerSelect").addEventListener("change", () => { const customer = activeCustomers.find((item) => item.id === $("serviceCustomerSelect").value); $("serviceSelectBirthday").value = customer?.birthday || ""; resetCandidate(); });
    $("serviceCustomerName").addEventListener("input", resetCandidate); $("serviceCustomerBirthday").addEventListener("change", resetCandidate);
    document.querySelectorAll("[data-lookup-mode]").forEach((button) => button.addEventListener("click", () => {
      document.querySelectorAll("[data-lookup-mode]").forEach((item) => item.classList.toggle("active", item === button));
      const manual = button.dataset.lookupMode === "manual"; $("selectLookupFields").hidden = manual; $("manualLookupFields").hidden = !manual; resetCandidate();
    }));
    $("serviceSelectLookup").addEventListener("click", () => {
      resetCandidate(); const id = $("serviceCustomerSelect").value, birthday = $("serviceSelectBirthday").value;
      if (!id || !birthday) { showLookupError("必须选择现有客户并确认生日。"); return; }
      const customer = activeCustomers.find((item) => item.id === id && item.birthday === birthday);
      if (!customer) { showLookupError("所选生日与客户档案不一致，请重新核对。"); return; }
      renderCustomerCore(customer);
    });
    $("serviceCustomerLookup").addEventListener("click", () => {
      resetCandidate(); const name = $("serviceCustomerName").value.trim(), birthday = $("serviceCustomerBirthday").value;
      if (!name || !birthday) { showLookupError("客户姓名和生日都必须填写。"); return; }
      const matches = activeCustomers.filter((customer) => customer.name === name && customer.birthday === birthday);
      if (matches.length === 1) renderCustomerCore(matches[0]);
      else if (matches.length > 1) {
        $("serviceCustomerResults").innerHTML = `<div class="duplicate-customer-list"><strong>找到 ${matches.length} 位同名同生日客户，请按编号选择：</strong>${matches.map((customer) => `<button type="button" data-preview-customer="${customer.id}">${customer.name} · ${customer.id}</button>`).join("")}</div>`;
        document.querySelectorAll("[data-preview-customer]").forEach((button) => button.addEventListener("click", () => renderCustomerCore(matches.find((customer) => customer.id === button.dataset.previewCustomer))));
      } else showLookupError("未找到本门店活跃客户；请核对信息，或先恢复已存档客户。");
    });
    $("confirmCustomerSelection").addEventListener("click", () => { if (candidateCustomer) confirmCustomer(candidateCustomer.id); });
  }
  function showLookupError(message) { $("serviceCustomerResults").innerHTML = `<div class="lookup-placeholder error"><strong>未能确认客户</strong><span>${message}</span></div>`; }
  function resetCandidate() { candidateCustomer = null; selectedCustomer = null; $("confirmCustomerSelection").disabled = true; $("serviceCustomerResults").innerHTML = `<div class="lookup-placeholder"><strong>等待查询客户</strong><span>查询成功后，此处显示客户建档照片、姓名、生日和客户编号。</span></div>`; disableBusinessStep(); }
  function renderCustomerCore(customer) {
    const photoId = customer.profilePhotoId;
    if (!photoId) { showLookupError("客户建档照片不存在，无法确认客户，请联系有权限人员处理档案。"); return; }
    candidateCustomer = customer;
    $("serviceCustomerResults").innerHTML = `<div class="customer-core-card"><div class="customer-core-heading"><span>客户身份确认</span><strong>${customer.name}</strong></div><div class="customer-profile-layout"><figure class="customer-profile-photo"><div class="profile-photo-visual" role="img" aria-label="${customer.name}的客户建档照片"><i></i><b></b><em>静态演示</em></div><figcaption><strong>客户建档照片</strong><span>照片编号：${photoId}</span></figcaption></figure><div class="customer-profile-details"><div class="customer-core-facts"><div><span>姓名</span><strong>${customer.name}</strong></div><div><span>生日</span><strong>${customer.birthday}</strong></div><div><span>客户编号</span><strong>${customer.id}</strong></div></div><p class="profile-photo-note">确认这是客户建立档案时拍摄并保存的当前有效照片。正式系统通过授权照片接口加载原图，照片无法读取时不得确认客户。</p></div></div></div>`;
    $("confirmCustomerSelection").disabled = false;
  }
  function disableBusinessStep() { document.querySelector("form.store-business-form")?.classList.add("business-step-disabled"); }
  function confirmCustomer(id) {
    selectedCustomer = allCustomers().find((customer) => customer.id === id);
    $("selectedCustomerText").textContent = `已确认：${selectedCustomer.name}（${selectedCustomer.id}）· ${selectedCustomer.birthday} · ${storeName}`; document.querySelector("form.store-business-form").classList.remove("business-step-disabled");
    if (["verification", "verification-supplemental"].includes(page)) { photoCaptured = false; $("verificationPhotoStatus").className = "capture-status pending"; $("verificationPhotoStatus").textContent = "尚未核验"; const balances = projectBalances(selectedCustomer).filter((project) => project.remaining > 0); $("verificationProject").innerHTML = `<option value="">请选择有剩余次数的项目</option>${balances.map((project) => `<option value="${project.id}">${project.name}（剩余 ${project.remaining} 次）</option>`).join("")}`; }
    $("confirmCustomerSelection").textContent = `已确认 ${selectedCustomer.name}（${selectedCustomer.id}）`;
  }
  function setupRecharge() {
    setupLookup(); fillProjects("rechargeProject");
    $("rechargeCreateForm").addEventListener("submit", (event) => {
      event.preventDefault(); const projectId = $("rechargeProject").value, count = Number($("rechargeCount").value);
      if (!selectedCustomer || !projectId || !Number.isInteger(count) || count < 1) { $("rechargeCreateMessage").textContent = "必须确认客户、选择项目并填写有效次数"; return; }
      const records = JSON.parse(sessionStorage.getItem("prototypeRechargeApplications") || "[]"), project = projects.find((item) => item.id === projectId), recordId = `RC-NEW-${Date.now()}`, note = $("rechargeNote").value.trim();
      records.push({ id: recordId, customerId: selectedCustomer.id, customerName: selectedCustomer.name, name: selectedCustomer.name, birthday: selectedCustomer.birthday, storeId, projectId, projectName: project.name, count, status: "待审核", account: session.account, note, createdAt: new Date().toISOString() }); saveList("prototypeRechargeApplications", records); addCommunication("recharge", recordId, note);
      $("rechargeCreateMessage").textContent = `${selectedCustomer.name} · ${project.name} · ${count}次充值申请已提交，审核通过后计入次数`;
    });
  }
  function setupVerification() {
    const supplementalPage = page === "verification-supplemental";
    setupLookup(); $("verificationProject").innerHTML = `<option value="">确认客户后加载可核销项目</option>`; $("verificationTeacher").innerHTML = `<option value="">请选择老师</option>${teachers.map((teacher) => `<option value="${teacher.id}">${teacher.name}（${teacher.id}）</option>`).join("")}`;
    $("captureVerificationPhoto").addEventListener("click", () => { photoCaptured = true; $("verificationPhotoStatus").className = "capture-status complete"; $("verificationPhotoStatus").textContent = "活体检测与人脸比对通过"; });
    $("verificationCreateForm").addEventListener("submit", (event) => {
      event.preventDefault(); const projectId = $("verificationProject").value, teacherId = $("verificationTeacher").value, note = $("verificationNote").value.trim(), supplemental = supplementalPage;
      if (!selectedCustomer || !projectId || !teacherId) { $("verificationCreateMessage").textContent = "必须确认客户并选择项目和老师"; return; }
      if (!photoCaptured) { $("verificationCreateMessage").textContent = "人脸识别核验未通过，禁止核销和发送设备信号"; return; }
      if (supplemental && !note) { $("verificationCreateMessage").textContent = "补录必须填写门店备注／原因"; return; }
      const records = JSON.parse(sessionStorage.getItem("prototypeVerificationRecords") || "[]"), project = projects.find((item) => item.id === projectId), recordId = `${supplemental ? "VE-SUP" : "VE-NEW"}-${Date.now()}`;
      records.push({ id: recordId, customerId: selectedCustomer.id, customerName: selectedCustomer.name, name: selectedCustomer.name, birthday: selectedCustomer.birthday, storeId, projectId, projectName: project.name, teacherId, count: 1, faceVerification: "活体检测与人脸比对通过", verificationType: supplemental ? "补录" : "正常", status: supplemental ? "待运营审核" : "正常", deviceSignal: supplemental ? "不发送（补录）" : "虚拟端口已发送", account: session.account, note, createdAt: new Date().toISOString() }); saveList("prototypeVerificationRecords", records); addCommunication("verification", recordId, note);
      if (supplemental) { const apps = JSON.parse(sessionStorage.getItem("prototypeVerificationReviewApplications") || "[]"); apps.push({ id: `AP-V-${Date.now()}`, kind: "补录", recordId, storeId, customerId: selectedCustomer.id, customerName: selectedCustomer.name, projectId, project: project.name, teacherId, applicantNote: note, status: "pending", time: new Date().toISOString(), faceVerification: "活体检测与人脸比对通过", deviceSignal: "不发送" }); saveList("prototypeVerificationReviewApplications", apps); $("verificationCreateMessage").textContent = `${selectedCustomer.name} · ${project.name} 补录已提交运营审核；不会打开设备`; }
      else $("verificationCreateMessage").textContent = `${selectedCustomer.name} · ${project.name} 正常核销成功；已向虚拟端口发送项目权限信号`;
      photoCaptured = false; $("verificationPhotoStatus").className = "capture-status pending"; $("verificationPhotoStatus").textContent = "尚未核验";
    });
  }

  document.documentElement.dataset.prototypeVersion = VERSION;
  if (page === "customer") setupCustomerCreate(); else if (page === "recharge") setupRecharge(); else if (["verification", "verification-supplemental"].includes(page)) setupVerification();
})();
