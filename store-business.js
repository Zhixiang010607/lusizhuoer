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
  let created = [], archived = new Set(), candidateCustomer = null, selectedCustomer = null, faceCaptured = false, photoCaptured = false, rechargeEvidenceCaptured = false, capturedPhotoDataUrl = "", cameraStream = null;
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

  function stopFaceCamera() {
    if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
    const video = $("faceCamera");
    if (video) video.srcObject = null;
  }
  function resetCapturedPhoto() {
    capturedPhotoDataUrl = ""; faceCaptured = false;
    const preview = $("facePhotoPreview"), placeholder = $("faceCameraPlaceholder");
    preview.hidden = true; preview.removeAttribute("src"); placeholder.hidden = false;
    $("retakeFace").hidden = true; $("faceCaptureStatus").className = "capture-status pending"; $("faceCaptureStatus").textContent = "尚未拍摄";
  }
  function cloudFunctionData(result) { return result?.result || result?.data?.result || result?.data || {}; }
  async function callCustomerEnrollment(payload) {
    if (!window.cloudbase || !window.CloudBaseAuthConfig || !window.registerFunctions) throw new Error("CloudBase 客户建档组件未加载，请刷新后重试");
    window.registerAuth?.(window.cloudbase); window.registerFunctions(window.cloudbase);
    const app = window.cloudbase.init(window.CloudBaseAuthConfig);
    const result = await app.callFunction({ name: "faceRecognition", data: payload });
    const data = cloudFunctionData(result);
    if (!data?.ok) throw new Error(data?.message || "腾讯云客户建档失败");
    return data;
  }
  function setupCustomerCreate() {
    const video = $("faceCamera"), preview = $("facePhotoPreview"), placeholder = $("faceCameraPlaceholder"), status = $("faceCaptureStatus"), message = $("customerCreateMessage"), capture = $("captureFace"), openCamera = $("openFaceCamera"), retake = $("retakeFace");
    openCamera.addEventListener("click", async () => {
      try {
        stopFaceCamera(); resetCapturedPhoto();
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前浏览器不支持摄像头访问，请使用最新版 Chrome 或 Edge");
        cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
        video.srcObject = cameraStream; video.hidden = false; placeholder.hidden = true; await video.play(); capture.disabled = false;
        status.className = "capture-status pending"; status.textContent = "摄像头已打开，请确认客户正对镜头后拍照";
      } catch (error) {
        stopFaceCamera(); capture.disabled = true; status.className = "capture-status pending"; status.textContent = "无法打开摄像头"; message.textContent = error?.message || "请检查浏览器摄像头权限";
      }
    });
    capture.addEventListener("click", () => {
      if (!cameraStream || !video.videoWidth || !video.videoHeight) { message.textContent = "摄像头画面尚未就绪，请稍后重新拍照"; return; }
      const canvas = $("faceCaptureCanvas"), cropSize = Math.min(video.videoWidth, video.videoHeight), maxSide = 1280, scale = Math.min(1, maxSide / cropSize);
      const sourceX = Math.round((video.videoWidth - cropSize) / 2), sourceY = Math.round((video.videoHeight - cropSize) / 2);
      canvas.width = Math.round(cropSize * scale); canvas.height = canvas.width;
      canvas.getContext("2d", { alpha: false }).drawImage(video, sourceX, sourceY, cropSize, cropSize, 0, 0, canvas.width, canvas.height);
      capturedPhotoDataUrl = canvas.toDataURL("image/jpeg", 0.9); faceCaptured = true; preview.src = capturedPhotoDataUrl; preview.hidden = false; video.hidden = true; stopFaceCamera(); capture.disabled = true; retake.hidden = false;
      status.className = "capture-status complete"; status.textContent = "照片已拍摄；建立档案时将上传腾讯云并录入人脸库"; message.textContent = "";
    });
    retake.addEventListener("click", () => { resetCapturedPhoto(); openCamera.click(); });
    window.addEventListener("pagehide", stopFaceCamera, { once: true });
    $("customerCreateForm").addEventListener("submit", async (event) => {
      event.preventDefault(); const name = $("createCustomerName").value.trim(), birthday = $("createCustomerBirthday").value, notes = $("createCustomerNotes").value.trim();
      if (!name || !birthday) { message.textContent = "姓名和生日必须填写"; return; }
      if (!faceCaptured || !capturedPhotoDataUrl || !$("faceConsent").checked) { message.textContent = "必须拍摄客户照片并取得明确授权后才能建立档案"; return; }
      const duplicate = allCustomers().find((customer) => customer.name === name && customer.birthday === birthday && !archived.has(customer.id));
      if (duplicate) { message.textContent = `发现本门店同名同生日客户 ${duplicate.id}，请先核对，不能重复建档`; return; }
      const submit = event.currentTarget.querySelector('[type="submit"]'); submit.disabled = true; message.textContent = "正在上传照片、创建人脸档案并保存客户资料…";
      try {
        const data = await callCustomerEnrollment({ action: "registerCustomer", customerName: name, birthDate: birthday, notes, consent: true, imageBase64: capturedPhotoDataUrl });
        const customer = data.customer;
        created.push({ id: customer.customerCode, name, birthday, notes, storeId, faceStatus: "已录入", profilePhotoId: customer.photoFileId, profilePhotoStatus: "已保存", facePersonId: customer.facePersonId, createdBy: session.account }); saveList("prototypeCreatedCustomers", created);
        message.textContent = `客户 ${name}（${customer.customerCode}）已建立；照片已留存腾讯云并已录入人脸库。`;
        event.target.reset(); resetCapturedPhoto();
      } catch (error) {
        message.textContent = error?.message || "客户建档失败；照片和人脸资料不会保留为半成品，请重试";
      } finally { submit.disabled = false; }
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
    setupLookup(); fillProjects("rechargeProject"); $("rechargeTeacher").innerHTML = `<option value="">请选择老师</option>${teachers.map((teacher) => `<option value="${teacher.id}">${teacher.name}（${teacher.id}）</option>`).join("")}`;
    $("rechargeCreateForm").addEventListener("submit", (event) => {
      event.preventDefault(); const projectId = $("rechargeProject").value, teacherId = $("rechargeTeacher").value, count = Number($("rechargeCount").value);
      if (!selectedCustomer || !projectId || !teacherId || !Number.isInteger(count) || count < 1) { $("rechargeCreateMessage").textContent = "必须确认客户、选择项目和老师并填写有效次数"; return; }
      const records = JSON.parse(sessionStorage.getItem("prototypeRechargeApplications") || "[]"), project = projects.find((item) => item.id === projectId), recordId = `RC-NEW-${Date.now()}`, note = $("rechargeNote").value.trim();
      records.push({ id: recordId, customerId: selectedCustomer.id, customerName: selectedCustomer.name, name: selectedCustomer.name, birthday: selectedCustomer.birthday, storeId, projectId, projectName: project.name, teacherId, count, status: "待审核", account: session.account, note, createdAt: new Date().toISOString() }); saveList("prototypeRechargeApplications", records); addCommunication("recharge", recordId, note);
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
