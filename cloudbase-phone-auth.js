(() => {
  "use strict";
  let app = null;
  let auth = null;
  let verifyOtp = null;
  const SMS_COOLDOWN_MS = 60 * 1000;
  const AUTH_CHANNEL_NAME = "lusizhuoer-auth-session-v1";
  const AUTH_STATE_KEY = "lusizhuoerActiveAuth";
  const PRODUCT_TEMPLATE_CACHE_TTL_MS = 15 * 1000;
  const PRODUCT_LOGO_DATA_CACHE_TTL_MS = 2 * 60 * 1000;
  // The lightweight teacherCreate function makes one synchronous account and
  // master-data request. This guard never retries or polls after an uncertain
  // transport result.
  const TEACHER_CREATE_WATCHDOG_MS = 75 * 1000;
  const productTemplateCache = new Map();
  const productTemplateFlights = new Map();
  const productLogoDataCache = new Map();
  const productLogoDataFlights = new Map();
  let productReceiptCacheGeneration = 0;
  let productLogoDataCacheBytes = 0;

  function registerCloudBaseComponent(register, componentName) {
    try {
      register(window.cloudbase);
    } catch (error) {
      const detail = String(error?.message || error || "").toLowerCase();
      const alreadyRegistered = detail.includes("duplicate component") && detail.includes(componentName);
      if (!alreadyRegistered) throw error;
    }
  }

  function normalizePhone(phone) {
    const digits = String(phone || "").replace(/\D/g, "");
    if (!/^1[3-9]\d{9}$/.test(digits)) throw new Error("请输入有效的中国大陆手机号");
    // CloudBase Web SDK 的 phone 参数使用 11 位中国大陆手机号；国家码不需写入。
    return digits;
  }

  function getApp() {
    if (app) return app;
    if (!window.cloudbase || !window.registerAuth || !window.registerFunctions || !window.CloudBaseAuthConfig) {
      throw new Error("CloudBase 登录组件未加载，请刷新后重试");
    }
    // Depending on the CDN bundle/version, auth and functions may already be
    // registered when their scripts load. Re-registering them aborts every
    // CloudBase request with INVALID_OPERATION, so only ignore that exact,
    // harmless duplicate-registration condition.
    registerCloudBaseComponent(window.registerAuth, "auth");
    registerCloudBaseComponent(window.registerFunctions, "functions");
    app = window.cloudbase.init(window.CloudBaseAuthConfig);
    return app;
  }

  function getAuth() {
    if (auth) return auth;
    auth = getApp().auth();
    return auth;
  }

  function authResponseData(result, fallback) {
    if (!result || typeof result !== "object") {
      throw new Error(`${fallback}，认证服务没有返回有效结果`);
    }
    if (result.error) throw new Error(result.error.message || fallback);
    if (!result.data || typeof result.data !== "object") {
      throw new Error(`${fallback}，认证服务没有返回有效会话`);
    }
    return result.data;
  }

  function functionPayload(result) {
    const candidates = [result?.result, result?.data?.result, result?.data, result].map((candidate) => {
      if (typeof candidate !== "string") return candidate;
      try { return JSON.parse(candidate); } catch (_) { return candidate; }
    });
    return candidates.find((candidate) => candidate && typeof candidate === "object" && (
      Object.prototype.hasOwnProperty.call(candidate, "ok") ||
      Object.prototype.hasOwnProperty.call(candidate, "message") ||
      Object.prototype.hasOwnProperty.call(candidate, "errMsg") ||
      Object.prototype.hasOwnProperty.call(candidate, "error")
    )) || {};
  }

  function functionFailureMessage(result, payload, fallback) {
    const detail = payload?.message || payload?.error?.message || payload?.errMsg ||
      result?.message || result?.error?.message || result?.errMsg || fallback;
    const code = payload?.code || payload?.error?.code || result?.code || result?.error?.code;
    const stage = payload?.stage || result?.stage;
    const requestId = payload?.requestId || result?.requestId;
    const diagnostic = [code, stage, requestId].filter(Boolean).join(" · ");
    return diagnostic ? `${detail}（${diagnostic}）` : detail;
  }

  async function callStaffAccount(data, fallback) {
    let result;
    try {
      result = await getApp().callFunction({ name: "staffAccount", data });
    } catch (error) {
      const wrapped = new Error(error?.message || fallback);
      Object.assign(wrapped, {
        code: error?.code,
        stage: error?.stage,
        requestId: error?.requestId,
        causeCode: error?.causeCode,
        causeMessage: error?.causeMessage
      });
      throw wrapped;
    }
    const payload = functionPayload(result);
    if (!payload?.ok) {
      const error = new Error(functionFailureMessage(result, payload, fallback));
      Object.assign(error, {
        code: payload?.code || result?.code,
        stage: payload?.stage || result?.stage,
        requestId: payload?.requestId || result?.requestId,
        storeId: payload?.storeId || result?.storeId,
        storeCode: payload?.storeCode || result?.storeCode,
        storeRolledBack: payload?.storeRolledBack || result?.storeRolledBack,
        causeCode: payload?.causeCode || result?.causeCode,
        causeMessage: payload?.causeMessage || result?.causeMessage
      });
      throw error;
    }
    return payload;
  }

  async function callTeacherCreate(data, fallback) {
    let result;
    try {
      result = await getApp().callFunction({ name: "teacherCreate", data });
    } catch (error) {
      const wrapped = new Error(error?.message || fallback);
      Object.assign(wrapped, {
        code: error?.code,
        stage: error?.stage,
        requestId: error?.requestId,
        causeCode: error?.causeCode,
        causeMessage: error?.causeMessage,
        // No function payload means the browser cannot know whether the
        // server accepted and is still running this write request.
        transportUncertain: true
      });
      throw wrapped;
    }
    const payload = functionPayload(result);
    if (!payload?.ok) {
      const code = payload?.code || result?.code;
      const authoritativeFunctionFailure = payload?.ok === false;
      const error = new Error(functionFailureMessage(result, payload, fallback));
      Object.assign(error, {
        code,
        stage: payload?.stage || result?.stage,
        requestId: payload?.requestId || result?.requestId,
        causeCode: payload?.causeCode || result?.causeCode,
        causeMessage: payload?.causeMessage || result?.causeMessage,
        // Only the function's own explicit ok:false response proves that the
        // write invocation has ended. Gateway/SDK envelopes remain unknown.
        transportUncertain: !authoritativeFunctionFailure
          || code === "TEACHER_CREATE_CLEANUP_INCOMPLETE"
      });
      throw error;
    }
    return payload;
  }

  function promiseWithWatchdog(request, fallback, timeoutMs) {
    let timer = null;
    const watchdog = new Promise((_, reject) => {
      timer = window.setTimeout(() => {
        const error = new Error(`${fallback}，浏览器等待超时；前端没有自动重发`);
        error.code = "CLIENT_REQUEST_TIMEOUT";
        error.transportUncertain = true;
        reject(error);
      }, timeoutMs);
    });
    return Promise.race([request, watchdog])
      .finally(() => window.clearTimeout(timer));
  }

  function productReceiptRefKey(value) {
    const text = String(value || "").trim();
    return /^\d+$/.test(text) ? text : text.toUpperCase();
  }

  function cloneProductTemplate(value) {
    if (!value || typeof value !== "object") return value;
    return { ...value, logo: value.logo && typeof value.logo === "object" ? { ...value.logo } : null };
  }

  function cloneProductLogoData(value) {
    return value && typeof value === "object" ? { ...value } : value;
  }

  function trimReceiptCache(cache, maximumEntries) {
    while (cache.size > maximumEntries) cache.delete(cache.keys().next().value);
  }

  function cachedProductTemplate(productRef) {
    const key = productReceiptRefKey(productRef);
    const entry = productTemplateCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      productTemplateCache.delete(key);
      return null;
    }
    productTemplateCache.delete(key);
    productTemplateCache.set(key, entry);
    return cloneProductTemplate(entry.value);
  }

  function rememberProductTemplate(productRef, template) {
    if (!template || typeof template !== "object") return;
    const entry = {
      value: cloneProductTemplate(template),
      expiresAt: Date.now() + PRODUCT_TEMPLATE_CACHE_TTL_MS
    };
    const keys = new Set([
      productReceiptRefKey(productRef),
      productReceiptRefKey(template.id),
      productReceiptRefKey(template.productCode)
    ]);
    for (const key of keys) {
      if (!key) continue;
      productTemplateCache.delete(key);
      productTemplateCache.set(key, entry);
    }
    trimReceiptCache(productTemplateCache, 48);
  }

  function expectedProductLogoReference(productRef, explicitReference) {
    const explicit = String(explicitReference || "").trim();
    if (explicit) return explicit;
    const cached = cachedProductTemplate(productRef);
    return String(cached?.logo?.reference || "").trim();
  }

  function clearProductReceiptCaches() {
    productReceiptCacheGeneration += 1;
    productTemplateCache.clear();
    productTemplateFlights.clear();
    productLogoDataCache.clear();
    productLogoDataFlights.clear();
    productLogoDataCacheBytes = 0;
  }

  function productLogoReadTransient(error) {
    const text = [error?.code, error?.causeCode, error?.message, error?.causeMessage]
      .filter(Boolean).join(" ").toUpperCase();
    return /(?:^|[^A-Z])(INTERNALERROR|INTERNAL_ERROR|HTTP_429|HTTP_5\d\d|TOOMANYREQUESTS|TOO_MANY_REQUESTS|THROTTL|TIMEOUT|TIMEDOUT|ETIMEDOUT|ECONNRESET|EAI_AGAIN|FETCH FAILED|NETWORK)(?:[^A-Z]|$)/.test(text);
  }

  function productLogoRetryDelay(milliseconds) {
    const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(milliseconds / 4)));
    return new Promise((resolve) => setTimeout(resolve, milliseconds + jitter));
  }

  async function callProductReceiptRead(data, fallback) {
    try {
      return await callStaffAccount(data, fallback);
    } catch (error) {
      if (!productLogoReadTransient(error)) throw error;
      await productLogoRetryDelay(120);
      return callStaffAccount(data, fallback);
    }
  }

  function canonicalBase64ByteLength(value) {
    const text = String(value || "");
    if (!text || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) return -1;
    const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
    return text.length / 4 * 3 - padding;
  }

  function validateProductLogoData(value, expectedReference = "") {
    if (!value || typeof value !== "object") throw new Error("项目 LOGO 原图服务返回了无效数据");
    const reference = String(value.reference || "").trim();
    const mimeType = String(value.mimeType || "").trim().toLowerCase();
    const bytes = Number(value.bytes);
    const base64Bytes = canonicalBase64ByteLength(value.base64);
    if (!reference || !["image/png", "image/jpeg", "image/webp"].includes(mimeType)
        || !Number.isSafeInteger(bytes) || bytes < 8 || bytes > 8 * 1024 * 1024
        || base64Bytes !== bytes) {
      throw new Error("项目 LOGO 原图服务返回了无效数据");
    }
    if (expectedReference && reference !== expectedReference) {
      const error = new Error("项目 LOGO 已更新，请重新读取项目模板");
      error.code = "PRODUCT_LOGO_CHANGED";
      throw error;
    }
    return { ...value, reference, mimeType, bytes };
  }

  async function completeChunkedProductLogo(productRef, expectedReference, manifest) {
    const reference = String(manifest?.reference || "").trim();
    const mimeType = String(manifest?.mimeType || "").trim().toLowerCase();
    const bytes = Number(manifest?.bytes);
    const chunkSize = Number(manifest?.chunkSize);
    if (!reference || (expectedReference && reference !== expectedReference)
        || !["image/png", "image/jpeg", "image/webp"].includes(mimeType)
        || !Number.isSafeInteger(bytes) || bytes <= 3 * 1024 * 1024 || bytes > 8 * 1024 * 1024
        || !Number.isSafeInteger(chunkSize) || chunkSize < 256 * 1024 || chunkSize > 2 * 1024 * 1024
        || chunkSize % 3 !== 0) {
      const error = new Error(expectedReference && reference !== expectedReference
        ? "项目 LOGO 已更新，请重新读取项目模板"
        : "项目 LOGO 分块读取清单无效");
      error.code = expectedReference && reference !== expectedReference ? "PRODUCT_LOGO_CHANGED" : "PRODUCT_LOGO_CHUNK_INVALID";
      throw error;
    }
    const parts = [];
    for (let offset = 0; offset < bytes; offset += chunkSize) {
      const chunkLength = Math.min(chunkSize, bytes - offset);
      const data = await callProductReceiptRead({
        action: "getProductReceiptLogoData",
        productRef,
        expectedReference: reference,
        chunkOffset: offset,
        chunkLength
      }, "项目 LOGO 分块读取失败");
      const chunk = data.logo;
      if (!chunk || String(chunk.reference || "").trim() !== reference
          || Number(chunk.bytes) !== bytes || Number(chunk.chunkOffset) !== offset
          || Number(chunk.chunkBytes) !== chunkLength
          || canonicalBase64ByteLength(chunk.base64) !== chunkLength) {
        throw new Error("项目 LOGO 分块读取不完整");
      }
      parts.push(String(chunk.base64));
    }
    return validateProductLogoData({ reference, mimeType, bytes, base64: parts.join("") }, reference);
  }

  function rememberProductLogoData(cacheKeys, value) {
    const entry = {
      value: cloneProductLogoData(value),
      expiresAt: Date.now() + PRODUCT_LOGO_DATA_CACHE_TTL_MS,
      bytes: Number(value?.bytes || 0)
    };
    for (const key of new Set(cacheKeys.filter(Boolean))) {
      const previous = productLogoDataCache.get(key);
      if (previous) productLogoDataCacheBytes -= previous.bytes || 0;
      productLogoDataCache.delete(key);
      productLogoDataCache.set(key, entry);
      productLogoDataCacheBytes += entry.bytes;
    }
    while (productLogoDataCache.size > 4 || productLogoDataCacheBytes > 16 * 1024 * 1024) {
      const oldestKey = productLogoDataCache.keys().next().value;
      const oldest = productLogoDataCache.get(oldestKey);
      productLogoDataCache.delete(oldestKey);
      productLogoDataCacheBytes -= oldest?.bytes || 0;
    }
  }

  function smsStateKey(phone) { return `lusizhuoerSmsState:${phone}`; }
  function readSmsState(phone) {
    try { return JSON.parse(localStorage.getItem(smsStateKey(phone)) || "{}"); } catch (_) { return {}; }
  }
  function writeSmsState(phone, state) {
    localStorage.setItem(smsStateKey(phone), JSON.stringify(state));
  }
  function cooldownRemaining(phone) {
    const state = readSmsState(normalizePhone(phone));
    return Math.max(0, Math.ceil((Number(state.lastSentAt || 0) + SMS_COOLDOWN_MS - Date.now()) / 1000));
  }

  function announceAuthEvent(type, session = null) {
    // Content may be reused only inside the current in-memory session. Never
    // retain a template or private-logo byte result across an auth transition.
    clearProductReceiptCaches();
    const state = {
      type,
      uid: String(session?.cloudbaseUserId || ""),
      role: String(session?.role || ""),
      store: String(session?.store || ""),
      sessionId: String(session?.sessionId || ""),
      occurredAt: Date.now()
    };
    try {
      if (type === "SIGNED_IN") localStorage.setItem(AUTH_STATE_KEY, JSON.stringify(state));
      else localStorage.removeItem(AUTH_STATE_KEY);
    } catch (_) { /* storage may be unavailable */ }
    if (typeof window.BroadcastChannel !== "function") return;
    const channel = new BroadcastChannel(AUTH_CHANNEL_NAME);
    try {
      channel.postMessage(state);
    } finally {
      channel.close();
    }
  }

  function sessionChanged(message) {
    const error = new Error(message);
    error.code = "AUTH_SESSION_CHANGED";
    return error;
  }

  window.CloudBasePhoneAuth = {
    async sendCode(phone) {
      const normalizedPhone = normalizePhone(phone);
      const state = readSmsState(normalizedPhone);
      const remaining = cooldownRemaining(normalizedPhone);
      if (remaining > 0) throw new Error(`验证码已发送，请 ${remaining} 秒后再试`);
      const result = await getAuth().signInWithOtp({
        phone: normalizedPhone,
        options: { shouldCreateUser: false }
      });
      const data = authResponseData(result, "验证码发送失败");
      verifyOtp = data.verifyOtp;
      if (!verifyOtp) throw new Error("验证码服务未返回验证会话");
      writeSmsState(normalizedPhone, { lastSentAt: Date.now() });
    },
    async signInWithCode(code) {
      if (!verifyOtp) throw new Error("请先获取短信验证码");
      const result = await verifyOtp({ token: String(code || "").trim() });
      return authResponseData(result, "验证码无效或已过期");
    },
    async signInWithPassword(phone, password) {
      const result = await getAuth().signInWithPassword({ phone: normalizePhone(phone), password });
      return authResponseData(result, "手机号或密码错误");
    },
    async getStaffSession() {
      const data = await callStaffAccount(
        { action: "session" },
        "当前登录身份尚未绑定业务账号"
      );
      if (!data?.profile?.role) throw new Error("当前登录身份尚未绑定业务账号");
      return data;
    },
    async validateWorkspaceSession(expectedSession) {
      const expected = expectedSession && typeof expectedSession === "object" ? expectedSession : {};
      if (!expected.cloudbaseUserId || !expected.role) {
        throw sessionChanged("当前页面登录信息不完整，请重新登录");
      }
      const data = await this.getStaffSession();
      const profile = data?.profile || {};
      const currentUid = String(data?.uid || "");
      const expectedUid = String(expected.cloudbaseUserId || "");
      const currentRole = String(profile.role || "").toLowerCase();
      const expectedRole = String(expected.role || "").toLowerCase();
      const currentStore = String(profile.storeId || "");
      const expectedStore = String(expected.store || "");
      if (!currentUid || currentUid !== expectedUid) {
        throw sessionChanged("此浏览器已经切换到另一个登录账号");
      }
      if (!currentRole || currentRole !== expectedRole) {
        throw sessionChanged("当前云端账号身份与本页面不一致");
      }
      if (expectedRole === "store" && (!currentStore || currentStore !== expectedStore)) {
        throw sessionChanged("当前门店账号与本页面门店不一致");
      }
      return data;
    },
    announceWorkspaceSession(session) {
      announceAuthEvent("SIGNED_IN", session);
    },
    announceAuthenticationChanged() {
      announceAuthEvent("AUTH_CHANGED");
    },
    async signOut() {
      try {
        const result = await getAuth().signOut();
        if (result?.error) throw new Error(result.error.message || "退出登录失败");
      } finally {
        announceAuthEvent("SIGNED_OUT");
      }
    },
    async bootstrapHq() {
      return callStaffAccount({ action: "bootstrapHq" }, "总部初始化未获授权");
    },
    async provisionStaff({ staffName, phone, role, initialPassword, storeId = "" }) {
      return callStaffAccount(
        { action: "provisionStaff", staffName, phone: normalizePhone(phone), role, initialPassword, storeId },
        "员工账号创建失败"
      );
    },
    async createTeacher({ staffName, phone, initialPassword, clientRequestId }) {
      const request = callTeacherCreate(
        {
          action: "createTeacher",
          staffName,
          phone: normalizePhone(phone),
          initialPassword,
          clientRequestId
        },
        "老师账号创建失败"
      );
      return promiseWithWatchdog(request, "老师账号创建失败", TEACHER_CREATE_WATCHDOG_MS);
    },
    async createStoreWithAccount({ storeName, province, city, district, addressDetail, contactName, contactPhone, initialPassword, existingStoreId = "" }) {
      return callStaffAccount(
        {
          action: "createStoreWithAccount",
          storeName,
          province,
          city,
          district,
          addressDetail,
          contactName,
          contactPhone: normalizePhone(contactPhone),
          initialPassword,
          existingStoreId
        },
        "门店与登录账号创建失败"
      );
    },
    async changeOwnPassword(newPassword) {
      return callStaffAccount({ action: "changeOwnPassword", newPassword }, "密码修改失败");
    },
    async resetStaffPassword({ uid, newPassword }) {
      return callStaffAccount({ action: "resetPassword", uid, newPassword }, "密码重置失败");
    },
    async setStaffStatus({ uid = "", phone = "", status }) {
      return callStaffAccount({ action: "setStaffStatus", uid, phone, status }, "人员状态更新失败");
    },
    // Deliberately not linked from the product UI. An HQ administrator runs
    // this once from an authenticated browser session while retiring the
    // legacy operation role; retries are safe if CloudBase blocks only part
    // of the credential batch.
    async retireOperationAccounts() {
      return callStaffAccount(
        { action: "retireOperationAccounts" },
        "运营账号下线失败"
      );
    },
    async setMasterStatus({ teacherId = "", storeId = "", status }) {
      return callStaffAccount(
        { action: "setMasterStatus", teacherId, storeId, status },
        storeId ? "门店状态更新失败" : "老师状态更新失败"
      );
    },
    async listStaff(role) {
      const data = await callStaffAccount({ action: "listStaff", role }, "人员列表读取失败");
      return data.staff || [];
    },
    async getTeacherExperienceEntitlements({ teacherId }) {
      return callStaffAccount(
        { action: "getTeacherExperienceEntitlements", teacherId },
        "老师体验额度读取失败"
      );
    },
    async upsertTeacherExperienceEntitlement({ teacherId, productId, monthlyAllowance }) {
      return callStaffAccount(
        { action: "upsertTeacherExperienceEntitlement", teacherId, productId, monthlyAllowance },
        "老师体验额度配置失败"
      );
    },
    async deleteTeacherExperienceEntitlement({ teacherId, productId }) {
      return callStaffAccount(
        { action: "deleteTeacherExperienceEntitlement", teacherId, productId },
        "老师体验额度删除失败"
      );
    },
    async rechargeTeacherExperienceEntitlement({ teacherId, productId, unitCount, note = "", clientRequestId }) {
      return callStaffAccount(
        { action: "rechargeTeacherExperienceEntitlement", teacherId, productId, unitCount, note, clientRequestId },
        "老师体验次数充值失败"
      );
    },
    async listStores() {
      const data = await callStaffAccount({ action: "listStores" }, "门店列表读取失败");
      return data.stores || [];
    },
    async getHqDashboard({ startDate, endDate, mode = "overview", dimension, rankingMetric, productId, pageNumber, pageSize } = {}) {
      return callStaffAccount(
        { action: "getHqDashboard", startDate, endDate, mode, dimension, rankingMetric, productId, pageNumber, pageSize },
        "总部首页数据库统计读取失败"
      );
    },
    async createProduct({ productName, productType, description = "", clientRequestId = "" }) {
      return callStaffAccount(
        { action: "createProduct", productName, productType, description, clientRequestId },
        "项目创建失败"
      );
    },
    async listProducts() {
      const data = await callStaffAccount({ action: "listProducts" }, "项目列表读取失败");
      return data.products || [];
    },
    async listRetailProducts() {
      const data = await callStaffAccount({ action: "listRetailProducts" }, "产品列表读取失败");
      return data.products || [];
    },
    async createRetailProduct({ productName, clientRequestId = "" }) {
      return callStaffAccount(
        { action: "createRetailProduct", productName, clientRequestId },
        "产品创建失败"
      );
    },
    async setRetailProductStatus({ productRef, status }) {
      return callStaffAccount(
        { action: "setRetailProductStatus", productRef, status },
        "产品状态更新失败"
      );
    },
    async setProductStatus({ productRef, status }) {
      const data = await callStaffAccount(
        { action: "setProductStatus", productRef, status },
        "项目状态更新失败"
      );
      clearProductReceiptCaches();
      return data;
    },
    async getProductReceiptTemplate({ productRef, forceRefresh = false, allowCached = false }) {
      const key = productReceiptRefKey(productRef);
      if (!key) throw new Error("缺少项目编号");
      // Receipt exports require the latest database instructions. Persistent
      // template entries are therefore metadata for logo-keying unless a
      // caller explicitly opts into a short-lived cached template.
      if (allowCached && !forceRefresh) {
        const cached = cachedProductTemplate(productRef);
        if (cached) return cached;
      }
      const flightKey = `${key}\n${forceRefresh ? "refresh" : "normal"}`;
      const existing = productTemplateFlights.get(flightKey);
      if (existing) return existing;
      const generation = productReceiptCacheGeneration;
      const flight = callProductReceiptRead(
        { action: "getProductReceiptTemplate", productRef },
        "项目单据模板读取失败"
      ).then((data) => {
        const value = data.template || null;
        if (generation === productReceiptCacheGeneration) rememberProductTemplate(productRef, value);
        return cloneProductTemplate(value);
      }).finally(() => {
        if (productTemplateFlights.get(flightKey) === flight) productTemplateFlights.delete(flightKey);
      });
      productTemplateFlights.set(flightKey, flight);
      return flight;
    },
    async beginProductLogoUpload({ productRef, originalName, mimeType, bytes, width, height }) {
      return callStaffAccount(
        { action: "beginProductLogoUpload", productRef, originalName, mimeType, bytes, width, height },
        "项目 LOGO 上传准备失败"
      );
    },
    async uploadProductLogoByFunction({ productRef, originalName, mimeType, bytes, width, height, imageBase64 }) {
      const data = await callStaffAccount(
        { action: "uploadProductLogoByFunction", productRef, originalName, mimeType, bytes, width, height, imageBase64 },
        "项目 LOGO 安全备用上传失败"
      );
      clearProductReceiptCaches();
      rememberProductTemplate(productRef, data.template);
      return cloneProductTemplate(data.template || null);
    },
    async confirmProductLogoUpload({ productRef, reference, originalName, mimeType, bytes, width, height }) {
      const data = await callStaffAccount(
        { action: "confirmProductLogoUpload", productRef, reference, originalName, mimeType, bytes, width, height },
        "项目 LOGO 保存确认失败"
      );
      clearProductReceiptCaches();
      rememberProductTemplate(productRef, data.template);
      return cloneProductTemplate(data.template || null);
    },
    async discardProductLogoUpload({ productRef, reference }) {
      return callStaffAccount(
        { action: "discardProductLogoUpload", productRef, reference },
        "项目 LOGO 未绑定文件清理失败"
      );
    },
    async saveProductReceiptTemplate({ productRef, verificationInstructions, rechargeInstructions }) {
      const data = await callStaffAccount(
        { action: "saveProductReceiptTemplate", productRef, verificationInstructions, rechargeInstructions },
        "项目单据模板保存失败"
      );
      clearProductReceiptCaches();
      rememberProductTemplate(productRef, data.template);
      return cloneProductTemplate(data.template || null);
    },
    async removeProductReceiptLogo({ productRef }) {
      const data = await callStaffAccount(
        { action: "removeProductReceiptLogo", productRef },
        "项目 LOGO 移除失败"
      );
      clearProductReceiptCaches();
      rememberProductTemplate(productRef, data.template);
      return cloneProductTemplate(data.template || null);
    },
    async getProductReceiptLogoData({ productRef, expectedReference = "", forceRefresh = false }) {
      const productKey = productReceiptRefKey(productRef);
      if (!productKey) throw new Error("缺少项目编号");
      const reference = expectedProductLogoReference(productRef, expectedReference);
      const cacheKey = `${productKey}\n${reference}`;
      if (!forceRefresh) {
        const cached = productLogoDataCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
          productLogoDataCache.delete(cacheKey);
          productLogoDataCache.set(cacheKey, cached);
          return cloneProductLogoData(cached.value);
        }
        if (cached) {
          productLogoDataCache.delete(cacheKey);
          productLogoDataCacheBytes -= cached.bytes || 0;
        }
      }
      const flightKey = `${cacheKey}\n${forceRefresh ? "refresh" : "normal"}`;
      const existing = productLogoDataFlights.get(flightKey);
      if (existing) return existing;
      const generation = productReceiptCacheGeneration;
      const flight = callProductReceiptRead(
        { action: "getProductReceiptLogoData", productRef, expectedReference: reference },
        "项目 LOGO 原图读取失败"
      ).then(async (data) => {
        const initial = data.logo || null;
        const value = initial?.chunked && !initial?.base64
          ? await completeChunkedProductLogo(productRef, reference, initial)
          : validateProductLogoData(initial, reference);
        const returnedReference = String(value.reference || "").trim();
        if (generation === productReceiptCacheGeneration) {
          rememberProductLogoData([
            cacheKey,
            returnedReference ? `${productKey}\n${returnedReference}` : ""
          ], value);
        }
        return cloneProductLogoData(value);
      }).finally(() => {
        if (productLogoDataFlights.get(flightKey) === flight) productLogoDataFlights.delete(flightKey);
      });
      productLogoDataFlights.set(flightKey, flight);
      return flight;
    },
    async requestOrderVoid({ recordType, recordId, note }) {
      return callStaffAccount(
        { action: "requestOrderVoid", recordType, recordId, note },
        "作废申请提交失败"
      );
    },
    async listReviewOrders({ recordType, recordId = "", recordCode = "", storeId = "", applicationType = "", status = "", limit = 200, paged = false, detailRead = false, cursor = null, pageNumber = null } = {}) {
      const payload = { action: "listReviewOrders", recordType, recordId, recordCode, storeId, applicationType, status, limit, paged, detailRead };
      if (pageNumber !== null && pageNumber !== undefined && String(pageNumber).trim() !== "") payload.pageNumber = pageNumber;
      if (cursor) {
        payload.cursorPending = cursor.pending;
        payload.cursorApplicationTime = cursor.applicationTime || "";
        payload.cursorId = cursor.id || "";
      }
      const data = await callStaffAccount(
        payload,
        "审核工单读取失败"
      );
      return paged
        ? {
          orders: data.orders || [],
          hasMore: data.hasMore === true,
          nextCursor: data.nextCursor || null,
          stores: data.stores || [],
          total: Number(data.total || 0),
          pageNumber: Number(data.pageNumber || 0),
          pageSize: Number(data.pageSize || 0),
          totalPages: Number(data.totalPages || 0)
        }
        : data.orders || [];
    },
    async reviewOrder({ recordType, recordId, decision, note }) {
      return callStaffAccount(
        { action: "reviewOrder", recordType, recordId, decision, note },
        "工单审核失败"
      );
    },
    async listRetailProductPurchaseReviews({ purchaseCode = "", storeId = "", status = "", limit = 100, pageNumber = 1 } = {}) {
      const data = await callStaffAccount(
        { action: "listRetailProductPurchaseReviews", purchaseCode, storeId, status, limit, pageNumber },
        "产品购买审核记录读取失败"
      );
      return { ...data, orders: data.orders || [], stores: data.stores || [] };
    },
    async reviewRetailProductPurchase({ recordId, decision, note }) {
      return callStaffAccount(
        { action: "reviewRetailProductPurchase", recordId, decision, note },
        "产品购买单审核失败"
      );
    },
    smsCooldownRemaining(phone) { return cooldownRemaining(phone); }
  };
})();
