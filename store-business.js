(() => {
  "use strict";
  const VERSION = "0.14.47", page = document.body.dataset.storeBusiness, $ = (id) => document.getElementById(id);
  const formatBirthday = (value, fallback = "—") => {
    const raw = String(value ?? "").trim();
    if (!raw) return fallback;
    const match = raw.match(/^(\d{4})[-年](\d{1,2})[-月](\d{1,2})(?:日|[T\s].*)?$/);
    return match ? `${match[1]}年${match[2].padStart(2, "0")}月${match[3].padStart(2, "0")}日` : raw;
  };
  let session = null;
  try { session = JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); } catch (_) { session = null; }
  const teacherMode = session?.role === "teacher" && document.body.hasAttribute("data-teacher-business");
  const hqMode = session?.role === "hq"
    && !document.body.hasAttribute("data-teacher-business")
    && ["customer", "recharge", "verification", "verification-supplemental"].includes(page);
  if (!session || (teacherMode
    ? !["recharge", "verification", "verification-supplemental"].includes(page)
    : !hqMode && session.role !== "store")) return;
  let storeId = teacherMode || hqMode ? "" : String(session?.store || "");
  const storeNo = Number(storeId.replace(/\D/g, "")) || 1;
  let storeName = teacherMode || hqMode ? "尚未选择门店" : `门店 ${storeNo}`;
  let databaseCustomers = [], databaseTeachers = [], databaseProducts = [], candidateCustomer = null, selectedCustomer = null, faceCaptured = false, photoCaptured = false, rechargeEvidenceCaptured = false, capturedPhotoDataUrl = "", verificationThumbnailDataUrl = "", cameraStream = null, customerPreviewRequest = 0, balanceRequest = 0, verificationBalanceProjects = [], rechargeRequest = null, verificationRequest = null, verificationFaceRequestId = "", verificationFaceEvidenceToken = "", customerEnrollmentRequest = null, previewCustomerCode = "", customerSubmissionBusy = false;
  const customerDetailCache = new Map(), customerDetailRequests = new Map();
  let customerServiceApp = null;
  let teacherBusinessStores = [], teacherBusinessProfile = null, teacherWorkflowStarted = false;
  const allCustomers = () => databaseCustomers;
  const saveList = (key, value) => { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* 当前静态会话不可持久化时不保存演示数据。 */ } };
  const saveGeneratedOrder = (key, record) => {
    let rows = [];
    try { rows = JSON.parse(sessionStorage.getItem(key) || "[]"); } catch (_) { rows = []; }
    const next = Array.isArray(rows) ? rows.filter((row) => String(row?.id || "") !== String(record.id)) : [];
    next.unshift(record);
    saveList(key, next.slice(0, 50));
  };
  function openGeneratedOrder(type, record) {
    // Navigation destroys the form, but explicitly release camera tracks and
    // the captured face image before leaving so biometric data is not retained
    // in this page's JavaScript state any longer than necessary.
    stopFaceCamera();
    capturedPhotoDataUrl = "";
    verificationThumbnailDataUrl = "";
    verificationFaceEvidenceToken = "";
    photoCaptured = false;
    faceCaptured = false;
    const target = teacherMode ? "teacher-work-order-detail.html" : (type === "recharge" ? "recharge-detail.html" : "verification-detail.html");
    const query = teacherMode
      ? new URLSearchParams({ type, recordId: String(record.id) })
      : new URLSearchParams({ recordId: String(record.id), source: "created", ...(hqMode ? { origin: "hq-business", businessPage: page } : {}) });
    window.location.assign(`${target}?${query.toString()}`);
  }
  const addCommunication = (recordType, recordId, message) => {
    if (!message.trim()) return;
    let rows = []; try { rows = JSON.parse(sessionStorage.getItem("prototypeCommunications") || "[]"); } catch (_) { rows = []; }
    const actorRole = teacherMode ? "老师" : hqMode ? "总部" : "门店";
    const actorName = session.staffName || (teacherMode ? "老师" : hqMode ? "总部人员" : "门店人员");
    rows.push({ recordType, recordId, role: actorRole, account: session.account, name: actorName, message: message.trim(), time: new Date().toISOString() }); saveList("prototypeCommunications", rows);
  };
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);

  function stopFaceCamera() {
    if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
    [$("faceCamera"), $("verificationCamera")].filter(Boolean).forEach((video) => { video.srcObject = null; });
  }

  function resizedCanvasDataUrl(sourceCanvas, maximumLongSide, quality) {
    const sourceWidth = sourceCanvas.width;
    const sourceHeight = sourceCanvas.height;
    const scale = Math.min(1, maximumLongSide / Math.max(sourceWidth, sourceHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(sourceWidth * scale));
    canvas.height = Math.max(1, Math.round(sourceHeight * scale));
    canvas.getContext("2d", { alpha: false }).drawImage(sourceCanvas, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", quality);
  }

  function dataUrlBytes(value) {
    const comma = String(value || "").indexOf(",");
    const base64Length = comma >= 0 ? String(value).length - comma - 1 : 0;
    return Math.floor(base64Length * 3 / 4);
  }
  function syncCustomerCreateSubmit() {
    const submit = document.querySelector('#customerCreateForm [type="submit"]');
    const consent = $("faceConsent");
    const nameReady = Boolean($("createCustomerName")?.value.trim());
    const birthdayReady = Boolean($("createCustomerBirthday")?.value);
    const ready = !customerSubmissionBusy && nameReady && birthdayReady && faceCaptured && Boolean(capturedPhotoDataUrl) && Boolean(consent?.checked);
    if (submit) {
      submit.disabled = !ready;
      submit.setAttribute("aria-disabled", String(!ready));
    }
  }
  function resetCapturedPhoto() {
    capturedPhotoDataUrl = ""; faceCaptured = false; customerEnrollmentRequest = null;
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
  function securelyResetCustomerCreateForm(form) {
    stopFaceCamera();
    customerEnrollmentRequest = null;
    const customerForm = form || $("customerCreateForm");
    if (typeof customerForm?.reset === "function") customerForm.reset();
    // Explicitly erase the live values as well as the form defaults so that a
    // browser restore/autofill cycle cannot leave the previous customer's
    // personal data visible after a successful enrollment.
    if ($("createCustomerName")) $("createCustomerName").value = "";
    if ($("createCustomerBirthday")) {
      $("createCustomerBirthday").value = "";
      $("createCustomerBirthday").syncChineseBirthday?.();
    }
    if ($("createCustomerNotes")) $("createCustomerNotes").value = "";
    if ($("faceConsent")) $("faceConsent").checked = false;
    resetCapturedPhoto();
    $("createCustomerName")?.focus({ preventScroll: true });
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
    customerServiceApp ||= window.cloudbase.init(window.CloudBaseAuthConfig);
    let result;
    try {
      const scopedPayload = (teacherMode || hqMode) && !["getTeacherBusinessContext", "getHqBusinessContext"].includes(payload.action)
        ? { ...payload, storeId }
        : payload;
      result = await customerServiceApp.callFunction({ name: "faceRecognition", data: scopedPayload });
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
  async function loadActiveTeachers(selectId, messageId, options = {}) {
    const select = $(selectId);
    if (!select) return;
    const optional = teacherMode ? false : options.optional === true;
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
        ? `<option value="">${optional ? "不指定业务老师" : "请选择老师"}</option>${databaseTeachers.map((teacher) => `<option value="${escapeHtml(teacher.id)}">${escapeHtml(teacher.name)}（${escapeHtml(teacher.code)}）</option>`).join("")}`
        : `<option value="">${optional ? "不指定业务老师" : "数据库中暂无活跃老师"}</option>`;
      select.disabled = !optional && databaseTeachers.length === 0;
      if (teacherMode && databaseTeachers.length === 1) {
        select.value = databaseTeachers[0].id;
        select.disabled = true;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
    } catch (error) {
      databaseTeachers = [];
      select.innerHTML = `<option value="">${optional ? "不指定业务老师" : "老师数据读取失败，禁止提交"}</option>`;
      select.disabled = !optional;
      const message = $(messageId);
      if (message) message.textContent = optional
        ? `老师列表读取失败，仍可不指定老师提交：${error?.message || "请稍后刷新重试"}`
        : (error?.message || "无法从数据库读取活跃老师，请刷新后重试");
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
  function nextVerificationRequestId(payload) {
    const fingerprint = JSON.stringify(payload);
    if (!verificationRequest || verificationRequest.fingerprint !== fingerprint) {
      const key = window.crypto?.randomUUID?.() || `verification_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
      verificationRequest = { key, fingerprint };
    }
    return verificationRequest.key;
  }
  function nextCustomerEnrollmentRequestId(payload) {
    const fingerprint = JSON.stringify(payload);
    if (!customerEnrollmentRequest || customerEnrollmentRequest.fingerprint !== fingerprint) {
      const key = window.crypto?.randomUUID?.() || `customer_${Date.now()}_${Math.random().toString(36).slice(2, 14)}`;
      customerEnrollmentRequest = { key, fingerprint };
    }
    return customerEnrollmentRequest.key;
  }
  function setupWorkflowResize() {
    const layout = document.querySelector(".store-workflow-main");
    const resizeHandle = $("workflowResizeHandle");
    if (!layout || !resizeHandle || resizeHandle.dataset.resizeReady === "true") return;
    resizeHandle.dataset.resizeReady = "true";
    const layoutWideEnough = () => window.matchMedia("(min-width: 981px)").matches;
    const resizeLimits = () => {
      const box = layout.getBoundingClientRect();
      const handleWidth = resizeHandle.getBoundingClientRect().width || 12;
      const available = Math.max(1, box.width - handleWidth);
      const compact = box.width < 1100;
      const minLookup = Math.min(compact ? 270 : 340, available * .46);
      const minAction = Math.min(compact ? 360 : 500, available * .54);
      return { box, available, minLookup, maxLookup: Math.max(minLookup, available - minAction) };
    };
    const setLookupWidth = (positionX) => {
      if (!layoutWideEnough()) return;
      const { box, available, minLookup, maxLookup } = resizeLimits();
      const value = Math.max(minLookup, Math.min(positionX - box.left, maxLookup));
      const percent = value / available * 100;
      layout.style.setProperty("--workflow-lookup-width", `${percent.toFixed(2)}%`);
      resizeHandle.setAttribute("aria-valuemin", String(Math.round(minLookup / available * 100)));
      resizeHandle.setAttribute("aria-valuemax", String(Math.round(maxLookup / available * 100)));
      resizeHandle.setAttribute("aria-valuenow", String(Math.round(percent)));
    };
    const resetLookupWidth = () => {
      layout.style.removeProperty("--workflow-lookup-width");
      resizeHandle.setAttribute("aria-valuenow", "39");
    };
    let dragging = false;
    resizeHandle.addEventListener("pointerdown", (event) => {
      if (!layoutWideEnough()) return;
      dragging = true;
      resizeHandle.classList.add("is-dragging");
      resizeHandle.setPointerCapture?.(event.pointerId);
      setLookupWidth(event.clientX);
      event.preventDefault();
    });
    resizeHandle.addEventListener("pointermove", (event) => { if (dragging) setLookupWidth(event.clientX); });
    const finishResize = () => {
      dragging = false;
      resizeHandle.classList.remove("is-dragging");
    };
    resizeHandle.addEventListener("pointerup", finishResize);
    resizeHandle.addEventListener("pointercancel", finishResize);
    resizeHandle.addEventListener("dblclick", resetLookupWidth);
    resizeHandle.addEventListener("keydown", (event) => {
      if (!layoutWideEnough() || !["ArrowLeft", "ArrowRight", "Home"].includes(event.key)) return;
      if (event.key === "Home") resetLookupWidth();
      else {
        const box = layout.getBoundingClientRect();
        const current = layout.querySelector(".workflow-lookup-panel")?.getBoundingClientRect().width || box.width * .39;
        setLookupWidth(box.left + current + (event.key === "ArrowLeft" ? -24 : 24));
      }
      event.preventDefault();
    });
    window.addEventListener("resize", () => { if (!layoutWideEnough()) resetLookupWidth(); });
  }
  function setupCustomerCreate() {
    const video = $("faceCamera"), preview = $("facePhotoPreview"), placeholder = $("faceCameraPlaceholder"), status = $("faceCaptureStatus"), message = $("customerCreateMessage"), capture = $("captureFace"), openCamera = $("openFaceCamera"), retake = $("retakeFace");
    const layout = document.querySelector(".customer-create-layout");
    const resizeHandle = $("customerCreateResizeHandle");
    if (layout && resizeHandle) {
      const layoutWideEnough = () => window.matchMedia("(min-width: 761px)").matches;
      const setFieldsWidth = (positionX) => {
        if (!layoutWideEnough()) return;
        const box = layout.getBoundingClientRect();
        const minFields = Math.min(360, box.width * 0.46);
        const minCapture = Math.min(440, box.width * 0.54);
        const upper = Math.max(minFields, box.width - minCapture - 10);
        const value = Math.max(minFields, Math.min(positionX - box.left, upper));
        layout.style.setProperty("--customer-fields-width", `${Math.round(value)}px`);
        resizeHandle.setAttribute("aria-valuenow", String(Math.round(value / box.width * 100)));
      };
      let dragging = false;
      resizeHandle.addEventListener("pointerdown", (event) => {
        if (!layoutWideEnough()) return;
        dragging = true; resizeHandle.classList.add("is-dragging");
        resizeHandle.setPointerCapture?.(event.pointerId); setFieldsWidth(event.clientX); event.preventDefault();
      });
      resizeHandle.addEventListener("pointermove", (event) => { if (dragging) setFieldsWidth(event.clientX); });
      const finishResize = () => { dragging = false; resizeHandle.classList.remove("is-dragging"); };
      resizeHandle.addEventListener("pointerup", finishResize); resizeHandle.addEventListener("pointercancel", finishResize);
      resizeHandle.addEventListener("keydown", (event) => {
        if (!layoutWideEnough() || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
        const box = layout.getBoundingClientRect();
        const current = parseFloat(getComputedStyle(layout).getPropertyValue("--customer-fields-width")) || box.width * .42;
        setFieldsWidth(box.left + current + (event.key === "ArrowLeft" ? -24 : 24)); event.preventDefault();
      });
    }
    $("faceConsent").addEventListener("change", syncCustomerCreateSubmit);
    $("createCustomerName").addEventListener("input", syncCustomerCreateSubmit);
    $("createCustomerBirthday").addEventListener("change", syncCustomerCreateSubmit);
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
      const outputHeight = Math.round(Math.min(sourceHeight, 1024));
      canvas.height = outputHeight; canvas.width = Math.round(outputHeight * targetRatio);
      canvas.getContext("2d", { alpha: false }).drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
      capturedPhotoDataUrl = canvas.toDataURL("image/jpeg", 0.85); faceCaptured = false; preview.src = capturedPhotoDataUrl; preview.hidden = false; video.hidden = true; stopFaceCamera(); openCamera.hidden = true; capture.disabled = true; retake.hidden = false;
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
      event.preventDefault();
      // Event.currentTarget is cleared by the browser once this async handler
      // yields, so retain the form reference before awaiting the cloud call.
      const customerForm = event.currentTarget;
      const name = $("createCustomerName").value.trim(), birthday = $("createCustomerBirthday").value, notes = $("createCustomerNotes").value.trim();
      if (!name || !birthday) { message.textContent = "姓名和生日必须填写"; return; }
      if (!faceCaptured || !capturedPhotoDataUrl || !$("faceConsent").checked) { message.textContent = "必须完成拍照、照片质量与活体检测，并取得明确授权后才能建立档案"; return; }
      customerSubmissionBusy = true; syncCustomerCreateSubmit(); message.textContent = "正在上传照片、创建人脸档案并保存客户资料…";
      try {
        const clientRequestId = nextCustomerEnrollmentRequestId({ storeId, name, birthday, notes, photoLength: capturedPhotoDataUrl.length, photoTail: capturedPhotoDataUrl.slice(-48) });
        const data = await callCustomerEnrollment({ action: "registerCustomer", customerName: name, birthDate: birthday, notes, consent: true, imageBase64: capturedPhotoDataUrl, clientRequestId });
        if (!data.customer?.customerCode) throw new Error("客户档案已提交，但云函数没有返回客户编号，请先查询确认，禁止重复提交");
        const createdCustomer = data.customer;
        const customerPageParams = new URLSearchParams({
          customerId: String(createdCustomer.customerCode),
          customerName: String(createdCustomer.customerName || name)
        });
        const createdStoreId = createdCustomer.storeId || storeId;
        if (createdStoreId) customerPageParams.set("storeId", String(createdStoreId));
        securelyResetCustomerCreateForm(customerForm);
        message.textContent = "客户档案已建立；资料和现场照片已安全清空，正在打开客户主页…";
        window.location.assign(`customer-detail.html?${customerPageParams.toString()}`);
      } catch (error) {
        message.textContent = error?.message || "客户建档失败；照片和人脸资料不会保留为半成品，请重试";
      } finally { customerSubmissionBusy = false; syncCustomerCreateSubmit(); }
    });
  }
  function setupLookup() {
    let activeCustomers = [];
    const customerSelect = $("serviceCustomerSelect");
    $("serviceSelectBirthday").type = "text";
    const confirmButton = $("confirmCustomerSelection");
    confirmButton.dataset.initialText = confirmButton.textContent.trim();
    customerSelect.disabled = true;
    customerSelect.innerHTML = `<option value="">正在从数据库读取本门店活跃客户…</option>`;
    const loadActiveCustomers = async () => {
      try {
        const result = await callCustomerEnrollment({ action: "listActiveStoreCustomers", limit:100 });
        storeName = String(result?.storeName || result?.storeCode || storeName);
        activeCustomers = (Array.isArray(result?.customers) ? result.customers : []).map((customer) => ({
          id: String(customer.customerCode || ""),
          name: String(customer.customerName || ""),
          birthday: String(customer.birthDate || "").slice(0, 10)
        })).filter((customer) => customer.id && customer.name && customer.birthday);
        databaseCustomers = activeCustomers;
        customerSelect.innerHTML = activeCustomers.length
          ? `<option value="">${result?.hasMore ? "请选择现有客户（先显示前 100 位，其他客户请用姓名＋生日查询）" : "请选择现有客户"}</option>${activeCustomers.map((customer) => `<option value="${escapeHtml(customer.id)}">${escapeHtml(customer.name)}（${escapeHtml(customer.id)}）</option>`).join("")}`
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
      const id = $("serviceCustomerSelect").value;
      if (!id) { resetCandidate(); return; }
      const customer = activeCustomers.find((item) => item.id === id);
      if (!customer?.birthday) { resetCandidate(); showLookupError("所选客户缺少生日资料，暂时不能办理业务，请先补全档案。"); return; }
      if (previewCustomerCode === id && (candidateCustomer?.id === id || customerDetailRequests.has(id))) return;
      resetCandidate();
      renderCustomerCore(customer);
    };
    $("serviceCustomerSelect").addEventListener("change", () => {
      const customer = activeCustomers.find((item) => item.id === $("serviceCustomerSelect").value);
      $("serviceSelectBirthday").value = formatBirthday(customer?.birthday, "");
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
    $("serviceCustomerLookup").addEventListener("click", async () => {
      resetCandidate(); const name = $("serviceCustomerName").value.trim(), birthday = $("serviceCustomerBirthday").value;
      if (!name || !birthday) { showLookupError("客户姓名和生日都必须填写。"); return; }
      const button = $("serviceCustomerLookup"); button.disabled = true;
      $("serviceCustomerResults").innerHTML = `<div class="lookup-placeholder"><strong>正在查询客户</strong><span>仅在本门店活跃客户中按姓名和生日精确查询。</span></div>`;
      try {
        const result = await callCustomerEnrollment({ action:"listActiveStoreCustomers", customerName:name, birthDate:birthday, limit:100 });
        const matches = (Array.isArray(result?.customers) ? result.customers : []).map((customer) => ({
          id:String(customer.customerCode || ""), name:String(customer.customerName || ""), birthday:String(customer.birthDate || "").slice(0, 10)
        })).filter((customer) => customer.id && customer.name && customer.birthday);
        if (matches.length === 1) renderCustomerCore(matches[0]);
        else if (matches.length > 1) {
          $("serviceCustomerResults").innerHTML = `<div class="duplicate-customer-list"><strong>找到 ${matches.length} 位同名同生日客户，请按编号选择：</strong>${matches.map((customer) => `<button type="button" data-preview-customer="${escapeHtml(customer.id)}">${escapeHtml(customer.name)} · ${escapeHtml(customer.id)}</button>`).join("")}</div>`;
          document.querySelectorAll("[data-preview-customer]").forEach((item) => item.addEventListener("click", () => renderCustomerCore(matches.find((customer) => customer.id === item.dataset.previewCustomer))));
        } else showLookupError("未找到本门店活跃客户；请核对信息，或先恢复已存档客户。");
      } catch (error) { showLookupError(error?.message || "客户查询失败，请重试。"); }
      finally { button.disabled = false; }
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
    previewCustomerCode = "";
    verificationBalanceProjects = [];
    if (["verification", "verification-supplemental"].includes(page)) resetVerificationCapture();
    $("confirmCustomerSelection").disabled = true;
    $("serviceCustomerResults").innerHTML = `<div class="lookup-placeholder"><strong>等待查询客户</strong><span>查询成功后，此处显示客户建档照片、姓名、生日和客户编号。</span></div>`;
    disableBusinessStep();
  }
  function customerPreviewMarkup(customer, hasPhoto = false) {
    const photo = hasPhoto
      ? `<div class="profile-photo-visual has-photo"><img id="selectedCustomerProfilePhoto" alt="${escapeHtml(customer.name)}的客户建档照片" referrerpolicy="no-referrer" decoding="async" fetchpriority="high"></div>`
      : `<div class="profile-photo-visual"><strong>照片加载中…</strong></div>`;
    return `<div class="customer-core-card"><div class="customer-core-heading"><span>客户身份确认</span><strong>${escapeHtml(customer.name)}</strong></div><div class="customer-profile-layout"><figure class="customer-profile-photo">${photo}<figcaption><strong>客户建档照片</strong><span>${hasPhoto ? "私有照片 · 临时授权显示" : "正在读取私有照片"}</span></figcaption></figure><div class="customer-profile-details"><div class="customer-core-facts"><div><span>姓名</span><strong>${escapeHtml(customer.name)}</strong></div><div><span>生日</span><strong>${escapeHtml(formatBirthday(customer.birthday))}</strong></div><div><span>客户编号</span><strong>${escapeHtml(customer.id)}</strong></div></div><p class="profile-photo-note">请核对照片与现场客户。照片无法读取时禁止继续确认客户。</p></div></div></div>`;
  }
  async function loadCustomerDetail(customerCode) {
    const now = Date.now();
    const cached = customerDetailCache.get(customerCode);
    if (cached && cached.expiresAt > now + 10000) return cached.result;
    if (customerDetailRequests.has(customerCode)) return customerDetailRequests.get(customerCode);
    const request = callCustomerEnrollment({ action: "getActiveStoreCustomerDetail", customerCode })
      .then((result) => {
        const ttlSeconds = Math.max(30, Number(result?.expiresIn || 120));
        // Keep only a short page cache. It removes repeated clicks without
        // keeping an ACTIVE/store authorization result around for long.
        const cacheSeconds = Math.min(30, Math.max(10, ttlSeconds - 10));
        customerDetailCache.set(customerCode, { result, expiresAt: Date.now() + cacheSeconds * 1000 });
        return result;
      })
      .finally(() => customerDetailRequests.delete(customerCode));
    customerDetailRequests.set(customerCode, request);
    return request;
  }
  async function renderCustomerCore(customer) {
    const request = ++customerPreviewRequest;
    previewCustomerCode = customer.id;
    candidateCustomer = null;
    $("confirmCustomerSelection").disabled = true;
    $("serviceCustomerResults").innerHTML = customerPreviewMarkup(customer);
    try {
      const result = await loadCustomerDetail(customer.id);
      if (request !== customerPreviewRequest) return;
      const detail = result?.customer && typeof result.customer === "object" ? result.customer : {};
      if (String(detail.customerCode || "") !== customer.id) throw new Error("客户详情与所选客户不一致，请重新查询");
      customer.name = String(detail.customerName || customer.name || "");
      customer.birthday = String(detail.birthDate || customer.birthday || "").slice(0, 10);
      customer.storeId = String(detail.storeId || "");
      customer.customerStatus = String(detail.customerStatus || "");
      customer.customerProcessStatus = String(detail.customerProcessStatus || "");
      customer.totalRechargeCount = Number(detail.totalRechargeCount || 0);
      customer.totalVerificationCount = Number(detail.totalVerificationCount || 0);
      customer.totalExperienceCount = Number(detail.totalExperienceCount || 0);
      customer.hasProfilePhoto = detail.hasProfilePhoto === true;
      customer.createdAt = detail.createdAt || "";
      const photoUrl = String(result?.photoUrl || "");
      if (!/^https:\/\//i.test(photoUrl)) throw new Error("客户照片临时地址无效，请刷新后重试");
      $("serviceCustomerResults").innerHTML = customerPreviewMarkup(customer, true);
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
    $("selectedCustomerText").textContent = `已确认：${selectedCustomer.name}（${selectedCustomer.id}）· ${formatBirthday(selectedCustomer.birthday)} · ${storeName}`; document.querySelector("form.store-business-form").classList.remove("business-step-disabled");
    if (["verification", "verification-supplemental"].includes(page)) { resetVerificationCapture(); await loadVerificationBalances(selectedCustomer); }
    $("confirmCustomerSelection").textContent = `已确认 ${selectedCustomer.name}（${selectedCustomer.id}）`;
  }
  function setupRecharge() {
    setupLookup(); loadActiveProducts("rechargeProject", "rechargeCreateMessage"); loadActiveTeachers("rechargeTeacher", "rechargeCreateMessage", { optional: true });
    $("rechargeCreateForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget, submit = form.querySelector('[type="submit"]');
      const projectId = $("rechargeProject").value, teacherId = $("rechargeTeacher").value, count = Number($("rechargeCount").value), note = $("rechargeNote").value.trim();
      if (!selectedCustomer || !projectId || !Number.isInteger(count) || count < 1 || count > 999) { $("rechargeCreateMessage").textContent = "必须确认客户、选择项目，并填写 1 至 999 的整数充值次数"; return; }
      const project = databaseProducts.find((item) => item.id === projectId), teacher = teacherId ? databaseTeachers.find((item) => item.id === teacherId) : null;
      if (!project || (teacherId && !teacher)) { $("rechargeCreateMessage").textContent = "项目或老师数据已经失效，请刷新页面后重新选择"; return; }
      const payload = { customerCode: selectedCustomer.id, productId: project.id, teacherId: teacher?.id || "", unitCount: count, message: note };
      const clientRequestId = nextRechargeRequestId({ storeId, ...payload });
      submit.disabled = true;
      $("rechargeCreateMessage").textContent = "正在向数据库提交待审核充值单…";
      try {
        const result = await callCustomerEnrollment({ action: "createRechargeApplication", ...payload, clientRequestId });
        if (String(result.recordStatus || "") !== "PENDING") throw new Error("数据库返回的充值单状态不是待审核，已停止后续操作");
        if (!result.rechargeId || !result.rechargeCode) throw new Error("数据库已响应，但没有返回充值单编号，已停止跳转");
        const record = {
          id: String(result.rechargeId),
          recordCode: String(result.rechargeCode),
          recordType: "recharge",
          applicationType: "新充值",
          customerId: String(result.customer?.customerCode || selectedCustomer.id),
          customerName: String(result.customer?.customerName || selectedCustomer.name),
          customerBirthday: String(selectedCustomer.birthday || ""),
          storeId,
          storeName,
          projectId: String(result.product?.productId || project.id),
          projectCode: String(result.product?.productCode || project.code || ""),
          projectName: String(result.product?.productName || project.name),
          teacherId: String(result.teacher?.teacherId || teacher?.id || ""),
          teacherCode: String(result.teacher?.teacherCode || teacher?.code || ""),
          teacherName: String(result.teacher?.teacherName || teacher?.name || ""),
          count: Number(result.unitCount || count),
          status: String(result.recordStatus),
          note,
          account: String(session?.account || ""),
          createdAt: result.submittedAt || new Date().toISOString(),
          databaseBacked: true
        };
        saveGeneratedOrder("prototypeRechargeRecords", record);
        addCommunication("recharge", record.id, note);
        openGeneratedOrder("recharge", record);
      } catch (error) {
        $("rechargeCreateMessage").textContent = error?.message || "充值申请提交失败，请核对数据库与云函数";
      } finally {
        submit.disabled = false;
      }
    });
  }
  function syncVerificationSubmit() {
    const submit = $("verificationSubmit");
    const projectReady = Boolean($("verificationProject")?.value);
    const teacherReady = Boolean($("verificationTeacher")?.value);
    const noteReady = page !== "verification-supplemental" || Boolean($("verificationNote")?.value.trim());
    const ready = Boolean(selectedCustomer) && photoCaptured && projectReady && teacherReady && noteReady;
    if (submit) {
      submit.disabled = !ready;
      submit.setAttribute("aria-disabled", String(!ready));
    }
  }
  function resetVerificationCapture() {
    stopFaceCamera(); capturedPhotoDataUrl = ""; verificationThumbnailDataUrl = ""; photoCaptured = false; verificationFaceRequestId = ""; verificationFaceEvidenceToken = "";
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
    $("verificationProject").addEventListener("change", syncVerificationSubmit);
    $("verificationTeacher").addEventListener("change", syncVerificationSubmit);
    $("verificationNote").addEventListener("input", syncVerificationSubmit);
    resetVerificationCapture();
    open.addEventListener("click", async () => {
      try {
        if (!selectedCustomer) throw new Error("请先查询并确认需要核销的客户");
        resetVerificationCapture(); open.hidden = true;
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前浏览器不支持摄像头访问，请使用最新版 Chrome 或 Edge");
        cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 1440 }, height: { ideal: 1920 } }, audio: false });
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
      const sourceX = Math.round((video.videoWidth - sourceWidth) / 2), sourceY = Math.round((video.videoHeight - sourceHeight) / 2), outputHeight = Math.round(Math.min(sourceHeight, 1920));
      canvas.height = outputHeight; canvas.width = Math.round(outputHeight * targetRatio);
      canvas.getContext("2d", { alpha: false }).drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
      let evidenceWidth = canvas.width, evidenceHeight = canvas.height;
      capturedPhotoDataUrl = canvas.toDataURL("image/jpeg", 0.92);
      if (dataUrlBytes(capturedPhotoDataUrl) > 3 * 1024 * 1024) {
        capturedPhotoDataUrl = resizedCanvasDataUrl(canvas, 1600, 0.9);
        const scale = Math.min(1, 1600 / Math.max(canvas.width, canvas.height));
        evidenceWidth = Math.max(1, Math.round(canvas.width * scale));
        evidenceHeight = Math.max(1, Math.round(canvas.height * scale));
      }
      if (dataUrlBytes(capturedPhotoDataUrl) > 3 * 1024 * 1024) {
        capturedPhotoDataUrl = resizedCanvasDataUrl(canvas, 1400, 0.86);
        const scale = Math.min(1, 1400 / Math.max(canvas.width, canvas.height));
        evidenceWidth = Math.max(1, Math.round(canvas.width * scale));
        evidenceHeight = Math.max(1, Math.round(canvas.height * scale));
      }
      verificationThumbnailDataUrl = resizedCanvasDataUrl(canvas, 480, 0.82);
      preview.src = capturedPhotoDataUrl; preview.hidden = false; video.hidden = true; stopFaceCamera(); open.hidden = true; capture.disabled = true; retake.hidden = false;
      photoCaptured = false; syncVerificationSubmit(); status.className = "capture-status pending"; status.textContent = "正在与所选客户进行 1:1 人脸验证…"; message.textContent = "";
      try {
        const result = await callCustomerEnrollment({
          action: "verifyCustomerFace",
          customerCode: selectedCustomer.id,
          imageBase64: capturedPhotoDataUrl,
          thumbnailBase64: verificationThumbnailDataUrl,
          imageWidth: evidenceWidth,
          imageHeight: evidenceHeight
        });
        if (!result.matched) throw new Error(`${result.message || "1:1 人脸验证未通过"}（相似度 ${result.score ?? 0}，要求 ${result.threshold ?? "-"}）`);
        photoCaptured = true;
        verificationFaceRequestId = String(result.requestId || "");
        if (!verificationFaceRequestId) throw new Error("人脸验证服务未返回验证请求编号，请重新拍照验证");
        verificationFaceEvidenceToken = String(result.faceEvidenceToken || "");
        if (!/^[0-9a-f]{48}$/.test(verificationFaceEvidenceToken)) throw new Error("现场人脸照片没有安全保存，请重新拍照验证");
        const livenessText = result?.liveness?.checked ? "、活体检测" : "";
        status.className = "capture-status complete"; status.textContent = `所选客户 1:1 人脸验证${livenessText}通过（${result.score} 分）`;
      } catch (error) {
        photoCaptured = false; status.className = "capture-status pending"; status.textContent = "1:1 人脸验证未通过，请重新拍照"; message.textContent = error?.message || "现场人脸与所选客户不一致";
      }
      syncVerificationSubmit();
    });
    retake.addEventListener("click", () => { resetVerificationCapture(); open.click(); });
    window.addEventListener("pagehide", stopFaceCamera, { once: true });
    $("verificationCreateForm").addEventListener("submit", async (event) => {
      event.preventDefault(); const form = event.currentTarget, submit = form.querySelector('[type="submit"]'), projectId = $("verificationProject").value, teacherId = $("verificationTeacher").value, note = $("verificationNote").value.trim(), supplemental = supplementalPage;
      if (!selectedCustomer || !projectId || !teacherId) { $("verificationCreateMessage").textContent = "必须确认客户并选择项目和老师"; return; }
      if (!photoCaptured) { $("verificationCreateMessage").textContent = "必须完成现场拍照并通过所选客户的 1:1 人脸验证，才能核销和发送设备信号"; return; }
      if (supplemental && !note) { $("verificationCreateMessage").textContent = "补录必须填写门店备注／原因"; return; }
      const project = verificationBalanceProjects.find((item) => item.id === projectId);
      if (!project) { $("verificationCreateMessage").textContent = "所选项目余额已失效，请重新确认客户后再试"; return; }
      const teacher = databaseTeachers.find((item) => item.id === teacherId);
      if (!teacher) { $("verificationCreateMessage").textContent = "老师数据已经失效，请刷新页面后重新选择"; return; }
      const payload = { customerCode: selectedCustomer.id, productId: project.id, teacherId: teacher.id, verificationType: supplemental ? "SUPPLEMENT" : "NORMAL", message: note, faceRequestId: verificationFaceRequestId, faceEvidenceToken: verificationFaceEvidenceToken };
      const clientRequestId = nextVerificationRequestId({ storeId, ...payload });
      submit.disabled = true;
      $("verificationCreateMessage").textContent = supplemental ? "正在向数据库提交待审核补录单…" : "正在向数据库提交核销单…";
      try {
        const result = await callCustomerEnrollment({ action: "createVerificationApplication", ...payload, clientRequestId });
        const expectedStatus = supplemental ? "PENDING" : "APPROVED";
        if (String(result.recordStatus || "") !== expectedStatus) throw new Error("数据库返回的核销单状态与当前业务类型不一致，已停止跳转");
        if (!result.verificationId || !result.verificationCode) throw new Error("数据库已响应，但没有返回核销单编号，已停止跳转");
        const record = {
          id: String(result.verificationId), recordCode: String(result.verificationCode), recordType: "verification",
          customerId: String(result.customer?.customerCode || selectedCustomer.id), customerName: String(result.customer?.customerName || selectedCustomer.name),
          name: selectedCustomer.name, birthday: selectedCustomer.birthday, storeId, storeName,
          projectId: String(result.product?.productId || project.id), projectCode: String(result.product?.productCode || project.code || ""), projectName: String(result.product?.productName || project.name),
          teacherId: String(result.teacher?.teacherId || teacher.id), teacherCode: String(result.teacher?.teacherCode || teacher.code || ""), teacherName: String(result.teacher?.teacherName || teacher.name),
          count: Number(result.unitCount || 1), faceVerification: "活体检测与人脸比对通过",
          verificationType: supplemental ? "补录核销" : "正常核销", status: String(result.recordStatus),
          deviceSignal: supplemental ? "不发送（补录）" : "设备信号待接入", account: session.account, note,
          createdAt: result.submittedAt || new Date().toISOString(), databaseBacked: true
        };
        saveGeneratedOrder("prototypeVerificationRecords", record);
        addCommunication("verification", record.id, note);
        openGeneratedOrder("verification", record);
      } catch (error) {
        $("verificationCreateMessage").textContent = error?.message || "核销申请提交失败，请核对数据库与云函数";
        if (["FACE_PHOTO_EVIDENCE_REQUIRED", "FACE_PHOTO_EVIDENCE_INVALID"].includes(error?.code)) resetVerificationCapture();
      } finally {
        submit.disabled = false;
        syncVerificationSubmit();
      }
    });
  }

  function startTeacherWorkflow() {
    if (teacherWorkflowStarted || !storeId) return;
    teacherWorkflowStarted = true;
    $("teacherBusinessStore").disabled = true;
    $("confirmTeacherBusinessStore").disabled = false;
    $("confirmTeacherBusinessStore").textContent = "重新选择门店";
    $("teacherBusinessStoreState").textContent = "已选择";
    $("teacherBusinessStoreMessage").textContent = `当前办理门店：${storeName}。如选择有误，可返回重新选择。`;
    $("teacherCustomerWorkflow")?.classList.remove("teacher-step-disabled");
    if (page === "recharge") setupRecharge();
    else setupVerification();
  }

  async function setupTeacherBusiness() {
    const select = $("teacherBusinessStore");
    const confirm = $("confirmTeacherBusinessStore");
    select.disabled = true;
    confirm.disabled = true;
    select.innerHTML = `<option value="">正在读取可用门店…</option>`;
    try {
      const result = await callCustomerEnrollment({ action:"getTeacherBusinessContext" });
      teacherBusinessProfile = result?.teacher || null;
      teacherBusinessStores = (Array.isArray(result?.stores) ? result.stores : []).map((store) => ({
        id:String(store.storeId || ""), code:String(store.storeCode || ""), name:String(store.storeName || "")
      })).filter((store) => store.id && store.name);
      $("teacherBusinessIdentity").textContent = teacherBusinessProfile
        ? `${teacherBusinessProfile.teacherName || "当前老师"} · ${teacherBusinessProfile.teacherCode || teacherBusinessProfile.teacherId}`
        : "当前老师";
      select.innerHTML = `<option value="">请选择本次办理门店</option>${teacherBusinessStores.map((store) => `<option value="${escapeHtml(store.id)}">${escapeHtml(store.name)} · ${escapeHtml(store.code || store.id)}</option>`).join("")}`;
      select.disabled = teacherBusinessStores.length === 0;
      confirm.disabled = true;
      if (!teacherBusinessStores.length) $("teacherBusinessStoreMessage").textContent = "数据库中没有可用的活跃门店，暂时不能办理业务。";
    } catch (error) {
      select.innerHTML = `<option value="">门店读取失败</option>`;
      $("teacherBusinessStoreMessage").textContent = error?.message || "无法读取老师与门店资料，请刷新重试。";
    }
    select.addEventListener("change", () => {
      confirm.disabled = !teacherBusinessStores.some((store) => store.id === select.value);
      $("teacherBusinessStoreMessage").textContent = "";
    });
    confirm.addEventListener("click", () => {
      if (teacherWorkflowStarted) {
        stopFaceCamera();
        window.location.reload();
        return;
      }
      const selected = teacherBusinessStores.find((store) => store.id === select.value);
      if (!selected) { $("teacherBusinessStoreMessage").textContent = "请先选择门店。"; return; }
      storeId = selected.id;
      storeName = [selected.name, selected.code].filter(Boolean).join(" · ");
      startTeacherWorkflow();
    });
  }

  function installHqBusinessStorePanel() {
    const workflow = document.querySelector("main.store-business-main");
    if (!workflow) return null;
    document.body.setAttribute("data-hq-business", "");
    workflow.classList.add("business-store-unconfirmed");
    workflow.setAttribute("inert", "");
    const lockedControls = Array.from(workflow.querySelectorAll("button, input, select, textarea, a[href]")).map((control) => ({
      control,
      disabled: "disabled" in control ? control.disabled : null,
      tabindex: control.getAttribute("tabindex"),
      ariaDisabled: control.getAttribute("aria-disabled")
    }));
    lockedControls.forEach(({ control, disabled }) => {
      if (disabled !== null) control.disabled = true;
      control.setAttribute("tabindex", "-1");
      control.setAttribute("aria-disabled", "true");
    });
    const panel = document.createElement("section");
    panel.className = "panel hq-business-store-panel";
    panel.innerHTML = `<div class="panel-heading"><div><h2>选择本次办理门店</h2><p>总部每次只能为一个具体门店办理业务，不能选择全部门店</p></div><span id="hqBusinessStoreState" class="badge">尚未选择</span></div><div class="hq-business-store-row"><label>当前总部账号<strong id="hqBusinessIdentity"></strong></label><label>办理门店<select id="hqBusinessStore"><option value="">正在读取活跃门店…</option></select></label><button id="confirmHqBusinessStore" type="button" disabled>确认门店</button></div><p id="hqBusinessStoreMessage" class="form-message" role="status"></p>`;
    workflow.before(panel);
    return {
      workflow,
      panel,
      unlock() {
        workflow.removeAttribute("inert");
        lockedControls.forEach(({ control, disabled, tabindex, ariaDisabled }) => {
          if (disabled !== null) control.disabled = disabled;
          if (tabindex === null) control.removeAttribute("tabindex"); else control.setAttribute("tabindex", tabindex);
          if (ariaDisabled === null) control.removeAttribute("aria-disabled"); else control.setAttribute("aria-disabled", ariaDisabled);
        });
      }
    };
  }

  async function setupHqBusiness() {
    const installed = installHqBusinessStorePanel();
    if (!installed) return;
    const { workflow, unlock } = installed;
    const select = $("hqBusinessStore");
    const confirm = $("confirmHqBusinessStore");
    const message = $("hqBusinessStoreMessage");
    $("hqBusinessIdentity").textContent = [session.staffName, session.account].filter(Boolean).join(" · ") || "当前总部账号";
    let stores = [];
    try {
      const result = await callCustomerEnrollment({ action: "getHqBusinessContext" });
      stores = (Array.isArray(result?.stores) ? result.stores : []).map((store) => ({
        id: String(store.storeId || ""),
        code: String(store.storeCode || ""),
        name: String(store.storeName || "")
      })).filter((store) => store.id && store.name);
      select.innerHTML = `<option value="">请选择本次办理门店</option>${stores.map((store) => `<option value="${escapeHtml(store.id)}">${escapeHtml(store.name)} · ${escapeHtml(store.code || store.id)}</option>`).join("")}`;
      select.disabled = stores.length === 0;
      if (!stores.length) message.textContent = "数据库中没有可办理业务的活跃门店。";
    } catch (error) {
      select.innerHTML = `<option value="">门店读取失败</option>`;
      select.disabled = true;
      message.textContent = error?.message || "无法读取总部可办理门店，请刷新后重试。";
    }
    select.addEventListener("change", () => {
      confirm.disabled = !stores.some((store) => store.id === select.value);
      message.textContent = "";
    });
    confirm.addEventListener("click", () => {
      if (!workflow.hasAttribute("inert")) {
        stopFaceCamera();
        window.location.reload();
        return;
      }
      const selected = stores.find((store) => store.id === select.value);
      if (!selected) { message.textContent = "必须先选择一个具体门店。"; return; }
      storeId = selected.id;
      storeName = [selected.name, selected.code].filter(Boolean).join(" · ");
      select.disabled = true;
      unlock();
      workflow.classList.remove("business-store-unconfirmed");
      $("hqBusinessStoreState").textContent = "已选择";
      confirm.textContent = "重新选择门店";
      message.textContent = `当前办理门店：${storeName}。如选择有误，请重新选择并清空本页资料。`;
      const scopeBadge = workflow.querySelector(".workflow-lookup-panel .badge");
      if (scopeBadge) scopeBadge.textContent = storeName;
      if (page === "customer") setupCustomerCreate();
      else if (page === "recharge") setupRecharge();
      else setupVerification();
    });
  }

  document.documentElement.dataset.prototypeVersion = VERSION;
  window.addEventListener("pageshow", (event) => {
    // A back-forward-cache restore retains every in-memory form, camera and
    // evidence value. HQ must reconfirm a concrete store on a clean workflow.
    if (hqMode && event.persisted) window.location.reload();
  });
  setupWorkflowResize();
  if (teacherMode) setupTeacherBusiness();
  else if (hqMode) setupHqBusiness();
  else if (page === "customer") setupCustomerCreate();
  else if (page === "recharge") setupRecharge();
  else if (["verification", "verification-supplemental"].includes(page)) setupVerification();
})();
