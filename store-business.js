(() => {
  "use strict";
  const VERSION = "0.14.62", page = document.body.dataset.storeBusiness, $ = (id) => document.getElementById(id);
  const formatBirthday = (value, fallback = "—") => {
    const raw = String(value ?? "").trim();
    if (!raw) return fallback;
    const match = raw.match(/^(\d{4})[-年](\d{1,2})[-月](\d{1,2})(?:日|[T\s].*)?$/);
    return match ? `${match[1]}年${match[2].padStart(2, "0")}月${match[3].padStart(2, "0")}日` : raw;
  };
  let session = null;
  try { session = JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); } catch (_) { session = null; }
  const businessPages = ["customer", "recharge", "refund", "product-purchase", "verification", "verification-experience"];
  const teacherMode = session?.role === "teacher" && businessPages.includes(page);
  const legacyTeacherMode = teacherMode && document.body.hasAttribute("data-teacher-business");
  const sharedTeacherMode = teacherMode && !legacyTeacherMode;
  const hqMode = session?.role === "hq"
    && !document.body.hasAttribute("data-teacher-business")
    && businessPages.includes(page);
  // EXPERIENCE is a teacher-only gift. Store and HQ shells are redirected by
  // auth-ui; stop this script before they can load customer or quota data.
  if (page === "verification-experience" && session?.role !== "teacher") return;
  if (!session || (teacherMode
    ? !businessPages.includes(page)
    : !hqMode && session.role !== "store")) return;
  const accountStoreId = session?.role === "store" ? String(session?.store || "") : "";
  let storeId = teacherMode || hqMode ? "" : accountStoreId;
  const storeNo = Number(storeId.replace(/\D/g, "")) || 1;
  let storeName = teacherMode || hqMode ? "尚未选择门店" : `门店 ${storeNo}`;
  let databaseCustomers = [], databaseTeachers = [], databaseProducts = [], retailGiftProducts = [], rechargeProductGifts = [], candidateCustomer = null, selectedCustomer = null, faceCaptured = false, photoCaptured = false, rechargeEvidenceCaptured = false, capturedPhotoDataUrl = "", verificationThumbnailDataUrl = "", cameraStream = null, customerPreviewRequest = 0, balanceRequest = 0, customerLookupScopeRequest = 0, verificationBalanceProjects = [], verificationFaceRequestId = "", verificationFaceEvidenceToken = "", customerEnrollmentRequest = null, previewCustomerCode = "", customerSubmissionBusy = false, submissionRecoveryLocked = false, submissionRecoveryRunning = false;
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
    const submissionRecordType = type === "recharge" ? "RECHARGE" : "VERIFICATION";
    const submissionIntent = readBusinessSubmission(submissionRecordType);
    const submissionAck = submissionIntent && !submissionIntent.invalid ? {
      submissionIntentKey: businessSubmissionStorageKey(submissionRecordType),
      clientRequestId: submissionIntent.clientRequestId
    } : {};
    const query = teacherMode
      ? new URLSearchParams({ type, recordId: String(record.id), ...submissionAck })
      : new URLSearchParams({ recordId: String(record.id), source: "created", ...submissionAck, ...(hqMode ? { origin: "hq-business", businessPage: page } : {}) });
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

  function normalizedTeacherProfile(value = {}) {
    return {
      id: String(value.teacherId || value.teacher_id || value.id || ""),
      code: String(value.teacherCode || value.teacher_code || value.code || ""),
      name: String(value.teacherName || value.teacher_name || value.name || "")
    };
  }

  function teacherBindingError() {
    const bound = normalizedTeacherProfile(teacherBusinessProfile || {});
    if (!teacherMode) return "";
    if (!bound.id) return "当前登录账号没有可用的老师档案，请联系总部检查账号绑定。";
    return "";
  }

  function renderBoundTeacher(select, teacher) {
    const label = select?.closest("label");
    if (!label) return;
    label.classList.add("role-bound-field");
    const labelText = Array.from(label.childNodes).find((node) => node.nodeType === Node.TEXT_NODE && String(node.nodeValue || "").trim());
    if (labelText) labelText.nodeValue = "当前老师（自动绑定）";
    let value = label.querySelector("[data-bound-teacher]");
    if (!value) {
      value = document.createElement("span");
      value.dataset.boundTeacher = "";
      value.className = "role-bound-value";
      select.before(value);
    }
    value.textContent = `${teacher.name || "当前老师"}${teacher.code ? `（${teacher.code}）` : ""}· 已自动绑定`;
    value.setAttribute("role", "status");
    select.hidden = true;
    select.setAttribute("aria-hidden", "true");
  }

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
    if (session.role === "store") {
      if (!accountStoreId) throw new Error("当前门店账号未绑定门店，不能办理业务。");
      // Store scope comes only from the authenticated session. No page field
      // can replace it with another store before an application is submitted.
      storeId = accountStoreId;
    }
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
      const wrapped = new Error(`${error?.message || "腾讯云函数调用失败"}${diagnostic ? `（${diagnostic}）` : ""}`);
      wrapped.code = error?.code || "FUNCTION_INVOCATION_FAILED";
      wrapped.requestId = error?.requestId || error?.RequestId || "";
      wrapped.submissionUncertain = true;
      throw wrapped;
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

  function normalizedActiveCustomer(value = {}) {
    return {
      id: String(value.customerCode || ""),
      name: String(value.customerName || ""),
      birthday: String(value.birthDate || "").slice(0, 10)
    };
  }

  function activeCustomerCursorKey(value) {
    if (typeof value === "string") return value.trim() ? `string:${value.trim()}` : "";
    if (!value || typeof value !== "object") return "";
    const customerName = String(value.customerName || "");
    const birthDate = String(value.birthDate || "").slice(0, 10);
    const customerCode = String(value.customerCode || "");
    return customerName && birthDate && customerCode
      ? `customer:${JSON.stringify([customerName, birthDate, customerCode])}`
      : "";
  }

  async function fetchAllActiveStoreCustomers({ customerName = "", birthDate = "", expectedStoreId = "", isCurrent = () => true, onProgress = () => {} } = {}) {
    const customers = [];
    const seenCustomerCodes = new Set();
    const seenCursors = new Set();
    let cursor = null;
    let storeMetadata = null;
    while (true) {
      if (!isCurrent()) return null;
      const result = await callCustomerEnrollment({
        action: "listActiveStoreCustomers",
        limit: 100,
        ...(customerName ? { customerName } : {}),
        ...(birthDate ? { birthDate } : {}),
        ...(cursor ? { cursor } : {})
      });
      if (!isCurrent()) return null;
      const responseStoreId = String(result?.storeId || "");
      if (expectedStoreId && responseStoreId !== expectedStoreId) {
        throw new Error("客户列表返回了其他门店的数据，请重新选择门店后再试。");
      }
      storeMetadata ||= {
        storeId: responseStoreId,
        storeCode: String(result?.storeCode || ""),
        storeName: String(result?.storeName || "")
      };
      // The server cursor is ordered by name, birthday and customer code.
      // Preserve that page order and keep the first occurrence if rows move
      // between pages while a new customer is being created concurrently.
      (Array.isArray(result?.customers) ? result.customers : [])
        .map(normalizedActiveCustomer)
        .filter((customer) => customer.id && customer.name && customer.birthday)
        .forEach((customer) => {
          if (seenCustomerCodes.has(customer.id)) return;
          seenCustomerCodes.add(customer.id);
          customers.push(customer);
        });
      onProgress(customers.length);
      if (result?.hasMore !== true) return { customers, ...(storeMetadata || {}) };
      const nextCursor = result?.nextCursor;
      const cursorKey = activeCustomerCursorKey(nextCursor);
      if (!cursorKey || seenCursors.has(cursorKey)) {
        throw new Error("客户列表分页游标无效，无法确认已读取全部客户，请刷新后重试。");
      }
      seenCursors.add(cursorKey);
      cursor = nextCursor;
    }
  }
  async function loadActiveTeachers(selectId, messageId, options = {}) {
    const select = $(selectId);
    if (!select) return;
    if (teacherMode) {
      const teacher = normalizedTeacherProfile(teacherBusinessProfile || {});
      databaseTeachers = teacher.id ? [teacher] : [];
      select.innerHTML = teacher.id
        ? `<option value="${escapeHtml(teacher.id)}">${escapeHtml(teacher.name || "当前老师")}</option>`
        : `<option value="">当前账号未绑定老师档案</option>`;
      select.value = teacher.id;
      select.disabled = true;
      if (teacher.id) renderBoundTeacher(select, teacher);
      const message = $(messageId);
      if (!teacher.id && message) message.textContent = teacherBindingError();
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    const optional = teacherMode ? false : options.optional === true;
    select.disabled = true;
    select.innerHTML = `<option value="">正在从数据库读取活跃老师…</option>`;
    try {
      const result = await callCustomerEnrollment({ action: "listActiveTeachers" });
      databaseTeachers = (Array.isArray(result?.teachers) ? result.teachers : [])
        .map(normalizedTeacherProfile)
        .filter((teacher) => teacher.id && teacher.name);
      select.innerHTML = databaseTeachers.length
        ? `<option value="">${optional ? "不指定业务老师" : "请选择老师"}</option>${databaseTeachers.map((teacher) => `<option value="${escapeHtml(teacher.id)}">${escapeHtml(teacher.name)}（${escapeHtml(teacher.code)}）</option>`).join("")}`
        : `<option value="">${optional ? "不指定业务老师" : "数据库中暂无活跃老师"}</option>`;
      select.disabled = !optional && databaseTeachers.length === 0;
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
        ? `<option value="">请选择项目</option>${databaseProducts.map((product) => `<option value="${escapeHtml(product.id)}">${escapeHtml(product.name)}</option>`).join("")}`
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

  function renderRechargeProductGifts() {
    const list = $("rechargeGiftList");
    if (!list) return;
    list.innerHTML = rechargeProductGifts.length
      ? rechargeProductGifts.map((item, index) => `<article class="recharge-gift-row"><div><strong>${escapeHtml(item.productName)}</strong><span>${escapeHtml(item.productCode)} · ${item.unitCount} 件</span></div><button type="button" data-remove-recharge-gift="${index}">删除</button></article>`).join("")
      : `<p class="recharge-gift-empty">暂未添加产品赠予</p>`;
  }

  function resetRechargeProductGifts() {
    rechargeProductGifts = [];
    if ($("rechargeGiftProduct")) $("rechargeGiftProduct").value = "";
    if ($("rechargeGiftQuantity")) $("rechargeGiftQuantity").value = "";
    if ($("rechargeGiftMessage")) $("rechargeGiftMessage").textContent = "";
    renderRechargeProductGifts();
  }

  async function loadActiveRetailGiftProducts() {
    const select = $("rechargeGiftProduct");
    if (!select) return;
    select.disabled = true;
    select.innerHTML = `<option value="">正在读取激活产品…</option>`;
    try {
      const result = await callCustomerEnrollment({ action: "listActiveRetailProducts" });
      retailGiftProducts = (Array.isArray(result?.products) ? result.products : []).map((item) => ({
        id: String(item.productId || ""), code: String(item.productCode || ""), name: String(item.productName || "")
      })).filter((item) => item.id && item.name);
      select.innerHTML = retailGiftProducts.length
        ? `<option value="">请选择激活产品</option>${retailGiftProducts.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${escapeHtml(item.code)}</option>`).join("")}`
        : `<option value="">当前没有可赠予的激活产品</option>`;
      select.disabled = retailGiftProducts.length === 0;
    } catch (error) {
      retailGiftProducts = [];
      select.innerHTML = `<option value="">激活产品读取失败</option>`;
      select.disabled = true;
      if ($("rechargeGiftMessage")) $("rechargeGiftMessage").textContent = `${error?.message || "赠予产品读取失败"}；仍可不添加赠品提交充值。`;
    }
  }

  function setupRechargeProductGifts() {
    if (!$("rechargeGiftProduct")) return;
    renderRechargeProductGifts();
    void loadActiveRetailGiftProducts();
    $("addRechargeGift").addEventListener("click", () => {
      const productId = $("rechargeGiftProduct").value;
      const unitCount = Number($("rechargeGiftQuantity").value);
      const product = retailGiftProducts.find((item) => item.id === productId);
      const message = $("rechargeGiftMessage");
      if (!selectedCustomer) { message.textContent = "必须先确认当前客户。"; return; }
      if (!product) { message.textContent = "请先选择一个当前激活的赠予产品。"; return; }
      if (!Number.isInteger(unitCount) || unitCount < 1 || unitCount > 999) { message.textContent = "赠予数量必须是 1 至 999 的整数。"; return; }
      if (rechargeProductGifts.some((item) => item.retailProductId === product.id)) { message.textContent = "该产品已经加入；如需修改，请先删除后重新加入。"; return; }
      if (rechargeProductGifts.length >= 20) { message.textContent = "一张充值单最多加入 20 种赠予产品。"; return; }
      rechargeProductGifts.push({ retailProductId: product.id, productCode: product.code, productName: product.name, unitCount });
      $("rechargeGiftProduct").value = "";
      $("rechargeGiftQuantity").value = "";
      message.textContent = `已加入 ${product.name} × ${unitCount}`;
      renderRechargeProductGifts();
    });
    $("rechargeGiftList").addEventListener("click", (event) => {
      const button = event.target.closest("[data-remove-recharge-gift]");
      if (!button) return;
      const index = Number(button.dataset.removeRechargeGift);
      if (!Number.isInteger(index) || index < 0 || index >= rechargeProductGifts.length) return;
      const [removed] = rechargeProductGifts.splice(index, 1);
      $("rechargeGiftMessage").textContent = `已删除 ${removed.productName}`;
      renderRechargeProductGifts();
    });
  }

  function businessSubmissionStorageKey(recordType) {
    const identity = businessSubmissionFingerprint([session?.role || "", session?.account || "", page || "", recordType]);
    return `lusizhuoer:business-submission:v1:${identity}`;
  }
  function businessRecordTypeForPage() {
    if (["recharge", "refund"].includes(page)) return "RECHARGE";
    if (page === "product-purchase") return "PRODUCT_PURCHASE";
    if (["verification", "verification-experience"].includes(page)) return "VERIFICATION";
    return "";
  }
  function businessSubmissionFingerprint(value) {
    const source = JSON.stringify(value);
    let left = 2166136261;
    let right = 2246822507;
    for (let index = 0; index < source.length; index += 1) {
      const code = source.charCodeAt(index);
      left = Math.imul(left ^ code, 16777619);
      right = Math.imul(right ^ code, 3266489909);
    }
    return `fp_${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0).toString(16).padStart(8, "0")}`;
  }
  function readBusinessSubmission(recordType) {
    let raw;
    try { raw = localStorage.getItem(businessSubmissionStorageKey(recordType)); }
    catch (_) { return { invalid: true, recordType, reason: "当前浏览器无法读取防重复提交记录。" }; }
    if (raw === null) return null;
    try {
      const value = JSON.parse(raw);
      if (!value || value.version !== 1 || value.recordType !== recordType
          || value.role !== String(session?.role || "") || value.account !== String(session?.account || "")
          || value.page !== page || !/^fp_[0-9a-f]{16}$/.test(String(value.fingerprint || ""))
          || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(String(value.clientRequestId || ""))) {
        return { invalid: true, recordType, reason: "浏览器中的防重复提交记录已损坏。" };
      }
      return value;
    } catch (_) { return { invalid: true, recordType, reason: "浏览器中的防重复提交记录无法解析。" }; }
  }
  function writeBusinessSubmission(intent) {
    try {
      const key = businessSubmissionStorageKey(intent.recordType);
      localStorage.setItem(key, JSON.stringify(intent));
      const saved = JSON.parse(localStorage.getItem(key) || "null");
      if (!saved || saved.clientRequestId !== intent.clientRequestId || saved.fingerprint !== intent.fingerprint) throw new Error("readback mismatch");
    } catch (_) {
      const error = new Error("当前浏览器无法可靠保存防重复提交编号，已禁止提交；请检查隐私模式或存储权限后重试。");
      error.code = "SUBMISSION_STORAGE_UNAVAILABLE";
      throw error;
    }
  }
  function clearBusinessSubmission(recordType) {
    try {
      const key = businessSubmissionStorageKey(recordType);
      localStorage.removeItem(key);
      return localStorage.getItem(key) === null;
    } catch (_) { return false; }
  }
  function beginBusinessSubmission(recordType, identityPayload) {
    const fingerprint = businessSubmissionFingerprint(identityPayload);
    const existing = readBusinessSubmission(recordType);
    if (existing) {
      submissionRecoveryLocked = true;
      const error = new Error(existing.invalid
        ? `${existing.reason} 为防止重复业务，已禁止继续提交；请先由管理员核对数据库。`
        : existing.fingerprint === fingerprint
        ? "上一次提交结果尚未确认，必须先恢复原结果，不能再次提交。"
        : "存在另一笔结果尚未确认的业务，必须先恢复原结果，不能更换资料重新提交。");
      error.code = "SUBMISSION_RECOVERY_REQUIRED";
      throw error;
    }
    const prefix = recordType === "RECHARGE" ? "recharge" : "verification";
    const clientRequestId = window.crypto?.randomUUID?.() || `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
    const intent = {
      version: 1,
      recordType,
      page,
      role: String(session?.role || ""),
      account: String(session?.account || ""),
      storeId: String(storeId || ""),
      clientRequestId,
      fingerprint,
      state: "SUBMITTING",
      createdAt: new Date().toISOString()
    };
    writeBusinessSubmission(intent);
    return intent;
  }
  function markBusinessSubmissionUncertain(recordType) {
    const intent = readBusinessSubmission(recordType);
    if (!intent || intent.invalid) return;
    try { writeBusinessSubmission({ ...intent, state: "UNKNOWN", lastCheckedAt: new Date().toISOString() }); }
    catch (_) { submissionRecoveryLocked = true; }
  }
  function confirmBusinessSubmission(recordType, recordId) {
    const intent = readBusinessSubmission(recordType);
    if (!intent || intent.invalid) return false;
    try {
      writeBusinessSubmission({ ...intent, state: "CONFIRMED", recordId: String(recordId), confirmedAt: new Date().toISOString() });
      submissionRecoveryLocked = true;
      return true;
    } catch (_) { return false; }
  }
  function businessSubmissionUi(recordType) {
    const verification = recordType === "VERIFICATION";
    const purchase = recordType === "PRODUCT_PURCHASE";
    return {
      message: $(verification ? "verificationCreateMessage" : purchase ? "purchaseCreateMessage" : "rechargeCreateMessage"),
      submit: verification ? $("verificationSubmit") : purchase ? $("productPurchaseForm")?.querySelector('[type="submit"]') : $("rechargeCreateForm")?.querySelector('[type="submit"]')
    };
  }
  function renderBusinessSubmissionLock(recordType, text) {
    submissionRecoveryLocked = true;
    const { message, submit } = businessSubmissionUi(recordType);
    if (submit) { submit.disabled = true; submit.setAttribute("aria-disabled", "true"); }
    if (!message) return;
    message.replaceChildren(document.createTextNode(text));
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "button-link";
    retry.textContent = "检查上次提交结果";
    retry.addEventListener("click", () => { void recoverPendingBusinessSubmission(recordType); });
    message.append(" ", retry);
  }
  function openRecoveredBusinessSubmission(recordType, result) {
    if (recordType === "PRODUCT_PURCHASE") {
      if (!result.purchaseId || !result.purchaseCode) return false;
      if (!confirmBusinessSubmission(recordType, result.purchaseId) || !clearBusinessSubmission(recordType)) {
        renderBusinessSubmissionLock(recordType, "产品购买单已确认写入，但浏览器无法清除防重复提交锁，请允许本站存储后重试。");
        return false;
      }
      submissionRecoveryLocked = false;
      const { message, submit } = businessSubmissionUi(recordType);
      if (message) message.textContent = `已找到上次产品购买单 ${result.purchaseCode}，不会重复提交。`;
      if (submit) submit.disabled = false;
      return true;
    }
    const recharge = recordType === "RECHARGE";
    const id = recharge ? result.rechargeId : result.verificationId;
    if (!id) return false;
    if (!confirmBusinessSubmission(recordType, id)) {
      renderBusinessSubmissionLock(recordType, "原业务已确认写入，但浏览器无法保存完成状态。已保持防重复提交锁，请先允许本站存储，再检查上次提交结果。");
      return false;
    }
    openGeneratedOrder(recharge ? "recharge" : "verification", { id: String(id) });
    return true;
  }
  async function recoverPendingBusinessSubmission(recordType, { missingIsDefinitive = false, originalError = null } = {}) {
    const intent = readBusinessSubmission(recordType);
    if (!intent || submissionRecoveryRunning) return false;
    if (intent.invalid) {
      renderBusinessSubmissionLock(recordType, `${intent.reason} 为防止重复充值或重复扣次，已禁止继续提交；请先由管理员核对数据库。`);
      return false;
    }
    if (!storeId) return false;
    if (String(intent.storeId) !== String(storeId)) {
      renderBusinessSubmissionLock(recordType, "上一次未确认提交属于另一个门店，禁止在当前门店继续办理。请返回后选择原门店恢复结果。");
      return false;
    }
    submissionRecoveryRunning = true;
    renderBusinessSubmissionLock(recordType, "正在从数据库检查上一次提交结果，请勿重复操作…");
    try {
      const result = await callCustomerEnrollment({
        action: "recoverBusinessSubmission",
        recordType,
        clientRequestId: intent.clientRequestId,
        storeId: intent.storeId
      });
      if (result.found && result.complete) return openRecoveredBusinessSubmission(recordType, result);
      if (result.found) {
        renderBusinessSubmissionLock(recordType, "上一次业务已写入，但设备信号或体验额度审计不完整。已锁定再次提交，请立即联系管理员处理。");
        return false;
      }
      if (missingIsDefinitive) {
        if (!clearBusinessSubmission(recordType)) {
          renderBusinessSubmissionLock(recordType, "数据库已确认原请求未写入，但浏览器无法清除防重复提交锁。请允许本站存储后再试。");
          return false;
        }
        submissionRecoveryLocked = false;
        const { message, submit } = businessSubmissionUi(recordType);
        if (message) message.textContent = originalError?.message || "上一次提交已确认未写入，可以修正后重新提交。";
        if (recordType === "VERIFICATION") syncVerificationSubmit();
        else if (submit) { submit.disabled = false; submit.removeAttribute("aria-disabled"); }
        return false;
      }
      renderBusinessSubmissionLock(recordType, "数据库暂未找到上一次结果，但原请求可能仍在执行。为防止重复充值或重复扣次，本页继续锁定；请稍后再次检查。");
      return false;
    } catch (error) {
      renderBusinessSubmissionLock(recordType, `${error?.message || "暂时无法检查上一次结果"}。为防止重复业务，本页继续锁定。`);
      return false;
    } finally {
      submissionRecoveryRunning = false;
    }
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
    let activeCustomerListRequest = 0;
    let manualLookupRequest = 0;
    const scopeRequest = ++customerLookupScopeRequest;
    const scopeStoreId = String(storeId || "");
    const isCurrentScope = () => scopeRequest === customerLookupScopeRequest && String(storeId || "") === scopeStoreId;
    const customerSelect = $("serviceCustomerSelect");
    $("serviceSelectBirthday").type = "text";
    const confirmButton = $("confirmCustomerSelection");
    confirmButton.dataset.initialText = confirmButton.textContent.trim();
    customerSelect.disabled = true;
    customerSelect.innerHTML = `<option value="">正在读取本门店全部活跃客户…</option>`;
    const loadActiveCustomers = async () => {
      const listRequest = ++activeCustomerListRequest;
      const isCurrentList = () => isCurrentScope() && listRequest === activeCustomerListRequest;
      try {
        const result = await fetchAllActiveStoreCustomers({
          expectedStoreId: scopeStoreId,
          isCurrent: isCurrentList,
          onProgress(count) {
            if (!isCurrentList()) return;
            customerSelect.innerHTML = `<option value="">正在读取本门店全部活跃客户（已读取 ${count} 位）…</option>`;
          }
        });
        if (!result || !isCurrentList()) return;
        storeName = String(result.storeName || result.storeCode || storeName);
        activeCustomers = result.customers;
        databaseCustomers = activeCustomers;
        customerSelect.innerHTML = activeCustomers.length
          ? `<option value="">请选择现有客户（可滑动浏览全部 ${activeCustomers.length} 位）</option>${activeCustomers.map((customer) => `<option value="${escapeHtml(customer.id)}">${escapeHtml(customer.name)} · ${escapeHtml(formatBirthday(customer.birthday))}</option>`).join("")}`
          : `<option value="">本门店暂无活跃客户</option>`;
        customerSelect.disabled = activeCustomers.length === 0;
      } catch (error) {
        if (!isCurrentList()) return;
        activeCustomers = [];
        databaseCustomers = [];
        customerSelect.innerHTML = `<option value="">客户数据读取失败</option>`;
        customerSelect.disabled = true;
        if (manualLookupRequest === 0) showLookupError(error?.message || "无法从数据库读取本门店全部活跃客户，请刷新重试。");
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
      manualLookupRequest += 1;
      const customer = activeCustomers.find((item) => item.id === $("serviceCustomerSelect").value);
      $("serviceSelectBirthday").value = formatBirthday(customer?.birthday, "");
      lookupSelectedCustomer();
    });
    const invalidateManualLookup = () => { manualLookupRequest += 1; resetCandidate(); };
    $("serviceCustomerName").addEventListener("input", invalidateManualLookup);
    $("serviceCustomerBirthday").addEventListener("change", invalidateManualLookup);
    document.querySelectorAll("[data-lookup-mode]").forEach((button) => button.addEventListener("click", () => {
      manualLookupRequest += 1;
      document.querySelectorAll("[data-lookup-mode]").forEach((item) => item.classList.toggle("active", item === button));
      const manual = button.dataset.lookupMode === "manual"; $("selectLookupFields").hidden = manual; $("manualLookupFields").hidden = !manual; resetCandidate();
    }));
    $("serviceSelectLookup").addEventListener("click", () => {
      if (!$("serviceCustomerSelect").value) { resetCandidate(); showLookupError("必须先选择现有客户。"); return; }
      lookupSelectedCustomer();
    });
    $("serviceCustomerLookup").addEventListener("click", async () => {
      resetCandidate(); const name = $("serviceCustomerName").value.trim(), birthday = $("serviceCustomerBirthday").value;
      if (!name && !birthday) { showLookupError("客户姓名或生日请至少填写一项。"); return; }
      const lookupRequest = ++manualLookupRequest;
      const isCurrentLookup = () => isCurrentScope() && lookupRequest === manualLookupRequest;
      const button = $("serviceCustomerLookup"); button.disabled = true;
      $("serviceCustomerResults").innerHTML = `<div class="lookup-placeholder"><strong>正在查询客户</strong><span>仅在本门店活跃客户中按已填写的姓名或生日精确查询。</span></div>`;
      try {
        const result = await fetchAllActiveStoreCustomers({ customerName: name, birthDate: birthday, expectedStoreId: scopeStoreId, isCurrent: isCurrentLookup });
        if (!result || !isCurrentLookup()) return;
        const matches = result.customers;
        if (matches.length === 1) renderCustomerCore(matches[0]);
        else if (matches.length > 1) {
          $("serviceCustomerResults").innerHTML = `<div class="duplicate-customer-list"><strong>找到 ${matches.length} 位匹配客户，请按编号选择：</strong>${matches.map((customer) => `<button type="button" data-preview-customer="${escapeHtml(customer.id)}">${escapeHtml(customer.name)} · ${escapeHtml(formatBirthday(customer.birthday))} · ${escapeHtml(customer.id)}</button>`).join("")}</div>`;
          document.querySelectorAll("[data-preview-customer]").forEach((item) => item.addEventListener("click", () => renderCustomerCore(matches.find((customer) => customer.id === item.dataset.previewCustomer))));
        } else showLookupError("未找到本门店活跃客户；请核对信息，或先恢复已存档客户。");
      } catch (error) {
        if (isCurrentLookup()) showLookupError(error?.message || "客户查询失败，请重试。");
      } finally {
        if (isCurrentScope()) button.disabled = false;
      }
    });
    $("confirmCustomerSelection").addEventListener("click", () => { if (candidateCustomer) confirmCustomer(candidateCustomer.id); });
    window.addEventListener("pagehide", () => {
      if (scopeRequest === customerLookupScopeRequest) customerLookupScopeRequest += 1;
    }, { once: true });
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
    if (page === "recharge") resetRechargeProductGifts();
    if (page === "refund" && $("rechargeProject")) {
      databaseProducts = [];
      $("rechargeProject").disabled = true;
      $("rechargeProject").innerHTML = `<option value="">确认客户后加载可退费项目</option>`;
      if ($("refundBalanceSummary")) $("refundBalanceSummary").textContent = "确认客户并选择项目后显示剩余次数。";
    }
    if (["verification", "verification-experience"].includes(page)) {
      resetVerificationCapture();
      resetVerificationUnitCount();
      const project = $("verificationProject");
      if (project) {
        project.disabled = true;
        project.innerHTML = `<option value="">${page === "verification-experience" ? "确认客户后读取当前老师的体验次数" : "确认客户后从数据库加载可核销项目"}</option>`;
      }
      if (page === "verification-experience" && $("experienceQuotaHint")) {
        $("experienceQuotaHint").textContent = "体验项目取决于老师体验额度，客户余额不会被读取或扣减。";
      }
    }
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
    resetVerificationUnitCount();
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
          name: String(item.productName || "未命名产品"),
          purchased: Number(item.purchasedCount || 0),
          verified: Number(item.effectiveVerificationCount || 0),
          remaining: Number(item.remainingCount || 0)
        }));
      select.innerHTML = verificationBalanceProjects.length
        ? `<option value="">请选择有剩余次数的项目</option>${verificationBalanceProjects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}（剩余 ${project.remaining} 次）</option>`).join("")}`
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
  async function loadTeacherExperienceEntitlements() {
    const select = $("verificationProject");
    if (!select) return;
    const teacherId = String($("verificationTeacher")?.value || "");
    const request = ++balanceRequest;
    verificationBalanceProjects = [];
    resetVerificationUnitCount();
    select.disabled = true;
    if (!teacherId) {
      select.innerHTML = `<option value="">请先选择有可用体验次数的老师</option>`;
      const hint = $("experienceQuotaHint");
      if (hint) hint.textContent = "体验项目取决于所选老师的可用体验次数，不会读取或扣减客户余额。";
      syncVerificationSubmit();
      return;
    }
    select.innerHTML = `<option value="">正在读取老师的可用体验次数…</option>`;
    const hint = $("experienceQuotaHint");
    if (hint) hint.textContent = "正在读取老师的体验额度…";
    try {
      // EXPERIENCE deliberately does not call getCustomerProductBalances.
      // The logged-in teacher owns the quota. The selected customer owns the
      // face evidence and remains the business subject of the record.
      const result = await callCustomerEnrollment({ action: "getTeacherExperienceEntitlements", teacherId });
      if (request !== balanceRequest || !selectedCustomer || String($("verificationTeacher")?.value || "") !== teacherId) return;
      verificationBalanceProjects = (Array.isArray(result?.entitlements) ? result.entitlements : [])
        .filter((item) => String(item.productStatus || item.product_status || "ACTIVE").toUpperCase() === "ACTIVE")
        .filter((item) => Number(item.availableCount ?? item.available_count ?? 0) > 0)
        .map((item) => ({
          id: String(item.productId || item.product_id || ""),
          code: String(item.productCode || item.product_code || ""),
          name: String(item.productName || item.product_name || "未命名产品"),
          remaining: Number(item.availableCount ?? item.available_count ?? 0),
          monthlyAllowance: Number(item.monthlyAllowance ?? item.monthly_allowance ?? 0),
          used: Number(item.usedCount ?? item.used_count ?? 0),
          manualRecharge: Number(item.manualRechargeCount ?? item.manual_recharge_count ?? 0)
        }))
        .filter((item) => item.id && item.remaining > 0);
      select.innerHTML = verificationBalanceProjects.length
        ? `<option value="">请选择老师有可用体验次数的项目</option>${verificationBalanceProjects.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}（老师可用 ${project.remaining} 次）</option>`).join("")}`
        : `<option value="">该老师没有可用的活跃产品体验次数</option>`;
      select.disabled = verificationBalanceProjects.length === 0;
      if (hint) hint.textContent = verificationBalanceProjects.length
        ? "体验核销将扣减当前老师的体验次数；现场只核验客户人脸，客户购买余额不会减少。"
        : "该老师目前没有可体验的活跃产品；可由总部在老师档案中配置或单独充值。";
    } catch (error) {
      if (request !== balanceRequest || !selectedCustomer || String($("verificationTeacher")?.value || "") !== teacherId) return;
      select.innerHTML = `<option value="">老师体验额度读取失败，禁止提交</option>`;
      select.disabled = true;
      if (hint) hint.textContent = error?.message || "无法读取老师体验额度，请刷新后重试。";
      const message = $("verificationCreateMessage");
      if (message) message.textContent = error?.message || "老师体验额度读取失败，请刷新后重试。";
    } finally {
      syncVerificationSubmit();
    }
  }
  async function loadRefundBalances(customer) {
    const select = $("rechargeProject");
    const summary = $("refundBalanceSummary");
    if (!select) return;
    const request = ++balanceRequest;
    databaseProducts = [];
    select.disabled = true;
    select.innerHTML = `<option value="">正在读取该客户的可退费项目…</option>`;
    if (summary) summary.textContent = "正在读取项目次数…";
    try {
      const result = await callCustomerEnrollment({ action: "getCustomerProductBalances", customerCode: customer.id });
      if (request !== balanceRequest || selectedCustomer?.id !== customer.id) return;
      databaseProducts = (Array.isArray(result?.balances) ? result.balances : [])
        .filter((item) => Number(item.purchasedCount) > 0)
        .map((item) => ({
          id: String(item.productId), code: String(item.productCode || ""), name: String(item.productName || "未命名项目"),
          purchased: Number(item.purchasedCount || 0), verified: Number(item.effectiveVerificationCount || 0), remaining: Math.max(0, Number(item.remainingCount || 0))
        }));
      select.innerHTML = databaseProducts.length
        ? `<option value="">请选择需要退费的项目</option>${databaseProducts.map((project) => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name)}（剩余 ${project.remaining} 次，可退 ${project.purchased} 次）</option>`).join("")}`
        : `<option value="">该客户没有可退费的已购项目</option>`;
      select.disabled = databaseProducts.length === 0;
      if (summary) summary.textContent = databaseProducts.length ? "选择项目后显示本单退费影响。" : "该客户目前没有可提交退费的项目。";
    } catch (error) {
      if (request !== balanceRequest || selectedCustomer?.id !== customer.id) return;
      select.innerHTML = `<option value="">项目次数读取失败，禁止提交退费</option>`;
      select.disabled = true;
      if (summary) summary.textContent = error?.message || "项目次数读取失败，请刷新后重试。";
    }
  }
  function renderRefundImpact() {
    if (page !== "refund") return;
    const project = databaseProducts.find((item) => item.id === $("rechargeProject")?.value);
    const count = Number($("rechargeCount")?.value || 0);
    const summary = $("refundBalanceSummary");
    if (!summary) return;
    if (!project) { summary.textContent = "选择项目后显示本单退费影响。"; return; }
    const after = Number.isInteger(count) && count > 0 ? Math.max(project.remaining - count, 0) : project.remaining;
    summary.innerHTML = `申请前剩余 <strong>${project.remaining}</strong> 次；本次退费 <strong>${Number.isInteger(count) && count > 0 ? count : 0}</strong> 次；审核通过后剩余 <strong>${after}</strong> 次。${count > project.remaining ? "退费次数超过剩余次数，剩余次数将归 0。" : ""}`;
  }
  async function confirmCustomer(id) {
    selectedCustomer = allCustomers().find((customer) => customer.id === id)
      || (candidateCustomer?.id === id ? candidateCustomer : null);
    if (!selectedCustomer) {
      resetCandidate();
      showLookupError("客户列表或精确查询结果已经失效，请重新选择客户。");
      return;
    }
    $("selectedCustomerText").textContent = `已确认：${selectedCustomer.name}（${selectedCustomer.id}）· ${formatBirthday(selectedCustomer.birthday)} · ${storeName}`; document.querySelector("form.store-business-form").classList.remove("business-step-disabled");
    if (page === "verification") { resetVerificationCapture(); await loadVerificationBalances(selectedCustomer); }
    if (page === "verification-experience") { resetVerificationCapture(); await loadTeacherExperienceEntitlements(); }
    if (page === "refund") await loadRefundBalances(selectedCustomer);
    $("confirmCustomerSelection").textContent = `已确认 ${selectedCustomer.name}（${selectedCustomer.id}）`;
  }
  function setupRecharge() {
    const refundPage = page === "refund";
    setupLookup();
    if (!refundPage) {
      loadActiveProducts("rechargeProject", "rechargeCreateMessage");
      setupRechargeProductGifts();
    }
    loadActiveTeachers("rechargeTeacher", "rechargeCreateMessage", { optional: true });
    if (refundPage) {
      $("rechargeProject").addEventListener("change", renderRefundImpact);
      $("rechargeCount").addEventListener("input", renderRefundImpact);
    }
    $("rechargeCreateForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget, submit = form.querySelector('[type="submit"]');
      if (submissionRecoveryLocked || readBusinessSubmission("RECHARGE")) {
        await recoverPendingBusinessSubmission("RECHARGE");
        return;
      }
      const projectId = $("rechargeProject").value, teacherId = $("rechargeTeacher").value, count = Number($("rechargeCount").value), note = $("rechargeNote").value.trim();
      if (!selectedCustomer || !projectId || !Number.isInteger(count) || count < 1 || count > 999) { $("rechargeCreateMessage").textContent = `必须确认客户、选择项目，并填写 1 至 999 的整数${refundPage ? "退费" : "充值"}次数`; return; }
      const project = databaseProducts.find((item) => item.id === projectId), teacher = teacherId ? databaseTeachers.find((item) => item.id === teacherId) : null;
      if (!project || (teacherId && !teacher)) { $("rechargeCreateMessage").textContent = "项目或老师数据已经失效，请刷新页面后重新选择"; return; }
      if (teacherMode && teacher?.id !== normalizedTeacherProfile(teacherBusinessProfile || {}).id) { $("rechargeCreateMessage").textContent = "老师账号只能将业务绑定给本人，请刷新页面后重试"; return; }
      if (refundPage && count > Number(project.purchased || 0)) { $("rechargeCreateMessage").textContent = `最多可退 ${project.purchased} 次；可以超过剩余 ${project.remaining} 次，但不能超过尚未退费的总购买次数`; return; }
      const payload = {
        applicationType: refundPage ? "REFUND" : "NEW", customerCode: selectedCustomer.id,
        productId: project.id, teacherId: teacher?.id || "", unitCount: count, message: note,
        productGifts: refundPage ? [] : rechargeProductGifts.map((item) => ({ retailProductId: item.retailProductId, unitCount: item.unitCount }))
      };
      let intent;
      try {
        intent = beginBusinessSubmission("RECHARGE", { storeId, ...payload });
      } catch (error) {
        $("rechargeCreateMessage").textContent = error?.message || "无法保存防重复提交编号，已禁止提交。";
        if (error?.code === "SUBMISSION_RECOVERY_REQUIRED") renderBusinessSubmissionLock("RECHARGE", error.message);
        return;
      }
      const clientRequestId = intent.clientRequestId;
      submit.disabled = true;
      $("rechargeCreateMessage").textContent = `正在向数据库提交待审核${refundPage ? "退费" : "充值"}单…`;
      let result = null;
      try {
        result = await callCustomerEnrollment({ action: "createRechargeApplication", ...payload, clientRequestId });
        if (String(result.recordStatus || "") !== "PENDING") throw new Error(`数据库返回的${refundPage ? "退费" : "充值"}单状态不是待审核，已停止后续操作`);
        if (!result.rechargeId || !result.rechargeCode) throw new Error("数据库已响应，但没有返回充值单编号，已停止跳转");
        const record = {
          id: String(result.rechargeId),
          recordCode: String(result.rechargeCode),
          recordType: "recharge",
          applicationType: refundPage ? "退费申请" : "充值申请",
          originalType: refundPage ? "REFUND" : "NEW",
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
          balanceBeforeCount: Number(result.balanceBeforeCount ?? project.remaining ?? 0),
          balanceAfterCount: result.balanceAfterCount === null || result.balanceAfterCount === undefined ? "" : Number(result.balanceAfterCount),
          status: String(result.recordStatus),
          note,
          account: String(session?.account || ""),
          createdAt: result.submittedAt || new Date().toISOString(),
          productGifts: Array.isArray(result.productGifts) ? result.productGifts : rechargeProductGifts.map((item, index) => ({ ...item, displayOrder: index + 1 })),
          databaseBacked: true
        };
        saveGeneratedOrder("prototypeRechargeRecords", record);
        addCommunication("recharge", record.id, note);
        if (!confirmBusinessSubmission("RECHARGE", record.id)) {
          renderBusinessSubmissionLock("RECHARGE", "充值/退费单已写入，但浏览器无法保存完成状态。已保持防重复提交锁，请先允许本站存储，再检查上次提交结果。");
          return;
        }
        openGeneratedOrder("recharge", record);
      } catch (error) {
        markBusinessSubmissionUncertain("RECHARGE");
        await recoverPendingBusinessSubmission("RECHARGE", {
          missingIsDefinitive: !error?.submissionUncertain && !result,
          originalError: error
        });
      } finally {
        if (!submissionRecoveryLocked) submit.disabled = false;
      }
    });
    void recoverPendingBusinessSubmission("RECHARGE");
  }
  function setupProductPurchase() {
    setupLookup();
    const select = $("purchaseProduct");
    select.disabled = true;
    select.innerHTML = `<option value="">正在读取激活产品…</option>`;
    void callCustomerEnrollment({ action: "listActiveRetailProducts" }).then((result) => {
      retailGiftProducts = (Array.isArray(result?.products) ? result.products : []).map((item) => ({
        id: String(item.productId || ""), code: String(item.productCode || ""), name: String(item.productName || "")
      })).filter((item) => item.id && item.name);
      select.innerHTML = retailGiftProducts.length
        ? `<option value="">请选择激活产品</option>${retailGiftProducts.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)} · ${escapeHtml(item.code)}</option>`).join("")}`
        : `<option value="">当前没有激活产品</option>`;
      select.disabled = retailGiftProducts.length === 0;
    }).catch((error) => {
      select.innerHTML = `<option value="">激活产品读取失败</option>`;
      $("purchaseCreateMessage").textContent = error?.message || "激活产品读取失败";
    });
    $("productPurchaseForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (submissionRecoveryLocked || readBusinessSubmission("PRODUCT_PURCHASE")) return void recoverPendingBusinessSubmission("PRODUCT_PURCHASE");
      const product = retailGiftProducts.find((item) => item.id === select.value);
      const unitCount = Number($("purchaseCount").value);
      const message = $("purchaseNote").value.trim();
      if (!selectedCustomer) { $("purchaseCreateMessage").textContent = "必须先查询并确认客户"; return; }
      if (!product) { $("purchaseCreateMessage").textContent = "请选择当前激活产品"; return; }
      if (!Number.isInteger(unitCount) || unitCount < 1 || unitCount > 999) { $("purchaseCreateMessage").textContent = "购买数量必须是 1 至 999 的整数"; return; }
      const payload = { storeId, customerCode: selectedCustomer.id, retailProductId: product.id, unitCount, message };
      let intent;
      try { intent = beginBusinessSubmission("PRODUCT_PURCHASE", payload); }
      catch (error) { $("purchaseCreateMessage").textContent = error?.message || "无法保存防重复提交编号"; return; }
      const submit = event.currentTarget.querySelector('[type="submit"]'); submit.disabled = true;
      $("purchaseCreateMessage").textContent = "正在提交产品购买申请…";
      try {
        const result = await callCustomerEnrollment({ action: "createRetailProductPurchaseApplication", ...payload, clientRequestId: intent.clientRequestId });
        if (String(result.recordStatus || "") !== "PENDING" || !result.purchaseId || !result.purchaseCode) throw new Error("服务端未返回完整待审核购买单");
        confirmBusinessSubmission("PRODUCT_PURCHASE", result.purchaseId);
        clearBusinessSubmission("PRODUCT_PURCHASE");
        $("purchaseCount").value = ""; $("purchaseNote").value = "";
        $("purchaseCreateMessage").textContent = `产品购买单 ${result.purchaseCode} 已提交，等待总部审核。`;
      } catch (error) {
        markBusinessSubmissionUncertain("PRODUCT_PURCHASE");
        await recoverPendingBusinessSubmission("PRODUCT_PURCHASE", { missingIsDefinitive: !error?.submissionUncertain, originalError: error });
      } finally { if (!submissionRecoveryLocked) submit.disabled = false; }
    });
    void recoverPendingBusinessSubmission("PRODUCT_PURCHASE");
  }
  function resetVerificationUnitCount() {
    const input = $("verificationUnitCount");
    if (!input) return;
    input.value = "";
    input.disabled = true;
    input.max = "999";
    input.placeholder = "选择项目后填写";
  }
  function syncVerificationUnitCount({ clear = false } = {}) {
    const input = $("verificationUnitCount");
    const productId = String($("verificationProject")?.value || "");
    const project = verificationBalanceProjects.find((item) => item.id === productId);
    if (!input) return null;
    if (clear) input.value = "";
    if (!project) {
      input.disabled = true;
      input.max = "999";
      input.placeholder = "选择项目后填写";
      return null;
    }
    const limit = Math.min(999, Math.max(0, Math.trunc(Number(project.remaining || 0))));
    input.disabled = limit < 1;
    input.max = String(limit || 999);
    input.placeholder = limit > 0 ? `请输入 1 至 ${limit} 次` : "当前项目没有可用次数";
    const unitCount = Number(input.value);
    return Number.isInteger(unitCount) && unitCount >= 1 && unitCount <= limit ? unitCount : null;
  }
  function syncVerificationSubmit() {
    const submit = $("verificationSubmit");
    const projectReady = Boolean($("verificationProject")?.value);
    const teacherReady = Boolean($("verificationTeacher")?.value);
    const countReady = syncVerificationUnitCount() !== null;
    const ready = !submissionRecoveryLocked && Boolean(selectedCustomer) && photoCaptured && projectReady && teacherReady && countReady;
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
    const experiencePage = page === "verification-experience";
    setupLookup(); $("verificationProject").innerHTML = `<option value="">${experiencePage ? "确认客户后读取当前老师的体验次数" : "确认客户后从数据库加载可核销项目"}</option>`; loadActiveTeachers("verificationTeacher", "verificationCreateMessage");
    const video = $("verificationCamera"), preview = $("verificationPhotoPreview"), placeholder = $("verificationCameraPlaceholder"), canvas = $("verificationCaptureCanvas"), open = $("openVerificationCamera"), capture = $("captureVerificationPhoto"), retake = $("retakeVerificationPhoto"), status = $("verificationPhotoStatus"), message = $("verificationCreateMessage");
    $("verificationProject").addEventListener("change", () => {
      syncVerificationUnitCount({ clear: true });
      syncVerificationSubmit();
    });
    $("verificationUnitCount").addEventListener("input", syncVerificationSubmit);
    $("verificationTeacher").addEventListener("change", async () => {
      if (experiencePage) {
        // Rebinding the authenticated teacher context invalidates any quota
        // response or customer capture produced for the previous context.
        resetVerificationCapture();
        if (selectedCustomer) await loadTeacherExperienceEntitlements();
      }
      syncVerificationSubmit();
    });
    $("verificationNote").addEventListener("input", syncVerificationSubmit);
    resetVerificationCapture();
    open.addEventListener("click", async () => {
      try {
        if (!selectedCustomer) throw new Error("请先查询并确认需要核销的客户");
        if (experiencePage && !databaseTeachers.some((item) => item.id === String($("verificationTeacher")?.value || ""))) {
          throw new Error("当前账号没有可用的老师档案，不能赠送体验核销。");
        }
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
      event.preventDefault(); const form = event.currentTarget, submit = form.querySelector('[type="submit"]'), projectId = $("verificationProject").value, teacherId = $("verificationTeacher").value, note = $("verificationNote").value.trim(), experience = experiencePage;
      if (submissionRecoveryLocked || readBusinessSubmission("VERIFICATION")) {
        await recoverPendingBusinessSubmission("VERIFICATION");
        return;
      }
      if (!selectedCustomer || !projectId || !teacherId) { $("verificationCreateMessage").textContent = "必须确认客户并选择项目和老师"; return; }
      if (!photoCaptured) { $("verificationCreateMessage").textContent = "必须完成现场拍照并通过所选客户的 1:1 人脸验证，才能核销和发送设备信号"; return; }
      const project = verificationBalanceProjects.find((item) => item.id === projectId);
      if (!project) { $("verificationCreateMessage").textContent = experience ? "所选老师的体验次数已失效，请重新选择老师和项目后再试" : "所选项目余额已失效，请重新确认客户后再试"; return; }
      const unitCount = syncVerificationUnitCount();
      if (unitCount === null) { $("verificationCreateMessage").textContent = `核销次数必须由办理人员填写，并且是 1 至 ${Math.min(999, project.remaining)} 的整数`; return; }
      const teacher = databaseTeachers.find((item) => item.id === teacherId);
      if (!teacher) { $("verificationCreateMessage").textContent = "老师数据已经失效，请刷新页面后重新选择"; return; }
      if (teacherMode && teacher.id !== normalizedTeacherProfile(teacherBusinessProfile || {}).id) { $("verificationCreateMessage").textContent = "老师账号只能将业务绑定给本人，请刷新页面后重试"; return; }
      const payload = { customerCode: selectedCustomer.id, productId: project.id, unitCount, teacherId: teacher.id, verificationType: experience ? "EXPERIENCE" : "NORMAL", message: note, faceRequestId: verificationFaceRequestId, faceEvidenceToken: verificationFaceEvidenceToken };
      let intent;
      try {
        intent = beginBusinessSubmission("VERIFICATION", {
          storeId,
          customerCode: selectedCustomer.id,
          productId: project.id,
          unitCount,
          teacherId: teacher.id,
          verificationType: experience ? "EXPERIENCE" : "NORMAL",
          message: note
        });
      } catch (error) {
        $("verificationCreateMessage").textContent = error?.message || "无法保存防重复提交编号，已禁止提交。";
        if (error?.code === "SUBMISSION_RECOVERY_REQUIRED") renderBusinessSubmissionLock("VERIFICATION", error.message);
        return;
      }
      const clientRequestId = intent.clientRequestId;
      submit.disabled = true;
      $("verificationCreateMessage").textContent = experience ? "正在自动完成体验核销并发送设备开启信号…" : "正在提交核销并发送设备开启信号…";
      let result = null;
      try {
        result = await callCustomerEnrollment({ action: "createVerificationApplication", ...payload, clientRequestId });
        const expectedStatus = "APPROVED";
        if (String(result.recordStatus || "") !== expectedStatus) throw new Error("数据库返回的核销单状态与当前业务类型不一致，已停止跳转");
        if (!result.verificationId || !result.verificationCode) throw new Error("数据库已响应，但没有返回核销单编号，已停止跳转");
        if (Number(result.unitCount) !== unitCount || Number(result.deviceSignal?.unitCount) !== unitCount) throw new Error("数据库或设备信号返回的核销次数与本次选择不一致，已停止跳转");
        const record = {
          id: String(result.verificationId), recordCode: String(result.verificationCode), recordType: "verification",
          customerId: String(result.customer?.customerCode || selectedCustomer.id), customerName: String(result.customer?.customerName || selectedCustomer.name),
          name: selectedCustomer.name, birthday: selectedCustomer.birthday, storeId, storeName,
          projectId: String(result.product?.productId || project.id), projectCode: String(result.product?.productCode || project.code || ""), projectName: String(result.product?.productName || project.name),
          teacherId: String(result.teacher?.teacherId || teacher.id), teacherCode: String(result.teacher?.teacherCode || teacher.code || ""), teacherName: String(result.teacher?.teacherName || teacher.name),
          count: Number(result.unitCount), faceVerification: "活体检测与人脸比对通过",
          faceSubjectType: "CUSTOMER",
          faceSubjectTeacherId: "",
          verificationType: experience ? "体验核销" : "正常核销", status: String(result.recordStatus),
          experienceQuotaAvailableAfter: experience && result.experienceQuota
            ? Number(result.experienceQuota.availableAfterCount ?? result.experienceQuota.availableAfter)
            : null,
          deviceSignal: result.deviceSignal?.status === "PENDING" ? "已发送至虚拟设备端口" : "设备信号已登记", account: session.account, note,
          createdAt: result.submittedAt || new Date().toISOString(), databaseBacked: true
        };
        saveGeneratedOrder("prototypeVerificationRecords", record);
        addCommunication("verification", record.id, note);
        if (!confirmBusinessSubmission("VERIFICATION", record.id)) {
          renderBusinessSubmissionLock("VERIFICATION", "核销单已写入，但浏览器无法保存完成状态。已保持防重复提交锁，请先允许本站存储，再检查上次提交结果。");
          return;
        }
        openGeneratedOrder("verification", record);
      } catch (error) {
        markBusinessSubmissionUncertain("VERIFICATION");
        await recoverPendingBusinessSubmission("VERIFICATION", {
          missingIsDefinitive: !error?.submissionUncertain && !result,
          originalError: error
        });
        if (!submissionRecoveryLocked && ["FACE_PHOTO_EVIDENCE_REQUIRED", "FACE_PHOTO_EVIDENCE_INVALID"].includes(error?.code)) resetVerificationCapture();
      } finally {
        syncVerificationSubmit();
      }
    });
    void recoverPendingBusinessSubmission("VERIFICATION");
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
    if (["recharge", "refund"].includes(page)) setupRecharge();
    else if (page === "product-purchase") setupProductPurchase();
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
      teacherBusinessProfile = result?.teacher ? normalizedTeacherProfile(result.teacher) : null;
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
    const pendingRecordType = businessRecordTypeForPage();
    const pendingIntent = pendingRecordType ? readBusinessSubmission(pendingRecordType) : null;
    const pendingStore = pendingIntent ? teacherBusinessStores.find((store) => store.id === String(pendingIntent.storeId || "")) : null;
    if (pendingStore) {
      select.value = pendingStore.id;
      storeId = pendingStore.id;
      storeName = [pendingStore.name, pendingStore.code].filter(Boolean).join(" · ");
      startTeacherWorkflow();
    }
  }

  function installSharedBusinessStorePanel() {
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
    const roleLabel = sharedTeacherMode ? "老师" : "总部";
    panel.innerHTML = `<div class="panel-heading"><div><h2>选择本次办理门店</h2><p>${roleLabel}每次只能为一个具体门店办理业务，不能选择全部门店</p></div><span id="hqBusinessStoreState" class="badge">尚未选择</span></div><div class="hq-business-store-row"><label>当前${roleLabel}账号<strong id="hqBusinessIdentity"></strong></label><label>办理门店<select id="hqBusinessStore"><option value="">正在读取活跃门店…</option></select></label><button id="confirmHqBusinessStore" type="button" disabled>确认门店</button></div><p id="hqBusinessStoreMessage" class="form-message" role="status"></p>`;
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

  async function setupSharedBusiness() {
    const installed = installSharedBusinessStorePanel();
    if (!installed) return;
    const { workflow, unlock } = installed;
    const select = $("hqBusinessStore");
    const confirm = $("confirmHqBusinessStore");
    const message = $("hqBusinessStoreMessage");
    $("hqBusinessIdentity").textContent = [session.staffName, session.account].filter(Boolean).join(" · ") || (sharedTeacherMode ? "当前老师账号" : "当前总部账号");
    let stores = [];
    try {
      const result = await callCustomerEnrollment({ action: sharedTeacherMode ? "getTeacherBusinessContext" : "getHqBusinessContext" });
      if (sharedTeacherMode && result?.teacher) {
        teacherBusinessProfile = normalizedTeacherProfile(result.teacher);
        $("hqBusinessIdentity").textContent = [teacherBusinessProfile.name, teacherBusinessProfile.code].filter(Boolean).join(" · ") || "当前老师账号";
      }
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
      message.textContent = error?.message || `无法读取${sharedTeacherMode ? "老师" : "总部"}可办理门店，请刷新后重试。`;
    }
    select.addEventListener("change", () => {
      confirm.disabled = !stores.some((store) => store.id === select.value);
      message.textContent = "";
    });
    const selectStoreAndStart = (selected) => {
      storeId = selected.id;
      storeName = [selected.name, selected.code].filter(Boolean).join(" · ");
      select.value = selected.id;
      select.disabled = true;
      unlock();
      workflow.classList.remove("business-store-unconfirmed");
      $("hqBusinessStoreState").textContent = "已选择";
      confirm.textContent = "重新选择门店";
      message.textContent = `当前办理门店：${storeName}。如选择有误，请重新选择并清空本页资料。`;
      const scopeBadge = workflow.querySelector(".workflow-lookup-panel .badge");
      if (scopeBadge) scopeBadge.textContent = storeName;
      if (page === "customer") setupCustomerCreate();
      else if (["recharge", "refund"].includes(page)) setupRecharge();
      else if (page === "product-purchase") setupProductPurchase();
      else setupVerification();
    };
    confirm.addEventListener("click", () => {
      if (!workflow.hasAttribute("inert")) {
        stopFaceCamera();
        window.location.reload();
        return;
      }
      const selected = stores.find((store) => store.id === select.value);
      if (!selected) { message.textContent = "必须先选择一个具体门店。"; return; }
      selectStoreAndStart(selected);
    });
    const pendingRecordType = businessRecordTypeForPage();
    const pendingIntent = pendingRecordType ? readBusinessSubmission(pendingRecordType) : null;
    const pendingStore = pendingIntent ? stores.find((store) => store.id === String(pendingIntent.storeId || "")) : null;
    if (pendingStore) selectStoreAndStart(pendingStore);
  }

  document.documentElement.dataset.prototypeVersion = VERSION;
  window.addEventListener("pageshow", (event) => {
    // A back-forward-cache restore retains every in-memory form, camera and
    // evidence value. Shared HQ/teacher workflows must reconfirm a concrete
    // store on a clean form before any further operation.
    if ((hqMode || sharedTeacherMode) && event.persisted) window.location.reload();
  });
  setupWorkflowResize();
  if (legacyTeacherMode) setupTeacherBusiness();
  else if (hqMode || sharedTeacherMode) setupSharedBusiness();
  else if (page === "customer") setupCustomerCreate();
  else if (["recharge", "refund"].includes(page)) setupRecharge();
  else if (page === "product-purchase") setupProductPurchase();
  else if (["verification", "verification-experience"].includes(page)) setupVerification();
})();
