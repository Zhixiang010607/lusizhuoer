(() => {
  "use strict";
  const VERSION = "0.14.31", page = document.body.dataset.storeBusiness, $ = (id) => document.getElementById(id);
  let session = null;
  try { session = JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); } catch (_) { session = null; }
  const storeId = String(session?.store || ""), storeNo = Number(storeId.replace(/\D/g, "")) || 1;
  let storeName = `门店 ${storeNo}`;
  let databaseCustomers = [], databaseTeachers = [], databaseProducts = [], candidateCustomer = null, selectedCustomer = null, faceCaptured = false, photoCaptured = false, rechargeEvidenceCaptured = false, capturedPhotoDataUrl = "", cameraStream = null, customerPreviewRequest = 0, balanceRequest = 0, verificationBalanceProjects = [], rechargeRequest = null;
  const allCustomers = () => databaseCustomers;
  const saveList = (key, value) => { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* 当前静态会话不可持久化时不保存演示数据。 */ } };
  const addCommunication = (recordType, recordId, message) => {
    if (!message.trim()) return;
    let rows = []; try { rows = JSON.parse(sessionStorage.getItem("prototypeCommunications") || "[]"); } catch (_) { rows = []; }
    rows.push({ recordType, recordId, role: "门店", account: session.account, name: "门店人员", message: message.trim(), time: new Date().toISOString() }); saveList("prototypeCommunications", rows);
  };
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

  function stopFaceCamera() {
    if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
    [$("faceCamera"), $("verificationCamera")].filter(Boolean).forEach((video) => { video.srcObject = null; });
  }
  function syncCustomerCreateSubmit() {
    const submit = document.querySelector('#customerCreateForm [type="submit"]');
    const consent = $("faceConsent");
    if (submit) submit.disabled = !(faceCaptured && capturedPhotoDataUrl && consent?.checked);
  }
  function resetCapturedPhoto() {
    capturedPhotoDataUrl = ""; faceCaptured = false;
    const preview = $("facePhotoPreview"), placeholder = $("faceCameraPlaceholder");
    const canvas = $("faceCaptureCanvas");
    if (canvas) { canvas.width = 0; canvas.height = 0; }
    preview.hidden = true; preview.removeAttribute("src"); placeholder.hidden = false;
    $("openFaceCamera").hidden = false; $("openFaceCamera").disabled = false;
    $("captureFace").disabled = true; $("retakeFace").hidden = true;
    $("faceCaptureStatus").className = "capture-status pending"; $("faceCaptureStatus").textContent = "尚未拍摄";
    if ($("faceQualityResult")) $("faceQualityResult").textContent = "待检测";
    if ($("faceLivenessResult")) $("faceLivenessResult").textContent = "待检测";
    syncCustomerCreateSubmit();
  }
  function parsedObject(value) {
    if (value && typeof value === "object") return value;
    if (typeof value !== "string") return null;
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" ? parsed : null; } catch (_) { return null; }
  }
  function cloudFunctionData(result) {
    return [result?.result, result?.data?.result, result?.data, result].map(parsedObject).find((candidate) => candidate && (
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
  async function callCustomerEnrollment(payload) {
    if (!window.cloudbase || !window.CloudBaseAuthConfig || !window.registerFunctions) throw new Error("CloudBase 客户建档组件未加载，请刷新后重试");
    registerCloudBaseComponent(window.registerAuth, "auth");
    registerCloudBaseComponent(window.registerFunctions, "functions");
    const app = window.cloudbase.init(window.CloudBaseAuthConfig);
    let result;
    try {
      result = await app.callFunction({ name: "faceRecognition", data: payload });
    } catch (error) {
      const diagnostic = [error?.code, error?.requestId || error?.RequestId].filter(Boolean).join(" · ");
      throw new Error(`${error?.message || "腾讯云函数调用失败"}${diagnostic ? `（${diagnostic}）` : ""}`);
    }
    const data = cloudFunctionData(result);
    if (!data?.ok) {
      const diagnostic = [data?.code, data?.requestId].filter(Boolean).join(" · ");
      const error = new Error(`${data?.message || "腾讯云客户建档失败：云函数没有返回业务结果"}${diagnostic ? `（${diagnostic}）` : ""}`);
      error.code = data?.code || "EMPTY_FUNCTION_RESULT";
      error.requestId = data?.requestId || "";
      throw error;
    }
    return data;
  }
  async function loadActiveTeachers(selectId, messageId) {
    const select = $(selectId);
    if (!select) return;
    select.disabled = true;
    select.innerHTML = `<option value="">正在从数据库读取活跃老师…</option>`;
    try {
      const result = await callCustomerEnrollment({ action: "listActiveTeachers" });
      databaseTeachers = (Array.isArray(result?.teachers) ? result.teachers : []).map((teacher) => ({
        id: String(teacher.teacherId || ""),
        code: String(teacher.teacherCode || ""),
        name: String(teacher.teacherName || "")
      })).filter((teacher) => teacher.id && teacher.name);
      select.innerHTML = databaseTeachers.length
        ? `<option value="">请选择老师</option>${databaseTeachers.map((teacher) => `<option value="${escapeHtml(teacher.id)}">${escapeHtml(teacher.name)}（${escapeHtml(teacher.code)}）</option>`).join("")}`
        : `<option value="">数据库中暂无活跃老师</option>`;
      select.disabled = databaseTeachers.length === 0;
    } catch (error) {
      databaseTeachers = [];
      select.innerHTML = `<option value="">老师数据读取失败，禁止提交</option>`;
      select.disabled = true;
      const message = $(messageId);
      if (message) message.textContent = error?.message || "无法从数据库读取活跃老师，请刷新后重试";
    }
  }
  async function loadActiveProducts(selectId, messageId) {
    const select = $(selectId);
    if (!select) return;
    select.disabled = true;
    select.innerHTML = `<option value="">正在从数据库读取活跃项目…</option>`;
    try {
      const result = await callCustomerEnrollment({ action: "listActiveProducts" });
      databaseProducts = (Array.isArray(result?.products) ? result.products : []).map((product) => ({
        id: String(product.productId || ""),
        code: String(product.productCode || ""),
        name: String(product.productName || "")
      })).filter((product) => product.id && product.name);
      select.innerHTML = databaseProducts.length
        ? `<option value="">请选择项目</option>${databaseProducts.map((product) => `<option value="${escapeHtml(product.id)}">${escapeHtml(product.name)}（${escapeHtml(product.code)}）</option>`).join("")}`
        : `<option value="">数据库中暂无活跃项目</option>`;
      select.disabled = databaseProducts.length === 0;
    } catch (error) {
      databaseProducts = [];
      select.innerHTML = `<option value="">项目数据读取失败，禁止提交</option>`;
      select.disabled = true;
      const message = $(messageId);
      if (message) message.textContent = error?.message || "无法从数据库读取活跃项目，请刷新后重试";
    }
  }

  function nextRechargeRequestId(payload) {
    const fingerprint = JSON.stringify(payload);
    if (!rechargeRequest || rechargeRequest.fingerprint !== fingerprint) {
      const key = window.crypto?.randomUUID?.() || `recharge_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
      rechargeRequest = { key, fingerprint };
    }
    return rechargeRequest.key;
  }
  function setupCustomerCreate() {
    const video = $("faceCamera"), preview = $("facePhotoPreview"), placeholder = $("faceCameraPlaceholder"), status = $("faceCaptureStatus"), message = $("customerCreateMessage"), capture = $("captureFace"), openCamera = $("openFaceCamera"), retake = $("retakeFace");
    $("faceConsent").addEventListener("change", syncCustomerCreateSubmit);
    syncCustomerCreateSubmit();
    openCamera.addEventListener("click", async () => {
      try {
        stopFaceCamera(); resetCapturedPhoto();
        openCamera.hidden = true;
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前浏览器不支持摄像头访问，请使用最新版 Chrome 或 Edge");
        cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 960 }, height: { ideal: 1280 } }, audio: false });
        video.srcObject = cameraStream; video.hidden = false; placeholder.hidden = true; await video.play(); capture.disabled = false;
        status.className = "capture-status pending"; status.textContent = "摄像头已打开，请确认客户正对镜头后拍照";
      } catch (error) {
        stopFaceCamera(); openCamera.hidden = false; capture.disabled = true; status.className = "capture-status pending"; status.textContent = "无法打开摄像头"; message.textContent = error?.message || "请检查浏览器摄像头权限";
      }
    });
    capture.addEventListener("click", async () => {
      if (!cameraStream || !video.videoWidth || !video.videoHeight) { message.textContent = "摄像头画面尚未就绪，请稍后重新拍照"; return; }
      const canvas = $("faceCaptureCanvas"), targetRatio = 3 / 4;
      let sourceWidth = video.videoWidth, sourceHeight = video.videoHeight;
      if (sourceWidth / sourceHeight > targetRatio) sourceWidth = sourceHeight * targetRatio;
      else sourceHeight = sourceWidth / targetRatio;
      const sourceX = Math.round((video.videoWidth - sourceWidth) / 2), sourceY = Math.round((video.videoHeight - sourceHeight) / 2);
      const outputHeight = Math.round(Math.min(sourceHeight, 1280));
      canvas.height = outputHeight; canvas.width = Math.round(outputHeight * targetRatio);
      canvas.getContext("2d", { alpha: false }).drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
      capturedPhotoDataUrl = canvas.toDataURL("image/jpeg", 0.88); faceCaptured = false; preview.src = capturedPhotoDataUrl; preview.hidden = false; video.hidden = true; stopFaceCamera(); openCamera.hidden = true; capture.disabled = true; retake.hidden = false;
      status.className = "capture-status pending"; status.textContent = "正在检查人脸、清晰度、遮挡和拍摄角度…"; message.textContent = ""; syncCustomerCreateSubmit();
      if ($("faceQualityResult")) $("faceQualityResult").textContent = "检测中…";
      if ($("faceLivenessResult")) $("faceLivenessResult").textContent = "等待质量检测";
      try {
        const validation = await callCustomerEnrollment({ action: "validateCapture", imageBase64: capturedPhotoDataUrl });
        faceCaptured = true;
        const score = Number(validation?.quality?.qualityScore);
        const qualityThreshold = validation?.quality?.qualityThreshold;
        const live = validation?.liveness || {};
        if ($("faceQualityResult")) $("faceQualityResult").textContent = Number.isFinite(score) ? `通过 · ${score} 分${qualityThreshold != null ? `（要求 ${qualityThreshold}）` : ""}` : "通过";
        if ($("faceLivenessResult")) $("faceLivenessResult").textContent = live.checked ? `通过 · ${live.score} 分${live.threshold != null ? `（要求 ${live.threshold}）` : ""}` : "未启用";
        status.className = "capture-status complete"; status.textContent = `${live.checked ? "照片质量与活体检测" : "照片质量检查"}通过；可以建立客户档案`;
      } catch (error) {
        faceCaptured = false;
        const livenessFailed = error?.code === "LIVENESS_FAILED";
        const captureRejected = ["FACE_NOT_FOUND", "MULTIPLE_FACES", "FACE_TOO_SMALL", "FACE_QUALITY_LOW", "FACE_MASKED", "EYES_CLOSED", "FACE_POSE_INVALID"].includes(error?.code);
        status.className = "capture-status pending"; status.textContent = livenessFailed ? "活体检测未通过，请重新拍照" : captureRejected ? "照片质量未通过，请重新拍照" : "检测服务调用失败，请查看下方错误";
        if ($("faceQualityResult")) $("faceQualityResult").textContent = livenessFailed ? "通过" : captureRejected ? "未通过" : "检测失败";
        if ($("faceLivenessResult")) $("faceLivenessResult").textContent = livenessFailed ? "未通过" : captureRejected ? "未执行" : "检测失败";
        message.textContent = error?.message || "照片不符合建档要求，请重新拍摄";
      }
      syncCustomerCreateSubmit();
    });
    retake.addEventListener("click", () => { resetCapturedPhoto(); openCamera.click(); });
    window.addEventListener("pagehide", stopFaceCamera, { once: true });
    $("customerCreateForm").addEventListener("submit", async (event) => {
      event.preventDefault(); const name = $("createCustomerName").value.trim(), birthday = $("createCustomerBirthday").value, notes = $("createCustomerNotes").value.trim();
      if (!name || !birthday) { message.textContent = "姓名和生日必须填写"; return; }
      if (!faceCaptured || !capturedPhotoDataUrl || !$("faceConsent").checked) { message.textContent = "必须拍摄客户照片并取得明确授权后才能建立档案"; return; }
      const submit = event.currentTarget.querySelector('[type="submit"]'); submit.disabled = true; message.textContent = "正在上传照片、创建人脸档案并保存客户资料…";
      try {
        const data = await callCustomerEnrollment({ action: "registerCustomer", customerName: name, birthDate: birthday, notes, consent: true, imageBase64: capturedPhotoDataUrl });
        const customer = data.customer;
        const savedCustomer = { id: customer.customerCode, name, birthday, notes: customer.notes ?? notes, storeId: customer.storeId || storeId, customerStatus: customer.customerStatus, customerProcessStatus: customer.customerProcessStatus, totalRechargeCount: customer.totalRechargeCount || 0, totalVerificationCount: customer.totalVerificationCount || 0, totalExperienceCount: customer.totalExperienceCount || 0, hasProfilePhoto: true, createdAt: customer.createdAt || "" };
        databaseCustomers = [savedCustomer, ...databaseCustomers.filter((item) => item.id !== savedCustomer.id)];
        message.textContent = `客户 ${name}（${customer.customerCode}）已建立；照片已留存腾讯云并已录入人脸库。`;
        event.target.reset(); resetCapturedPhoto();
      } catch (error) {
        message.textContent = error?.message || "客户建档失败；照片和人脸资料不会保留为半成品，请重试";
      } finally { syncCustomerCreateSubmit(); }
    });
  }
  function setupLookup() {
    let activeCustomers = [];
    const customerSelect = $("serviceCustomerSelect");
    customerSelect.disabled = true;
    customerSelect.innerHTML = `<option value="">正在从数据库读取本门店活跃客户…</option>`;
    const loadActiveCustomers = async () => {
      try {
        const result = await callCustomerEnrollment({ action: "listActiveStoreCustomers" });
        storeName = String(result?.storeName || result?.storeCode || storeName);
        activeCustomers = (Array.isArray(result?.customers) ? result.customers : []).map((customer) => ({
          id: String(customer.customerCode || ""),
          name: String(customer.customerName || ""),
          birthday: String(customer.birthDate || "").slice(0, 10)
        })).filter((customer) => customer.id && customer.name && customer.birthday);
        databaseCustomers = activeCustomers;
        customerSelect.innerHTML = activeCustomers.length
          ? `<option value="">请选择现有客户</option>${activeCustomers.map((customer) => `<option value="${escapeHtml(customer.id)}">${escapeHtml(customer.name)}（${escapeHtml(customer.id)}）</option>`).join("")}`
          : `<option value="">本门店暂无活跃客户</option>`;
        customerSelect.disabled = activeCustomers.length === 0;
      } catch (error) {
        activeCustomers = [];
        databaseCustomers = [];
        customerSelect.innerHTML = `<option value="">客户数据读取失败</option>`;
        customerSelect.disabled = true;
        showLookupError(error?.message || "无法从数据库读取本门店活跃客户，请刷新重试。");
      }
    };
    const lookupSelectedCustomer = () => {
      resetCandidate();
      const id = $("serviceCustomerSelect").value;
      const birthday = $("serviceSelectBirthday").value;
      if (!id) return;
      if (!birthday) { showLookupError("所选客户缺少生日资料，暂时不能办理业务，请先补全档案。"); return; }
      const customer = activeCustomers.find((item) => item.id === id && item.birthday === birthday);
      if (!customer) { showLookupError("所选生日与客户档案不一致，请重新核对。"); return; }
      renderCustomerCore(customer);
    };
    $("serviceCustomerSelect").addEventListener("change", () => {
      const customer = activeCustomers.find((item) => item.id === $("serviceCustomerSelect").value);
      $("serviceSelectBirthday").value = customer?.birthday || "";
      lookupSelectedCustomer();
    });
    $("serviceCustomerName").addEventListener("input", resetCandidate); $("serviceCustomerBirthday").addEventListener("change", resetCandidate);
    document.querySelectorAll("[data-lookup-mode]").forEach((button) => button.addEventListener("click", () => {
      document.querySelectorAll("[data-lookup-mode]").forEach((item) => item.classList.toggle("active", item === button));
      const manual = button.dataset.lookupMode === "manual"; $("selectLookupFields").hidden = manual; $("manualLookupFields").hidden = !manual; resetCandidate();
    }));
    $("serviceSelectLookup").addEventListener("click", () => {
      if (!$("serviceCustomerSelect").value) { resetCandidate(); showLookupError("必须先选择现有客户。"); return; }
      lookupSelectedCustomer();
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
    loadActiveCustomers();
  }
  function showLookupError(message) { $("serviceCustomerResults").innerHTML = `<div class="lookup-placeholder error"><strong>未能确认客户</strong><span>${message}</span></div>`; }
  function resetCandidate() {
    customerPreviewRequest += 1;
    balanceRequest += 1;
    candidateCustomer = null;
    selectedCustomer = null;
    verificationBalanceProjects = [];
    if (["verification", "verification-supplemental"].includes(page)) resetVerificationCapture();
    $("confirmCustomerSelection").disabled = true;
    $("serviceCustomerResults").innerHTML = `<div class="lookup-placeholder"><strong>等待查询客户</strong><span>查询成功后，此处显示客户建档照片、姓名、生日和客户编号。</span></div>`;
    disableBusinessStep();
  }
  async function renderCustomerCore(customer) {
    const request = ++customerPreviewRequest;
    candidateCustomer = null;
    $("confirmCustomerSelection").disabled = true;
    $("serviceCustomerResults").innerHTML = `<div class="lookup-placeholder"><strong>正在安全读取客户照片</strong><span>正在验证当前门店权限并生成短时访问地址…</span></div>`;
    try {
      const result = await callCustomerEnrollment({ action: "getActiveStoreCustomerDetail", customerCode: customer.id });
      if (request !== customerPreviewRequest) return;
      const detail = result?.customer && typeof result.customer === "object" ? result.customer : {};
      if (String(detail.customerCode || "") !== customer.id) throw new Error("客户详情与所选客户不一致，请重新查询");
      customer.name = String(detail.customerName || customer.name || "");
      customer.birthday = String(detail.birthDate || customer.birthday || "").slice(0, 10);
      customer.notes = String(detail.notes || "");
      customer.storeId = String(detail.storeId || "");
      customer.customerStatus = String(detail.customerStatus || "");
      customer.customerProcessStatus = String(detail.customerProcessStatus || "");
      customer.totalRechargeCount = Number(detail.totalRechargeCount || 0);
      customer.totalVerificationCount = Number(detail.totalVerificationCount || 0);
      customer.totalExperienceCount = Number(detail.totalExperienceCount || 0);
      customer.hasProfilePhoto = detail.hasProfilePhoto === true;
      customer.createdAt = detail.createdAt || "";
      const photoUrl = String(result?.photoUrl || "");
      const customerNotes = customer.notes.trim();
      customer.notes = customerNotes;
      if (!/^https:\/\//i.test(photoUrl)) throw new Error("客户照片临时地址无效，请刷新后重试");
      $("serviceCustomerResults").innerHTML = `<div class="customer-core-card"><div class="customer-core-heading"><span>客户身份确认</span><strong>${escapeHtml(customer.name)}</strong></div><div class="customer-profile-layout"><figure class="customer-profile-photo"><div class="profile-photo-visual has-photo"><img id="selectedCustomerProfilePhoto" alt="${escapeHtml(customer.name)}的客户建档照片" referrerpolicy="no-referrer"></div><figcaption><strong>客户建档照片</strong><span>私有照片 · 临时授权显示</span></figcaption></figure><div class="customer-profile-details"><div class="customer-core-facts"><div><span>姓名</span><strong>${escapeHtml(customer.name)}</strong></div><div><span>生日</span><strong>${escapeHtml(customer.birthday)}</strong></div><div><span>客户编号</span><strong>${escapeHtml(customer.id)}</strong></div><div><span>客户备注</span><strong>${escapeHtml(customerNotes || "—")}</strong></div></div><p class="profile-photo-note">请核对照片与现场客户。该地址短时有效，照片无法读取时禁止继续确认客户。</p></div></div></div>`;
      const image = $("selectedCustomerProfilePhoto");
      image.addEventListener("load", () => {
        if (request !== customerPreviewRequest) return;
        candidateCustomer = customer;
        $("confirmCustomerSelection").disabled = false;
      }, { once: true });
      image.addEventListener("error", () => {
        if (request !== customerPreviewRequest) return;
        candidateCustomer = null;
        $("confirmCustomerSelection").disabled = true;
        showLookupError("客户建档照片读取失败，不能继续确认客户，请刷新后重试。");
      }, { once: true });
      image.src = photoUrl;
    } catch (error) {
      if (request !== customerPreviewRequest) return;
      showLookupError(error?.message || "客户建档照片读取失败，不能继续确认客户。");
    }
  }
  function disableBusinessStep() { document.querySelector("form.store-business-form")?.classList.add("business-step-disabled"); }
  async function loadVerificationBalances(customer) {
    const select = $("verificationProject");
    if (!select) return;
    const request = ++balanceRequest;
    verificationBalanceProjects = [];
    select.disabled = true;
    select.innerHTML = `<option value="">正在读取该客户的真实项目余额…</option>`;
    try {
      const result = await callCustomerEnrollment({ action: "getCustomerProductBalances", customerCode: customer.id });
      if (request !== balanceRequest || selectedCustomer?.id !== customer.id) return;
      verificationBalanceProjects = (Array.isArray(result?.balances) ? result.balances : [])
        .filter((item) => Number(item.remainingCount) > 0)
        .map((item) => ({
          id: String(item.productId),
          code: String(item.productCode || ""),
          name: String(item.productName || item.productCode || "未命名产品"),
          purchased: Number(item.purchasedCount || 0),
          verified: Number(item.effectiveVerificationCount || 0),
          remaining: Number(item.remainingCount || 0)
        }));
      select.innerHTML = verificationBalanceProjects.length
        ? `<option value="">请选择有剩余次数的项目</option>${verificationBalanceProjects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}（${escapeHtml(project.code)} · 剩余 ${project.remaining} 次）</option>`).join("")}`
        : `<option value="">该客户没有可核销的剩余项目</option>`;
      select.disabled = verificationBalanceProjects.length === 0;
    } catch (error) {
      if (request !== balanceRequest || selectedCustomer?.id !== customer.id) return;
      select.innerHTML = `<option value="">项目余额读取失败，禁止继续核销</option>`;
      select.disabled = true;
      const message = $("verificationCreateMessage");
      if (message) message.textContent = error?.message || "项目余额读取失败，请刷新后重试";
    }
  }
  async function confirmCustomer(id) {
    selectedCustomer = allCustomers().find((customer) => customer.id === id);
    $("selectedCustomerText").textContent = `已确认：${selectedCustomer.name}（${selectedCustomer.id}）· ${selectedCustomer.birthday} · ${storeName}`; document.querySelector("form.store-business-form").classList.remove("business-step-disabled");
    if (["verification", "verification-supplemental"].includes(page)) { resetVerificationCapture(); await loadVerificationBalances(selectedCustomer); }
    $("confirmCustomerSelection").textContent = `已确认 ${selectedCustomer.name}（${selectedCustomer.id}）`;
  }
  function setupRecharge() {
    setupLookup(); loadActiveProducts("rechargeProject", "rechargeCreateMessage"); loadActiveTeachers("rechargeTeacher", "rechargeCreateMessage");
    $("rechargeCreateForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget, submit = form.querySelector('[type="submit"]');
      const projectId = $("rechargeProject").value, teacherId = $("rechargeTeacher").value, count = Number($("rechargeCount").value), note = $("rechargeNote").value.trim();
      if (!selectedCustomer || !projectId || !teacherId || !Number.isInteger(count) || count < 1 || count > 999) { $("rechargeCreateMessage").textContent = "必须确认客户、选择项目和老师，并填写 1 至 999 的整数充值次数"; return; }
      const project = databaseProducts.find((item) => item.id === projectId), teacher = databaseTeachers.find((item) => item.id === teacherId);
      if (!project || !teacher) { $("rechargeCreateMessage").textContent = "项目或老师数据已经失效，请刷新页面后重新选择"; return; }
      const payload = { customerCode: selectedCustomer.id, productId: project.id, teacherId: teacher.id, unitCount: count, message: note };
      const clientRequestId = nextRechargeRequestId(payload);
      submit.disabled = true;
      $("rechargeCreateMessage").textContent = "正在向数据库提交待审核充值单…";
      try {
        const result = await callCustomerEnrollment({ action: "createRechargeApplication", ...payload, clientRequestId });
        if (String(result.recordStatus || "") !== "PENDING") throw new Error("数据库返回的充值单状态不是待审核，已停止后续操作");
        rechargeRequest = null;
        $("rechargeCreateMessage").textContent = `${selectedCustomer.name} · ${project.name} · ${count} 次充值单 ${result.rechargeCode} 已提交，当前为待审核；仅审核通过后才增加次数`;
      } catch (error) {
        $("rechargeCreateMessage").textContent = error?.message || "充值申请提交失败，请核对数据库与云函数";
      } finally {
        submit.disabled = false;
      }
    });
  }
  function syncVerificationSubmit() {
    const submit = $("verificationSubmit");
    if (submit) submit.disabled = !photoCaptured;
  }
  function resetVerificationCapture() {
    stopFaceCamera(); capturedPhotoDataUrl = ""; photoCaptured = false;
    const video = $("verificationCamera"), preview = $("verificationPhotoPreview"), placeholder = $("verificationCameraPlaceholder"), canvas = $("verificationCaptureCanvas"), open = $("openVerificationCamera"), capture = $("captureVerificationPhoto"), retake = $("retakeVerificationPhoto");
    if (!video || !preview || !placeholder || !canvas || !open || !capture || !retake) return;
    video.hidden = true; preview.hidden = true; preview.removeAttribute("src"); placeholder.hidden = false;
    canvas.width = 0; canvas.height = 0; open.hidden = false; open.disabled = false; capture.disabled = true; retake.hidden = true;
    $("verificationPhotoStatus").className = "capture-status pending"; $("verificationPhotoStatus").textContent = "尚未核验";
    syncVerificationSubmit();
  }
  function setupVerification() {
    const supplementalPage = page === "verification-supplemental";
    setupLookup(); $("verificationProject").innerHTML = `<option value="">确认客户后从数据库加载可核销项目</option>`; loadActiveTeachers("verificationTeacher", "verificationCreateMessage");
    const video = $("verificationCamera"), preview = $("verificationPhotoPreview"), placeholder = $("verificationCameraPlaceholder"), canvas = $("verificationCaptureCanvas"), open = $("openVerificationCamera"), capture = $("captureVerificationPhoto"), retake = $("retakeVerificationPhoto"), status = $("verificationPhotoStatus"), message = $("verificationCreateMessage");
    resetVerificationCapture();
    open.addEventListener("click", async () => {
      try {
        if (!selectedCustomer) throw new Error("请先查询并确认需要核销的客户");
        resetVerificationCapture(); open.hidden = true;
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前浏览器不支持摄像头访问，请使用最新版 Chrome 或 Edge");
        cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 960 }, height: { ideal: 1280 } }, audio: false });
        video.srcObject = cameraStream; video.hidden = false; placeholder.hidden = true; await video.play(); capture.disabled = false;
        status.className = "capture-status pending"; status.textContent = "摄像头已打开，请让所选客户正对镜头"; message.textContent = "";
      } catch (error) {
        stopFaceCamera(); open.hidden = false; capture.disabled = true; status.className = "capture-status pending"; status.textContent = "无法开始验证"; message.textContent = error?.message || "请检查摄像头权限";
      }
    });
    capture.addEventListener("click", async () => {
      if (!selectedCustomer) { message.textContent = "请重新确认需要核销的客户"; return; }
      if (!cameraStream || !video.videoWidth || !video.videoHeight) { message.textContent = "摄像头画面尚未就绪，请稍后重试"; return; }
      const targetRatio = 3 / 4;
      let sourceWidth = video.videoWidth, sourceHeight = video.videoHeight;
      if (sourceWidth / sourceHeight > targetRatio) sourceWidth = sourceHeight * targetRatio;
      else sourceHeight = sourceWidth / targetRatio;
      const sourceX = Math.round((video.videoWidth - sourceWidth) / 2), sourceY = Math.round((video.videoHeight - sourceHeight) / 2), outputHeight = Math.round(Math.min(sourceHeight, 1280));
      canvas.height = outputHeight; canvas.width = Math.round(outputHeight * targetRatio);
      canvas.getContext("2d", { alpha: false }).drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
      capturedPhotoDataUrl = canvas.toDataURL("image/jpeg", 0.88); preview.src = capturedPhotoDataUrl; preview.hidden = false; video.hidden = true; stopFaceCamera(); open.hidden = true; capture.disabled = true; retake.hidden = false;
      photoCaptured = false; syncVerificationSubmit(); status.className = "capture-status pending"; status.textContent = "正在与所选客户进行 1:1 人脸验证…"; message.textContent = "";
      try {
        const result = await callCustomerEnrollment({ action: "verifyCustomerFace", customerCode: selectedCustomer.id, imageBase64: capturedPhotoDataUrl });
        if (!result.matched) throw new Error(`${result.message || "1:1 人脸验证未通过"}（相似度 ${result.score ?? 0}，要求 ${result.threshold ?? "-"}）`);
        photoCaptured = true;
        const livenessText = result?.liveness?.checked ? "、活体检测" : "";
        status.className = "capture-status complete"; status.textContent = `所选客户 1:1 人脸验证${livenessText}通过（${result.score} 分）`;
      } catch (error) {
        photoCaptured = false; status.className = "capture-status pending"; status.textContent = "1:1 人脸验证未通过，请重新拍照"; message.textContent = error?.message || "现场人脸与所选客户不一致";
      }
      syncVerificationSubmit();
    });
    retake.addEventListener("click", () => { resetVerificationCapture(); open.click(); });
    window.addEventListener("pagehide", stopFaceCamera, { once: true });
    $("verificationCreateForm").addEventListener("submit", (event) => {
      event.preventDefault(); const projectId = $("verificationProject").value, teacherId = $("verificationTeacher").value, note = $("verificationNote").value.trim(), supplemental = supplementalPage;
      if (!selectedCustomer || !projectId || !teacherId) { $("verificationCreateMessage").textContent = "必须确认客户并选择项目和老师"; return; }
      if (!photoCaptured) { $("verificationCreateMessage").textContent = "人脸识别核验未通过，禁止核销和发送设备信号"; return; }
      if (supplemental && !note) { $("verificationCreateMessage").textContent = "补录必须填写门店备注／原因"; return; }
      const records = JSON.parse(sessionStorage.getItem("prototypeVerificationRecords") || "[]"), project = verificationBalanceProjects.find((item) => item.id === projectId), recordId = `${supplemental ? "VE-SUP" : "VE-NEW"}-${Date.now()}`;
      if (!project) { $("verificationCreateMessage").textContent = "所选项目余额已失效，请重新确认客户后再试"; return; }
      records.push({ id: recordId, customerId: selectedCustomer.id, customerName: selectedCustomer.name, name: selectedCustomer.name, birthday: selectedCustomer.birthday, storeId, projectId, projectName: project.name, teacherId, count: 1, faceVerification: "活体检测与人脸比对通过", verificationType: supplemental ? "补录" : "正常", status: supplemental ? "待运营审核" : "正常", deviceSignal: supplemental ? "不发送（补录）" : "虚拟端口已发送", account: session.account, note, createdAt: new Date().toISOString() }); saveList("prototypeVerificationRecords", records); addCommunication("verification", recordId, note);
      if (supplemental) { const apps = JSON.parse(sessionStorage.getItem("prototypeVerificationReviewApplications") || "[]"); apps.push({ id: `AP-V-${Date.now()}`, kind: "补录", recordId, storeId, customerId: selectedCustomer.id, customerName: selectedCustomer.name, projectId, project: project.name, teacherId, applicantNote: note, status: "pending", time: new Date().toISOString(), faceVerification: "活体检测与人脸比对通过", deviceSignal: "不发送" }); saveList("prototypeVerificationReviewApplications", apps); $("verificationCreateMessage").textContent = `${selectedCustomer.name} · ${project.name} 补录已提交运营审核；不会打开设备`; }
      else $("verificationCreateMessage").textContent = `${selectedCustomer.name} · ${project.name} 正常核销成功；已向虚拟端口发送项目权限信号`;
      resetVerificationCapture();
    });
  }

  document.documentElement.dataset.prototypeVersion = VERSION;
  if (page === "customer") setupCustomerCreate(); else if (page === "recharge") setupRecharge(); else if (["verification", "verification-supplemental"].includes(page)) setupVerification();
})();
