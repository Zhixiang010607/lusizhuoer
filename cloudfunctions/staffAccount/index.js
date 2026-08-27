"use strict";

const crypto = require("node:crypto");

/*
 * 员工账号云函数
 * CloudBase 身份认证只负责手机号、密码和验证码。
 * 业务身份只保存在 PostgreSQL 的 public.staff_accounts 表，绝不写入 user_desc JSON。
 */
const ROLES = new Set(["hq", "store", "teacher"]);
// Change this whenever the function contract changes. It is intentionally
// non-sensitive and lets the CloudBase console confirm the deployed source.
const FUNCTION_VERSION = "v79";
// Keep every synchronous dashboard response well below CloudBase's 6 MB
// response-body limit.  The overview returns summary metrics and these small
// chart samples; the ranking endpoint returns one bounded page at a time.
const HQ_DASHBOARD_CHART_LIMIT = 10;
const HQ_DASHBOARD_DEFAULT_PAGE_SIZE = 100;
const HQ_DASHBOARD_MAX_PAGE_SIZE = 500;
const HQ_DASHBOARD_MAX_PAGE_NUMBER = 10000;
const ORDER_VOID_APPLICATIONS_ENABLED = false;
const TEACHER_EXPERIENCE_RESET_TIMER_TRIGGER_NAME = "reset-teacher-experience-quotas-monthly";
const PRODUCT_LOGO_MAX_BYTES = 8 * 1024 * 1024;
// Base64 expands bytes by roughly one third and synchronous cloud-function
// events have a much smaller payload ceiling than the signed PUT channel.
// Keep the normal 8 MB direct-upload contract, but bound the authenticated
// function fallback so the complete request remains below that ceiling.
const PRODUCT_LOGO_FUNCTION_MAX_BYTES = 3 * 1024 * 1024;
const PRODUCT_LOGO_DOWNLOAD_CACHE_TTL_MS = 5 * 60 * 1000;
const PRODUCT_LOGO_DOWNLOAD_CACHE_MAX_ENTRIES = 8;
const PRODUCT_LOGO_CHUNK_BYTES = 1536 * 1024;
const PRODUCT_LOGO_DOWNLOAD_RETRY_DELAYS_MS = Object.freeze([80, 240]);
const PRODUCT_LOGO_SIGN_SAFETY_MS = 30 * 1000;
const PRODUCT_LOGO_STORAGE_MAX_CONCURRENCY = 6;
const PRODUCT_LOGO_TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"]
]);
let app = null;
let auth = null;
let managerClient = null;
let storeBindingLayout = null;
let storeCreationCapabilities = null;
let productTemplateCapabilities = null;
let retailProductCapabilities = null;
let rechargeProductGiftSchemaReady = null;
const productLogoDownloadCache = new Map();
const productLogoDownloadFlights = new Map();
const productLogoSignCache = new Map();
const productLogoSignFlights = new Map();
let productLogoDownloadCacheBytes = 0;
let productLogoStorageActive = 0;
const productLogoStorageQueue = [];

function getApp() {
  if (!app) {
    const cloudbase = require("@cloudbase/node-sdk");
    app = cloudbase.init({});
  }
  return app;
}

function getAuth() {
  if (!auth) auth = getApp().auth();
  return auth;
}

function manager() {
  if (!managerClient) {
    const CloudBaseManager = require("@cloudbase/manager-node");
    managerClient = CloudBaseManager.init({
      envId: process.env.CLOUDBASE_ENV_ID || process.env.TCB_ENV
    });
  }
  return managerClient;
}

function productTemplateStorageSettings() {
  const envId = String(process.env.CLOUDBASE_ENV_ID || process.env.TCB_ENV || "").trim();
  const accessToken = String(process.env.CLOUDBASE_APIKEY || process.env.CLOUDBASE_SERVICE_ROLE_KEY || "").trim();
  const bucketId = String(process.env.PRODUCT_TEMPLATE_BUCKET_ID || "product-templates").trim();
  if (!envId) fail("项目模板存储缺少 CLOUDBASE_ENV_ID 或 TCB_ENV", "PRODUCT_STORAGE_NOT_CONFIGURED");
  if (!accessToken) fail("项目模板存储缺少 CLOUDBASE_APIKEY", "PRODUCT_STORAGE_NOT_CONFIGURED");
  if (!bucketId) fail("项目模板私有存储桶编号不能为空", "PRODUCT_STORAGE_NOT_CONFIGURED");
  return { envId, accessToken, bucketId };
}

function nestedString(value, keyPattern, validator, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = nestedString(item, keyPattern, validator, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (typeof value !== "object") return "";
  for (const [key, item] of Object.entries(value)) {
    if (keyPattern.test(key) && validator(item)) return String(item).trim();
  }
  for (const item of Object.values(value)) {
    const found = nestedString(item, keyPattern, validator, depth + 1);
    if (found) return found;
  }
  return "";
}

function signedStorageUrl(value) {
  return nestedString(value, /^(?:url|signedurl|fullsignedurl|uploadurl)$/i,
    (item) => typeof item === "string" && /^https:\/\//i.test(item.trim()));
}

function safeResponseShape(value, depth = 0) {
  if (depth > 2 || value === null || value === undefined) return typeof value;
  if (Array.isArray(value)) return value.slice(0, 2).map((item) => safeResponseShape(item, depth + 1));
  if (typeof value !== "object") return typeof value;
  return Object.fromEntries(Object.entries(value).slice(0, 24)
    .map(([key, item]) => [key, safeResponseShape(item, depth + 1)]));
}

function signedStorageUrlScheme(value) {
  const candidate = nestedString(value, /^(?:url|signedurl|fullsignedurl|uploadurl)$/i,
    (item) => typeof item === "string" && item.trim().length > 0);
  if (!candidate) return "missing";
  try { return new URL(candidate).protocol.replace(/:$/, "").toLowerCase() || "missing"; }
  catch (_) { return candidate.startsWith("/") ? "relative" : "invalid"; }
}

function canonicalProductLogoUploadUrl(storage, objectName, token) {
  if (!token) return "";
  const bucket = encodeURIComponent(storage.bucketId);
  const objectPath = String(objectName).split("/").map((part) => encodeURIComponent(part)).join("/");
  const target = new URL(`https://${storage.envId}.api.tcloudbasegateway.com/v1/storages/object/upload/sign/${bucket}/${objectPath}`);
  target.searchParams.set("token", token);
  return target.toString();
}

function signedStorageUpload(response, storage, objectName, contentType) {
  const token = nestedString(response, /^(?:token|uploadtoken|signaturetoken)$/i,
    (item) => typeof item === "string" && item.trim().length > 0);
  // manager-node's own uploadObjectBySign implementation rebuilds this same
  // public gateway URL from env/bucket/object/token. Prefer that canonical
  // HTTPS target so an internal or relative URL returned by the signing
  // endpoint is never handed to the browser.
  let url = canonicalProductLogoUploadUrl(storage, objectName, token) || signedStorageUrl(response);
  if (!url) {
    console.error("CloudBase product-logo signed upload response is unusable", {
      bucketId: storage.bucketId,
      objectName,
      responseShape: safeResponseShape(response),
      urlScheme: signedStorageUrlScheme(response),
      tokenPresent: Boolean(token)
    });
    fail("项目 LOGO 上传地址生成失败", "PRODUCT_LOGO_UPLOAD_SIGN_FAILED");
  }
  if (token && !new URL(url).searchParams.get("token")) {
    const target = new URL(url);
    target.searchParams.set("token", token);
    url = target.toString();
  }
  return {
    url,
    bucketId: storage.bucketId,
    objectName,
    method: "PUT",
    contentType,
    headers: { "Content-Type": contentType }
  };
}

function parseProductLogoReference(value) {
  const reference = String(value || "").trim();
  if (!reference.startsWith("pg://")) fail("项目 LOGO 存储引用无效", "PRODUCT_LOGO_REFERENCE_INVALID");
  const path = reference.slice(5);
  const slash = path.indexOf("/");
  if (slash < 1 || slash === path.length - 1) fail("项目 LOGO 存储引用无效", "PRODUCT_LOGO_REFERENCE_INVALID");
  return { bucketId: path.slice(0, slash), objectName: path.slice(slash + 1), reference };
}

function storageObjectInfo(value, depth = 0) {
  if (depth > 5 || !value || typeof value !== "object") return null;
  if (!Array.isArray(value) && (
    Object.prototype.hasOwnProperty.call(value, "size")
    || Object.prototype.hasOwnProperty.call(value, "content_type")
    || Object.prototype.hasOwnProperty.call(value, "bucket_id")
  )) return value;
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    const found = storageObjectInfo(item, depth + 1);
    if (found) return found;
  }
  return null;
}

function storageUploadResponseMismatch(error) {
  const detail = String(error?.message || "");
  return detail.includes("上传成功但响应格式异常")
    && detail.includes("Id")
    && detail.includes("Key");
}

function productLogoStorageError(message, code, cause, context = {}) {
  const causeDetails = cloudErrorDetails(cause);
  const requestId = requestIdFrom(cause);
  console.error("CloudBase product-logo storage operation failed", {
    operation: context.operation,
    bucketId: context.bucketId,
    objectName: context.objectName,
    code: causeDetails.code || undefined,
    requestId: requestId || undefined,
    message: causeDetails.message || undefined
  });
  const error = new Error(message);
  error.code = code;
  error.requestId = requestId || undefined;
  error.causeCode = causeDetails.code || undefined;
  error.causeMessage = causeDetails.message || undefined;
  return error;
}

function productLogoTransientStorageError(error) {
  const details = cloudErrorDetails(error);
  const code = String(details.code || "").trim().toUpperCase();
  const message = String(details.message || error?.message || "").trim().toUpperCase();
  const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
  return code === "PRODUCT_LOGO_DOWNLOAD_TRUNCATED" || status === 429 || status >= 500
    || /(?:^|[^A-Z])(INTERNALERROR|INTERNAL_ERROR|HTTP_429|HTTP_5\d\d|TOOMANYREQUESTS|TOO_MANY_REQUESTS|THROTTL|TIMEOUT|TIMEDOUT|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|UND_ERR|FETCH FAILED|NETWORK)(?:[^A-Z]|$)/.test(`${code} ${message}`);
}

function productLogoReadDelay(milliseconds) {
  const jitter = Math.floor(Math.random() * Math.max(1, Math.floor(milliseconds / 4)));
  return new Promise((resolve) => setTimeout(resolve, milliseconds + jitter));
}

async function withProductLogoStorageSlot(task) {
  if (productLogoStorageActive >= PRODUCT_LOGO_STORAGE_MAX_CONCURRENCY) {
    await new Promise((resolve) => productLogoStorageQueue.push(resolve));
  }
  productLogoStorageActive += 1;
  try {
    return await task();
  } finally {
    productLogoStorageActive -= 1;
    productLogoStorageQueue.shift()?.();
  }
}

async function retryProductLogoStorage(operation, task) {
  let attempt = 0;
  while (true) {
    try {
      return await withProductLogoStorageSlot(() => task(attempt + 1));
    } catch (error) {
      const retryable = productLogoTransientStorageError(error);
      if (!retryable || attempt >= PRODUCT_LOGO_DOWNLOAD_RETRY_DELAYS_MS.length) throw error;
      const cause = cloudErrorDetails(error);
      console.warn("CloudBase product-logo transient storage read will retry", {
        operation,
        attempt: attempt + 1,
        code: cause.code || undefined,
        requestId: requestIdFrom(error) || undefined
      });
      await productLogoReadDelay(PRODUCT_LOGO_DOWNLOAD_RETRY_DELAYS_MS[attempt]);
      attempt += 1;
    }
  }
}

async function productLogoResponseBuffer(response, maximumBytes, expectedRange = null) {
  const status = Number(response?.status || 0);
  const declaredBytes = Number(response?.headers?.["content-length"] || 0);
  const validStatus = expectedRange ? status === 206 : status === 200;
  if (!validStatus || !response?.body) {
    const error = new Error(`项目 LOGO 存储响应无效（HTTP ${status || "未知"}）`);
    error.code = status ? `HTTP_${status}` : "PRODUCT_LOGO_DOWNLOAD_RESPONSE_INVALID";
    error.status = status || undefined;
    throw error;
  }
  if (expectedRange) {
    const expectedLength = expectedRange.end - expectedRange.start + 1;
    const contentRange = String(response?.headers?.["content-range"] || "").trim();
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange);
    if (!match || Number(match[1]) !== expectedRange.start
        || Number(match[2]) !== expectedRange.end || Number(match[3]) !== expectedRange.total
        || (declaredBytes > 0 && declaredBytes !== expectedLength)) {
      response.body.destroy?.();
      const error = new Error("项目 LOGO 分块响应范围无效");
      error.code = "PRODUCT_LOGO_RANGE_MISMATCH";
      throw error;
    }
  }
  if (Number.isFinite(declaredBytes) && declaredBytes > maximumBytes) {
    response.body.destroy?.();
    fail("项目 LOGO 超过允许的读取大小", "PRODUCT_LOGO_TOO_LARGE");
  }
  const chunks = [];
  let total = 0;
  try {
    const source = Buffer.isBuffer(response.body) ? [response.body] : response.body;
    for await (const chunk of source) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maximumBytes) {
        response.body.destroy?.();
        fail("项目 LOGO 超过允许的读取大小", "PRODUCT_LOGO_TOO_LARGE");
      }
      chunks.push(buffer);
    }
  } catch (error) {
    response.body.destroy?.();
    throw error;
  }
  const output = Buffer.concat(chunks);
  if (!output.length) fail("项目 LOGO 文件为空", "PRODUCT_LOGO_UPLOAD_INCOMPLETE");
  if (declaredBytes > 0 && output.length !== declaredBytes) {
    const error = new Error("项目 LOGO 下载流长度与响应头不一致");
    error.code = "PRODUCT_LOGO_DOWNLOAD_TRUNCATED";
    throw error;
  }
  if (expectedRange && output.length !== expectedRange.end - expectedRange.start + 1) {
    const error = new Error("项目 LOGO 分块下载长度不完整");
    error.code = "PRODUCT_LOGO_DOWNLOAD_TRUNCATED";
    throw error;
  }
  return output;
}

function productLogoSignedToken(urlValue, storage) {
  try {
    const url = new URL(String(urlValue || ""));
    if (url.protocol !== "https:" || url.hostname !== `${storage.envId}.api.tcloudbasegateway.com`) return "";
    const token = String(url.searchParams.get("token") || "");
    return token && token.length <= 8192 ? token : "";
  } catch (_) {
    return "";
  }
}

async function fetchSignedProductLogoRange(url, range, maximumBytes, expectedRange) {
  if (typeof fetch !== "function") {
    const error = new Error("当前运行时不支持安全分块读取");
    error.code = "PRODUCT_LOGO_RANGE_UNSUPPORTED";
    throw error;
  }
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeout = setTimeout(() => controller?.abort(), 15000);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Range: range },
      redirect: "error",
      signal: controller?.signal
    });
    const headers = {};
    response.headers?.forEach?.((value, key) => { headers[String(key).toLowerCase()] = value; });
    return await productLogoResponseBuffer(
      { status: response.status, headers, body: response.body },
      maximumBytes,
      expectedRange
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function downloadProductLogoUncached(reference, storage, maximumBytes, options = {}) {
  const range = String(options.range || "").trim();
  const expectedRange = options.expectedRange || null;
  let authenticatedError = null;
  try {
    return await retryProductLogoStorage("downloadAuthenticatedObject", async () => {
      const response = await manager().storage.downloadAuthenticatedObject({
        bucketId: reference.bucketId,
        objectName: reference.objectName,
        method: "GET",
        range: range || undefined,
        accessToken: storage.accessToken,
        envId: storage.envId
      });
      return productLogoResponseBuffer(response, maximumBytes, expectedRange);
    });
  } catch (error) {
    if (["PRODUCT_LOGO_TOO_LARGE", "PRODUCT_LOGO_UPLOAD_INCOMPLETE"].includes(error?.code)) throw error;
    authenticatedError = error;
    const cause = cloudErrorDetails(error);
    console.warn("CloudBase product-logo authenticated read unavailable; trying signed read", {
      bucketId: reference.bucketId,
      objectName: reference.objectName,
      code: cause.code || undefined,
      requestId: requestIdFrom(error) || undefined
    });
  }

  try {
    const signed = await signProductLogo(reference.reference, 900);
    const token = productLogoSignedToken(signed.url, storage);
    if (!token) fail("项目 LOGO 签名读取令牌无效", "PRODUCT_LOGO_SIGN_FAILED");
    return await retryProductLogoStorage(range ? "downloadSignedRange" : "downloadObjectBySign", async () => {
      if (range) return fetchSignedProductLogoRange(signed.url, range, maximumBytes, expectedRange);
      const response = await manager().storage.downloadObjectBySign({
        bucketId: reference.bucketId,
        objectName: reference.objectName,
        token,
        method: "GET",
        envId: storage.envId
      });
      return productLogoResponseBuffer(response, maximumBytes, expectedRange);
    });
  } catch (signedError) {
    const primary = cloudErrorDetails(authenticatedError);
    const secondary = cloudErrorDetails(signedError);
    console.error("CloudBase product-logo read channels exhausted", {
      bucketId: reference.bucketId,
      objectName: reference.objectName,
      authenticatedCode: primary.code || undefined,
      authenticatedRequestId: requestIdFrom(authenticatedError) || undefined,
      signedCode: secondary.code || undefined,
      signedRequestId: requestIdFrom(signedError) || undefined
    });
    throw productLogoStorageError(
      "项目 LOGO 原图读取失败，请稍后重试",
      "PRODUCT_LOGO_DOWNLOAD_FAILED",
      signedError,
      { operation: "downloadProductLogo", bucketId: reference.bucketId, objectName: reference.objectName }
    );
  }
}

function cachedProductLogo(referenceValue, maximumBytes) {
  const entry = productLogoDownloadCache.get(referenceValue);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    productLogoDownloadCache.delete(referenceValue);
    productLogoDownloadCacheBytes -= entry.buffer.length;
    return null;
  }
  if (entry.buffer.length > maximumBytes) fail("项目 LOGO 超过允许的读取大小", "PRODUCT_LOGO_TOO_LARGE");
  productLogoDownloadCache.delete(referenceValue);
  productLogoDownloadCache.set(referenceValue, entry);
  return entry.buffer;
}

function cacheProductLogo(referenceValue, buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > PRODUCT_LOGO_FUNCTION_MAX_BYTES) return;
  const previous = productLogoDownloadCache.get(referenceValue);
  if (previous) productLogoDownloadCacheBytes -= previous.buffer.length;
  productLogoDownloadCache.delete(referenceValue);
  productLogoDownloadCache.set(referenceValue, {
    buffer,
    expiresAt: Date.now() + PRODUCT_LOGO_DOWNLOAD_CACHE_TTL_MS
  });
  productLogoDownloadCacheBytes += buffer.length;
  while (productLogoDownloadCache.size > PRODUCT_LOGO_DOWNLOAD_CACHE_MAX_ENTRIES
      || productLogoDownloadCacheBytes > PRODUCT_LOGO_FUNCTION_MAX_BYTES * PRODUCT_LOGO_DOWNLOAD_CACHE_MAX_ENTRIES) {
    const oldestKey = productLogoDownloadCache.keys().next().value;
    const oldest = productLogoDownloadCache.get(oldestKey);
    productLogoDownloadCache.delete(oldestKey);
    productLogoDownloadCacheBytes -= oldest?.buffer?.length || 0;
  }
}

function evictCachedProductLogo(referenceValue) {
  const reference = String(referenceValue || "").trim();
  const entry = productLogoDownloadCache.get(reference);
  if (!entry) return;
  productLogoDownloadCache.delete(reference);
  productLogoDownloadCacheBytes -= entry.buffer.length;
}

function evictProductLogoServerCaches(referenceValue) {
  const reference = String(referenceValue || "").trim();
  evictCachedProductLogo(reference);
  for (const key of productLogoSignCache.keys()) {
    if (key.endsWith(`\n${reference}`)) productLogoSignCache.delete(key);
  }
}

async function downloadProductLogo(referenceValue, maximumBytes = PRODUCT_LOGO_MAX_BYTES, options = {}) {
  const reference = parseProductLogoReference(referenceValue);
  const storage = productTemplateStorageSettings();
  if (reference.bucketId !== storage.bucketId || !/^products\/\d+\/receipt-logo\//.test(reference.objectName)) {
    fail("项目 LOGO 不属于指定私有存储桶", "PRODUCT_LOGO_BUCKET_MISMATCH");
  }
  const useCache = options.cache === true;
  if (useCache) {
    const cached = cachedProductLogo(reference.reference, maximumBytes);
    if (cached) return cached;
  }
  const range = String(options.range || "").trim();
  const flightKey = `${reference.reference}\n${maximumBytes}\n${range}`;
  const existing = productLogoDownloadFlights.get(flightKey);
  if (existing) return existing;
  const flight = downloadProductLogoUncached(reference, storage, maximumBytes, options)
    .then((buffer) => {
      if (useCache) cacheProductLogo(reference.reference, buffer);
      return buffer;
    })
    .finally(() => productLogoDownloadFlights.delete(flightKey));
  productLogoDownloadFlights.set(flightKey, flight);
  return flight;
}

function productLogoMagicMatches(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  if (mimeType === "image/png") return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === "image/jpeg") return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mimeType === "image/webp") return buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP";
  return false;
}

function productLogoDimensions(buffer, mimeType) {
  let width = 0;
  let height = 0;
  if (mimeType === "image/png" && buffer.length >= 24
      && buffer.toString("ascii", 12, 16) === "IHDR") {
    width = buffer.readUInt32BE(16);
    height = buffer.readUInt32BE(20);
  } else if (mimeType === "image/jpeg") {
    const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let offset = 2;
    while (offset + 3 < buffer.length) {
      while (offset < buffer.length && buffer[offset] === 0xff) offset += 1;
      if (offset >= buffer.length) break;
      const marker = buffer[offset];
      offset += 1;
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > buffer.length) break;
      const segmentLength = buffer.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > buffer.length) break;
      if (startOfFrame.has(marker) && segmentLength >= 7) {
        height = buffer.readUInt16BE(offset + 3);
        width = buffer.readUInt16BE(offset + 5);
        break;
      }
      offset += segmentLength;
    }
  } else if (mimeType === "image/webp" && buffer.length >= 30) {
    const kind = buffer.toString("ascii", 12, 16);
    if (kind === "VP8X") {
      width = 1 + buffer.readUIntLE(24, 3);
      height = 1 + buffer.readUIntLE(27, 3);
    } else if (kind === "VP8L" && buffer[20] === 0x2f) {
      const packed = buffer.readUInt32LE(21);
      width = 1 + (packed & 0x3fff);
      height = 1 + ((packed >>> 14) & 0x3fff);
    } else if (kind === "VP8 "
        && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
      width = buffer.readUInt16LE(26) & 0x3fff;
      height = buffer.readUInt16LE(28) & 0x3fff;
    }
  }
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
      || width < 1 || height < 1 || width > 12000 || height > 12000) {
    fail("无法从项目 LOGO 原图确认图片尺寸", "PRODUCT_LOGO_DIMENSIONS_INVALID");
  }
  return { width, height };
}

function productLogoFunctionBuffer(event, input) {
  if (input.bytes > PRODUCT_LOGO_FUNCTION_MAX_BYTES) {
    fail("项目 LOGO 安全备用上传仅支持不超过 3 MB 的原图，请使用签名直传", "PRODUCT_LOGO_FUNCTION_TOO_LARGE");
  }
  const text = String(event.imageBase64 || "").trim();
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/i.exec(text);
  const base64 = match?.[2] || "";
  const canonicalBase64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (!match || String(match[1]).toLowerCase() !== input.mimeType
      || !base64 || !canonicalBase64.test(base64)
      || base64.length > Math.ceil(PRODUCT_LOGO_FUNCTION_MAX_BYTES / 3) * 4 + 4) {
    fail("项目 LOGO 备用上传内容格式无效", "PRODUCT_LOGO_BASE64_INVALID");
  }
  const buffer = Buffer.from(base64, "base64");
  if (buffer.toString("base64") !== base64) {
    fail("项目 LOGO 备用上传内容格式无效", "PRODUCT_LOGO_BASE64_INVALID");
  }
  if (buffer.length !== input.bytes) {
    fail("项目 LOGO 大小与上传前不一致", "PRODUCT_LOGO_SIZE_MISMATCH");
  }
  if (!buffer.length || buffer.length > PRODUCT_LOGO_FUNCTION_MAX_BYTES) {
    fail("项目 LOGO 安全备用上传仅支持不超过 3 MB 的原图", "PRODUCT_LOGO_FUNCTION_TOO_LARGE");
  }
  if (!productLogoMagicMatches(buffer, input.mimeType)) {
    fail("上传文件不是有效的项目 LOGO 图片", "PRODUCT_LOGO_FORMAT_INVALID");
  }
  const dimensions = productLogoDimensions(buffer, input.mimeType);
  if (dimensions.width !== input.width || dimensions.height !== input.height) {
    fail("项目 LOGO 尺寸与上传前不一致", "PRODUCT_LOGO_DIMENSIONS_MISMATCH");
  }
  return buffer;
}

async function inspectProductLogo(referenceValue, expected) {
  const reference = parseProductLogoReference(referenceValue);
  const storage = productTemplateStorageSettings();
  let response;
  try {
    response = await manager().storage.getObjectInfoAuthenticated({
      bucketId: reference.bucketId,
      objectName: reference.objectName,
      method: "GET",
      accessToken: storage.accessToken,
      envId: storage.envId
    });
  } catch (error) {
    fail(`项目 LOGO 尚未上传完成：${error?.message || "存储对象不存在"}`, "PRODUCT_LOGO_UPLOAD_INCOMPLETE");
  }
  const info = storageObjectInfo(response);
  if (!info) fail("无法确认项目 LOGO 上传结果", "PRODUCT_LOGO_INFO_INVALID");
  const bytes = Number(info.size ?? response?.headers?.["content-length"]);
  const contentType = String(info.content_type || response?.headers?.["content-type"] || "")
    .split(";", 1)[0].trim().toLowerCase();
  if (!Number.isSafeInteger(bytes) || bytes !== expected.bytes) {
    fail("项目 LOGO 大小与上传前不一致", "PRODUCT_LOGO_SIZE_MISMATCH");
  }
  if (contentType && contentType !== expected.mimeType) {
    fail("项目 LOGO 类型与上传前不一致", "PRODUCT_LOGO_TYPE_MISMATCH");
  }
  const buffer = await downloadProductLogo(reference.reference);
  if (buffer.length !== bytes || !productLogoMagicMatches(buffer, expected.mimeType)) {
    fail("上传文件不是有效的项目 LOGO 图片", "PRODUCT_LOGO_FORMAT_INVALID");
  }
  const dimensions = productLogoDimensions(buffer, expected.mimeType);
  if (dimensions.width !== expected.width || dimensions.height !== expected.height) {
    fail("项目 LOGO 尺寸与上传前不一致", "PRODUCT_LOGO_DIMENSIONS_MISMATCH");
  }
  return { bytes, sha256: crypto.createHash("sha256").update(buffer).digest("hex") };
}

function validatedProductLogoSignedUrl(value, storage, reference) {
  const candidate = signedStorageUrl(value);
  if (!candidate) return "";
  try {
    const target = new URL(candidate);
    const expectedPath = `/v1/storages/object/sign/${reference.bucketId}/${reference.objectName}`;
    if (target.protocol !== "https:"
        || target.hostname !== `${storage.envId}.api.tcloudbasegateway.com`
        || target.port || target.username || target.password
        || decodeURIComponent(target.pathname) !== expectedPath
        || !target.searchParams.get("token")) return "";
    // Keep the exact SDK response bytes. Re-serializing a signed query can
    // alter escaping or parameter order and invalidate the provider token.
    return candidate;
  } catch (_) {
    return "";
  }
}

async function signProductLogoUncached(reference, storage, expiresIn) {
  let firstError = null;
  try {
    const response = await retryProductLogoStorage("signObject", () => manager().storage.signObject({
      bucketId: reference.bucketId,
      objectName: reference.objectName,
      expiresIn,
      accessToken: storage.accessToken,
      envId: storage.envId
    }));
    const signedUrl = validatedProductLogoSignedUrl(response, storage, reference);
    if (signedUrl) return signedUrl;
    const error = new Error("项目 LOGO 单对象签名响应缺少可信 signedURL");
    error.code = "PRODUCT_LOGO_SIGN_RESPONSE_INVALID";
    throw error;
  } catch (error) {
    firstError = error;
  }
  if (typeof manager().storage.signObjects === "function") {
    try {
      const response = await retryProductLogoStorage("signObjects", () => manager().storage.signObjects({
        bucketId: reference.bucketId,
        paths: [reference.objectName],
        expiresIn,
        accessToken: storage.accessToken,
        envId: storage.envId
      }));
      const signedUrl = validatedProductLogoSignedUrl(response, storage, reference);
      if (signedUrl) return signedUrl;
      const error = new Error("项目 LOGO 批量签名响应缺少可信 signedURL");
      error.code = "PRODUCT_LOGO_SIGN_RESPONSE_INVALID";
      throw error;
    } catch (error) {
      const first = cloudErrorDetails(firstError);
      const second = cloudErrorDetails(error);
      console.error("CloudBase product-logo sign channels exhausted", {
        bucketId: reference.bucketId,
        objectName: reference.objectName,
        singleCode: first.code || undefined,
        singleRequestId: requestIdFrom(firstError) || undefined,
        batchCode: second.code || undefined,
        batchRequestId: requestIdFrom(error) || undefined
      });
      throw productLogoStorageError(
        "项目 LOGO 临时访问地址生成失败",
        "PRODUCT_LOGO_SIGN_FAILED",
        error,
        { operation: "signProductLogo", bucketId: reference.bucketId, objectName: reference.objectName }
      );
    }
  }
  throw productLogoStorageError(
    "项目 LOGO 临时访问地址生成失败",
    "PRODUCT_LOGO_SIGN_FAILED",
    firstError,
    { operation: "signProductLogo", bucketId: reference.bucketId, objectName: reference.objectName }
  );
}

async function signProductLogo(referenceValue, expiresIn = 900) {
  const reference = parseProductLogoReference(referenceValue);
  const storage = productTemplateStorageSettings();
  if (reference.bucketId !== storage.bucketId || !/^products\/\d+\/receipt-logo\//.test(reference.objectName)) {
    fail("项目 LOGO 不属于指定私有存储桶", "PRODUCT_LOGO_BUCKET_MISMATCH");
  }
  const cacheKey = `${storage.envId}\n${reference.reference}`;
  const cached = productLogoSignCache.get(cacheKey);
  if (cached && cached.expiresAt - Date.now() > PRODUCT_LOGO_SIGN_SAFETY_MS) {
    productLogoSignCache.delete(cacheKey);
    productLogoSignCache.set(cacheKey, cached);
    return { url: cached.url, expiresIn: Math.max(1, Math.floor((cached.expiresAt - Date.now()) / 1000)) };
  }
  if (cached) productLogoSignCache.delete(cacheKey);
  const existing = productLogoSignFlights.get(cacheKey);
  if (existing) return existing;
  const flight = signProductLogoUncached(reference, storage, expiresIn)
    .then((url) => {
      const expiresAt = Date.now() + expiresIn * 1000;
      productLogoSignCache.set(cacheKey, { url, expiresAt });
      while (productLogoSignCache.size > 64) productLogoSignCache.delete(productLogoSignCache.keys().next().value);
      return { url, expiresIn };
    })
    .finally(() => productLogoSignFlights.delete(cacheKey));
  productLogoSignFlights.set(cacheKey, flight);
  return flight;
}

async function deleteProductLogo(referenceValue) {
  if (!referenceValue) return true;
  evictProductLogoServerCaches(referenceValue);
  try {
    const reference = parseProductLogoReference(referenceValue);
    const storage = productTemplateStorageSettings();
    if (reference.bucketId !== storage.bucketId) return false;
    await manager().storage.deleteObject({
      bucketId: reference.bucketId,
      objectName: reference.objectName,
      accessToken: storage.accessToken,
      envId: storage.envId
    });
    return true;
  } catch (error) {
    console.warn("product logo cleanup failed", error?.message || error);
    return false;
  }
}

function sqlText(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function temporalNumber(value) {
  let current = value;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current === "number") return Number.isFinite(current) ? current : NaN;
    if (typeof current === "string") {
      const parsed = Number(current.trim());
      return Number.isFinite(parsed) ? parsed : NaN;
    }
    if (!current || typeof current !== "object") return NaN;
    const key = ["$numberLong", "$numberInt", "$numberDouble", "value"].find((name) => current[name] !== undefined);
    if (!key) return NaN;
    current = current[key];
  }
  return NaN;
}

function sqlTemporalText(value, columnName = "") {
  const column = String(columnName || "").toLowerCase();
  if (!/(?:_at|_time|_date)$/.test(column) || value === null || value === undefined || value === "") return value;
  let current = value;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof Date) return Number.isNaN(current.getTime()) ? value : current.toISOString();
    if (typeof current === "number") {
      const millis = Math.abs(current) < 100000000000 ? current * 1000 : current;
      const parsed = new Date(millis);
      return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
    }
    if (typeof current === "string") {
      const text = current.trim();
      if (!text) return value;
      if (/^-?\d+(?:\.\d+)?$/.test(text)) { current = Number(text); continue; }
      if (text[0] === "{" || text[0] === "[") {
        try { current = JSON.parse(text); continue; } catch (error) { /* keep database text */ }
      }
      if (/_date$/.test(column) && /^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
      const normalized = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)
        ? `${text.replace(" ", "T")}Z`
        : text.replace(/([+-]\d{2})$/, "$1:00");
      const parsed = new Date(normalized);
      return Number.isNaN(parsed.getTime()) ? text : parsed.toISOString();
    }
    if (!current || typeof current !== "object") return value;
    if (typeof current.toDate === "function") {
      try { current = current.toDate(); continue; } catch (error) { /* inspect stored fields */ }
    }
    if (typeof current.toISOString === "function") {
      try {
        const text = current.toISOString();
        if (text) { current = text; continue; }
      } catch (error) { /* inspect stored fields */ }
    }
    const seconds = temporalNumber(current.seconds ?? current._seconds);
    if (Number.isFinite(seconds)) {
      const nanos = temporalNumber(current.nanoseconds ?? current._nanoseconds);
      const parsed = new Date((seconds * 1000) + (Number.isFinite(nanos) ? Math.trunc(nanos / 1000000) : 0));
      return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
    }
    const wrapperKey = ["$date", "$numberLong", "$numberInt", "$numberDouble", "date", "timestamp", "time", "iso", "isoString", "value"].find((name) => current[name] !== undefined);
    if (wrapperKey) { current = current[wrapperKey]; continue; }
    const printable = String(current);
    if (printable && printable !== "[object Object]") { current = printable; continue; }
    return value;
  }
  return value;
}

function parseSqlRows(result) {
  const columns = result?.Columns || [];
  return (result?.Rows || []).map((raw) => {
    const values = Array.isArray(raw) ? raw : JSON.parse(raw);
    return Object.fromEntries(columns.map((column, index) => [column, sqlTemporalText(values[index], column)]));
  });
}

async function executeSql(sql) {
  const result = await manager().database.executePGSql({ Sql: sql });
  return parseSqlRows(result);
}

function databaseBoolean(value) {
  return [true, "true", "t", 1, "1"].includes(value);
}

async function getStoreBindingLayout() {
  if (storeBindingLayout) return storeBindingLayout;
  let rows;
  try {
    rows = await executeSql(
      `SELECT
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'stores' AND column_name = 'store_account_id'
        ) AS has_store_account_id,
        EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'staff_store_assignments'
        ) AS has_staff_store_assignments`
    );
  } catch (error) {
    asDatabaseError(error, "读取门店绑定结构");
  }
  const layout = rows?.[0] || {};
  if (databaseBoolean(layout.has_store_account_id)) {
    storeBindingLayout = "stores";
    return storeBindingLayout;
  }
  if (databaseBoolean(layout.has_staff_store_assignments)) {
    storeBindingLayout = "assignments";
    return storeBindingLayout;
  }
  fail("数据库缺少门店账号绑定结构，请先执行完整数据库建表脚本", "DATABASE_SCHEMA_MISSING");
}

async function getStoreCreationCapabilities() {
  if (storeCreationCapabilities) return storeCreationCapabilities;
  let rows;
  try {
    rows = await executeSql(
      `SELECT
        EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'stores'
        ) AS has_stores,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'stores' AND column_name = 'contacts_json'
        ) AS has_contacts_json,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'stores' AND column_name = 'created_by'
        ) AS has_created_by,
        EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'store_contacts'
        ) AS has_store_contacts,
        COALESCE((
          SELECT column_default
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'stores' AND column_name = 'store_code'
          LIMIT 1
        ), '') AS store_code_default`
    );
  } catch (error) {
    asDatabaseError(error, "读取门店创建结构");
  }
  const row = rows?.[0] || {};
  if (!databaseBoolean(row.has_stores)) {
    fail("数据库缺少 stores 表，请先执行完整数据库建表脚本", "DATABASE_SCHEMA_MISSING");
  }
  if (!databaseBoolean(row.has_contacts_json) && !databaseBoolean(row.has_store_contacts)) {
    fail("数据库缺少门店联系人结构，请先执行完整数据库建表脚本", "DATABASE_SCHEMA_MISSING");
  }
  storeCreationCapabilities = {
    contactsJson: databaseBoolean(row.has_contacts_json),
    createdBy: databaseBoolean(row.has_created_by),
    storeContacts: databaseBoolean(row.has_store_contacts),
    storeCodeHasDefault: Boolean(String(row.store_code_default || "").trim())
  };
  return storeCreationCapabilities;
}

function fail(message, code = "BAD_REQUEST") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function requestIdFrom(error) {
  return String(error?.RequestId || error?.requestId || error?.response?.RequestId || "");
}

function cloudErrorDetails(error) {
  const nested = error?.response?.data?.Response?.Error ||
    error?.response?.Response?.Error ||
    error?.data?.Response?.Error ||
    error?.response?.Error ||
    {};
  return {
    // Cross-function SDK errors often put the actionable target-function
    // reason under Response.Error while the outer message is only
    // FUNCTIONS_INVOCATION_FAILED. Prefer that nested, bounded text in
    // operational logs and in the sanitized cause fields returned to HQ.
    code: String(nested?.Code || error?.code || error?.Code || "").trim(),
    message: String(nested?.Message || error?.message || error?.Message || "").trim().slice(0, 300)
  };
}

function stageFail(stage, message, code, cause) {
  const requestId = requestIdFrom(cause);
  const causeDetails = cloudErrorDetails(cause);
  console.error("staff account provision failed", {
    stage,
    code,
    requestId: requestId || undefined,
    causeCode: causeDetails.code || undefined,
    causeMessage: causeDetails.message || undefined
  });
  const error = new Error(message);
  error.code = code;
  error.stage = stage;
  error.requestId = requestId || undefined;
  error.causeCode = causeDetails.code || undefined;
  error.causeMessage = causeDetails.message || undefined;
  throw error;
}

function authErrorHttpStatus(error) {
  const candidates = [
    error?.status, error?.statusCode, error?.status_code,
    error?.response?.status, error?.response?.statusCode, error?.response?.StatusCode,
    error?.response?.data?.status
  ];
  for (const candidate of candidates) {
    const status = Number(candidate);
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }
  return 0;
}

function isDuplicateAuthError(error) {
  if (!error) return false;
  const status = authErrorHttpStatus(error);
  if ([408, 425, 429, 499].includes(status) || status >= 500) return false;
  const details = cloudErrorDetails(error);
  const code = String(details.code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (/^(?:FAILEDOPERATION)?DUPLICATE(?:D)?DATA$/.test(code)
      || /^(?:USER|ACCOUNT|PHONE|EMAIL)ALREADY(?:EXISTS|REGISTERED)$/.test(code)) {
    return true;
  }
  // A real HTTP conflict is a definite non-write result.  Only here may the
  // bounded provider message disambiguate the kind of conflict; free-form
  // text from a timeout/5xx wrapper is never accepted as ownership proof.
  const message = String(details.message || "").toLowerCase();
  return status === 409 && /duplicate|already exist|already registered|已存在|已注册/.test(message);
}

function teacherAuthCreateDefinitelyRejected(error) {
  if (!error) return false;
  const details = cloudErrorDetails(error);
  const code = String(details.code || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  const status = authErrorHttpStatus(error);
  // Transport uncertainty wins over every nested provider word.  A 503
  // wrapper may itself contain "InvalidParameter" from a downstream attempt,
  // but that does not prove whether the original create committed.
  if ([408, 425, 429, 499].includes(status) || status >= 500
      || /(?:TIMEOUT|ETIMEDOUT|ECONNRESET|ECONNABORTED|EPIPE|ENETUNREACH|EHOSTUNREACH|FETCHFAILED|NETWORKERROR|REQUESTTIMEOUT|INTERNALERROR|SERVICEUNAVAILABLE|TOOMANYREQUESTS|THROTTL|LIMITEXCEEDED|EXCEEDRATELIMIT|HTTP5\d\d)/.test(code)) {
    return false;
  }
  if (isDuplicateAuthError(error)) return false;
  if (status >= 400 && status < 500 && status !== 409) return true;
  return /^(?:INVALID(?:PARAMETER|PARAM|ARGUMENT|CREDENTIAL|PASSWORD)|BADREQUEST|EXCEEDAUTHORITY|ACTIONFORBIDDEN|UNAUTHORIZED|UNAUTHORIZEDOPERATION|PERMISSIONDENIED|AUTHFAILURE|PASSWORD(?:POLICY|FORMAT|WEAK)|PHONE(?:INVALID|FORMAT))/.test(code);
}

function managerDependencyInstalled() {
  try {
    require.resolve("@cloudbase/manager-node");
    return true;
  } catch (_) {
    return false;
  }
}

function normalizedMainlandPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 13 && digits.startsWith("86") ? digits.slice(2) : digits;
}

async function describeAuthUsersByPhone(phone) {
  try {
    return await manager().user.describeUserList({ phone, pageNo: 1, pageSize: 20 });
  } catch (error) {
    stageFail(
      "AUTH_LOOKUP",
      "无法读取认证账号。请确认云函数已点击“保存并安装依赖”，并检查函数权限。",
      "AUTH_LOOKUP_FAILED",
      error
    );
  }
}

async function describeAuthUsersByName(name) {
  try {
    return await manager().user.describeUserList({ name, pageNo: 1, pageSize: 20 });
  } catch (error) {
    stageFail(
      "AUTH_LOOKUP",
      "无法按登录名读取认证账号。请检查云函数的用户管理权限。",
      "AUTH_LOOKUP_FAILED",
      error
    );
  }
}

async function findAuthUserByExactPhone(phone) {
  const responses = [await describeAuthUsersByPhone(phone)];
  let users = responses[0]?.Data?.UserList || [];
  let matches = users.filter((user) => normalizedMainlandPhone(user?.Phone) === phone);

  // Some CloudBase accounts are returned with an E.164-style +86 prefix.
  // The phone filter is fuzzy, but not every console/runtime version treats
  // the 11-digit and +86 forms identically, so retry the prefixed form once.
  if (!matches.length) {
    const prefixed = await describeAuthUsersByPhone(`+86${phone}`);
    responses.push(prefixed);
    users = [...users, ...(prefixed?.Data?.UserList || [])];
    const uniqueUsers = Array.from(new Map(users.map((user) => [String(user?.Uid || ""), user])).values());
    matches = uniqueUsers.filter((user) => normalizedMainlandPhone(user?.Phone) === phone);
  }
  if (!matches.length) {
    const username = `staff_${phone}`;
    const byName = await describeAuthUsersByName(username);
    responses.push(byName);
    const nameMatches = (byName?.Data?.UserList || []).filter((user) => String(user?.Name || "") === username);
    if (nameMatches.length > 1) {
      const error = new Error("Multiple identity users share this generated username");
      error.RequestId = byName?.RequestId;
      stageFail(
        "AUTH_LOOKUP",
        "认证系统返回多个同登录名账号，请由总部先处理认证账号。",
        "AUTH_USERNAME_AMBIGUOUS",
        error
      );
    }
    const namedUser = nameMatches[0] || null;
    if (namedUser) {
      const namedPhone = normalizedMainlandPhone(namedUser?.Phone);
      if (namedPhone && namedPhone !== phone) {
        fail("该登录名已绑定其他手机号，请由总部先处理认证账号", "AUTH_USERNAME_CONFLICT");
      }
      if (!namedPhone) {
        try {
          await manager().user.modifyUser({ uid: String(namedUser.Uid), phone });
          namedUser.Phone = phone;
        } catch (error) {
          const cause = cloudErrorDetails(error);
          const diagnostic = [cause.code, cause.message].filter(Boolean).join("：");
          stageFail(
            "AUTH_REPAIR",
            `检测到未绑定手机号的已有登录账号，但补充手机号失败。${diagnostic ? `腾讯云返回 ${diagnostic}。` : "请检查云函数的用户管理权限。"}`,
            "AUTH_PHONE_REPAIR_FAILED",
            error
          );
        }
      }
      matches = [namedUser];
    }
  }
  if (matches.length > 1) {
    const error = new Error("Multiple identity users share this phone");
    error.RequestId = responses.map((response) => response?.RequestId).filter(Boolean).join(",");
    stageFail(
      "AUTH_LOOKUP",
      "认证系统返回了多个同手机号账号，请由总部先处理认证账号。",
      "AUTH_PHONE_AMBIGUOUS",
      error
    );
  }
  return matches[0] || null;
}

// Teacher creation has destructive compensation and therefore must never use
// the legacy name fallback above: that fallback may repair (mutate) an
// unrelated pre-existing Auth user before this Saga has proved ownership.
async function findAuthUserByExactPhoneReadOnly(phone) {
  const responses = await Promise.all([
    describeAuthUsersByPhone(phone),
    describeAuthUsersByPhone(`+86${phone}`)
  ]);
  const users = responses.flatMap((response) => response?.Data?.UserList || []);
  const uniqueUsers = Array.from(new Map(
    users.map((user) => [String(user?.Uid || ""), user])
  ).values());
  const matches = uniqueUsers.filter((user) => normalizedMainlandPhone(user?.Phone) === phone);
  if (matches.length > 1) {
    const error = new Error("Multiple identity users share this phone");
    error.RequestId = responses.map((response) => response?.RequestId).filter(Boolean).join(",");
    stageFail(
      "AUTH_LOOKUP",
      "认证系统返回了多个同手机号账号，请由总部先处理认证账号。",
      "AUTH_PHONE_AMBIGUOUS",
      error
    );
  }
  return matches[0] || null;
}

function validatePhone(phone) {
  const value = String(phone || "").replace(/\D/g, "");
  if (!/^1[3-9]\d{9}$/.test(value)) fail("手机号必须是 11 位中国大陆手机号");
  return value;
}

function validatePassword(password) {
  const value = String(password || "");
  // CloudBase Identity rejects a password whose first character is special.
  // Keep this server-side boundary before any role preflight, SQL write or
  // external identity mutation so stale/crafted clients fail closed as well.
  if (value && !/^[A-Za-z0-9]/.test(value)) {
    fail("初始密码不能以特殊字符开头，请以英文字母或数字开头", "PASSWORD_START_INVALID");
  }
  const groups = [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z\d]/].filter((rule) => rule.test(value)).length;
  if (value.length < 8 || value.length > 32 || groups < 3) {
    fail("初始密码须为 8-32 位，并包含大写、小写、数字、特殊字符中的至少三类");
  }
  return value;
}

function strictDashboardDate(value, label) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) fail(`${label}必须使用 YYYY-MM-DD 格式`, "BAD_REQUEST");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (
    year < 1 ||
    !Number.isFinite(parsed.valueOf()) ||
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== day
  ) {
    fail(`${label}不是有效日期`, "BAD_REQUEST");
  }
  return text;
}

function dashboardDateRange(event) {
  const rawStart = event.startDate === undefined || event.startDate === null
    ? ""
    : String(event.startDate).trim();
  const rawEnd = event.endDate === undefined || event.endDate === null
    ? ""
    : String(event.endDate).trim();
  const allTime = event.allTime === true;
  if (allTime && (rawStart || rawEnd)) fail("全部时间不能同时指定开始或结束日期", "BAD_REQUEST");
  if (allTime) return { allTime: true };
  if (Boolean(rawStart) !== Boolean(rawEnd)) {
    fail("开始日期和结束日期必须同时提供", "BAD_REQUEST");
  }
  if (!rawStart) return null;

  const startDate = strictDashboardDate(rawStart, "开始日期");
  const endDate = strictDashboardDate(rawEnd, "结束日期");
  const startTime = Date.parse(`${startDate}T00:00:00.000Z`);
  const endTime = Date.parse(`${endDate}T00:00:00.000Z`);
  if (startTime > endTime) fail("开始日期不能晚于结束日期", "BAD_REQUEST");
  const days = Math.floor((endTime - startTime) / 86400000) + 1;
  if (days > 366) fail("统计日期范围最多为 366 天", "BAD_REQUEST");
  return { startDate, endDate, days };
}

function dashboardReadMode(event = {}) {
  const mode = String(event.mode || "overview").trim().toLowerCase();
  if (mode === "overview" || mode === "ranking" || mode === "product-summary") return mode;
  fail("总部看板读取类型无效", "BAD_REQUEST");
}

function strictDashboardPositiveInteger(value, label, fallback, maximum) {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) fail(`${label}必须是正整数`, "BAD_REQUEST");
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    fail(`${label}必须在 1 到 ${maximum} 之间`, "BAD_REQUEST");
  }
  return parsed;
}

function dashboardRankingRequest(event = {}) {
  const dimension = String(event.dimension || "store").trim().toLowerCase();
  if (!new Set(["store", "teacher"]).has(dimension)) {
    fail("总部看板排名维度无效", "BAD_REQUEST");
  }
  const rankingMetric = String(event.rankingMetric || "recharge").trim().toLowerCase();
  if (!new Set(["recharge", "verification", "experience", "refund"]).has(rankingMetric)) {
    fail("总部看板排名业务类型无效", "BAD_REQUEST");
  }
  const productIdText = String(event.productId || "").trim();
  return {
    dimension,
    rankingMetric,
    productId: productIdText ? numericId(productIdText, "排名项目") : null,
    pageNumber: strictDashboardPositiveInteger(
      event.pageNumber,
      "排名页码",
      1,
      HQ_DASHBOARD_MAX_PAGE_NUMBER
    ),
    pageSize: strictDashboardPositiveInteger(
      event.pageSize,
      "每页数量",
      HQ_DASHBOARD_DEFAULT_PAGE_SIZE,
      HQ_DASHBOARD_MAX_PAGE_SIZE
    )
  };
}

function dashboardProductSummaryRequest(event = {}) {
  return {
    pageNumber: strictDashboardPositiveInteger(
      event.pageNumber,
      "项目汇总页码",
      1,
      HQ_DASHBOARD_MAX_PAGE_NUMBER
    ),
    pageSize: strictDashboardPositiveInteger(
      event.pageSize,
      "项目汇总每页条数",
      10,
      HQ_DASHBOARD_MAX_PAGE_SIZE
    )
  };
}

function hqDashboardDateSql(requestedRange) {
  if (requestedRange?.allTime === true) {
    return {
      startDateSql: `(COALESCE(
        (SELECT MIN(source.first_date)
           FROM (
             SELECT MIN((submitted_at AT TIME ZONE 'Asia/Shanghai')::date) AS first_date
               FROM public.recharge_records
              WHERE record_status = 'APPROVED' AND recharge_type IN ('NEW', 'REFUND')
             UNION ALL
             SELECT MIN((submitted_at AT TIME ZONE 'Asia/Shanghai')::date) AS first_date
               FROM public.verification_records
              WHERE record_status = 'APPROVED' AND verification_type IN ('NORMAL', 'SUPPLEMENT', 'EXPERIENCE')
           ) source),
        (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date))`,
      endDateSql: "(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date"
    };
  }
  return {
    startDateSql: requestedRange
      ? `${sqlText(requestedRange.startDate)}::date`
      : "((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date - 29)",
    endDateSql: requestedRange
      ? `${sqlText(requestedRange.endDate)}::date`
      : "(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date"
  };
}

// This CTE deliberately contains only approved business facts. Submitter joins
// classify whether teacher_id has a valid store/teacher source; they never
// filter an event. Presentation master tables are joined after aggregation, so
// archive status never removes historical facts from the headquarters totals.
function hqBusinessEventsCte(startDateSql, endDateSql, productId = null) {
  const productIdSql = productId ? `${productId}::bigint` : "NULL::bigint";
  return `WITH date_bounds AS (
    SELECT ${startDateSql} AS start_date,
           ${endDateSql} AS end_date
  ), bounds AS (
    SELECT start_date,
           end_date,
           start_date::timestamp AT TIME ZONE 'Asia/Shanghai' AS start_at,
           (end_date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai' AS end_at
      FROM date_bounds
  ), business_events AS (
    SELECT r.store_id,
           r.product_id,
           CASE
             WHEN submitter.role_code = 'store'
              AND r.recharge_type IN ('NEW', 'REFUND') THEN r.teacher_id
             WHEN submitter.role_code = 'teacher'
              AND submitting_teacher.id = r.teacher_id
              AND r.recharge_type IN ('NEW', 'REFUND') THEN r.teacher_id
             ELSE NULL::bigint
           END AS teacher_id,
           CASE WHEN r.recharge_type = 'NEW' THEN r.unit_count::bigint ELSE 0::bigint END AS recharge_count,
           0::bigint AS verification_count,
           0::bigint AS experience_count,
           CASE WHEN r.recharge_type = 'REFUND' THEN r.unit_count::bigint ELSE 0::bigint END AS refund_count
      FROM public.recharge_records r
     CROSS JOIN bounds b
      LEFT JOIN public.staff_accounts submitter
        ON submitter.id = r.submitted_by_account_id
      LEFT JOIN public.teachers submitting_teacher
        ON submitting_teacher.staff_account_id = submitter.id
     WHERE r.record_status = 'APPROVED'
       AND r.recharge_type IN ('NEW', 'REFUND')
       AND (${productIdSql} IS NULL OR r.product_id = ${productIdSql})
       AND r.submitted_at >= b.start_at
       AND r.submitted_at < b.end_at
    UNION ALL
    SELECT v.store_id,
           v.product_id,
           CASE
             WHEN submitter.role_code = 'store'
              AND v.verification_type = 'NORMAL' THEN v.teacher_id
             WHEN submitter.role_code = 'teacher'
              AND submitting_teacher.id = v.teacher_id
              AND v.verification_type IN ('NORMAL', 'EXPERIENCE') THEN v.teacher_id
             ELSE NULL::bigint
           END AS teacher_id,
           0::bigint AS recharge_count,
           CASE WHEN v.verification_type IN ('NORMAL', 'SUPPLEMENT') THEN v.unit_count::bigint ELSE 0::bigint END AS verification_count,
           CASE WHEN v.verification_type = 'EXPERIENCE' THEN v.unit_count::bigint ELSE 0::bigint END AS experience_count,
           0::bigint AS refund_count
      FROM public.verification_records v
     CROSS JOIN bounds b
      LEFT JOIN public.staff_accounts submitter
        ON submitter.id = v.submitted_by_account_id
      LEFT JOIN public.teachers submitting_teacher
        ON submitting_teacher.staff_account_id = submitter.id
     WHERE v.record_status = 'APPROVED'
       AND v.verification_type IN ('NORMAL', 'SUPPLEMENT', 'EXPERIENCE')
       AND (${productIdSql} IS NULL OR v.product_id = ${productIdSql})
       AND v.submitted_at >= b.start_at
       AND v.submitted_at < b.end_at
  )`;
}

function hqDashboardRankingProjection(dimension) {
  if (dimension === "store") {
    return `SELECT s.id AS entity_id,
                   COALESCE(s.store_code::text, '') AS entity_code,
                   COALESCE(s.store_name::text, '') AS entity_name,
                   COALESCE(SUM(event.recharge_count), 0)::bigint AS recharge_count,
                   COALESCE(SUM(event.verification_count), 0)::bigint AS verification_count,
                   COALESCE(SUM(event.experience_count), 0)::bigint AS experience_count,
                   COALESCE(SUM(event.refund_count), 0)::bigint AS refund_count
              FROM public.stores s
         LEFT JOIN business_events event ON event.store_id = s.id
            WHERE s.store_status = 'ACTIVE'
               OR event.store_id IS NOT NULL
             GROUP BY s.id, s.store_code, s.store_name`;
  }
  if (dimension === "project") {
    return `SELECT event.product_id AS entity_id,
                   COALESCE(product.product_code::text, '') AS entity_code,
                   COALESCE(product.product_name::text, '') AS entity_name,
                   COALESCE(SUM(event.recharge_count), 0)::bigint AS recharge_count,
                   COALESCE(SUM(event.verification_count), 0)::bigint AS verification_count,
                   COALESCE(SUM(event.experience_count), 0)::bigint AS experience_count,
                   COALESCE(SUM(event.refund_count), 0)::bigint AS refund_count
              FROM business_events event
         LEFT JOIN public.products product ON product.id = event.product_id
             GROUP BY event.product_id, product.product_code, product.product_name`;
  }
  if (dimension === "teacher") {
    return `SELECT teacher.id AS entity_id,
                   COALESCE(teacher.teacher_code::text, '') AS entity_code,
                   COALESCE(teacher.teacher_name::text, '') AS entity_name,
                   COALESCE(SUM(event.recharge_count), 0)::bigint AS recharge_count,
                   COALESCE(SUM(event.verification_count), 0)::bigint AS verification_count,
                   COALESCE(SUM(event.experience_count), 0)::bigint AS experience_count,
                   COALESCE(SUM(event.refund_count), 0)::bigint AS refund_count
              FROM public.teachers teacher
         LEFT JOIN business_events event ON event.teacher_id = teacher.id
             WHERE teacher.teacher_status = 'ACTIVE'
                OR event.teacher_id IS NOT NULL
             GROUP BY teacher.id, teacher.teacher_code, teacher.teacher_name
             UNION ALL
            SELECT 0::bigint AS entity_id,
                   'UNASSIGNED'::text AS entity_code,
                   '未指定老师'::text AS entity_name,
                   COALESCE(SUM(event.recharge_count), 0)::bigint AS recharge_count,
                   COALESCE(SUM(event.verification_count), 0)::bigint AS verification_count,
                   COALESCE(SUM(event.experience_count), 0)::bigint AS experience_count,
                   COALESCE(SUM(event.refund_count), 0)::bigint AS refund_count
              FROM business_events event
             WHERE event.teacher_id IS NULL
            HAVING COALESCE(SUM(
                     event.recharge_count
                   + event.verification_count
                   + event.experience_count
                   + event.refund_count
                   ), 0) > 0`;
  }
  fail("总部看板排名维度无效", "BAD_REQUEST");
}

function asDatabaseError(error, action) {
  if (error) fail(`${action}失败：${error.message || "数据库暂不可用"}`, "DATABASE_ERROR");
}

async function findStaffProfile(uid) {
  let rows;
  try {
    const layout = await getStoreBindingLayout();
    const storeJoin = layout === "stores"
      ? "LEFT JOIN public.stores s ON s.store_account_id = a.id"
      : "LEFT JOIN public.staff_store_assignments sa ON sa.staff_account_id = a.id AND sa.assignment_status = 'ACTIVE' LEFT JOIN public.stores s ON s.id = sa.store_id";
    rows = await executeSql(
      `SELECT a.id, a.phone, a.staff_name, a.role_code, a.account_status,
        a.password_initialized_at, a.password_changed_at, a.password_change_required,
        s.id AS store_id, s.store_code, s.store_name, s.store_status,
        t.id AS teacher_id, t.teacher_status
       FROM public.staff_accounts a
       ${storeJoin}
       LEFT JOIN public.teachers t ON t.staff_account_id = a.id
       WHERE a.auth_uid = ${sqlText(uid)}
       LIMIT 1`
    );
  } catch (error) {
    asDatabaseError(error, "读取员工身份");
  }
  const staff = rows?.[0];
  if (!staff) return null;
  if (staff.role_code === "operation") {
    fail("运营账号已下线，无法再登录或使用业务功能。", "OPERATION_ROLE_RETIRED");
  }
  if (!ROLES.has(staff.role_code)) return null;
  if (staff.account_status !== "ACTIVE") fail("该人员账号已封存，无法登录", "ARCHIVED_ACCOUNT");

  let storeId = "";
  if (staff.role_code === "store") {
    storeId = staff.store_id ? String(staff.store_id) : "";
    if (!storeId) fail("该门店账号尚未绑定有效门店", "UNASSIGNED_STORE");
    if (staff.store_status !== "ACTIVE") fail("关联门店已封存，无法登录", "ARCHIVED_STORE");
  }
  if (staff.role_code === "teacher") {
    if (!staff.teacher_id) {
      // Migration 050 backfills this invariant. Keep a runtime repair for
      // legacy/stress rows created concurrently with deployment, but verify
      // the status-synchronization contract before any write can affect login.
      await requireTeacherStatusSchema();
      const teacher = await ensureTeacherDatabaseProfile(staff.id);
      staff.teacher_id = teacher.id;
      staff.teacher_status = teacher.teacher_status;
    }
    if (staff.teacher_status === "ARCHIVED") fail("该老师资料已封存，无法登录", "ARCHIVED_TEACHER");
  }
  return {
    staffId: staff.id,
    staffCode: `${staff.role_code === "hq" ? "HQ" : staff.role_code === "teacher" ? "TCH" : "S"}${String(staff.id).padStart(3, "0")}`,
    role: staff.role_code,
    staffName: staff.staff_name,
    phone: staff.phone || "",
    accountStatus: staff.account_status || "",
    storeId,
    storeCode: staff.store_code || "",
    storeName: staff.store_name || "",
    passwordChangeRequired: [true, "true", "t", 1, "1"].includes(staff.password_change_required),
    passwordInitializedAt: staff.password_initialized_at || null,
    passwordChangedAt: staff.password_changed_at || null,
    teacherId: staff.teacher_id ? String(staff.teacher_id) : "",
    teacherStatus: staff.teacher_status || ""
  };
}

function bootstrapHqProfile(uid, userInfo) {
  if (!process.env.BOOTSTRAP_HQ_UID || String(uid) !== String(process.env.BOOTSTRAP_HQ_UID)) return null;
  return {
    staffId: null,
    role: "hq",
    staffName: String(userInfo?.nickName || userInfo?.name || "总部管理员"),
    storeId: ""
  };
}

async function currentUser(includeUserInfo = false) {
  const { uid } = getAuth().getUserInfo();
  if (!uid) fail("请先登录", "UNAUTHENTICATED");
  let userInfo = {};
  if (includeUserInfo) {
    try {
      const result = await getAuth().getEndUserInfo(uid);
      userInfo = result?.userInfo || {};
    } catch (_) {
      // User details are only needed when the bootstrap HQ account is first created.
    }
  }
  const profile = await findStaffProfile(uid);
  return { uid: String(uid), userInfo, profile };
}

function requireHq(caller) {
  if (caller.profile?.role !== "hq") fail("仅总部账号可以管理员工账号", "FORBIDDEN");
}

function requireReviewer(caller) {
  if (caller.profile?.role !== "hq") {
    fail("仅总部账号可以审核业务工单", "FORBIDDEN");
  }
}

function requireStore(caller) {
  if (caller.profile?.role !== "store" || !caller.profile?.storeId) {
    fail("仅已绑定门店的门店账号可以提交作废申请", "FORBIDDEN");
  }
}

async function ensureBootstrapHq(caller) {
  if (!process.env.BOOTSTRAP_HQ_UID || caller.uid !== String(process.env.BOOTSTRAP_HQ_UID)) {
    fail("首次总部初始化未获授权", "FORBIDDEN");
  }
  const existing = await findStaffProfile(caller.uid);
  if (existing) return existing;
  if (!caller.userInfo || Object.keys(caller.userInfo).length === 0) {
    try {
      const result = await getAuth().getEndUserInfo(caller.uid);
      caller.userInfo = result?.userInfo || {};
    } catch (_) {
      fail("无法读取首次总部账号资料", "AUTH_PROFILE_UNAVAILABLE");
    }
  }
  const phone = validatePhone(caller.userInfo?.phone || caller.userInfo?.phoneNumber || caller.userInfo?.phone_number);
  const staffName = String(caller.userInfo?.nickName || caller.userInfo?.name || "总部管理员");
  try {
    await executeSql(
      `INSERT INTO public.staff_accounts (auth_uid, phone, staff_name, role_code, account_status) VALUES (${sqlText(caller.uid)}, ${sqlText(phone)}, ${sqlText(staffName)}, 'hq', 'ACTIVE')`
    );
  } catch (error) {
    asDatabaseError(error, "初始化总部账户");
  }
  return findStaffProfile(caller.uid);
}

async function ensureTeacherDatabaseProfile(staffId) {
  const normalizedStaffId = numericId(staffId, "老师账号编号");
  try {
    await executeSql(
      `INSERT INTO public.teachers
        (teacher_code, teacher_name, staff_account_id, teacher_status)
       SELECT 'TCHF' || account.id::text, account.staff_name, account.id,
              CASE WHEN account.account_status = 'ACTIVE' THEN 'ACTIVE' ELSE 'ARCHIVED' END
         FROM public.staff_accounts AS account
        WHERE account.id = ${normalizedStaffId}
       ON CONFLICT (staff_account_id) DO UPDATE
         SET teacher_name = EXCLUDED.teacher_name,
             updated_at = NOW()`
    );
  } catch (error) {
    asDatabaseError(error, "创建老师资料");
  }

  // CloudBase executePGSql can commit a writable statement without exposing
  // rows produced by RETURNING. Read the durable row back with a plain SELECT
  // before deciding that profile creation failed. This also makes a retry of a
  // previously half-reported teacher creation repair itself safely.
  let rows;
  try {
    rows = await executeSql(
       `SELECT teacher.id, teacher.teacher_code, teacher.teacher_name,
               teacher.teacher_status
         FROM public.teachers AS teacher
         JOIN public.staff_accounts AS account
           ON account.id = teacher.staff_account_id
        WHERE teacher.staff_account_id = ${normalizedStaffId}
          AND account.role_code = 'teacher'
        LIMIT 1`
    );
  } catch (error) {
    asDatabaseError(error, "确认老师资料");
  }
  const teacher = rows?.[0];
  if (!teacher) fail("老师账号已创建，但老师资料未能写入", "TEACHER_PROFILE_MISSING");
  return teacher;
}

async function createStaffDatabaseProfile({ uid, phone, staffName, role, storeId, initialAccountStatus = "ACTIVE" }) {
  if (role === "operation") fail("运营账号已下线，不能再创建或恢复。", "OPERATION_ROLE_RETIRED");
  const accountStatus = String(initialAccountStatus || "").toUpperCase();
  if (!['ACTIVE', 'ARCHIVED'].includes(accountStatus)) fail("员工初始状态无效", "BAD_REQUEST");
  let existingRows;
  try {
    existingRows = await executeSql(
      `SELECT id, auth_uid, role_code FROM public.staff_accounts WHERE phone = ${sqlText(phone)} LIMIT 1`
    );
  } catch (error) {
    asDatabaseError(error, "Read existing staff profile");
  }

  const existing = existingRows?.[0];
  if (existing && existing.role_code !== role) {
    fail("该手机号已经绑定其他业务身份；一个手机号只能有一个身份", "PHONE_ROLE_CONFLICT");
  }
  if (existing?.auth_uid && String(existing.auth_uid) !== String(uid)) {
    fail("该手机号已经有可用登录账号；请使用修改密码功能，不要重复创建", "PHONE_ALREADY_PROVISIONED");
  }

  let rows;
  try {
    rows = existing
      ? await executeSql(
        `WITH updated_account AS (
           UPDATE public.staff_accounts
           SET auth_uid = ${sqlText(uid)}, staff_name = ${sqlText(staffName)}, account_status = ${sqlText(accountStatus)}, updated_at = NOW()
           WHERE id = ${Number(existing.id)}
           RETURNING id
         )
         SELECT id FROM updated_account`
      )
      : await executeSql(
        `WITH created_account AS (
           INSERT INTO public.staff_accounts (auth_uid, phone, staff_name, role_code, account_status)
           VALUES (${sqlText(uid)}, ${sqlText(phone)}, ${sqlText(staffName)}, ${sqlText(role)}, ${sqlText(accountStatus)})
           RETURNING id
         )
         SELECT id FROM created_account`
      );
  } catch (error) {
    asDatabaseError(error, "保存员工业务身份");
  }
  let durableStaffId = rows?.[0]?.id || null;
  if (!durableStaffId) {
    // executePGSql can commit a writable CTE while returning no rows. Never
    // infer failure from an empty RETURNING envelope; read the exact immutable
    // identity back before continuing or compensating the teacher saga.
    let durableRows;
    try {
      durableRows = await executeSql(
        `SELECT id
           FROM public.staff_accounts
          WHERE auth_uid = ${sqlText(uid)}
            AND phone = ${sqlText(phone)}
            AND role_code = ${sqlText(role)}
          ORDER BY id ASC
          LIMIT 2`
      );
    } catch (error) {
      asDatabaseError(error, "确认员工业务身份");
    }
    if ((durableRows || []).length > 1) {
      fail("员工身份保存后读回到多条记录，已停止继续处理", "DATABASE_IDENTITY_AMBIGUOUS");
    }
    durableStaffId = durableRows?.[0]?.id || null;
  }
  const profile = { staffId: durableStaffId, role, staffName, storeId: "" };
  if (role === "teacher") {
    if (!profile.staffId) fail("员工身份保存后未返回账号编号", "DATABASE_ERROR");
    const teacher = await ensureTeacherDatabaseProfile(profile.staffId);
    profile.teacherId = String(teacher.id);
    profile.teacherCode = String(teacher.teacher_code || "");
    profile.teacherStatus = String(teacher.teacher_status || "");
    return profile;
  }
  if (role !== "store") return profile;
  const staffId = profile.staffId;
  if (!staffId) fail("员工身份保存后未返回账号编号", "DATABASE_ERROR");
  try {
    const layout = await getStoreBindingLayout();
    const targetStoreId = numericId(storeId, "门店编号");
    let storeRows;
    if (layout === "stores") {
      const activeRows = await executeSql(
        `SELECT id FROM public.stores
         WHERE store_account_id = ${Number(staffId)} AND store_status = 'ACTIVE'
         LIMIT 1`
      );
      if (activeRows?.[0] && Number(activeRows[0].id) !== targetStoreId) {
        fail("该门店账号已绑定其他门店；一个联系人账号只能绑定一个门店", "STORE_ACCOUNT_ALREADY_ASSIGNED");
      }
      storeRows = await executeSql(
        `WITH bound_store AS (
           UPDATE public.stores
           SET store_account_id = ${Number(staffId)}, updated_at = NOW()
           WHERE id = ${targetStoreId}
             AND store_status = 'ACTIVE'
             AND (store_account_id IS NULL OR store_account_id = ${Number(staffId)})
           RETURNING id
         )
         SELECT id FROM bound_store`
      );
    } else {
      const activeRows = await executeSql(
        `SELECT store_id FROM public.staff_store_assignments
         WHERE staff_account_id = ${Number(staffId)} AND assignment_status = 'ACTIVE'
         LIMIT 1`
      );
      if (activeRows?.[0] && Number(activeRows[0].store_id) !== targetStoreId) {
        fail("该门店账号已绑定其他门店；一个联系人账号只能绑定一个门店", "STORE_ACCOUNT_ALREADY_ASSIGNED");
      }
      storeRows = await executeSql(
        `WITH bound_assignment AS (
           INSERT INTO public.staff_store_assignments (staff_account_id, store_id, assignment_status)
           VALUES (${Number(staffId)}, ${targetStoreId}, 'ACTIVE')
           ON CONFLICT (staff_account_id, store_id)
           DO UPDATE SET assignment_status = 'ACTIVE'
           RETURNING store_id
         )
         SELECT store_id FROM bound_assignment`
      );
    }
    if (!storeRows?.[0]) fail("门店不存在、已封存或已绑定其他门店账号", "STORE_BINDING_FAILED");
  } catch (error) {
    if (["STORE_BINDING_FAILED", "STORE_ACCOUNT_ALREADY_ASSIGNED"].includes(error?.code)) throw error;
    asDatabaseError(error, "绑定门店");
  }
  profile.storeId = String(storeId);
  return profile;
}

async function assertPhoneCanUseRole(phone, role) {
  let rows;
  try {
    rows = await executeSql(
      `SELECT id, role_code, account_status
       FROM public.staff_accounts
       WHERE phone = ${sqlText(phone)}
       LIMIT 1`
    );
  } catch (error) {
    asDatabaseError(error, "检查手机号业务身份");
  }
  const account = rows?.[0] || null;
  if (account && account.role_code !== role) {
    fail("该手机号已经绑定其他业务身份；一个手机号只能有一个身份", "PHONE_ROLE_CONFLICT");
  }
  return account;
}

async function writeCredentialEvent({ targetStaffId, actorStaffId = null, eventType, passwordChangeRequired }) {
  const targetId = Number(targetStaffId);
  const actorId = actorStaffId === null || actorStaffId === undefined ? "NULL" : String(Number(actorStaffId));
  if (!Number.isInteger(targetId) || targetId <= 0) fail("Credential event is missing a staff account", "DATABASE_ERROR");
  if (!['ACCOUNT_CREATED', 'HQ_PASSWORD_RESET', 'SELF_PASSWORD_CHANGED'].includes(eventType)) {
    fail("Unsupported credential event", "BAD_REQUEST");
  }
  try {
    await executeSql(
      `UPDATE public.staff_accounts
       SET password_initialized_at = CASE WHEN ${sqlText(eventType)} = 'ACCOUNT_CREATED'
                                            THEN COALESCE(password_initialized_at, NOW())
                                          ELSE password_initialized_at END,
           password_changed_at = NOW(),
           password_change_required = ${passwordChangeRequired ? "TRUE" : "FALSE"},
           updated_at = NOW()
       WHERE id = ${targetId}`
    );
    await executeSql(
      `INSERT INTO public.credential_events
        (target_staff_account_id, actor_staff_account_id, event_type)
       VALUES (${targetId}, ${actorId}, ${sqlText(eventType)})`
    );
  } catch (error) {
    asDatabaseError(error, "Record credential management event");
  }
}

function requiredText(value, label, maxLength) {
  const text = String(value || "").trim();
  if (!text) fail(`请填写${label}`);
  if (text.length > maxLength) fail(`${label}不能超过 ${maxLength} 个字符`);
  return text;
}

function numericId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) fail(`${label}无效`, "BAD_REQUEST");
  return id;
}

function storeInputFromEvent(event) {
  return {
    storeName: requiredText(event.storeName, "门店名称", 100),
    province: requiredText(event.province, "省", 32),
    city: requiredText(event.city, "市", 32),
    district: requiredText(event.district, "区", 32),
    addressDetail: requiredText(event.addressDetail, "详细地址", 255),
    contactName: requiredText(event.contactName, "登录联系人姓名", 64),
    contactPhone: validatePhone(event.contactPhone),
    existingStoreId: String(event.existingStoreId || "").trim()
  };
}

function storeMatchesInput(store, input) {
  return [
    [store.store_name, input.storeName],
    [store.province, input.province],
    [store.city, input.city],
    [store.district, input.district],
    [store.address_detail, input.addressDetail]
  ].every(([actual, expected]) => String(actual || "").trim() === String(expected || "").trim());
}

function storeAccountJoin(layout) {
  return layout === "stores"
    ? "LEFT JOIN public.staff_accounts account ON account.id = store.store_account_id"
    : "LEFT JOIN public.staff_store_assignments assignment ON assignment.store_id = store.id AND assignment.assignment_status = 'ACTIVE' LEFT JOIN public.staff_accounts account ON account.id = assignment.staff_account_id";
}

async function findStoreByContactPhone(phone, capabilities) {
  const layout = await getStoreBindingLayout();
  const phoneChecks = ["account.phone = " + sqlText(phone)];
  let contactJoin = "";
  if (capabilities.storeContacts) {
    contactJoin = "LEFT JOIN public.store_contacts contact ON contact.store_id = store.id AND contact.contact_status = 'ACTIVE'";
    phoneChecks.push("contact.contact_phone = " + sqlText(phone));
  }
  if (capabilities.contactsJson) {
    phoneChecks.push(`store.contacts_json @> jsonb_build_array(jsonb_build_object('phone', ${sqlText(phone)}))`);
  }
  try {
    const rows = await executeSql(
      `SELECT DISTINCT store.id, store.store_code, store.store_name, store.province, store.city,
              store.district, store.address_detail, store.store_status
       FROM public.stores store
       ${storeAccountJoin(layout)}
       ${contactJoin}
       WHERE ${phoneChecks.join(" OR ")}
       ORDER BY store.id ASC
       LIMIT 2`
    );
    if (rows.length > 1) fail("该登录联系电话已关联多个门店，请先由总部处理历史数据", "STORE_CONTACT_AMBIGUOUS");
    return rows[0] || null;
  } catch (error) {
    if (error?.code) throw error;
    asDatabaseError(error, "查询门店登录联系人");
  }
}

async function findRecoverableStoreByProfile(input, capabilities) {
  const layout = await getStoreBindingLayout();
  const noActiveContact = capabilities.storeContacts
    ? `AND NOT EXISTS (
         SELECT 1 FROM public.store_contacts contact
         WHERE contact.store_id = store.id AND contact.contact_status = 'ACTIVE'
       )`
    : "";
  const noJsonContact = capabilities.contactsJson
    ? "AND COALESCE(jsonb_array_length(store.contacts_json), 0) = 0"
    : "";
  let rows;
  try {
    rows = await executeSql(
      `SELECT DISTINCT store.id, store.store_code, store.store_name, store.province, store.city,
              store.district, store.address_detail, store.store_status
       FROM public.stores store
       ${storeAccountJoin(layout)}
       WHERE store.store_name = ${sqlText(input.storeName)}
         AND store.province = ${sqlText(input.province)}
         AND store.city = ${sqlText(input.city)}
         AND store.district = ${sqlText(input.district)}
         AND store.address_detail = ${sqlText(input.addressDetail)}
         AND store.store_status = 'ACTIVE'
         AND account.id IS NULL
         ${noActiveContact}
         ${noJsonContact}
       ORDER BY store.id ASC
       LIMIT 2`
    );
  } catch (error) {
    asDatabaseError(error, "读取未完成门店资料");
  }
  if (rows.length > 1) {
    fail("发现多条相同的未完成门店资料，请先由总部在数据库中核对后再绑定账号", "INCOMPLETE_STORE_AMBIGUOUS");
  }
  return rows[0] || null;
}

async function ensureSingleStoreContact(storeId, input, capabilities) {
  if (!capabilities.storeContacts) return;
  let contacts;
  try {
    contacts = await executeSql(
      `SELECT id, contact_name, contact_phone
       FROM public.store_contacts
       WHERE store_id = ${numericId(storeId, "门店编号")}
         AND contact_status = 'ACTIVE'
       ORDER BY is_primary DESC, id ASC
       LIMIT 2`
    );
  } catch (error) {
    asDatabaseError(error, "查询门店联系人");
  }
  if (contacts.length > 1) {
    fail("该门店已有多个活跃联系人，不能再绑定登录账号", "STORE_CONTACT_AMBIGUOUS");
  }
  const contact = contacts[0];
  if (contact) {
    const nameMatches = String(contact.contact_name || "").trim() === input.contactName;
    const phoneMatches = String(contact.contact_phone || "").replace(/\D/g, "") === input.contactPhone;
    if (!nameMatches || !phoneMatches) {
      fail("该门店已有不同的登录联系人，不能覆盖原账号", "STORE_CONTACT_CONFLICT");
    }
    return;
  }
  try {
    await executeSql(
      `INSERT INTO public.store_contacts
        (store_id, contact_name, contact_phone, contact_status, is_primary)
       VALUES (${numericId(storeId, "门店编号")}, ${sqlText(input.contactName)}, ${sqlText(input.contactPhone)}, 'ACTIVE', TRUE)`
    );
  } catch (error) {
    asDatabaseError(error, "保存门店登录联系人");
  }
}

async function loadStoreById(storeId) {
  try {
    const rows = await executeSql(
      `SELECT id, store_code, store_name, province, city, district, address_detail, store_status
       FROM public.stores WHERE id = ${numericId(storeId, "门店编号")} LIMIT 1`
    );
    return rows[0] || null;
  } catch (error) {
    asDatabaseError(error, "读取已有门店");
  }
}

async function createOrRecoverStore(caller, input) {
  const capabilities = await getStoreCreationCapabilities();
  let existing = input.existingStoreId ? await loadStoreById(input.existingStoreId) : null;
  if (!existing) existing = await findStoreByContactPhone(input.contactPhone, capabilities);
  if (!existing) existing = await findRecoverableStoreByProfile(input, capabilities);
  if (existing) {
    if (existing.store_status !== "ACTIVE") {
      fail("该门店已封存，不能绑定或恢复登录账号", "ARCHIVED_STORE");
    }
    if (!storeMatchesInput(existing, input)) {
      fail("该联系电话已关联其他门店；一个手机号只能绑定一个业务身份", "PHONE_ROLE_CONFLICT");
    }
    await ensureSingleStoreContact(existing.id, input, capabilities);
    return { id: String(existing.id), code: String(existing.store_code) };
  }

  const columns = ["store_name", "province", "city", "district", "address_detail"];
  const values = [
    sqlText(input.storeName),
    sqlText(input.province),
    sqlText(input.city),
    sqlText(input.district),
    sqlText(input.addressDetail)
  ];
  let prefix = "";
  if (!capabilities.storeCodeHasDefault) {
    let sequenceRows;
    try {
      sequenceRows = await executeSql("SELECT nextval(pg_get_serial_sequence('public.stores', 'id')) AS reserved_store_id");
    } catch (error) {
      asDatabaseError(error, "生成门店编号");
    }
    const reservedId = numericId(sequenceRows?.[0]?.reserved_store_id, "门店编号");
    columns.unshift("id", "store_code");
    values.unshift(String(reservedId), sqlText(`STR${String(reservedId).padStart(6, "0")}`));
    prefix = "OVERRIDING SYSTEM VALUE ";
  }
  if (capabilities.contactsJson) {
    columns.push("contacts_json");
    values.push(`jsonb_build_array(jsonb_build_object('name', ${sqlText(input.contactName)}, 'phone', ${sqlText(input.contactPhone)}))`);
  }
  if (capabilities.createdBy && caller.profile?.staffId) {
    columns.push("created_by");
    values.push(String(numericId(caller.profile.staffId, "总部账号编号")));
  }

  let rows;
  try {
    rows = await executeSql(
      `WITH created_store AS (
         INSERT INTO public.stores (${columns.join(", ")})
         ${prefix}VALUES (${values.join(", ")})
         RETURNING id, store_code
       )
       SELECT id, store_code FROM created_store`
    );
  } catch (error) {
    asDatabaseError(error, "创建门店资料");
  }
  const store = rows?.[0];
  if (!store?.id || !store?.store_code) fail("门店资料创建后未返回编号", "DATABASE_ERROR");
  await ensureSingleStoreContact(store.id, input, capabilities);
  return { id: String(store.id), code: String(store.store_code) };
}

async function removeUnboundStore(storeId) {
  const targetStoreId = numericId(storeId, "门店编号");
  try {
    const layout = await getStoreBindingLayout();
    const unboundCondition = layout === "stores"
      ? "store.store_account_id IS NULL"
      : `NOT EXISTS (
           SELECT 1 FROM public.staff_store_assignments assignment
           WHERE assignment.store_id = store.id AND assignment.assignment_status = 'ACTIVE'
         )`;
    await executeSql(
      `DELETE FROM public.stores store
       WHERE store.id = ${targetStoreId}
         AND ${unboundCondition}`
    );
    const remaining = await executeSql(
      `SELECT id FROM public.stores WHERE id = ${targetStoreId} LIMIT 1`
    );
    return !remaining?.[0];
  } catch (error) {
    console.error("unbound store cleanup failed", {
      storeId: targetStoreId,
      code: error?.code,
      requestId: requestIdFrom(error) || undefined,
      message: error?.message
    });
    return false;
  }
}

async function getProductCreationCapabilities() {
  let rows;
  try {
    rows = await executeSql(
      `SELECT
        EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'products'
        ) AS has_products,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'description'
        ) AS has_description,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'product_type'
        ) AS has_product_type,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'product_status'
        ) AS has_product_status,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'idempotency_key'
        ) AS has_idempotency_key,
        EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = 'products'
            AND indexname = 'uq_products_normalized_name'
        ) AS has_unique_product_name,
        COALESCE((
          SELECT column_default
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'product_code'
          LIMIT 1
        ), '') AS product_code_default`
    );
  } catch (error) {
    asDatabaseError(error, "读取项目表结构");
  }
  const row = rows?.[0] || {};
  if (!databaseBoolean(row.has_products)) {
    fail("数据库缺少 products 表，请先执行完整数据库建表脚本", "DATABASE_SCHEMA_MISSING");
  }
  if (!databaseBoolean(row.has_product_type) || !databaseBoolean(row.has_product_status)) {
    fail("products 表缺少基础字段，请先执行完整数据库建表脚本", "DATABASE_SCHEMA_MISSING");
  }
  const baseReady = databaseBoolean(row.has_description) &&
    databaseBoolean(row.has_idempotency_key) &&
    Boolean(String(row.product_code_default || "").trim());
  if (!baseReady) {
    fail("项目表尚未完成升级，请先执行 018_product_creation_idempotency.sql", "DATABASE_SCHEMA_MISSING");
  }
  if (!databaseBoolean(row.has_unique_product_name)) {
    fail("项目表尚未启用名称唯一约束，请先执行 019_unique_product_name.sql", "DATABASE_SCHEMA_MISSING");
  }
  return { ready: true };
}

function productInputFromEvent(event) {
  const clientRequestId = String(event.clientRequestId || "").trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientRequestId)) {
    fail("项目创建请求编号格式无效", "BAD_REQUEST");
  }
  const description = String(event.description || "").trim();
  if (description.length > 1000) fail("项目介绍不能超过 1000 个字符", "BAD_REQUEST");
  return {
    productName: requiredText(event.productName, "项目名称", 100),
    productType: requiredText(event.productType, "项目类别", 32),
    description,
    clientRequestId
  };
}

async function findProductByRequestId(clientRequestId) {
  let rows;
  try {
    rows = await executeSql(
      `SELECT id, product_code, product_name, product_type, description, product_status,
              created_at, updated_at
       FROM public.products
       WHERE idempotency_key = ${sqlText(clientRequestId)}
       LIMIT 1`
    );
  } catch (error) {
    asDatabaseError(error, "读取项目创建请求");
  }
  return rows?.[0] || null;
}

async function findProductByName(productName) {
  let rows;
  try {
    rows = await executeSql(
      `SELECT id, product_code, product_name, product_type, description, product_status,
              created_at, updated_at
       FROM public.products
       WHERE LOWER(BTRIM(product_name)) = LOWER(BTRIM(${sqlText(productName)}))
       ORDER BY id ASC
       LIMIT 1`
    );
  } catch (error) {
    asDatabaseError(error, "检查项目名称");
  }
  return rows?.[0] || null;
}

function failProductNameExists(product) {
  const code = String(product?.product_code || "").trim();
  fail(`已存在同名项目${code ? `（${code}）` : ""}，不能重复创建`, "PRODUCT_NAME_EXISTS");
}

function assertSameProductRequest(product, input) {
  const same = String(product?.product_name || "").trim() === input.productName &&
    String(product?.product_type || "").trim() === input.productType &&
    String(product?.description || "").trim() === input.description;
  if (!same) {
    fail("同一项目创建请求编号已用于其他项目，请刷新创建页面后重试", "IDEMPOTENCY_CONFLICT");
  }
}

async function createProductRecord(event) {
  const input = productInputFromEvent(event);
  await getProductCreationCapabilities();
  const recovered = await findProductByRequestId(input.clientRequestId);
  if (recovered) {
    assertSameProductRequest(recovered, input);
    return { product: recovered, created: false };
  }
  const duplicateName = await findProductByName(input.productName);
  if (duplicateName) failProductNameExists(duplicateName);

  let rows;
  try {
    rows = await executeSql(
      `WITH created_product AS (
         INSERT INTO public.products
           (product_name, product_type, description, product_status, idempotency_key)
         VALUES
           (${sqlText(input.productName)}, ${sqlText(input.productType)}, ${sqlText(input.description)},
            'ACTIVE', ${sqlText(input.clientRequestId)})
         RETURNING id, product_code, product_name, product_type, description, product_status,
                   created_at, updated_at
       )
       SELECT id, product_code, product_name, product_type, description, product_status,
              created_at, updated_at
       FROM created_product`
    );
  } catch (error) {
    try {
      const concurrent = await findProductByRequestId(input.clientRequestId);
      if (concurrent) {
        assertSameProductRequest(concurrent, input);
        return { product: concurrent, created: false };
      }
      const concurrentName = await findProductByName(input.productName);
      if (concurrentName) failProductNameExists(concurrentName);
    } catch (recoveryError) {
      if (["IDEMPOTENCY_CONFLICT", "PRODUCT_NAME_EXISTS"].includes(recoveryError?.code)) {
        throw recoveryError;
      }
    }
    asDatabaseError(error, "创建项目资料");
  }
  // CloudBase executePGSql can report a successful writable statement without
  // exposing the rows produced by RETURNING. Always read the persisted record
  // back through a plain SELECT before deciding that creation failed. The
  // idempotency key makes this safe for retries and concurrent submissions.
  const returnedProduct = rows?.[0];
  const product = returnedProduct?.id && returnedProduct?.product_code
    ? returnedProduct
    : await findProductByRequestId(input.clientRequestId);
  if (!product?.id || !product?.product_code) {
    fail("项目创建后数据库未返回项目编号", "DATABASE_ERROR");
  }
  assertSameProductRequest(product, input);
  return { product, created: true };
}

async function requireRetailProductSchema() {
  if (retailProductCapabilities) return retailProductCapabilities;
  let rows;
  try {
    rows = await executeSql(
      `SELECT
         (SELECT COUNT(*)::integer
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'retail_products'
            AND column_name IN (
              'id', 'product_code', 'product_name', 'product_status', 'idempotency_key',
              'created_by_staff_account_id', 'updated_by_staff_account_id', 'created_at', 'updated_at'
            )) AS column_count,
         EXISTS (
           SELECT 1 FROM pg_indexes
           WHERE schemaname = 'public' AND tablename = 'retail_products'
             AND indexname = 'uq_retail_products_normalized_name'
         ) AS has_unique_name,
         EXISTS (
           SELECT 1 FROM pg_indexes
           WHERE schemaname = 'public' AND tablename = 'retail_products'
             AND indexname = 'uq_retail_products_idempotency_key'
         ) AS has_idempotency,
         EXISTS (
           SELECT 1
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relname = 'retail_products'
             AND t.tgname = 'trg_060_prevent_retail_product_delete' AND NOT t.tgisinternal
         ) AS has_delete_guard`
    );
  } catch (error) {
    asDatabaseError(error, "读取独立产品表结构");
  }
  const row = rows?.[0] || {};
  const ready = Number(row.column_count || 0) === 9 &&
    databaseBoolean(row.has_unique_name) &&
    databaseBoolean(row.has_idempotency) &&
    databaseBoolean(row.has_delete_guard);
  if (!ready) {
    fail("产品数据库尚未升级，请先执行 060-01-retail-products.sql", "DATABASE_SCHEMA_MISSING");
  }
  retailProductCapabilities = { ready: true };
  return retailProductCapabilities;
}

function retailProductInputFromEvent(event) {
  const clientRequestId = String(event.clientRequestId || "").trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientRequestId)) {
    fail("产品创建请求编号格式无效", "BAD_REQUEST");
  }
  return {
    productName: requiredText(event.productName, "产品名称", 100),
    clientRequestId
  };
}

async function findRetailProductByRequestId(clientRequestId) {
  let rows;
  try {
    rows = await executeSql(
      `SELECT id, product_code, product_name, product_status, created_at, updated_at
       FROM public.retail_products
       WHERE idempotency_key = ${sqlText(clientRequestId)}
       LIMIT 1`
    );
  } catch (error) {
    asDatabaseError(error, "读取产品创建请求");
  }
  return rows?.[0] || null;
}

async function findRetailProductByName(productName) {
  let rows;
  try {
    rows = await executeSql(
      `SELECT id, product_code, product_name, product_status, created_at, updated_at
       FROM public.retail_products
       WHERE LOWER(BTRIM(product_name)) = LOWER(BTRIM(${sqlText(productName)}))
       ORDER BY id ASC
       LIMIT 1`
    );
  } catch (error) {
    asDatabaseError(error, "检查产品名称");
  }
  return rows?.[0] || null;
}

async function findRetailProductByReference(productRef) {
  const value = String(productRef || "").trim();
  if (!value) fail("缺少产品编号", "BAD_REQUEST");
  const idCondition = /^\d+$/.test(value) ? `id = ${numericId(value, "产品编号")}` : "FALSE";
  let rows;
  try {
    rows = await executeSql(
      `SELECT id, product_code, product_name, product_status, created_at, updated_at
       FROM public.retail_products
       WHERE (${idCondition}) OR product_code = ${sqlText(value)}
       LIMIT 1`
    );
  } catch (error) {
    asDatabaseError(error, "读取产品资料");
  }
  return rows?.[0] || null;
}

function assertSameRetailProductRequest(product, input) {
  if (String(product?.product_name || "").trim() !== input.productName) {
    fail("同一产品创建请求编号已用于其他产品，请刷新页面后重试", "IDEMPOTENCY_CONFLICT");
  }
}

async function createRetailProductRecord(caller, event) {
  await requireRetailProductSchema();
  const input = retailProductInputFromEvent(event);
  const recovered = await findRetailProductByRequestId(input.clientRequestId);
  if (recovered) {
    assertSameRetailProductRequest(recovered, input);
    return { product: recovered, created: false };
  }
  const duplicate = await findRetailProductByName(input.productName);
  if (duplicate) {
    const code = String(duplicate.product_code || "").trim();
    fail(`已存在同名产品${code ? `（${code}）` : ""}，请直接激活原产品`, "RETAIL_PRODUCT_NAME_EXISTS");
  }
  const actorId = numericId(caller.profile.staffId, "总部账号编号");
  let rows;
  try {
    rows = await executeSql(
      `WITH created_product AS (
         INSERT INTO public.retail_products
           (product_name, product_status, idempotency_key, created_by_staff_account_id, updated_by_staff_account_id)
         VALUES
           (${sqlText(input.productName)}, 'ACTIVE', ${sqlText(input.clientRequestId)}, ${actorId}, ${actorId})
         RETURNING id, product_code, product_name, product_status, created_at, updated_at
       )
       SELECT id, product_code, product_name, product_status, created_at, updated_at
       FROM created_product`
    );
  } catch (error) {
    const concurrentRequest = await findRetailProductByRequestId(input.clientRequestId).catch(() => null);
    if (concurrentRequest) {
      assertSameRetailProductRequest(concurrentRequest, input);
      return { product: concurrentRequest, created: false };
    }
    const concurrentName = await findRetailProductByName(input.productName).catch(() => null);
    if (concurrentName) {
      const code = String(concurrentName.product_code || "").trim();
      fail(`已存在同名产品${code ? `（${code}）` : ""}，请直接激活原产品`, "RETAIL_PRODUCT_NAME_EXISTS");
    }
    asDatabaseError(error, "创建产品资料");
  }
  const returned = rows?.[0];
  const product = returned?.id && returned?.product_code
    ? returned
    : await findRetailProductByRequestId(input.clientRequestId);
  if (!product?.id || !product?.product_code) {
    fail("产品创建后数据库未返回产品编号", "DATABASE_ERROR");
  }
  assertSameRetailProductRequest(product, input);
  return { product, created: true };
}

async function requireProductTemplateSchema() {
  if (productTemplateCapabilities) return productTemplateCapabilities;
  let rows;
  try {
    rows = await executeSql(
      `SELECT COUNT(*)::integer AS column_count
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'products'
         AND column_name IN (
           'receipt_logo_file_id', 'receipt_logo_mime_type', 'receipt_logo_original_name',
           'receipt_logo_bytes', 'receipt_logo_width', 'receipt_logo_height',
           'verification_receipt_instructions', 'recharge_receipt_instructions',
           'receipt_template_updated_by', 'receipt_template_updated_at'
         )`
    );
  } catch (error) {
    asDatabaseError(error, "读取项目单据模板结构");
  }
  if (Number(rows?.[0]?.column_count || 0) !== 10) {
    fail("项目模板数据库尚未升级，请先执行 045-01-product-receipt-templates.sql", "DATABASE_SCHEMA_MISSING");
  }
  productTemplateCapabilities = { ready: true };
  return productTemplateCapabilities;
}

function productReferenceCondition(productRef, alias = "p") {
  const value = String(productRef || "").trim();
  if (!value) fail("缺少项目编号", "BAD_REQUEST");
  const id = /^\d+$/.test(value) ? numericId(value, "项目编号") : null;
  return `((${id ? `${alias}.id = ${id}` : "FALSE"}) OR ${alias}.product_code = ${sqlText(value)})`;
}

async function productTemplateRow(productRef) {
  await requireProductTemplateSchema();
  let rows;
  try {
    rows = await executeSql(
      `SELECT p.id, p.product_code, p.product_name, p.product_type, p.description,
              p.product_status, p.receipt_logo_file_id, p.receipt_logo_mime_type,
              p.receipt_logo_original_name, p.receipt_logo_bytes,
              p.receipt_logo_width, p.receipt_logo_height,
              p.verification_receipt_instructions, p.recharge_receipt_instructions,
              p.receipt_template_updated_at, updater.staff_name AS receipt_template_updated_by_name,
              p.created_at, p.updated_at
       FROM public.products p
       LEFT JOIN public.staff_accounts updater ON updater.id = p.receipt_template_updated_by
       WHERE ${productReferenceCondition(productRef, "p")}
       LIMIT 1`
    );
  } catch (error) {
    asDatabaseError(error, "读取项目单据模板");
  }
  if (!rows?.[0]) fail("未找到该项目", "NOT_FOUND");
  return rows[0];
}

async function productTemplatePayload(row) {
  let logoUrl = "";
  let logoExpiresIn = 0;
  if (row.receipt_logo_file_id) {
    try {
      const signed = await signProductLogo(row.receipt_logo_file_id, 900);
      logoUrl = signed.url;
      logoExpiresIn = signed.expiresIn;
    } catch (error) {
      // Keep the persisted template readable when only the temporary public
      // URL signer is unavailable. Authenticated clients will use the guarded
      // getProductReceiptLogoData action and still verify the original bytes.
      console.warn("CloudBase product-logo signed read unavailable; using authenticated fallback", {
        code: error?.code,
        requestId: error?.requestId || requestIdFrom(error) || undefined
      });
    }
  }
  return {
    id: String(row.id),
    productCode: String(row.product_code || ""),
    productName: String(row.product_name || ""),
    productType: String(row.product_type || ""),
    description: String(row.description || ""),
    productStatus: String(row.product_status || ""),
    logo: row.receipt_logo_file_id ? {
      reference: String(row.receipt_logo_file_id),
      url: logoUrl,
      expiresIn: logoExpiresIn,
      mimeType: String(row.receipt_logo_mime_type || ""),
      originalName: String(row.receipt_logo_original_name || ""),
      bytes: Number(row.receipt_logo_bytes || 0),
      width: Number(row.receipt_logo_width || 0),
      height: Number(row.receipt_logo_height || 0)
    } : null,
    verificationInstructions: String(row.verification_receipt_instructions || ""),
    rechargeInstructions: String(row.recharge_receipt_instructions || ""),
    updatedAt: row.receipt_template_updated_at || null,
    updatedByName: String(row.receipt_template_updated_by_name || "")
  };
}

async function getProductReceiptTemplate(event) {
  return productTemplatePayload(await productTemplateRow(event.productRef));
}

function productLogoUploadInput(event) {
  const mimeType = String(event.mimeType || "").trim().toLowerCase();
  const bytes = Number(event.bytes);
  const width = Number(event.width);
  const height = Number(event.height);
  if (!PRODUCT_LOGO_TYPES.has(mimeType)) fail("项目 LOGO 仅支持 PNG、JPEG 或 WebP", "PRODUCT_LOGO_TYPE_INVALID");
  if (!Number.isSafeInteger(bytes) || bytes < 8 || bytes > PRODUCT_LOGO_MAX_BYTES) {
    fail("项目 LOGO 原图必须小于 8 MB", "PRODUCT_LOGO_TOO_LARGE");
  }
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)
      || width < 1 || height < 1 || width > 12000 || height > 12000) {
    fail("项目 LOGO 图片尺寸无效", "PRODUCT_LOGO_DIMENSIONS_INVALID");
  }
  const originalName = String(event.originalName || "logo").replace(/[\\/\u0000-\u001f<>:"|?*]/g, "_").trim().slice(0, 180) || "logo";
  return { mimeType, bytes, width, height, originalName };
}

async function beginProductLogoUpload(event) {
  const product = await productTemplateRow(event.productRef);
  const input = productLogoUploadInput(event);
  const storage = productTemplateStorageSettings();
  const token = crypto.randomBytes(18).toString("base64url");
  const objectName = `products/${Number(product.id)}/receipt-logo/${Date.now()}-${token}.${PRODUCT_LOGO_TYPES.get(input.mimeType)}`;
  let response;
  let upload;
  try {
    response = await manager().storage.signUploadObject({
      bucketId: storage.bucketId,
      objectName,
      upsert: false,
      accessToken: storage.accessToken,
      envId: storage.envId
    });
    upload = signedStorageUpload(response, storage, objectName, input.mimeType);
  } catch (error) {
    if (error?.code === "PRODUCT_LOGO_UPLOAD_SIGN_FAILED") throw error;
    throw productLogoStorageError(
      `项目 LOGO 上传地址生成失败：${error?.message || "请检查私有存储桶"}`,
      "PRODUCT_LOGO_UPLOAD_SIGN_FAILED",
      error,
      { operation: "signUploadObject", bucketId: storage.bucketId, objectName }
    );
  }
  return {
    productId: String(product.id),
    reference: `pg://${storage.bucketId}/${objectName}`,
    upload,
    expected: input
  };
}

async function persistProductLogo(caller, product, input, reference) {
  const previousReference = String(product.receipt_logo_file_id || "");
  try {
    await executeSql(
      `UPDATE public.products
       SET receipt_logo_file_id = ${sqlText(reference.reference)},
           receipt_logo_mime_type = ${sqlText(input.mimeType)},
           receipt_logo_original_name = ${sqlText(input.originalName)},
           receipt_logo_bytes = ${input.bytes},
           receipt_logo_width = ${input.width},
           receipt_logo_height = ${input.height},
           receipt_template_updated_by = ${numericId(caller.profile.staffId, "总部账号编号")},
           receipt_template_updated_at = NOW(), updated_at = NOW()
       WHERE id = ${Number(product.id)}`
    );
  } catch (error) {
    await deleteProductLogo(reference.reference);
    asDatabaseError(error, "保存项目 LOGO");
  }
  const persisted = await productTemplateRow(String(product.id));
  if (String(persisted.receipt_logo_file_id || "") !== reference.reference) {
    await deleteProductLogo(reference.reference);
    fail("项目 LOGO 保存后未能从数据库确认", "DATABASE_ERROR");
  }
  if (previousReference && previousReference !== reference.reference) void deleteProductLogo(previousReference);
  return productTemplatePayload(persisted);
}

async function deleteUnboundProductLogo(product, referenceValue) {
  const reference = String(referenceValue || "").trim();
  if (!reference || reference === String(product?.receipt_logo_file_id || "").trim()) return false;
  return deleteProductLogo(reference);
}

async function confirmProductLogoUpload(caller, event) {
  const product = await productTemplateRow(event.productRef);
  const input = productLogoUploadInput(event);
  const reference = parseProductLogoReference(event.reference);
  const storage = productTemplateStorageSettings();
  const requiredPrefix = `products/${Number(product.id)}/receipt-logo/`;
  if (reference.bucketId !== storage.bucketId || !reference.objectName.startsWith(requiredPrefix)) {
    fail("项目 LOGO 上传路径与当前项目不一致", "PRODUCT_LOGO_REFERENCE_INVALID");
  }
  try {
    await inspectProductLogo(reference.reference, input);
  } catch (error) {
    await deleteUnboundProductLogo(product, reference.reference);
    throw error;
  }
  return persistProductLogo(caller, product, input, reference);
}

async function uploadProductLogoByFunction(caller, event) {
  const product = await productTemplateRow(event.productRef);
  const input = productLogoUploadInput(event);
  const buffer = productLogoFunctionBuffer(event, input);
  const storage = productTemplateStorageSettings();
  const token = crypto.randomBytes(18).toString("base64url");
  const objectName = `products/${Number(product.id)}/receipt-logo/${Date.now()}-${token}.${PRODUCT_LOGO_TYPES.get(input.mimeType)}`;
  const referenceValue = `pg://${storage.bucketId}/${objectName}`;
  try {
    await manager().storage.uploadObject({
      bucketId: storage.bucketId,
      objectName,
      body: buffer,
      contentType: input.mimeType,
      contentLength: buffer.length,
      cacheControl: "private, max-age=31536000, immutable",
      upsert: false,
      accessToken: storage.accessToken,
      envId: storage.envId
    });
  } catch (error) {
    // manager-node 5.6.4 can throw after the storage gateway has already
    // committed the exact body when the successful response omits Id/Key.
    // The immutable object path and bytes were both chosen and validated by
    // this function, so that one known post-commit response mismatch is safe.
    if (storageUploadResponseMismatch(error)) {
      console.warn("CloudBase product-logo fallback upload succeeded without Id/Key response metadata", {
        bucketId: storage.bucketId,
        objectName
      });
    } else {
      await deleteUnboundProductLogo(product, referenceValue);
      throw productLogoStorageError(
        `项目 LOGO 安全备用上传失败：${error?.message || "请检查私有存储桶"}`,
        "PRODUCT_LOGO_FUNCTION_UPLOAD_FAILED",
        error,
        { operation: "uploadObject", bucketId: storage.bucketId, objectName }
      );
    }
  }
  const reference = parseProductLogoReference(referenceValue);
  try {
    await inspectProductLogo(reference.reference, input);
  } catch (error) {
    await deleteUnboundProductLogo(product, reference.reference);
    throw error;
  }
  return persistProductLogo(caller, product, input, reference);
}

async function discardProductLogoUpload(caller, event) {
  const product = await productTemplateRow(event.productRef);
  const reference = parseProductLogoReference(event.reference);
  const storage = productTemplateStorageSettings();
  const requiredPrefix = `products/${Number(product.id)}/receipt-logo/`;
  if (reference.bucketId !== storage.bucketId || !reference.objectName.startsWith(requiredPrefix)) {
    fail("项目 LOGO 上传路径与当前项目不一致", "PRODUCT_LOGO_REFERENCE_INVALID");
  }
  const currentlyBound = reference.reference === String(product.receipt_logo_file_id || "");
  const discarded = currentlyBound ? false : await deleteProductLogo(reference.reference);
  return { discarded, currentlyBound };
}

async function saveProductReceiptTemplate(caller, event) {
  const product = await productTemplateRow(event.productRef);
  const verificationInstructions = String(event.verificationInstructions || "").trim();
  const rechargeInstructions = String(event.rechargeInstructions || "").trim();
  if (verificationInstructions.length > 3000 || rechargeInstructions.length > 3000) {
    fail("单据文字说明不能超过 3000 字", "BAD_REQUEST");
  }
  try {
    await executeSql(
      `UPDATE public.products
       SET verification_receipt_instructions = ${sqlText(verificationInstructions)},
           recharge_receipt_instructions = ${sqlText(rechargeInstructions)},
           receipt_template_updated_by = ${numericId(caller.profile.staffId, "总部账号编号")},
           receipt_template_updated_at = NOW(), updated_at = NOW()
       WHERE id = ${Number(product.id)}`
    );
  } catch (error) {
    asDatabaseError(error, "保存项目单据说明");
  }
  return getProductReceiptTemplate({ productRef: String(product.id) });
}

async function removeProductReceiptLogo(caller, event) {
  const product = await productTemplateRow(event.productRef);
  const reference = String(product.receipt_logo_file_id || "");
  try {
    await executeSql(
      `UPDATE public.products
       SET receipt_logo_file_id = NULL, receipt_logo_mime_type = NULL,
           receipt_logo_original_name = NULL, receipt_logo_bytes = NULL,
           receipt_logo_width = NULL, receipt_logo_height = NULL,
           receipt_template_updated_by = ${numericId(caller.profile.staffId, "总部账号编号")},
           receipt_template_updated_at = NOW(), updated_at = NOW()
       WHERE id = ${Number(product.id)}`
    );
  } catch (error) {
    asDatabaseError(error, "移除项目 LOGO");
  }
  if (reference) void deleteProductLogo(reference);
  return getProductReceiptTemplate({ productRef: String(product.id) });
}

async function getProductReceiptLogoData(event) {
  const row = await productTemplateRow(event.productRef);
  if (!row.receipt_logo_file_id) fail("该项目尚未上传 LOGO", "PRODUCT_LOGO_MISSING");
  const reference = String(row.receipt_logo_file_id || "").trim();
  const expectedReference = String(event.expectedReference || "").trim();
  if (expectedReference && expectedReference !== reference) {
    fail("项目 LOGO 已更新，请重新读取项目模板", "PRODUCT_LOGO_CHANGED");
  }
  const mimeType = String(row.receipt_logo_mime_type || "").trim().toLowerCase();
  if (!PRODUCT_LOGO_TYPES.has(mimeType)) fail("项目 LOGO 保存类型无效", "PRODUCT_LOGO_TYPE_INVALID");
  const expectedBytes = Number(row.receipt_logo_bytes || 0);
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 8 || expectedBytes > PRODUCT_LOGO_MAX_BYTES) {
    fail("项目 LOGO 原图大小记录无效", "PRODUCT_LOGO_SIZE_MISMATCH");
  }
  const hasChunkRequest = Object.prototype.hasOwnProperty.call(event, "chunkOffset")
    || Object.prototype.hasOwnProperty.call(event, "chunkLength");
  if (expectedBytes > PRODUCT_LOGO_FUNCTION_MAX_BYTES && !hasChunkRequest) {
    return {
      reference,
      mimeType,
      bytes: expectedBytes,
      chunked: true,
      chunkSize: PRODUCT_LOGO_CHUNK_BYTES
    };
  }
  if (hasChunkRequest) {
    if (!expectedReference) fail("分块读取必须绑定当前 LOGO 引用", "PRODUCT_LOGO_REFERENCE_REQUIRED");
    const chunkOffset = Number(event.chunkOffset);
    const chunkLength = Number(event.chunkLength);
    const requiredLength = Math.min(PRODUCT_LOGO_CHUNK_BYTES, expectedBytes - chunkOffset);
    if (!Number.isSafeInteger(chunkOffset) || chunkOffset < 0 || chunkOffset >= expectedBytes
        || chunkOffset % PRODUCT_LOGO_CHUNK_BYTES !== 0
        || !Number.isSafeInteger(chunkLength) || chunkLength !== requiredLength) {
      fail("项目 LOGO 分块范围无效", "PRODUCT_LOGO_RANGE_INVALID");
    }
    const chunkEnd = chunkOffset + chunkLength - 1;
    const buffer = await downloadProductLogo(reference, chunkLength, {
      range: `bytes=${chunkOffset}-${chunkEnd}`,
      expectedRange: { start: chunkOffset, end: chunkEnd, total: expectedBytes }
    });
    return {
      reference,
      mimeType,
      bytes: expectedBytes,
      chunked: true,
      chunkSize: PRODUCT_LOGO_CHUNK_BYTES,
      chunkOffset,
      chunkBytes: buffer.length,
      base64: buffer.toString("base64")
    };
  }
  const buffer = await downloadProductLogo(reference, PRODUCT_LOGO_FUNCTION_MAX_BYTES, { cache: true });
  if (buffer.length !== expectedBytes) {
    fail("项目 LOGO 原图大小与数据库记录不一致", "PRODUCT_LOGO_SIZE_MISMATCH");
  }
  if (!productLogoMagicMatches(buffer, mimeType)) {
    fail("项目 LOGO 原图格式与数据库记录不一致", "PRODUCT_LOGO_FORMAT_INVALID");
  }
  const dimensions = productLogoDimensions(buffer, mimeType);
  if (dimensions.width !== Number(row.receipt_logo_width || 0)
      || dimensions.height !== Number(row.receipt_logo_height || 0)) {
    fail("项目 LOGO 原图尺寸与数据库记录不一致", "PRODUCT_LOGO_DIMENSIONS_MISMATCH");
  }
  return {
    reference,
    mimeType,
    bytes: buffer.length,
    base64: buffer.toString("base64")
  };
}

function reviewFilterSql(event, alias, recordCodeExpression, statusExpression, typeExpression) {
  const clauses = [];
  const recordId = String(event.recordId || "").trim();
  const recordCode = String(event.recordCode || "").trim().toUpperCase();
  const storeId = String(event.storeId || "").trim();
  const status = String(event.status || "").trim().toUpperCase();
  const applicationType = String(event.applicationType || "").trim().toUpperCase();
  if (recordId) clauses.push(`${alias}.id = ${numericId(recordId, "工单编号")}`);
  if (recordCode) {
    if (!/^[A-Z0-9_-]{2,40}$/.test(recordCode)) fail("工单编号格式不正确", "BAD_REQUEST");
    clauses.push(`UPPER(${recordCodeExpression}) = ${sqlText(recordCode)}`);
  }
  if (storeId) clauses.push(`${alias}.store_id = ${numericId(storeId, "门店编号")}`);
  if (["PENDING", "APPROVED", "REJECTED"].includes(status)) clauses.push(`${statusExpression} = ${sqlText(status)}`);
  if (applicationType) clauses.push(`${typeExpression} = ${sqlText(applicationType)}`);
  return clauses.length ? `AND ${clauses.join(" AND ")}` : "";
}

function reviewOrderTeacherAttributionCondition(alias, recordType) {
  const recharge = recordType === "RECHARGE";
  const storeTypeCondition = recharge
    ? `${alias}.recharge_type IN ('NEW', 'REFUND')`
    : `${alias}.verification_type = 'NORMAL'`;
  const teacherTypeCondition = recharge
    ? `${alias}.recharge_type IN ('NEW', 'REFUND')`
    : `${alias}.verification_type IN ('NORMAL', 'EXPERIENCE')`;
  return `EXISTS (
    SELECT 1
      FROM public.staff_accounts attribution_submitter
 LEFT JOIN public.teachers attribution_submitter_teacher
        ON attribution_submitter_teacher.staff_account_id = attribution_submitter.id
     WHERE attribution_submitter.id = ${alias}.submitted_by_account_id
       AND (
         (attribution_submitter.role_code = 'store' AND ${storeTypeCondition})
         OR (
           attribution_submitter.role_code = 'teacher'
           AND attribution_submitter_teacher.id = ${alias}.teacher_id
           AND ${teacherTypeCondition}
         )
       )
  )`;
}

async function hasRechargeProductGiftSchema() {
  if (rechargeProductGiftSchemaReady !== null) return rechargeProductGiftSchemaReady;
  const rows = await executeSql(
    `SELECT TO_REGCLASS('public.recharge_product_gifts') IS NOT NULL AS ready`
  );
  rechargeProductGiftSchemaReady = databaseBoolean(rows?.[0]?.ready);
  return rechargeProductGiftSchemaReady;
}

async function listReviewOrders(caller, event) {
  const exactLookup = Boolean(String(event.recordId || "").trim() || String(event.recordCode || "").trim());
  const storeReader = caller.profile?.role === "store";
  if (storeReader) {
    requireStore(caller);
    if (!exactLookup) fail("门店只能按精确工单编号读取本门店工单", "FORBIDDEN");
  } else {
    requireReviewer(caller);
  }
  const recordType = String(event.recordType || "").trim().toUpperCase();
  if (!["RECHARGE", "VERIFICATION"].includes(recordType)) fail("不支持的审核工单类型", "BAD_REQUEST");
  const scopedEvent = storeReader ? { ...event, storeId: caller.profile.storeId } : event;
  const reviewListEvent = scopedEvent;
  const paged = event.paged === true && !exactLookup && !storeReader;
  const requestedLimit = Number(event.limit);
  const limit = storeReader ? 1 : paged
    ? Math.min(Math.max(Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : 100, 1), 100)
    : Math.min(Math.max(Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : 200, 1), 500);

  // Cursor pagination remains available to existing callers. The review
  // workbenches use pageNumber so an HQ reviewer can jump to any valid page
  // without first loading every prior page in the browser.
  const pageNumberValue = event.pageNumber;
  const hasPageNumber = pageNumberValue !== undefined && pageNumberValue !== null && String(pageNumberValue).trim() !== "";
  let requestedPageNumber = 1;
  if (hasPageNumber) {
    requestedPageNumber = Number(pageNumberValue);
    if (!Number.isSafeInteger(requestedPageNumber) || requestedPageNumber < 1 || requestedPageNumber > 10000) {
      fail("审核列表页码必须是 1 到 10000 之间的整数", "BAD_REQUEST");
    }
    if (!paged) fail("只有按条件读取的总部审核列表可以使用页码", "BAD_REQUEST");
  }

  const cursorApplicationTime = String(event.cursorApplicationTime || "").trim();
  const cursorIdValue = String(event.cursorId || "").trim();
  const hasCursor = Boolean(cursorApplicationTime || cursorIdValue || event.cursorPending !== undefined);
  if (hasCursor && hasPageNumber) fail("审核列表不能同时使用页码与游标", "BAD_REQUEST");
  if (hasCursor && (!paged || !cursorApplicationTime || !cursorIdValue || typeof event.cursorPending !== "boolean")) {
    fail("审核列表游标不完整", "BAD_REQUEST");
  }
  if (cursorApplicationTime && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(cursorApplicationTime)) {
    fail("审核列表游标时间无效", "BAD_REQUEST");
  }
  if (cursorApplicationTime) {
    const parsedCursorTime = new Date(cursorApplicationTime);
    if (Number.isNaN(parsedCursorTime.getTime())
      || parsedCursorTime.toISOString().slice(0, 19) !== cursorApplicationTime.slice(0, 19)) {
      fail("审核列表游标时间无效", "BAD_REQUEST");
    }
  }
  const cursorId = cursorIdValue ? numericId(cursorIdValue, "审核列表游标编号") : "";
  const pageOffsetPagination = paged && hasPageNumber;
  const sqlLimit = paged && !pageOffsetPagination ? limit + 1 : limit;
  const rechargeProductGiftSelect = recordType === "RECHARGE" && exactLookup && await hasRechargeProductGiftSchema()
    ? `(SELECT COALESCE(JSONB_AGG(JSONB_BUILD_OBJECT(
           'id', gift.id,
           'retailProductId', gift.retail_product_id,
           'productCode', gift.product_code_snapshot,
           'productName', gift.product_name_snapshot,
           'unitCount', gift.unit_count,
           'displayOrder', gift.display_order
         ) ORDER BY gift.display_order, gift.id), '[]'::jsonb)
          FROM public.recharge_product_gifts gift
         WHERE gift.recharge_id = r.id)`
    : `'[]'::jsonb`;
  let sql;
  let countSql = "";
  if (recordType === "RECHARGE") {
    const statusExpression = exactLookup ? "CASE WHEN r.void_request_status <> 'NONE' THEN r.void_request_status ELSE r.record_status END" : "r.record_status";
    const typeExpression = exactLookup ? "CASE WHEN r.void_request_status <> 'NONE' THEN 'VOID' ELSE r.recharge_type END" : "r.recharge_type";
    const timeExpression = exactLookup ? "CASE WHEN r.void_request_status <> 'NONE' THEN r.void_requested_at ELSE r.submitted_at END" : "r.submitted_at";
    const cursorClause = hasCursor
      ? `AND ((${statusExpression} = 'PENDING')::int, ${timeExpression}, r.id) < (${event.cursorPending ? 1 : 0}, ${sqlText(cursorApplicationTime)}::timestamptz, ${cursorId}::bigint)`
      : "";
    const fromSql = `FROM public.recharge_records r
             JOIN public.stores s ON s.id = r.store_id
             JOIN public.customers c ON c.id = r.customer_id
             JOIN public.products p ON p.id = r.product_id
        LEFT JOIN public.teachers t
               ON t.id = r.teacher_id
              AND ${reviewOrderTeacherAttributionCondition("r", "RECHARGE")}`;
    const whereSql = `WHERE ${exactLookup ? "TRUE" : "r.recharge_type IN ('NEW', 'REFUND')"}
              ${reviewFilterSql(reviewListEvent, "r", "r.recharge_code", statusExpression, typeExpression)}
              ${cursorClause}`;
    sql = `SELECT r.id, r.recharge_code AS record_code, 'RECHARGE'::text AS record_type,
                  ${typeExpression} AS application_type,
                  ${statusExpression} AS application_status,
                  ${timeExpression} AS application_time,
                  TO_CHAR(${timeExpression} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_application_time,
                  r.record_status AS original_status, r.recharge_type AS original_type,
                  r.unit_count, r.balance_before_count, r.balance_after_count,
                  r.message AS initial_store_note, r.review_note AS initial_review_note,
                  r.submitted_at AS original_submitted_at, r.reviewed_at AS original_reviewed_at,
                  r.void_request_status, r.void_request_note, r.void_requested_at,
                  r.void_review_note, r.void_reviewed_at,
                  s.id AS store_id, s.store_code, s.store_name,
                  s.province AS store_province, s.city AS store_city,
                  s.district AS store_district, s.address_detail AS store_address_detail,
                  c.id AS customer_id, c.customer_code, c.customer_name,
                  p.id AS product_id, p.product_code, p.product_name,
                  t.id AS teacher_id, t.teacher_code, t.teacher_name,
                  ${rechargeProductGiftSelect} AS product_gifts
             ${fromSql}
             ${whereSql}
         ORDER BY (${statusExpression} = 'PENDING') DESC, ${timeExpression} DESC, r.id DESC`;
    countSql = `SELECT COUNT(*) AS total ${fromSql} ${whereSql}`;
  } else {
    const statusExpression = "v.record_status";
    const typeExpression = "v.verification_type";
    const timeExpression = "v.submitted_at";
    const cursorClause = hasCursor
      ? `AND ((${statusExpression} = 'PENDING')::int, ${timeExpression}, v.id) < (${event.cursorPending ? 1 : 0}, ${sqlText(cursorApplicationTime)}::timestamptz, ${cursorId}::bigint)`
      : "";
    const fromSql = `FROM public.verification_records v
             JOIN public.stores s ON s.id = v.store_id
             JOIN public.customers c ON c.id = v.customer_id
             JOIN public.products p ON p.id = v.product_id
        LEFT JOIN public.teachers t
               ON t.id = v.teacher_id
              AND ${reviewOrderTeacherAttributionCondition("v", "VERIFICATION")}`;
    const whereSql = `WHERE ${exactLookup && event.detailRead === true ? "TRUE" : "v.verification_type = 'SUPPLEMENT' AND v.void_request_status = 'NONE'"}
              ${reviewFilterSql(scopedEvent, "v", "v.verification_code", statusExpression, typeExpression)}
              ${cursorClause}`;
    sql = `SELECT v.id, v.verification_code AS record_code, 'VERIFICATION'::text AS record_type,
                  ${typeExpression} AS application_type,
                  ${statusExpression} AS application_status,
                  ${timeExpression} AS application_time,
                  TO_CHAR(${timeExpression} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_application_time,
                  v.record_status AS original_status, v.verification_type AS original_type,
                  v.unit_count, v.message AS initial_store_note, v.review_note AS initial_review_note,
                  v.supplement_note, v.submitted_at AS original_submitted_at,
                  v.reviewed_at AS original_reviewed_at,
                  v.void_request_status, v.void_request_note, v.void_requested_at,
                  v.void_review_note, v.void_reviewed_at,
                  s.id AS store_id, s.store_code, s.store_name,
                  s.province AS store_province, s.city AS store_city,
                  s.district AS store_district, s.address_detail AS store_address_detail,
                  c.id AS customer_id, c.customer_code, c.customer_name,
                  p.id AS product_id, p.product_code, p.product_name,
                  t.id AS teacher_id, t.teacher_code, t.teacher_name
             ${fromSql}
             ${whereSql}
         ORDER BY (${statusExpression} = 'PENDING') DESC, ${timeExpression} DESC, v.id DESC`;
    countSql = `SELECT COUNT(*) AS total ${fromSql} ${whereSql}`;
  }
  try {
    if (pageOffsetPagination) {
      const countRows = await executeSql(countSql);
      const total = Number(countRows?.[0]?.total || 0);
      if (!Number.isSafeInteger(total) || total < 0) fail("审核列表总数读取失败", "DATABASE_ERROR");
      const totalPages = Math.max(1, Math.ceil(total / limit));
      // The data can change between a page jump and this count. Clamp a stale
      // page number to the final page instead of rendering an empty workbench.
      const pageNumber = Math.min(requestedPageNumber, totalPages);
      const pageOffset = (pageNumber - 1) * limit;
      const orders = await executeSql(`${sql} LIMIT ${limit} OFFSET ${pageOffset}`);
      const stores = pageNumber === 1
        ? await executeSql(`SELECT id AS store_id, store_code, store_name FROM public.stores ORDER BY store_name, store_code, id`)
        : [];
      return {
        orders,
        total,
        pageNumber,
        pageSize: limit,
        totalPages,
        hasMore: pageNumber < totalPages,
        nextCursor: null,
        stores
      };
    }

    const rows = await executeSql(`${sql} LIMIT ${sqlLimit}`);
    if (!paged) return rows;
    const hasMore = rows.length > limit;
    const orders = rows.slice(0, limit);
    const last = orders[orders.length - 1];
    const stores = !hasCursor
      ? await executeSql(`SELECT id AS store_id, store_code, store_name FROM public.stores ORDER BY store_name, store_code, id`)
      : [];
    return {
      orders,
      hasMore,
      nextCursor: hasMore && last ? {
        pending: String(last.application_status || "").toUpperCase() === "PENDING",
        applicationTime: last.cursor_application_time,
        id: String(last.id)
      } : null,
      stores
    };
  } catch (error) {
    asDatabaseError(error, "读取审核工单");
  }
}

async function requestOrderVoid(caller, event) {
  requireStore(caller);
  if (!ORDER_VOID_APPLICATIONS_ENABLED) {
    fail("充值单不再提供作废申请；历史记录仍保留只读", "ORDER_VOID_DISABLED");
  }
  const recordType = String(event.recordType || "").trim().toUpperCase();
  if (recordType !== "RECHARGE") {
    fail("核销工单不再支持作废；如需补回次数，请提交充值工单", "VERIFICATION_VOID_DISABLED");
  }
  const recordId = numericId(event.recordId || event.verificationId, "工单编号");
  const note = String(event.note || event.voidNote || "").trim();
  if (!note) fail("提交作废申请必须填写说明", "VOID_NOTE_REQUIRED");
  if (note.length > 1000) fail("作废说明不能超过 1000 个字符", "BAD_REQUEST");
  let rows;
  try {
    rows = await executeSql(
      `SELECT record_id, record_code, record_status, void_request_status, void_requested_at
         FROM public.request_order_void(${sqlText(recordType)}, ${recordId},
              ${numericId(caller.profile.staffId, "当前门店账号")}, ${sqlText(note)})`
    );
  } catch (error) {
    if (/order type cannot request a void/i.test(String(error?.message || ""))) {
      fail("仅已通过的正常充值可以申请作废", "VOID_TYPE_NOT_ALLOWED");
    }
    asDatabaseError(error, "提交作废申请");
  }
  if (!rows?.[0]) fail("未找到该工单", "NOT_FOUND");
  return rows[0];
}

async function requireRetailProductPurchaseSchema() {
  const rows = await executeSql(
    `SELECT TO_REGCLASS('public.retail_product_purchase_records') IS NOT NULL AS has_table,
            TO_REGPROCEDURE('public.review_retail_product_purchase(bigint,bigint,text,text)') IS NOT NULL AS has_review`
  );
  if (!databaseBoolean(rows?.[0]?.has_table) || !databaseBoolean(rows?.[0]?.has_review)) {
    fail("产品购买数据库尚未启用，请先执行迁移 062。", "DATABASE_SCHEMA_MISSING");
  }
}

async function listRetailProductPurchaseReviews(caller, event = {}) {
  requireReviewer(caller);
  await requireRetailProductPurchaseSchema();
  if (!await hasRechargeProductGiftSchema()) {
    fail("充值产品赠送数据库尚未启用，请先执行迁移 061。", "DATABASE_SCHEMA_MISSING");
  }
  const status = String(event.status || "").trim().toUpperCase();
  if (status && !["PENDING", "APPROVED", "REJECTED"].includes(status)) fail("审核状态无效", "BAD_REQUEST");
  const requestedSourceType = String(event.sourceType || "").trim().toUpperCase();
  if (requestedSourceType && !["PURCHASE", "GIFT"].includes(requestedSourceType)) fail("产品来源无效", "BAD_REQUEST");
  const purchaseCode = String(event.purchaseCode || "").trim().toUpperCase();
  if (purchaseCode && !/^PP\d{14}$/.test(purchaseCode)) fail("请输入完整产品购买单号", "BAD_REQUEST");
  const recordCode = String(event.recordCode || purchaseCode || "").trim().toUpperCase();
  if (recordCode && !/^(?:PP\d{14}|RC\d{12})$/.test(recordCode)) fail("请输入完整产品工单号", "BAD_REQUEST");
  const sourceType = purchaseCode ? "PURCHASE"
    : recordCode.startsWith("PP") ? "PURCHASE"
      : recordCode.startsWith("RC") ? "GIFT"
        : requestedSourceType;
  const storeText = String(event.storeId || "").trim();
  const storeId = storeText ? numericId(storeText, "门店编号") : "";
  const productText = String(event.retailProductId || event.productId || "").trim();
  const retailProductId = productText ? numericId(productText, "产品编号") : "";
  const customerName = String(event.customerName || "").trim();
  if (customerName.length > 100) fail("客户姓名查询不能超过 100 个字符", "BAD_REQUEST");
  const birthDateText = String(event.birthDate || "").trim();
  const birthDate = birthDateText ? strictDashboardDate(birthDateText, "客户生日") : "";
  const startText = String(event.startDate || "").trim();
  const endText = String(event.endDate || "").trim();
  if (Boolean(startText) !== Boolean(endText)) fail("开始日期和结束日期必须同时提供", "BAD_REQUEST");
  const startDate = startText ? strictDashboardDate(startText, "开始日期") : "";
  const endDate = endText ? strictDashboardDate(endText, "结束日期") : "";
  if (startDate && startDate > endDate) fail("开始日期不能晚于结束日期", "BAD_REQUEST");
  const requestedLimit = Number(event.limit);
  const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : 100, 1), 100);
  const requestedPage = Number(event.pageNumber);
  const pageNumber = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  const clauses = ["TRUE"];
  if (status) clauses.push(`entry.record_status = ${sqlText(status)}`);
  if (sourceType) clauses.push(`entry.source_type = ${sqlText(sourceType)}`);
  if (recordCode) clauses.push(`entry.record_code = ${sqlText(recordCode)}`);
  if (storeId) clauses.push(`entry.store_id = ${storeId}`);
  if (retailProductId) clauses.push(`entry.retail_product_id = ${retailProductId}`);
  if (customerName) clauses.push(`customer.customer_name ILIKE '%' || ${sqlText(customerName)} || '%'`);
  if (birthDate) clauses.push(`customer.birth_date = ${sqlText(birthDate)}::date`);
  if (startDate) {
    clauses.push(`entry.submitted_at >= (${sqlText(startDate)}::date::timestamp AT TIME ZONE 'Asia/Shanghai')`);
    clauses.push(`entry.submitted_at < ((${sqlText(endDate)}::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai')`);
  }
  const whereSql = clauses.join(" AND ");
  const sourceSql = `WITH product_entries AS (
    SELECT purchase.id AS source_line_id, purchase.id AS record_id,
           purchase.purchase_code AS record_code, 'PURCHASE'::text AS source_type,
           purchase.unit_count, purchase.record_status, purchase.message, purchase.review_note,
           purchase.submitted_at, purchase.reviewed_at,
           purchase.store_id, purchase.customer_id, purchase.retail_product_id, purchase.teacher_id,
           purchase.product_code_snapshot, purchase.product_name_snapshot,
           purchase.submitted_by_account_id, purchase.reviewed_by_account_id
      FROM public.retail_product_purchase_records purchase
    UNION ALL
    SELECT gift.id AS source_line_id, recharge.id AS record_id,
           recharge.recharge_code AS record_code, 'GIFT'::text AS source_type,
           gift.unit_count, recharge.record_status, recharge.message, recharge.review_note,
           recharge.submitted_at, recharge.reviewed_at,
           gift.store_id, gift.customer_id, gift.retail_product_id, gift.teacher_id,
           gift.product_code_snapshot, gift.product_name_snapshot,
           recharge.submitted_by_account_id, recharge.reviewed_by_account_id
      FROM public.recharge_product_gifts gift
      JOIN public.recharge_records recharge ON recharge.id = gift.recharge_id
     WHERE recharge.recharge_type = 'NEW'
  )`;
  const countRows = await executeSql(
    `${sourceSql}
     SELECT COUNT(*)::bigint AS total
       FROM product_entries entry
       JOIN public.customers customer ON customer.id = entry.customer_id
      WHERE ${whereSql}`
  );
  const total = Number(countRows?.[0]?.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.min(pageNumber, totalPages);
  const rows = await executeSql(
    `${sourceSql}
     SELECT entry.record_id AS id, entry.source_line_id, entry.record_id, entry.record_code,
            CASE WHEN entry.source_type = 'PURCHASE' THEN entry.record_code ELSE '' END AS purchase_code,
            entry.source_type, entry.unit_count,
            entry.record_status, entry.message, entry.review_note,
            entry.submitted_at, entry.reviewed_at,
            store.id AS store_id, store.store_code, store.store_name,
            customer.customer_code, customer.customer_name, customer.birth_date,
            entry.retail_product_id, entry.product_code_snapshot, entry.product_name_snapshot,
            teacher.id AS teacher_id, teacher.teacher_code, teacher.teacher_name,
            submitter.staff_name AS submitted_by_name,
            reviewer.staff_name AS reviewed_by_name
       FROM product_entries entry
       JOIN public.stores store ON store.id = entry.store_id
       JOIN public.customers customer ON customer.id = entry.customer_id
       LEFT JOIN public.teachers teacher ON teacher.id = entry.teacher_id
       JOIN public.staff_accounts submitter ON submitter.id = entry.submitted_by_account_id
       LEFT JOIN public.staff_accounts reviewer ON reviewer.id = entry.reviewed_by_account_id
      WHERE ${whereSql}
      ORDER BY (entry.record_status = 'PENDING') DESC, entry.submitted_at DESC,
               entry.source_type, entry.source_line_id DESC
      LIMIT ${limit} OFFSET ${(currentPage - 1) * limit}`
  );
  const summaryClauses = clauses.filter((clause) => !clause.startsWith("entry.record_status ="));
  const [stores, products, summaryRows] = await Promise.all([
    executeSql(`SELECT id AS store_id, store_code, store_name FROM public.stores ORDER BY store_name, store_code, id`),
    executeSql(
      `SELECT id AS product_id, product_code, product_name, product_status
         FROM public.retail_products
        ORDER BY (product_status = 'ACTIVE') DESC, product_name, product_code, id`
    ),
    executeSql(
      `${sourceSql}
       SELECT COUNT(*)::bigint AS total,
              COUNT(*) FILTER (WHERE entry.source_type = 'PURCHASE')::bigint AS purchase,
              COUNT(*) FILTER (WHERE entry.source_type = 'GIFT')::bigint AS gift,
              COUNT(*) FILTER (WHERE entry.record_status = 'PENDING')::bigint AS pending,
              COUNT(*) FILTER (WHERE entry.record_status = 'APPROVED')::bigint AS approved,
              COUNT(*) FILTER (WHERE entry.record_status = 'REJECTED')::bigint AS rejected
         FROM product_entries entry
         JOIN public.customers customer ON customer.id = entry.customer_id
        WHERE ${summaryClauses.join(" AND ")}`
    )
  ]);
  const summary = summaryRows?.[0] || {};
  return {
    orders: rows, total, pageNumber: currentPage, pageSize: limit, totalPages, stores,
    products: (products || []).map((product) => ({
      productId: String(product.product_id || ""),
      productCode: String(product.product_code || ""),
      productName: String(product.product_name || ""),
      productStatus: String(product.product_status || "")
    })),
    summary: {
      total: Number(summary.total || 0), pending: Number(summary.pending || 0),
      approved: Number(summary.approved || 0), rejected: Number(summary.rejected || 0),
      purchase: Number(summary.purchase || 0), gift: Number(summary.gift || 0)
    }
  };
}

async function reviewRetailProductPurchase(caller, event = {}) {
  requireReviewer(caller);
  await requireRetailProductPurchaseSchema();
  const decision = String(event.decision || "").trim().toUpperCase();
  if (!["APPROVED", "REJECTED"].includes(decision)) fail("审核结果只能是通过或驳回", "BAD_REQUEST");
  const note = String(event.note || "").trim();
  if (note.length > 1000) fail("审核留言不能超过 1000 个字符", "BAD_REQUEST");
  const recordId = numericId(event.recordId || event.purchaseId, "购买工单编号");
  let rows;
  try {
    rows = await executeSql(
      `SELECT record_id, purchase_code, record_status, reviewed_at
         FROM public.review_retail_product_purchase(
           ${recordId}, ${numericId(caller.profile.staffId, "当前审核账号")},
           ${sqlText(decision)}, ${sqlText(note)}
         )`
    );
  } catch (error) {
    if (/RETAIL_PRODUCT_PURCHASE_NOT_PENDING/.test(String(error?.message || ""))) {
      fail("该产品购买单已完成审核，请刷新列表", "ORDER_ALREADY_REVIEWED");
    }
    asDatabaseError(error, "审核产品购买单");
  }
  if (!rows?.[0]) fail("未找到待审核的产品购买单", "NOT_FOUND");
  return rows[0];
}

async function reviewOrder(caller, event) {
  requireReviewer(caller);
  const recordType = String(event.recordType || "").trim().toUpperCase();
  const decision = String(event.decision || "").trim().toUpperCase();
  if (!["RECHARGE", "VERIFICATION"].includes(recordType)) fail("不支持的工单类型", "BAD_REQUEST");
  if (!["APPROVED", "REJECTED"].includes(decision)) fail("审核结果只能是通过或驳回", "BAD_REQUEST");
  const recordId = numericId(event.recordId, "工单编号");
  const note = String(event.note || "").trim();
  if (note.length > 1000) fail("审核留言不能超过 1000 个字符", "BAD_REQUEST");
  if (recordType === "VERIFICATION") {
    const verificationRows = await executeSql(
      `SELECT verification_type, record_status, void_request_status
         FROM public.verification_records
        WHERE id = ${recordId}
        LIMIT 1`
    );
    const verification = verificationRows[0];
    if (!verification) fail("未找到该核销工单", "NOT_FOUND");
    if (
      String(verification.verification_type || "").toUpperCase() !== "SUPPLEMENT" ||
      String(verification.void_request_status || "NONE").toUpperCase() !== "NONE"
    ) {
      fail("核销审核只处理补录核销；核销作废流程已停用", "VERIFICATION_REVIEW_NOT_ALLOWED");
    }
  }
  let rows;
  try {
    rows = await executeSql(
      `SELECT record_id, record_code, record_status, void_request_status, reviewed_at
         FROM public.review_order_application(${sqlText(recordType)}, ${recordId},
              ${numericId(caller.profile.staffId, "当前审核账号")}, ${sqlText(decision)}, ${sqlText(note)})`
    );
  } catch (error) {
    const databaseMessage = String(error?.message || "");
    if (
      recordType === "RECHARGE" &&
      decision === "APPROVED" &&
      /refund units exceed unrefunded purchased units/i.test(databaseMessage)
    ) {
      fail("该项目可退费总购买次数已经发生变化，当前退费次数过大，请驳回后由门店重新提交。", "REFUND_COUNT_EXCEEDS_PURCHASED");
    }
    asDatabaseError(error, "审核业务工单");
  }
  if (!rows?.[0]) fail("未找到该工单", "NOT_FOUND");
  return rows[0];
}

async function requireTeacherStatusSchema() {
  const rows = await executeSql(
    `WITH trigger_definitions AS (
       SELECT COALESCE(
                pg_get_functiondef(TO_REGPROCEDURE('public.sync_teacher_profile()')),
                ''
              ) AS profile_definition,
              COALESCE(
                pg_get_functiondef(TO_REGPROCEDURE('public.sync_teacher_account_status()')),
                ''
              ) AS account_definition
     )
     SELECT EXISTS (
              SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public'
                  AND table_name = 'teacher_product_experience_quotas'
                  AND column_name = 'quota_status'
             ) AS has_quota_status,
             TO_REGPROCEDURE('public.delete_teacher_product_experience_quota(bigint,bigint,bigint)') IS NOT NULL
               AS has_delete_function,
             profile_definition ~* 'teacher_status[[:space:]]*=[[:space:]]*excluded[.]teacher_status'
               AS has_optional_profile_trigger_definition,
             account_definition ~* 'desired_status[[:space:]]*:=[[:space:]]*case[[:space:]]+when[[:space:]]+new[.]teacher_status[[:space:]]*=[[:space:]]*''active''[[:space:]]+then[[:space:]]+''active''[[:space:]]+else[[:space:]]+''archived''[[:space:]]+end'
               AS has_optional_account_trigger_definition,
             EXISTS (
               SELECT 1 FROM pg_trigger trg
                WHERE trg.tgrelid = TO_REGCLASS('public.staff_accounts')
                  AND trg.tgname = 'trg_sync_teacher_profile'
                  AND NOT trg.tgisinternal
                  AND trg.tgfoid = TO_REGPROCEDURE('public.sync_teacher_profile()')
             ) AS has_profile_trigger_binding,
             EXISTS (
               SELECT 1 FROM pg_trigger trg
                WHERE trg.tgrelid = TO_REGCLASS('public.teachers')
                  AND trg.tgname = 'trg_sync_teacher_account_status'
                  AND NOT trg.tgisinternal
                  AND trg.tgfoid = TO_REGPROCEDURE('public.sync_teacher_account_status()')
             ) AS has_account_trigger_binding
       FROM trigger_definitions`
  );
  const schema = rows?.[0] || {};
  if (!databaseBoolean(schema.has_quota_status) || !databaseBoolean(schema.has_delete_function)) {
    fail("老师状态及体验额度生命周期尚未启用，请先执行迁移 048。", "DATABASE_SCHEMA_MISSING");
  }
  if (
    !databaseBoolean(schema.has_optional_profile_trigger_definition) ||
    !databaseBoolean(schema.has_optional_account_trigger_definition) ||
    !databaseBoolean(schema.has_profile_trigger_binding) ||
    !databaseBoolean(schema.has_account_trigger_binding)
  ) {
    fail("老师状态同步触发器尚未就绪，请先执行迁移 048-02 后重试。", "DATABASE_SCHEMA_MISSING");
  }
}

async function archiveTeacherProvisioning(staffId, { uid = "", phone = "" } = {}) {
  if (!staffId) return;
  try {
    // Migration 046's teacher-status trigger updates the linked account in
    // this same SQL command. Keep the explicit account write separate: a
    // data-modifying CTE must never update the row that the trigger updates.
    const ownershipPredicate = uid && phone
      ? `AND account.auth_uid = ${sqlText(uid)} AND account.phone = ${sqlText(phone)}`
      : "";
    await executeSql(
      `UPDATE public.teachers AS teacher
          SET teacher_status = 'ARCHIVED', updated_at = NOW()
         FROM public.staff_accounts AS account
        WHERE teacher.staff_account_id = account.id
          AND account.id = ${Number(staffId)}
          AND account.role_code = 'teacher'
          ${ownershipPredicate}`
    );
    await executeSql(
      `UPDATE public.staff_accounts AS account
          SET account_status = 'ARCHIVED', updated_at = NOW()
        WHERE account.id = ${Number(staffId)}
          AND account.role_code = 'teacher'
          ${ownershipPredicate}`
    );
  } catch (error) {
    console.error("teacher provisioning could not archive database profile", {
      staffId: Number(staffId), code: error?.code || undefined, message: error?.message || undefined
    });
  }
}

async function requireTeacherExperienceQuotaSchema() {
  const rows = await executeSql(
    `SELECT TO_REGCLASS('public.teacher_product_experience_quotas') IS NOT NULL AS quota_table,
            TO_REGCLASS('public.teacher_experience_quota_recharges') IS NOT NULL AS recharge_table,
            TO_REGCLASS('public.teacher_experience_quota_resets') IS NOT NULL AS reset_table,
            TO_REGCLASS('public.teacher_experience_quota_usages') IS NOT NULL AS usage_table,
            TO_REGCLASS('public.teacher_experience_quota_configuration_events') IS NOT NULL AS configuration_event_table,
            EXISTS (
              SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public'
                 AND table_name = 'teacher_product_experience_quotas'
                 AND column_name = 'quota_status'
            ) AS quota_status_column,
            TO_REGPROCEDURE('public.upsert_teacher_product_experience_quota(bigint,bigint,integer,bigint)') IS NOT NULL AS upsert_function,
            TO_REGPROCEDURE('public.delete_teacher_product_experience_quota(bigint,bigint,bigint)') IS NOT NULL AS delete_function,
            TO_REGPROCEDURE('public.recharge_teacher_product_experience_quota(bigint,bigint,integer,text,character varying,bigint)') IS NOT NULL AS recharge_function,
            COALESCE(pg_get_functiondef(TO_REGPROCEDURE('public.recharge_teacher_product_experience_quota(bigint,bigint,integer,text,character varying,bigint)')), '')
              ~* 'quota_status[[:space:]]*=[[:space:]]*''active'''
              AS has_active_recharge_function,
            COALESCE(pg_get_functiondef(TO_REGPROCEDURE('public.recharge_teacher_product_experience_quota(bigint,bigint,integer,text,character varying,bigint)')), '')
              ~* '[a-z_]+[.]manual_recharge_count[[:space:]]*[+][[:space:]]*p_unit_count'
              AS has_qualified_recharge_function,
            POSITION(
              'assert_active_teacher_experience_subjects' IN
              COALESCE(pg_get_functiondef(TO_REGPROCEDURE('public.delete_teacher_product_experience_quota(bigint,bigint,bigint)')), '')
            ) > 0 AS has_active_delete_function,
            TO_REGPROCEDURE('public.reset_teacher_experience_quotas(date,bigint)') IS NOT NULL AS reset_function`
  );
  const schema = rows?.[0] || {};
  if (!databaseBoolean(schema.quota_table) || !databaseBoolean(schema.recharge_table)
      || !databaseBoolean(schema.reset_table) || !databaseBoolean(schema.usage_table)
      || !databaseBoolean(schema.configuration_event_table) || !databaseBoolean(schema.quota_status_column)
      || !databaseBoolean(schema.upsert_function) || !databaseBoolean(schema.delete_function)
      || !databaseBoolean(schema.recharge_function)
      || !databaseBoolean(schema.has_active_recharge_function)
      || !databaseBoolean(schema.has_qualified_recharge_function)
      || !databaseBoolean(schema.has_active_delete_function)
      || !databaseBoolean(schema.reset_function)) {
    fail("老师体验额度修复尚未完整启用，请按顺序完成迁移 048—050。", "DATABASE_SCHEMA_MISSING");
  }
}

function teacherExperienceIdempotencyKey(value) {
  const key = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(key)) {
    fail("体验次数充值缺少有效的防重复提交编号。", "IDEMPOTENCY_KEY_REQUIRED");
  }
  return key;
}

function teacherExperienceEntitlement(row) {
  return {
    id: String(row.id || row.quota_id || ""),
    teacherId: String(row.teacher_id || ""),
    productId: String(row.product_id || ""),
    productCode: String(row.product_code || ""),
    productName: String(row.product_name || ""),
    productStatus: String(row.product_status || ""),
    monthlyAllowance: Number(row.monthly_allowance || 0),
    quotaMonth: row.quota_month,
    availableCount: Number(row.available_count || row.available_after_count || 0),
    usedCount: Number(row.used_count || 0),
    totalExperienceCount: Number(row.total_experience_count || row.total_used_count || 0),
    totalUsedCount: Number(row.total_used_count || row.total_experience_count || 0),
    manualRechargeCount: Number(row.manual_recharge_count || 0),
    monthlyResetAt: row.monthly_reset_at
  };
}

async function getHqTeacherExperienceEntitlements(caller, event = {}) {
  await requireTeacherExperienceQuotaSchema();
  const teacherId = numericId(event.teacherId || event.teacherRef, "老师编号");
  // This also makes the configuration page correct when the monthly timer was
  // delayed.  The database function locks each row and writes an immutable
  // reset event only once per quota/month.
  await executeSql(
    `SELECT public.reset_teacher_experience_quota(
              q.id, public.teacher_experience_quota_month(),
              ${numericId(caller.profile.staffId, "总部账号")}::bigint
            )
       FROM public.teacher_product_experience_quotas q
      WHERE q.teacher_id = ${teacherId}::bigint
        AND q.quota_status = 'ACTIVE'
        AND q.quota_month < public.teacher_experience_quota_month()`
  );
  const teacherRows = await executeSql(
    `SELECT t.id, t.teacher_code, t.teacher_name, t.teacher_status,
            a.account_status
       FROM public.teachers t
       LEFT JOIN public.staff_accounts a ON a.id = t.staff_account_id
      WHERE t.id = ${teacherId}::bigint
      LIMIT 1`
  );
  const teacher = teacherRows[0];
  if (!teacher) fail("未找到该老师资料。", "NOT_FOUND");
  const entitlementRows = await executeSql(
    `SELECT q.id, q.teacher_id, q.product_id, q.monthly_allowance, q.quota_month,
            q.available_count, q.used_count, q.manual_recharge_count, q.monthly_reset_at,
            p.product_code, p.product_name, p.product_status,
            COALESCE((
              SELECT SUM(u.unit_count)::bigint
                FROM public.teacher_experience_quota_usages u
                JOIN public.verification_records usage_verification
                  ON usage_verification.id = u.verification_id
               WHERE u.teacher_id = q.teacher_id
                 AND u.product_id = q.product_id
                 AND usage_verification.teacher_id = u.teacher_id
                 AND usage_verification.product_id = u.product_id
                 AND usage_verification.record_status = 'APPROVED'
                 AND usage_verification.verification_type = 'EXPERIENCE'
                 AND ${reviewOrderTeacherAttributionCondition("usage_verification", "VERIFICATION")}
            ), 0)::bigint AS total_experience_count
       FROM public.teacher_product_experience_quotas q
       JOIN public.products p ON p.id = q.product_id
      WHERE q.teacher_id = ${teacherId}::bigint
        AND q.quota_status = 'ACTIVE'
      ORDER BY p.product_name, p.product_code, q.id`
  );
  // Keep the all-time per-product summary independent from whether a current
  // configuration is live. A deleted configuration deliberately disappears
  // from the recharge/selectable list, but its completed experiences remain
  // visible to headquarters as historical business data.
  const experienceTotalRows = await executeSql(
    `SELECT u.product_id, p.product_code, p.product_name, p.product_status,
            COALESCE(SUM(u.unit_count), 0)::bigint AS total_experience_count
       FROM public.teacher_experience_quota_usages u
       JOIN public.verification_records usage_verification
         ON usage_verification.id = u.verification_id
       LEFT JOIN public.products p ON p.id = u.product_id
      WHERE u.teacher_id = ${teacherId}::bigint
        AND usage_verification.teacher_id = u.teacher_id
        AND usage_verification.product_id = u.product_id
        AND usage_verification.record_status = 'APPROVED'
        AND usage_verification.verification_type = 'EXPERIENCE'
        AND ${reviewOrderTeacherAttributionCondition("usage_verification", "VERIFICATION")}
      GROUP BY u.product_id, p.product_code, p.product_name, p.product_status
      ORDER BY p.product_name NULLS LAST, p.product_code NULLS LAST, u.product_id`
  );
  const historyRows = await executeSql(
    `WITH history AS (
       SELECT event.occurred_at,
              CASE event.event_type
                WHEN 'CONFIGURED' THEN 'CONFIGURATION'
                WHEN 'REMOVED' THEN 'REMOVED'
                ELSE event.event_type
              END AS event_type,
              event.product_id,
              (CASE WHEN event.event_type = 'REMOVED' THEN 0 ELSE event.monthly_allowance END)::integer AS unit_count,
              event.available_after_count,
              ''::text AS note,
              event.occurred_by_account_id AS actor_account_id
         FROM public.teacher_experience_quota_configuration_events event
        WHERE event.teacher_id = ${teacherId}::bigint
       UNION ALL
       SELECT r.created_at, 'TOP_UP'::text, r.product_id, r.unit_count,
              r.available_after_count, r.note, r.recharged_by_account_id
         FROM public.teacher_experience_quota_recharges r
        WHERE r.teacher_id = ${teacherId}::bigint
       UNION ALL
       SELECT r.reset_at, 'MONTHLY_RESET'::text, q.product_id, r.monthly_allowance,
              r.monthly_allowance, ''::text, r.reset_by_account_id
         FROM public.teacher_experience_quota_resets r
         JOIN public.teacher_product_experience_quotas q ON q.id = r.quota_id
        WHERE q.teacher_id = ${teacherId}::bigint
       UNION ALL
       SELECT u.consumed_at, 'EXPERIENCE_CONSUMED'::text, u.product_id, -u.unit_count,
              u.available_after_count, ''::text, NULL::bigint
         FROM public.teacher_experience_quota_usages u
        WHERE u.teacher_id = ${teacherId}::bigint
     )
     SELECT h.occurred_at, h.event_type, h.unit_count, h.available_after_count, h.note,
            p.product_code, p.product_name, a.staff_name AS actor_name
       FROM history h
       LEFT JOIN public.products p ON p.id = h.product_id
       LEFT JOIN public.staff_accounts a ON a.id = h.actor_account_id
      ORDER BY h.occurred_at DESC
      LIMIT 200`
  );
  const entitlements = entitlementRows.map(teacherExperienceEntitlement);
  const experienceTotals = experienceTotalRows.map((row) => ({
    productId: String(row.product_id || ""),
    productCode: String(row.product_code || ""),
    productName: String(row.product_name || "未命名项目"),
    productStatus: String(row.product_status || "ARCHIVED"),
    totalExperienceCount: Number(row.total_experience_count || 0)
  }));
  return {
    ok: true,
    teacher: {
      id: String(teacher.id), teacherId: String(teacher.id), teacherCode: String(teacher.teacher_code || ""),
      teacherName: String(teacher.teacher_name || ""), teacherStatus: String(teacher.teacher_status || ""),
      accountStatus: String(teacher.account_status || "")
    },
    entitlements,
    history: historyRows.map((row) => ({
      at: row.occurred_at, type: String(row.event_type || ""), productCode: String(row.product_code || ""),
      productName: String(row.product_name || ""), count: Number(row.unit_count || 0),
      availableAfterCount: Number(row.available_after_count || 0), note: String(row.note || ""), actorName: String(row.actor_name || "")
    })),
    experienceTotals,
    totalAvailableCount: entitlements.reduce((total, item) => total + item.availableCount, 0),
    totalExperienceCount: experienceTotals.reduce((total, item) => total + item.totalExperienceCount, 0)
  };
}

async function upsertTeacherExperienceEntitlement(caller, event = {}) {
  await requireTeacherExperienceQuotaSchema();
  const teacherId = numericId(event.teacherId || event.teacherRef, "老师编号");
  const productId = numericId(event.productId, "项目编号");
  const monthlyAllowance = Number(event.monthlyAllowance);
  if (!Number.isInteger(monthlyAllowance) || monthlyAllowance < 0 || monthlyAllowance > 1000000) {
    fail("每月体验次数必须是 0 至 1000000 的整数。", "BAD_REQUEST");
  }
  let rows;
  try {
    rows = await executeSql(
      `SELECT * FROM public.upsert_teacher_product_experience_quota(
         ${teacherId}::bigint, ${productId}::bigint, ${monthlyAllowance}::integer,
         ${numericId(caller.profile.staffId, "总部账号")}::bigint
       )`
    );
  } catch (error) {
    const detail = String(error?.message || "").toLowerCase();
    if (detail.includes("archived") || detail.includes("product is missing")) {
      fail("封存老师或封存项目不能配置体验次数。", "MASTER_DATA_NOT_ACTIVE");
    }
    throw error;
  }
  const result = rows?.[0];
  if (!result) fail("体验额度配置未保存。", "TEACHER_EXPERIENCE_QUOTA_SAVE_FAILED");
  const page = await getHqTeacherExperienceEntitlements(caller, { teacherId });
  return { ok: true, created: databaseBoolean(result.created_now), entitlement: page.entitlements.find((item) => item.productId === String(productId)) || null };
}

async function deleteTeacherExperienceEntitlement(caller, event = {}) {
  await requireTeacherExperienceQuotaSchema();
  const teacherId = numericId(event.teacherId || event.teacherRef, "老师编号");
  const productId = numericId(event.productId, "项目编号");
  let rows;
  try {
    rows = await executeSql(
      `SELECT * FROM public.delete_teacher_product_experience_quota(
         ${teacherId}::bigint, ${productId}::bigint,
         ${numericId(caller.profile.staffId, "总部账号")}::bigint
       )`
    );
  } catch (error) {
    const detail = String(error?.message || "").toLowerCase();
    if (detail.includes("no active experience quota")) {
      fail("该老师该项目当前没有可删除的体验额度配置。", "TEACHER_EXPERIENCE_QUOTA_NOT_CONFIGURED");
    }
    throw error;
  }
  const removed = rows?.[0];
  if (!removed) fail("体验额度配置未能删除。", "TEACHER_EXPERIENCE_QUOTA_DELETE_FAILED");
  return {
    ok: true,
    removed: {
      quotaId: String(removed.quota_id || ""),
      teacherId: String(removed.teacher_id || teacherId),
      productId: String(removed.product_id || productId),
      availableCount: Number(removed.available_count || 0),
      removedAt: removed.removed_at || null
    }
  };
}

async function rechargeTeacherExperienceEntitlement(caller, event = {}) {
  await requireTeacherExperienceQuotaSchema();
  const teacherId = numericId(event.teacherId || event.teacherRef, "老师编号");
  const productId = numericId(event.productId, "项目编号");
  const unitCount = Number(event.unitCount);
  if (!Number.isInteger(unitCount) || unitCount < 1 || unitCount > 1000000) {
    fail("体验次数充值必须是 1 至 1000000 的整数。", "BAD_REQUEST");
  }
  const note = String(event.note || "").trim();
  if (note.length > 500) fail("充值说明不能超过 500 个字符。", "BAD_REQUEST");
  const clientRequestId = teacherExperienceIdempotencyKey(event.clientRequestId);
  let rows;
  try {
    rows = await executeSql(
      `SELECT * FROM public.recharge_teacher_product_experience_quota(
         ${teacherId}::bigint, ${productId}::bigint, ${unitCount}::integer,
         ${sqlText(note)}::text, ${sqlText(clientRequestId)}::varchar,
         ${numericId(caller.profile.staffId, "总部账号")}::bigint
       )`
    );
  } catch (error) {
    const detail = String(error?.message || "").toLowerCase();
    if (detail.includes("no configured experience quota") || detail.includes("no active configured experience quota")) {
      fail("请先配置该老师该项目的月度体验次数。", "TEACHER_EXPERIENCE_QUOTA_NOT_CONFIGURED");
    }
    if (detail.includes("idempotency key belongs")) fail("该充值请求编号已用于另一笔体验充值。", "IDEMPOTENCY_CONFLICT");
    if (detail.includes("archived") || detail.includes("product is missing")) {
      fail("封存老师或封存项目不能充值体验次数。", "MASTER_DATA_NOT_ACTIVE");
    }
    throw error;
  }
  const recharge = rows?.[0];
  if (!recharge) fail("体验次数充值未保存。", "TEACHER_EXPERIENCE_RECHARGE_FAILED");
  const page = await getHqTeacherExperienceEntitlements(caller, { teacherId });
  return {
    ok: true,
    createdNow: databaseBoolean(recharge.created_now),
    recharge: {
      id: String(recharge.recharge_id), quotaId: String(recharge.quota_id), quotaMonth: recharge.quota_month,
      unitCount, availableBeforeCount: Number(recharge.available_before_count || 0),
      availableAfterCount: Number(recharge.available_after_count || 0), createdAt: recharge.created_at
    },
    entitlement: page.entitlements.find((item) => item.productId === String(productId)) || null
  };
}

async function resetTeacherExperienceQuotas(caller = null) {
  await requireTeacherExperienceQuotaSchema();
  const actorId = caller?.profile?.staffId ? numericId(caller.profile.staffId, "总部账号") : "NULL";
  const rows = await executeSql(
    `SELECT public.reset_teacher_experience_quotas(
       public.teacher_experience_quota_month(), ${actorId === "NULL" ? "NULL" : `${actorId}::bigint`}
     ) AS reset_count`
  );
  return { ok: true, resetCount: Number(rows?.[0]?.reset_count || 0), quotaMonth: null };
}

async function setMasterStatus(caller, event = {}) {
  // Keep this guard inside the service function as well as at the router.
  // Store/teacher pages may expose the wrapper, but only an authenticated HQ
  // identity is ever allowed to change a master-data status.
  requireHq(caller);
  const teacherIdText = String(event.teacherId || "").trim();
  const storeIdText = String(event.storeId || "").trim();
  const status = String(event.status || "").toUpperCase();
  if (Boolean(teacherIdText) === Boolean(storeIdText) || !["ACTIVE", "ARCHIVED"].includes(status)) {
    fail("必须只指定一个老师或门店编号，并提供 ACTIVE 或 ARCHIVED 状态。", "BAD_REQUEST");
  }
  if (teacherIdText) {
    const teacherId = numericId(teacherIdText, "老师编号");
    const rows = await executeSql(
      `SELECT t.id, t.staff_account_id, a.auth_uid
         FROM public.teachers t
         LEFT JOIN public.staff_accounts a ON a.id = t.staff_account_id
        WHERE t.id = ${teacherId}::bigint
        LIMIT 1`
    );
    const teacher = rows?.[0];
    if (!teacher) fail("未找到该老师。", "NOT_FOUND");
    if (status === "ACTIVE") await requireTeacherStatusSchema();
    if (teacher.auth_uid) {
      const result = await main({ action: "setStaffStatus", uid: String(teacher.auth_uid), status });
      return { ...result, entity: "teacher", teacherId: String(teacherId) };
    }
    // The 046 trigger updates the linked staff account as part of this
    // statement. Avoid a second same-statement account write, which is not
    // deterministic when a PostgreSQL trigger already changed that row.
    const changedRows = await executeSql(
      `UPDATE public.teachers
          SET teacher_status = ${sqlText(status)}, updated_at = NOW()
        WHERE id = ${teacherId}::bigint
        RETURNING staff_account_id`
    );
    if (!changedRows?.[0]) fail("老师状态未能保存。", "DATABASE_ERROR");
    const accountRows = await executeSql(
      `SELECT account_status FROM public.staff_accounts
        WHERE id = ${Number(changedRows[0].staff_account_id)}
        LIMIT 1`
    );
    if (String(accountRows?.[0]?.account_status || "") !== status) {
      fail("老师主档状态未能同步到账号，请确认迁移 046 已完整执行。", "STATUS_SYNC_FAILED");
    }
    return { ok: true, entity: "teacher", teacherId: String(teacherId), status, noAuthAccount: true };
  }

  return await setStoreMasterStatus(numericId(storeIdText, "门店编号"), status);
}

function missingCloudBaseCredential(error) {
  const detail = cloudErrorDetails(error);
  const text = `${detail.code} ${detail.message}`.toLowerCase();
  return /(?:resource|user|account)[._ -]*not[._ -]*found/.test(text) ||
    /(?:user|account).*(?:does not exist|doesn't exist|not exist)/.test(text) ||
    /(?:invalid|illegal).*(?:uid|user.?id)/.test(text) ||
    /(?:uid|user.?id).*(?:invalid|illegal)/.test(text) ||
    /用户.*(?:不存在|未找到|无效)/.test(text) ||
    /(?:不存在|未找到|无效).*用户/.test(text);
}

async function persistStoreStatusById(storeId, status) {
  const layout = await getStoreBindingLayout();
  const targetStore = layout === "stores"
    ? `SELECT store.id, store.store_account_id AS staff_account_id,
              CASE WHEN store.store_account_id IS NULL THEN 0 ELSE 1 END AS expected_account_count,
              (store.store_account_id IS NULL OR EXISTS (
                SELECT 1 FROM public.staff_accounts account
                 WHERE account.id = store.store_account_id AND account.role_code = 'store'
              )) AS binding_valid
         FROM public.stores store
        WHERE store.id = ${storeId}::bigint`
    : `SELECT store.id, MIN(assignment.staff_account_id) AS staff_account_id,
              COUNT(assignment.staff_account_id)::integer AS expected_account_count,
              (COUNT(assignment.staff_account_id) <= 1 AND
               COUNT(*) FILTER (
                 WHERE assignment.staff_account_id IS NOT NULL
                   AND (linked_account.id IS NULL OR linked_account.role_code <> 'store')
               ) = 0) AS binding_valid
         FROM public.stores store
         LEFT JOIN public.staff_store_assignments assignment
           ON assignment.store_id = store.id AND assignment.assignment_status = 'ACTIVE'
         LEFT JOIN public.staff_accounts linked_account ON linked_account.id = assignment.staff_account_id
        WHERE store.id = ${storeId}::bigint
        GROUP BY store.id`;
  const rows = await executeSql(
    `WITH target_store AS (
       ${targetStore}
     ), changed_store AS (
       UPDATE public.stores store
          SET store_status = ${sqlText(status)}, updated_at = NOW()
         FROM target_store target
        WHERE store.id = target.id
          AND target.binding_valid
       RETURNING store.id
     ), changed_account AS (
       UPDATE public.staff_accounts account
          SET account_status = ${sqlText(status)}, updated_at = NOW()
         FROM target_store target
        WHERE account.id = target.staff_account_id
          AND account.role_code = 'store'
          AND EXISTS (SELECT 1 FROM changed_store)
       RETURNING account.id, account.auth_uid, account.phone
     )
     SELECT (SELECT COUNT(*) FROM target_store)::integer AS store_exists,
            (SELECT COUNT(*) FROM changed_store)::integer AS store_count,
            COALESCE((SELECT expected_account_count FROM target_store LIMIT 1), 0)::integer AS expected_account_count,
            (SELECT COUNT(*) FROM changed_account)::integer AS account_count,
            COALESCE((SELECT id::text FROM changed_account LIMIT 1), '') AS staff_account_id,
            COALESCE((SELECT auth_uid FROM changed_account LIMIT 1), '') AS auth_uid,
            COALESCE((SELECT phone FROM changed_account LIMIT 1), '') AS phone`
  );
  const result = rows?.[0] || {};
  if (Number(result.store_exists || 0) !== 1) fail("未找到该门店。", "NOT_FOUND");
  if (Number(result.store_count || 0) !== 1) {
    fail("门店绑定了无效的登录账号，状态未修改。请先核对门店与门店账号的绑定关系。", "STORE_ACCOUNT_BINDING_INVALID");
  }
  if (Number(result.account_count || 0) !== Number(result.expected_account_count || 0)) {
    fail("门店主档与登录账号状态未能同步，状态未修改。", "STATUS_SYNC_FAILED");
  }
  return {
    staffAccountId: String(result.staff_account_id || ""),
    authUid: String(result.auth_uid || "").trim(),
    phone: String(result.phone || "").trim()
  };
}

async function setStoreMasterStatus(storeId, status) {
  let persisted;
  try {
    // The store master and its linked PostgreSQL account change in one SQL
    // statement. Archiving this database identity immediately removes all
    // business authorization even if Tencent identity management is degraded.
    persisted = await persistStoreStatusById(storeId, status);
  } catch (error) {
    if (["NOT_FOUND", "STORE_ACCOUNT_BINDING_INVALID", "STATUS_SYNC_FAILED"].includes(error?.code)) throw error;
    asDatabaseError(error, "同步门店主档与登录账号状态");
  }

  const response = {
    ok: true,
    entity: "store",
    storeId: String(storeId),
    status,
    staffAccountId: persisted.staffAccountId || undefined,
    noAuthAccount: !persisted.authUid
  };
  if (!persisted.authUid) {
    if (status === "ACTIVE") {
      await persistStoreStatusById(storeId, "ARCHIVED");
      fail("门店没有可恢复的 CloudBase 认证账号，业务状态已保持封存。", "STORE_AUTH_ACCOUNT_MISSING");
    }
    return {
      ...response,
      credentialStatus: "NOT_LINKED",
      warning: undefined
    };
  }

  try {
    await manager().user.modifyUser({
      uid: persisted.authUid,
      userStatus: status === "ACTIVE" ? "ACTIVE" : "BLOCKED"
    });
    return { ...response, credentialStatus: status === "ACTIVE" ? "ACTIVE" : "BLOCKED" };
  } catch (error) {
    const missingCredential = missingCloudBaseCredential(error);
    const cause = cloudErrorDetails(error);
    if (status === "ARCHIVED") {
      // PostgreSQL is the application authorization source. Do not turn a
      // successful archive into a false UI failure merely because a legacy or
      // stress-test auth_uid has no corresponding CloudBase user.
      return {
        ...response,
        credentialStatus: missingCredential ? "MISSING" : "BLOCK_FAILED",
        warning: missingCredential
          ? "门店及其业务账号已封存；原认证账号不存在，无需额外禁用。"
          : "门店及其业务账号已封存，业务登录已被后端拒绝；CloudBase 认证层禁用失败，请总部检查云函数用户管理权限。",
        warningCode: missingCredential ? "AUTH_CREDENTIAL_MISSING" : "AUTH_BLOCK_FAILED",
        requestId: requestIdFrom(error) || undefined,
        causeCode: cause.code || undefined
      };
    }
    try {
      await persistStoreStatusById(storeId, "ARCHIVED");
    } catch (compensationError) {
      console.error("store activation compensation failed", {
        storeId,
        code: compensationError?.code || undefined,
        message: compensationError?.message || undefined
      });
      stageFail(
        "AUTH_ACTIVATE_COMPENSATION",
        "CloudBase 登录账号激活失败，且门店业务状态无法自动重新封存。请总部立即人工检查。",
        "AUTH_ACTIVATION_COMPENSATION_FAILED",
        error
      );
    }
    stageFail(
      "AUTH_ACTIVATE",
      missingCredential
        ? "原 CloudBase 认证账号不存在，门店业务状态已重新封存。"
        : "CloudBase 登录账号激活失败，门店业务状态已重新封存。",
      missingCredential ? "AUTH_CREDENTIAL_MISSING" : "AUTH_ACTIVATION_FAILED",
      error
    );
  }
}

function hqDashboardRow(row) {
  return {
    entityId: row.entity_id === null || row.entity_id === undefined ? "" : String(row.entity_id),
    entityCode: String(row.entity_code || ""),
    entityName: String(row.entity_name || ""),
    recharge: Number(row.recharge_count || 0),
    verification: Number(row.verification_count || 0),
    experience: Number(row.experience_count || 0),
    refund: Number(row.refund_count || 0)
  };
}

function hqDashboardRangeFromTotal(totalRow) {
  return {
    startDate: String(totalRow.start_date),
    endDate: String(totalRow.end_date),
    days: Number(totalRow.range_days),
    timeZone: "Asia/Shanghai"
  };
}

async function getHqDashboardOverview(requestedRange) {
  const { startDateSql, endDateSql } = hqDashboardDateSql(requestedRange);
  const storeProjection = hqDashboardRankingProjection("store");
  const projectProjection = hqDashboardRankingProjection("project");
  const teacherProjection = hqDashboardRankingProjection("teacher");
  let dashboardRows;
  try {
    dashboardRows = await executeSql(
      `${hqBusinessEventsCte(startDateSql, endDateSql)},
       totals AS (
         SELECT COALESCE(SUM(recharge_count), 0)::bigint AS recharge_count,
                COALESCE(SUM(verification_count), 0)::bigint AS verification_count,
                COALESCE(SUM(experience_count), 0)::bigint AS experience_count,
                COALESCE(SUM(refund_count), 0)::bigint AS refund_count
           FROM business_events
       ), teacher_population AS (
         SELECT COUNT(DISTINCT teacher_id)::bigint AS teacher_count
           FROM business_events
          WHERE teacher_id IS NOT NULL
       ), store_chart AS (
          SELECT 'store'::text AS dimension,
                 ranked.*
           FROM (${storeProjection}) ranked
          ORDER BY (ranked.recharge_count + ranked.verification_count + ranked.experience_count + ranked.refund_count) DESC,
                   ranked.entity_name ASC NULLS LAST,
                   ranked.entity_id ASC
          LIMIT ${HQ_DASHBOARD_CHART_LIMIT}
       ), project_chart AS (
          SELECT 'project'::text AS dimension,
                 ranked.*
           FROM (${projectProjection}) ranked
          ORDER BY (ranked.recharge_count + ranked.verification_count + ranked.experience_count + ranked.refund_count) DESC,
                   ranked.entity_name ASC NULLS LAST,
                   ranked.entity_id ASC
          LIMIT ${HQ_DASHBOARD_CHART_LIMIT}
       ), teacher_chart AS (
          SELECT 'teacher'::text AS dimension,
                 ranked.*
           FROM (${teacherProjection}) ranked
          ORDER BY (ranked.recharge_count + ranked.verification_count + ranked.experience_count + ranked.refund_count) DESC,
                   ranked.entity_name ASC NULLS LAST,
                   ranked.entity_id ASC
          LIMIT ${HQ_DASHBOARD_CHART_LIMIT}
       ), chart_rows AS (
         SELECT * FROM store_chart
         UNION ALL
         SELECT * FROM project_chart
         UNION ALL
         SELECT * FROM teacher_chart
       ), result_rows AS (
       SELECT 'TOTAL'::text AS row_type,
              TO_CHAR(date_range.start_date, 'YYYY-MM-DD') AS start_date,
              TO_CHAR(date_range.end_date, 'YYYY-MM-DD') AS end_date,
              (date_range.end_date - date_range.start_date + 1)::integer AS range_days,
              NULL::text AS dimension,
              NULL::bigint AS entity_id,
              NULL::text AS entity_code,
              NULL::text AS entity_name,
              totals.recharge_count,
              totals.verification_count,
              totals.experience_count,
              totals.refund_count,
              (SELECT COUNT(*) FROM public.stores)::bigint AS store_count,
              teacher_population.teacher_count
         FROM date_bounds date_range
        CROSS JOIN totals
        CROSS JOIN teacher_population
       UNION ALL
       SELECT 'CHART'::text AS row_type,
              NULL::text AS start_date,
              NULL::text AS end_date,
              NULL::integer AS range_days,
              chart_rows.dimension,
              chart_rows.entity_id,
              chart_rows.entity_code,
              chart_rows.entity_name,
              chart_rows.recharge_count,
              chart_rows.verification_count,
              chart_rows.experience_count,
              chart_rows.refund_count,
              NULL::bigint AS store_count,
              NULL::bigint AS teacher_count
          FROM chart_rows
       )
       SELECT *
         FROM result_rows
        ORDER BY CASE row_type WHEN 'TOTAL' THEN 0 ELSE 1 END,
                 CASE dimension WHEN 'store' THEN 0 WHEN 'project' THEN 1 ELSE 2 END,
                 (recharge_count + verification_count + experience_count + refund_count) DESC,
                 entity_name ASC NULLS LAST,
                 entity_id ASC`
    );
  } catch (error) {
    asDatabaseError(error, "读取总部首页汇总");
  }

  const totalRow = dashboardRows?.find((row) => row.row_type === "TOTAL");
  if (!totalRow) fail("总部首页统计未返回日期范围", "DATABASE_ERROR");
  const charts = { store: [], project: [], teacher: [] };
  (dashboardRows || []).forEach((row) => {
    if (row.row_type === "CHART" && Object.prototype.hasOwnProperty.call(charts, row.dimension)) {
      charts[row.dimension].push(hqDashboardRow(row));
    }
  });
  return {
    range: hqDashboardRangeFromTotal(totalRow),
    totals: {
      recharge: Number(totalRow.recharge_count || 0),
      verification: Number(totalRow.verification_count || 0),
      experience: Number(totalRow.experience_count || 0),
      refund: Number(totalRow.refund_count || 0),
      stores: Number(totalRow.store_count || 0),
      teachers: Number(totalRow.teacher_count || 0)
    },
    charts
  };
}

function hqDashboardRankingMetricColumn(metric) {
  return {
    recharge: "recharge_count",
    verification: "verification_count",
    experience: "experience_count",
    refund: "refund_count"
  }[metric] || "recharge_count";
}

function hqDashboardRankingSql(startDateSql, endDateSql, dimension, rankingMetric, productId, pageSize, pageOffset) {
  const projection = hqDashboardRankingProjection(dimension);
  const rankingColumn = hqDashboardRankingMetricColumn(rankingMetric);
  return `${hqBusinessEventsCte(startDateSql, endDateSql, productId)},
    ranked AS (
      ${projection}
    ), ranked_with_totals AS (
      SELECT ranked.*,
             COUNT(*) OVER () AS total_rows,
             COALESCE(SUM(
               ranked.recharge_count + ranked.verification_count + ranked.experience_count + ranked.refund_count
             ) OVER (), 0)::bigint AS business_total,
             COALESCE(SUM(ranked.${rankingColumn}) OVER (), 0)::bigint AS ranking_total
        FROM ranked
    )
    SELECT entity_id, entity_code, entity_name,
           recharge_count, verification_count, experience_count, refund_count,
           total_rows, business_total, ranking_total
      FROM ranked_with_totals
     ORDER BY ${rankingColumn} DESC,
              entity_name ASC NULLS LAST,
              entity_id ASC
     LIMIT ${pageSize} OFFSET ${pageOffset}`;
}

async function getHqDashboardRanking(requestedRange, event) {
  const request = dashboardRankingRequest(event);
  const { startDateSql, endDateSql } = hqDashboardDateSql(requestedRange);
  let rows;
  try {
    rows = await executeSql(
      hqDashboardRankingSql(
        startDateSql,
        endDateSql,
        request.dimension,
        request.rankingMetric,
        request.productId,
        request.pageSize,
        (request.pageNumber - 1) * request.pageSize
      )
    );
  } catch (error) {
    asDatabaseError(error, "读取总部首页排名");
  }

  // A normal browser request always knows the total from page 1.  If a stale
  // tab asks for a now-nonexistent page, calculate the count once, clamp to
  // the final page, and read that bounded page instead of returning a false
  // empty result.
  let pageNumber = request.pageNumber;
  let total = Number(rows?.[0]?.total_rows || 0);
  let businessTotal = Number(rows?.[0]?.business_total || 0);
  let rankingTotal = Number(rows?.[0]?.ranking_total || 0);
  if (!rows?.length && request.pageNumber > 1) {
    let totalRows;
    try {
      totalRows = await executeSql(
        `${hqBusinessEventsCte(startDateSql, endDateSql, request.productId)},
         ranked AS (
           ${hqDashboardRankingProjection(request.dimension)}
         )
         SELECT COUNT(*)::bigint AS total_rows,
                COALESCE(SUM(recharge_count + verification_count + experience_count + refund_count), 0)::bigint AS business_total,
                COALESCE(SUM(${hqDashboardRankingMetricColumn(request.rankingMetric)}), 0)::bigint AS ranking_total
           FROM ranked`
      );
    } catch (error) {
      asDatabaseError(error, "校正总部首页排名页码");
    }
    total = Number(totalRows?.[0]?.total_rows || 0);
    businessTotal = Number(totalRows?.[0]?.business_total || 0);
    rankingTotal = Number(totalRows?.[0]?.ranking_total || 0);
    const totalPages = Math.max(1, Math.ceil(total / request.pageSize));
    pageNumber = Math.min(request.pageNumber, totalPages);
    if (total > 0 && pageNumber !== request.pageNumber) {
      try {
        rows = await executeSql(
          hqDashboardRankingSql(
            startDateSql,
            endDateSql,
            request.dimension,
            request.rankingMetric,
            request.productId,
            request.pageSize,
            (pageNumber - 1) * request.pageSize
          )
        );
      } catch (error) {
        asDatabaseError(error, "读取校正后的总部首页排名");
      }
    }
  }
  const totalPages = Math.max(1, Math.ceil(total / request.pageSize));
  return {
    ranking: {
      dimension: request.dimension,
      rankingMetric: request.rankingMetric,
      productId: request.productId ? String(request.productId) : "",
      pageNumber,
      pageSize: request.pageSize,
      total,
      totalPages,
      businessTotal,
      rankingTotal,
      rows: (rows || []).map(hqDashboardRow)
    }
  };
}

function hqDashboardProductSummarySql(startDateSql, endDateSql, pageNumber, pageSize) {
  return `${hqBusinessEventsCte(startDateSql, endDateSql)},
    product_summary AS (
      SELECT product.id AS entity_id,
             COALESCE(product.product_code::text, '') AS entity_code,
             COALESCE(product.product_name::text, '') AS entity_name,
             COALESCE(SUM(event.recharge_count), 0)::bigint AS recharge_count,
             COALESCE(SUM(event.verification_count), 0)::bigint AS verification_count,
             COALESCE(SUM(event.experience_count), 0)::bigint AS experience_count,
             COALESCE(SUM(event.refund_count), 0)::bigint AS refund_count
        FROM public.products product
   LEFT JOIN business_events event ON event.product_id = product.id
    GROUP BY product.id, product.product_code, product.product_name
    ), ordered_products AS (
      SELECT product_summary.*,
             ROW_NUMBER() OVER (
               ORDER BY entity_name ASC NULLS LAST, entity_code ASC NULLS LAST, entity_id ASC
             )::bigint AS row_number,
             COUNT(*) OVER ()::bigint AS total_rows
        FROM product_summary
    ), summary_meta AS (
      SELECT COALESCE(MAX(total_rows), 0)::bigint AS total_rows,
             LEAST(
               ${pageNumber}::bigint,
               GREATEST(1::bigint, CEIL(COALESCE(MAX(total_rows), 0)::numeric / ${pageSize})::bigint)
             ) AS page_number
        FROM ordered_products
    ), result_rows AS (
      SELECT 'META'::text AS row_type,
             NULL::bigint AS entity_id,
             NULL::text AS entity_code,
             NULL::text AS entity_name,
             NULL::bigint AS recharge_count,
             NULL::bigint AS verification_count,
             NULL::bigint AS experience_count,
             NULL::bigint AS refund_count,
             meta.total_rows,
             meta.page_number,
             0::bigint AS row_number
        FROM summary_meta meta
      UNION ALL
      SELECT 'ROW'::text AS row_type,
             product.entity_id,
             product.entity_code,
             product.entity_name,
             product.recharge_count,
             product.verification_count,
             product.experience_count,
             product.refund_count,
             meta.total_rows,
             meta.page_number,
             product.row_number
        FROM ordered_products product
       CROSS JOIN summary_meta meta
       WHERE product.row_number > (meta.page_number - 1) * ${pageSize}
         AND product.row_number <= meta.page_number * ${pageSize}
    )
    SELECT *
      FROM result_rows
     ORDER BY CASE row_type WHEN 'META' THEN 0 ELSE 1 END, row_number ASC`;
}

async function getHqDashboardProductSummary(requestedRange, event) {
  const request = dashboardProductSummaryRequest(event);
  const { startDateSql, endDateSql } = hqDashboardDateSql(requestedRange);
  let resultRows;
  try {
    resultRows = await executeSql(
      hqDashboardProductSummarySql(
        startDateSql,
        endDateSql,
        request.pageNumber,
        request.pageSize
      )
    );
  } catch (error) {
    asDatabaseError(error, "读取总部首页项目汇总");
  }
  const meta = (resultRows || []).find((row) => row.row_type === "META") || {};
  const total = Number(meta.total_rows || 0);
  const pageNumber = Number(meta.page_number || 1);
  return {
    productSummary: {
      pageNumber,
      pageSize: request.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / request.pageSize)),
      rows: (resultRows || []).filter((row) => row.row_type === "ROW").map(hqDashboardRow)
    }
  };
}

async function getHqDashboard(event = {}) {
  const requestedRange = dashboardDateRange(event);
  const mode = dashboardReadMode(event);
  const payload = mode === "ranking"
    ? await getHqDashboardRanking(requestedRange, event)
    : mode === "product-summary"
      ? await getHqDashboardProductSummary(requestedRange, event)
      : await getHqDashboardOverview(requestedRange);
  return { ok: true, version: FUNCTION_VERSION, mode, ...payload };
}

function requireTeacherExperienceTimerControlPlaneCaller() {
  let identity;
  try {
    identity = getAuth().getUserInfo();
  } catch (_) {
    fail("无法验证体验额度定时任务来源。", "UNTRUSTED_TIMER_EVENT");
  }
  if (String(identity?.uid || "").trim()) {
    fail("普通客户端不能执行体验额度月度重置。", "FORBIDDEN");
  }
}

async function handleTrustedTeacherExperienceResetTimer(event = {}, context = {}) {
  if (String(event?.Type || "").trim() !== "Timer"
      || String(event?.TriggerName || "").trim() !== TEACHER_EXPERIENCE_RESET_TIMER_TRIGGER_NAME) {
    return null;
  }
  // These are SCF-reserved runtime values, unlike event payload fields.  A
  // callFunction client cannot forge the timer source or function identity.
  if (String(process.env.TRIGGER_SRC || "").trim() !== "timer"
      || String(process.env.SCF_FUNCTIONNAME || "").trim() !== "staffAccount"
      || (String(context?.function_name || "").trim() && String(context.function_name) !== "staffAccount")
      || !Number.isFinite(Date.parse(String(event?.Time || "")))) {
    fail("体验额度月度重置定时任务来源无效。", "UNTRUSTED_TIMER_EVENT");
  }
  requireTeacherExperienceTimerControlPlaneCaller();
  const result = await resetTeacherExperienceQuotas(null);
  return {
    ...result,
    timer: true,
    triggerName: TEACHER_EXPERIENCE_RESET_TIMER_TRIGGER_NAME,
    timeZone: "Asia/Shanghai"
  };
}

async function retireOperationAccounts() {
  let accounts;
  try {
    accounts = await executeSql(
      `SELECT id, auth_uid
         FROM public.staff_accounts
        WHERE role_code = 'operation'
        ORDER BY id ASC`
    );
  } catch (error) {
    asDatabaseError(error, "读取待下线运营账号");
  }

  const failedStaffIds = [];
  let blockedCredentialCount = 0;
  for (const account of accounts || []) {
    const uid = String(account.auth_uid || "").trim();
    if (!uid) continue;
    try {
      // Repeating BLOCKED is supported by the same CloudBase path used when
      // an individual staff account is archived, so a failed batch is safe to
      // retry without restoring an earlier credential.
      await manager().user.modifyUser({ uid, userStatus: "BLOCKED" });
      blockedCredentialCount += 1;
    } catch (error) {
      console.error("operation credential retirement failed", {
        staffId: Number(account.id),
        requestId: requestIdFrom(error) || undefined,
        cause: cloudErrorDetails(error).code || undefined
      });
      failedStaffIds.push(Number(account.id));
    }
  }
  if (failedStaffIds.length) {
    const error = new Error("部分运营登录账号未能封存；数据库账号尚未归档。请检查云函数用户管理权限后重试。");
    error.code = "OPERATION_AUTH_RETIRE_INCOMPLETE";
    error.pendingStaffIds = failedStaffIds;
    throw error;
  }

  let retired;
  try {
    retired = await executeSql(
      `UPDATE public.staff_accounts
          SET account_status = 'ARCHIVED', updated_at = NOW()
        WHERE role_code = 'operation'
          AND account_status IS DISTINCT FROM 'ARCHIVED'
      RETURNING id`
    );
  } catch (error) {
    asDatabaseError(error, "归档运营业务账号");
  }
  return {
    ok: true,
    blockedCredentialCount,
    retiredDatabaseAccountCount: (retired || []).length
  };
}

async function main(event = {}, context = {}) {
  const scheduledReset = await handleTrustedTeacherExperienceResetTimer(event, context);
  if (scheduledReset) return scheduledReset;
  const action = event.action || "session";
  if (action === "health") {
    return {
      ok: true,
      message: "员工账号云函数已就绪",
      version: FUNCTION_VERSION,
      managerNodeInstalled: managerDependencyInstalled(),
      teacherExperienceResetTimerTriggerName: TEACHER_EXPERIENCE_RESET_TIMER_TRIGGER_NAME,
      teacherCreationService: "teacherCreate"
    };
  }
  const caller = await currentUser(false);

  if (action === "session") {
    if (!caller.profile && String(caller.uid) === String(process.env.BOOTSTRAP_HQ_UID || "")) {
      caller.profile = await ensureBootstrapHq(caller);
    }
    if (!caller.profile) {
      fail("当前登录身份尚未绑定可用业务账号。", "UNASSIGNED_IDENTITY");
    }
    return { ok: true, version: FUNCTION_VERSION, uid: caller.uid, profile: caller.profile };
  }
  if (action === "getHqDashboard") {
    requireHq(caller);
    return await getHqDashboard(event);
  }
  if (action === "getTeacherExperienceEntitlements") {
    requireHq(caller);
    return await getHqTeacherExperienceEntitlements(caller, event);
  }
  if (action === "upsertTeacherExperienceEntitlement") {
    requireHq(caller);
    return await upsertTeacherExperienceEntitlement(caller, event);
  }
  if (action === "deleteTeacherExperienceEntitlement") {
    requireHq(caller);
    return await deleteTeacherExperienceEntitlement(caller, event);
  }
  if (action === "rechargeTeacherExperienceEntitlement") {
    requireHq(caller);
    return await rechargeTeacherExperienceEntitlement(caller, event);
  }
  if (action === "resetTeacherExperienceQuotas") {
    requireHq(caller);
    return await resetTeacherExperienceQuotas(caller);
  }
  if (action === "setMasterStatus") {
    requireHq(caller);
    return await setMasterStatus(caller, event);
  }
  if (action === "retireOperationAccounts") {
    requireHq(caller);
    return await retireOperationAccounts();
  }
  if (action === "bootstrapHq") {
    return { ok: true, profile: await ensureBootstrapHq(caller) };
  }
  if (action === "listStaff") {
    requireHq(caller);
    const role = String(event.role || "");
    if (!ROLES.has(role)) fail("Unsupported staff role");
    const codePrefix = role === "teacher" ? "T" : role === "hq" ? "HQ" : "S";
    const rows = await executeSql(
      `SELECT a.id, a.auth_uid, a.phone, a.staff_name, a.role_code, a.account_status,
              a.password_initialized_at, a.password_changed_at, a.password_change_required,
              t.id AS teacher_id, t.teacher_code, t.teacher_status,
              ${sqlText(codePrefix)} || LPAD(a.id::text, 3, '0') AS person_code
       FROM public.staff_accounts a
       LEFT JOIN public.teachers t ON t.staff_account_id = a.id
       WHERE a.role_code = ${sqlText(role)} ORDER BY a.id ASC`
    );
    return { ok: true, staff: rows };
  }
  if (action === "listProducts") {
    if (!caller.profile?.role) fail("当前登录账号没有有效业务身份", "UNASSIGNED_PHONE");
    await getProductCreationCapabilities();
    await requireProductTemplateSchema();
    const statusFilter = caller.profile.role === "hq" ? "" : "WHERE product_status = 'ACTIVE'";
    let rows;
    try {
      rows = await executeSql(
        `SELECT id, product_code, product_name, product_type, description, product_status,
                (receipt_logo_file_id IS NOT NULL) AS receipt_logo_configured,
                (BTRIM(verification_receipt_instructions) <> '') AS verification_instructions_configured,
                (BTRIM(recharge_receipt_instructions) <> '') AS recharge_instructions_configured,
                receipt_template_updated_at, created_at, updated_at
         FROM public.products
         ${statusFilter}
         ORDER BY id ASC`
      );
    } catch (error) {
      asDatabaseError(error, "读取项目列表");
    }
    return { ok: true, products: rows };
  }
  if (action === "listRetailProducts") {
    requireHq(caller);
    await requireRetailProductSchema();
    let rows;
    try {
      rows = await executeSql(
        `SELECT id, product_code, product_name, product_status, created_at, updated_at
         FROM public.retail_products
         ORDER BY CASE product_status WHEN 'ACTIVE' THEN 0 ELSE 1 END, id ASC`
      );
    } catch (error) {
      asDatabaseError(error, "读取产品列表");
    }
    return { ok: true, products: rows };
  }
  if (action === "createRetailProduct") {
    requireHq(caller);
    const result = await createRetailProductRecord(caller, event);
    return { ok: true, product: result.product, created: result.created };
  }
  if (action === "setRetailProductStatus") {
    requireHq(caller);
    await requireRetailProductSchema();
    const productRef = String(event.productRef || "").trim();
    const status = String(event.status || "").toUpperCase();
    if (!productRef) fail("缺少产品编号", "BAD_REQUEST");
    if (!["ACTIVE", "ARCHIVED"].includes(status)) {
      fail("产品状态只能是 ACTIVE（活跃）或 ARCHIVED（封存）", "BAD_REQUEST");
    }
    const idCondition = /^\d+$/.test(productRef)
      ? `id = ${numericId(productRef, "产品编号")}`
      : "FALSE";
    const actorId = numericId(caller.profile.staffId, "总部账号编号");
    let rows;
    try {
      rows = await executeSql(
        `WITH updated_product AS (
           UPDATE public.retail_products
           SET product_status = ${sqlText(status)},
               updated_by_staff_account_id = ${actorId},
               updated_at = NOW()
           WHERE (${idCondition}) OR product_code = ${sqlText(productRef)}
           RETURNING id, product_code, product_name, product_status, created_at, updated_at
         )
         SELECT id, product_code, product_name, product_status, created_at, updated_at
         FROM updated_product`
      );
    } catch (error) {
      asDatabaseError(error, "更新产品状态");
    }
    const product = rows?.[0] || await findRetailProductByReference(productRef);
    if (!product) fail("未找到该产品", "NOT_FOUND");
    if (String(product.product_status || "").toUpperCase() !== status) {
      fail("产品状态写入后数据库回读不一致", "DATABASE_ERROR");
    }
    return { ok: true, product };
  }
  if (action === "createProduct") {
    requireHq(caller);
    const result = await createProductRecord(event);
    return { ok: true, product: result.product, created: result.created };
  }
  if (action === "setProductStatus") {
    requireHq(caller);
    const productRef = String(event.productRef || "").trim();
    const status = String(event.status || "").toUpperCase();
    if (!productRef) fail("缺少项目编号", "BAD_REQUEST");
    if (!["ACTIVE", "ARCHIVED"].includes(status)) {
      fail("项目状态只能是 ACTIVE（活跃）或 ARCHIVED（封存）", "BAD_REQUEST");
    }
    const idCondition = /^\d+$/.test(productRef)
      ? `id = ${numericId(productRef, "项目编号")}`
      : "FALSE";
    let rows;
    try {
      rows = await executeSql(
        `WITH updated_product AS (
           UPDATE public.products
           SET product_status = ${sqlText(status)}, updated_at = NOW()
           WHERE (${idCondition}) OR product_code = ${sqlText(productRef)}
           RETURNING id, product_code, product_name, product_type, description, product_status,
                     created_at, updated_at
         )
         SELECT id, product_code, product_name, product_type, description, product_status,
                created_at, updated_at
         FROM updated_product`
      );
    } catch (error) {
      asDatabaseError(error, "更新项目状态");
    }
    if (!rows?.[0]) fail("未找到该项目", "NOT_FOUND");
    return { ok: true, product: rows[0] };
  }
  if (action === "getProductReceiptTemplate") {
    if (!caller.profile?.role) fail("当前登录账号没有有效业务身份", "UNASSIGNED_PHONE");
    return { ok: true, template: await getProductReceiptTemplate(event) };
  }
  if (action === "getProductReceiptLogoData") {
    if (!caller.profile?.role) fail("当前登录账号没有有效业务身份", "UNASSIGNED_PHONE");
    return { ok: true, logo: await getProductReceiptLogoData(event) };
  }
  if (action === "beginProductLogoUpload") {
    requireHq(caller);
    return { ok: true, ...(await beginProductLogoUpload(event)) };
  }
  if (action === "uploadProductLogoByFunction") {
    requireHq(caller);
    return {
      ok: true,
      uploadMode: "FUNCTION",
      template: await uploadProductLogoByFunction(caller, event)
    };
  }
  if (action === "confirmProductLogoUpload") {
    requireHq(caller);
    return { ok: true, template: await confirmProductLogoUpload(caller, event) };
  }
  if (action === "discardProductLogoUpload") {
    requireHq(caller);
    return { ok: true, ...(await discardProductLogoUpload(caller, event)) };
  }
  if (action === "saveProductReceiptTemplate") {
    requireHq(caller);
    return { ok: true, template: await saveProductReceiptTemplate(caller, event) };
  }
  if (action === "removeProductReceiptLogo") {
    requireHq(caller);
    return { ok: true, template: await removeProductReceiptLogo(caller, event) };
  }
  if (action === "listReviewOrders") {
    const result = await listReviewOrders(caller, event);
    return Array.isArray(result) ? { ok: true, orders: result } : { ok: true, ...result };
  }
  if (action === "reviewOrder") {
    return { ok: true, order: await reviewOrder(caller, event) };
  }
  if (action === "listRetailProductPurchaseReviews") {
    return { ok: true, ...(await listRetailProductPurchaseReviews(caller, event)) };
  }
  if (action === "reviewRetailProductPurchase") {
    return { ok: true, order: await reviewRetailProductPurchase(caller, event) };
  }
  if (action === "requestOrderVoid") {
    return { ok: true, order: await requestOrderVoid(caller, event) };
  }
  if (action === "voidVerification") {
    fail("核销工单不再支持作废；如需补回次数，请提交充值工单", "VERIFICATION_VOID_DISABLED");
  }
  if (action === "listStores") {
    requireHq(caller);
    const capabilities = await getStoreCreationCapabilities();
    const layout = await getStoreBindingLayout();
    const contactJoin = capabilities.storeContacts
      ? `LEFT JOIN LATERAL (
           SELECT contact_name, contact_phone
           FROM public.store_contacts
           WHERE store_id = store.id AND contact_status = 'ACTIVE'
           ORDER BY is_primary DESC, id ASC
           LIMIT 1
         ) contact ON TRUE`
      : "";
    const contactName = capabilities.storeContacts ? "contact.contact_name" : "NULL::varchar";
    const contactPhone = capabilities.storeContacts ? "contact.contact_phone" : "NULL::varchar";
    const jsonName = capabilities.contactsJson ? "store.contacts_json -> 0 ->> 'name'" : "NULL::text";
    const jsonPhone = capabilities.contactsJson ? "store.contacts_json -> 0 ->> 'phone'" : "NULL::text";
    const rows = await executeSql(
      `SELECT store.id, store.store_code, store.store_name, store.province, store.city,
              store.district, store.address_detail, store.store_status,
              COALESCE(${contactName}, ${jsonName}, account.staff_name) AS contact_name,
              COALESCE(${contactPhone}, ${jsonPhone}, account.phone) AS contact_phone,
              account.auth_uid, account.id AS staff_account_id
       FROM public.stores store
       ${storeAccountJoin(layout)}
       ${contactJoin}
       ORDER BY store.id ASC`
    );
    return { ok: true, stores: rows };
  }
  if (action === "provisionStaff") {
    requireHq(caller);
    const staffName = String(event.staffName || "").trim();
    const phone = validatePhone(event.phone);
    const role = String(event.role || "");
    const storeId = String(event.storeId || "").trim();
    const password = validatePassword(event.initialPassword);
    if (!staffName) fail("请填写员工姓名");
    if (role === "operation") fail("运营账号已下线，不能再创建。", "OPERATION_ROLE_RETIRED");
    if (!ROLES.has(role)) fail("员工角色必须是总部、门店或老师");
    // Teacher creation is owned exclusively by the dedicated teacherCreate
    // service. Reject the role before Auth or SQL work.
    if (role === "teacher") {
      fail("新建老师必须使用独立 teacherCreate 服务。", "TEACHER_CREATE_SERVICE_REQUIRED");
    }
    if (role === "store" && !/^\d+$/.test(storeId)) fail("门店员工必须绑定已创建门店的数字编号");

    await assertPhoneCanUseRole(phone, role);

    let authUser = await findAuthUserByExactPhone(phone);
    let authCreated = false;

    if (!authUser) {
      try {
        const created = await manager().user.createUser({
          name: `staff_${phone}`,
          password,
          // Business permissions are resolved from PostgreSQL staff_accounts.
          // Creating these as external users avoids consuming the CloudBase
          // package's limited internal/organization-member quota.
          type: "externalUser",
          userStatus: "ACTIVE",
          nickName: staffName,
          phone,
          description: "业务员工登录账号"
        });
        const uid = String(created?.Data?.Uid || "");
        if (!uid) {
          const error = new Error("CreateUser did not return a UID");
          error.RequestId = created?.RequestId;
          stageFail(
            "AUTH_CREATE",
            "认证账号创建后未返回 UID。请勿重复提交，先由总部检查认证用户。",
            "AUTH_CREATE_INCOMPLETE",
            error
          );
        }
        authUser = { Uid: uid };
        authCreated = true;
      } catch (error) {
        if (!isDuplicateAuthError(error)) {
          const cause = cloudErrorDetails(error);
          const diagnostic = [cause.code, cause.message].filter(Boolean).join("：");
          stageFail(
            "AUTH_CREATE",
            `认证登录账号创建失败。${diagnostic ? `腾讯云返回 ${diagnostic}。` : "请检查云函数的用户管理权限。"}`,
            "AUTH_CREATE_FAILED",
            error
          );
        }
        // Two HQ requests may arrive together. Re-query by the exact phone and
        // then continue safely without overwriting an existing password.
        authUser = await findAuthUserByExactPhone(phone);
        if (!authUser?.Uid) {
          stageFail(
            "AUTH_CREATE",
            "认证账号创建冲突，但无法读取已有账号。请勿重复提交。",
            "AUTH_CREATE_CONFLICT",
            error
          );
        }
      }
    }

    const uid = String(authUser?.Uid || "");
    if (!uid) fail("认证账号无有效 UID，请勿重复提交", "AUTH_CREATE_INCOMPLETE");

    let profile;
    try {
      profile = await createStaffDatabaseProfile({ uid, phone, staffName, role, storeId });
    } catch (error) {
      stageFail(
        "DB_PROFILE",
        error?.code === "PHONE_ROLE_CONFLICT" || error?.code === "PHONE_ALREADY_PROVISIONED" || error?.code === "STORE_BINDING_FAILED"
          ? error.message
          : "认证账号已存在，但员工业务资料绑定失败。请勿重复创建，稍后可用同一手机号继续恢复。",
        error?.code || "STAFF_PROFILE_SAVE_FAILED",
        error
      );
    }

    let warning = "";
    if (authCreated) {
      try {
        await writeCredentialEvent({
          targetStaffId: profile.staffId,
          actorStaffId: caller.profile.staffId,
          eventType: "ACCOUNT_CREATED",
          passwordChangeRequired: true
        });
      } catch (error) {
        // The login account and business identity are already usable. Do not
        // make the HQ create screen look like it failed solely due to audit.
        console.error("credential audit write failed after provision", {
          code: error?.code,
          requestId: requestIdFrom(error) || undefined,
          message: error?.message
        });
        warning = "账号已创建，但密码审计记录未写入；请稍后检查数据库迁移。";
      }
    }
    return {
      ok: true,
      uid,
      phone,
      profile,
      authAccount: authCreated ? "created" : "recovered",
      passwordInitialized: authCreated,
      warning: warning || undefined
    };
  }
  if (action === "createStoreWithAccount") {
    requireHq(caller);
    const input = storeInputFromEvent(event);
    const password = validatePassword(event.initialPassword);
    try {
      await assertPhoneCanUseRole(input.contactPhone, "store");
    } catch (error) {
      stageFail(
        "ACCOUNT_PREFLIGHT",
        error?.message || "门店登录手机号检查失败",
        error?.code || "ACCOUNT_PREFLIGHT_FAILED",
        error
      );
    }
    let store;
    try {
      store = await createOrRecoverStore(caller, input);
    } catch (error) {
      stageFail(
        "STORE_PROFILE",
        error?.message || "门店资料创建失败",
        error?.code || "STORE_PROFILE_SAVE_FAILED",
        error
      );
    }
    try {
      // Reuse the same idempotent account path as all other business roles.
      // It rechecks the currently authenticated HQ before it writes the account.
      const account = await main({
        action: "provisionStaff",
        staffName: input.contactName,
        phone: input.contactPhone,
        role: "store",
        storeId: store.id,
        initialPassword: password
      });
      return {
        ok: true,
        storeId: store.id,
        storeCode: store.code,
        store: { id: store.id, code: store.code },
        account: {
          uid: account.uid,
          staffId: account.profile?.staffId || null,
          authAccount: account.authAccount,
          passwordInitialized: account.passwordInitialized
        },
        warning: account.warning || undefined
      };
    } catch (error) {
      // CloudBase Identity and PostgreSQL cannot share one transaction. Roll
      // back only an unbound store, and never delete a store whose account was
      // bound by a concurrent request. If cleanup cannot be confirmed, retain
      // the identifiers so the same form can safely resume the binding.
      const removed = await removeUnboundStore(store.id);
      if (!removed) {
        error.storeId = store.id;
        error.storeCode = store.code;
      } else {
        error.storeRolledBack = true;
      }
      error.stage = error.stage || "ACCOUNT_BINDING";
      throw error;
    }
  }
  if (action === "resetPassword") {
    requireHq(caller);
    const uid = String(event.uid || "").trim();
    if (!uid) fail("缺少员工 UID");
    const newPassword = validatePassword(event.newPassword);
    const rows = await executeSql(
      `SELECT id, auth_uid, role_code FROM public.staff_accounts WHERE auth_uid = ${sqlText(uid)} LIMIT 1`
    );
    const target = rows?.[0];
    if (!target) fail("Target staff account was not found", "NOT_FOUND");
    if (target.role_code === "operation") fail("运营账号已下线，不能修改密码。", "OPERATION_ROLE_RETIRED");
    await manager().user.modifyUser({ uid, password: newPassword });
    await writeCredentialEvent({
      targetStaffId: target.id,
      actorStaffId: caller.profile.staffId,
      eventType: "HQ_PASSWORD_RESET",
      passwordChangeRequired: true
    });
    return { ok: true };
  }
  if (action === "changeOwnPassword") {
    const newPassword = validatePassword(event.newPassword);
    if (!caller.profile?.staffId) fail("This login account has no staff identity", "UNASSIGNED_PHONE");
    await manager().user.modifyUser({ uid: caller.uid, password: newPassword });
    await writeCredentialEvent({
      targetStaffId: caller.profile.staffId,
      actorStaffId: caller.profile.staffId,
      eventType: "SELF_PASSWORD_CHANGED",
      passwordChangeRequired: false
    });
    return { ok: true };
  }
  if (action === "setStaffStatus") {
    requireHq(caller);
    const uid = String(event.uid || "").trim();
    const phone = String(event.phone || "").replace(/\D/g, "");
    const status = String(event.status || "").toUpperCase();
    if ((!uid && !/^1[3-9]\d{9}$/.test(phone)) || !["ACTIVE", "ARCHIVED"].includes(status)) fail("人员状态只能是 ACTIVE（活跃）或 ARCHIVED（封存）");
    let rows;
    try {
      const column = uid ? "auth_uid" : "phone";
      const value = uid || phone;
      rows = await executeSql(
        `SELECT a.id, a.auth_uid, a.phone, a.role_code, a.account_status,
                t.id AS teacher_id, t.teacher_status
           FROM public.staff_accounts a
           LEFT JOIN public.teachers t ON t.staff_account_id = a.id
          WHERE a.${column} = ${sqlText(value)}
          LIMIT 1`
      );
    } catch (error) {
      asDatabaseError(error, "查找人员账号");
    }
    const staff = rows?.[0];
    if (!staff) fail("未找到该人员账号", "NOT_FOUND");
    if (staff.role_code === "operation") {
      fail("运营账号已下线，不能恢复、封存或修改。请使用 retireOperationAccounts 完成统一下线。", "OPERATION_ROLE_RETIRED");
    }
    if (staff.role_code === "teacher") {
      // Preflight/repair the master-data invariant before any external
      // credential write. This prevents a legacy missing profile from turning
      // an archive click into "CloudBase BLOCKED but PostgreSQL ACTIVE".
      if (status === "ACTIVE") await requireTeacherStatusSchema();
      if (!staff.teacher_id) {
        const teacher = await ensureTeacherDatabaseProfile(staff.id);
        staff.teacher_id = teacher.id;
        staff.teacher_status = teacher.teacher_status;
      }
    }
    // Teacher activation depends only on the account/master status invariant.
    try {
      await persistStaffStatusAndMaster(staff, status);
    } catch (error) {
      if (["TEACHER_PROFILE_MISSING", "STORE_PROFILE_MISSING", "STATUS_SYNC_FAILED"].includes(error?.code)) throw error;
      asDatabaseError(error, "同步人员与业务主档状态");
    }
    let credentialStatus = staff.auth_uid ? "UNCHANGED" : "NOT_LINKED";
    let warning = "";
    let warningCode = "";
    if (!staff.auth_uid && status === "ACTIVE") {
      if (staff.role_code === "teacher") await archiveTeacherProvisioning(staff.id);
      fail("该人员没有可恢复的 CloudBase 认证账号，业务状态已保持封存。", "AUTH_CREDENTIAL_MISSING");
    }
    if (staff.auth_uid) {
      try {
        await manager().user.modifyUser({ uid: staff.auth_uid, userStatus: status === "ACTIVE" ? "ACTIVE" : "BLOCKED" });
        credentialStatus = status === "ACTIVE" ? "ACTIVE" : "BLOCKED";
      } catch (error) {
        if (status === "ACTIVE") {
          // Never leave an account selectable/active in PostgreSQL when its
          // corresponding CloudBase login could not be restored consistently.
          if (staff.role_code === "teacher") await archiveTeacherProvisioning(staff.id);
          else if (staff.role_code === "store") await archiveStoreProvisioning(staff.id);
          else {
            try {
              await executeSql(
                `UPDATE public.staff_accounts SET account_status = 'ARCHIVED', updated_at = NOW() WHERE id = ${Number(staff.id)}`
              );
            } catch (compensationError) {
              console.error("staff activation compensation failed", compensationError?.message || compensationError);
            }
          }
          const missingCredential = missingCloudBaseCredential(error);
          stageFail(
            "AUTH_ACTIVATE",
            missingCredential
              ? "该历史／压力账号没有真实 CloudBase 认证凭据，不能激活登录；业务资料已保持封存。"
              : "CloudBase 登录账号激活失败，业务资料已重新封存。",
            missingCredential ? "AUTH_CREDENTIAL_MISSING" : "AUTH_ACTIVATION_FAILED",
            error
          );
        } else {
          // PostgreSQL is the application authorization source. Once
          // archived, even a legacy/fake credential cannot enter a business
          // function. Report the secondary identity-layer outcome without
          // reverting the successful archive or showing a false UI failure.
          const missingCredential = missingCloudBaseCredential(error);
          credentialStatus = missingCredential ? "MISSING" : "BLOCK_FAILED";
          warningCode = missingCredential ? "AUTH_CREDENTIAL_MISSING" : "AUTH_BLOCK_FAILED";
          warning = missingCredential
            ? "人员及业务主档已封存；历史认证账号不存在，无需额外禁用。"
            : "人员及业务主档已封存，业务登录已被后端拒绝；CloudBase 认证层禁用失败，请总部检查函数权限。";
        }
      }
    }
    const finalRows = await executeSql(
      `SELECT account.account_status, teacher.teacher_status
         FROM public.staff_accounts AS account
         LEFT JOIN public.teachers AS teacher ON teacher.staff_account_id = account.id
        WHERE account.id = ${Number(staff.id)}
        LIMIT 1`
    );
    const finalState = finalRows?.[0] || {};
    if (String(finalState.account_status || "") !== status
        || (staff.role_code === "teacher" && String(finalState.teacher_status || "") !== status)) {
      fail("人员主档与账号最终状态不一致。", "STATUS_SYNC_FAILED");
    }
    return {
      ok: true,
      uid: staff.auth_uid,
      staffId: String(staff.id),
      teacherId: staff.teacher_id ? String(staff.teacher_id) : undefined,
      status,
      accountStatus: String(finalState.account_status || ""),
      teacherStatus: String(finalState.teacher_status || "") || undefined,
      credentialStatus,
      warning: warning || undefined,
      warningCode: warningCode || undefined
    };
  }
  fail("不支持的操作");
}

// Keep master-data status and the linked credential status in one database
// statement wherever the schema has no status-synchronizing trigger. For a
// teacher, migration 046's teacher trigger performs the account update inside
// the same UPDATE statement; doing a second CTE update of the same account
// row would conflict with that trigger's write.
async function persistStaffStatusAndMaster(staff, status) {
  const staffId = Number(staff.id);
  if (!Number.isSafeInteger(staffId) || staffId < 1) fail("人员账号编号无效。", "BAD_REQUEST");

  if (staff.role_code === "teacher") {
    if (!staff.teacher_id) {
      const repaired = await ensureTeacherDatabaseProfile(staffId);
      staff.teacher_id = repaired.id;
    }
    const rows = await executeSql(
      `UPDATE public.teachers
          SET teacher_status = ${sqlText(status)}, updated_at = NOW()
        WHERE staff_account_id = ${staffId}
        RETURNING id, teacher_status`
    );
    if (!rows?.[0]) fail("老师主档自动修复后仍无法保存状态。", "TEACHER_PROFILE_MISSING");
    // trg_sync_teacher_account_status makes this status update atomic with
    // the master-row update. Verify the invariant instead of issuing a later
    // independent account update that could reopen a partial state.
    const accountRows = await executeSql(
      `SELECT account_status FROM public.staff_accounts WHERE id = ${staffId} LIMIT 1`
    );
    if (String(accountRows?.[0]?.account_status || "") !== status) {
      fail("老师主档状态未能同步到登录账号，请确认迁移 050 已完整执行。", "STATUS_SYNC_FAILED");
    }
    return;
  }

  if (staff.role_code === "store") {
    const layout = await getStoreBindingLayout();
    const statement = layout === "stores"
      ? `WITH changed_store AS (
           UPDATE public.stores
              SET store_status = ${sqlText(status)}, updated_at = NOW()
            WHERE store_account_id = ${staffId}
            RETURNING id
         ), changed_account AS (
           UPDATE public.staff_accounts
              SET account_status = ${sqlText(status)}, updated_at = NOW()
            WHERE id = ${staffId}
              AND EXISTS (SELECT 1 FROM changed_store)
            RETURNING id
         )
         SELECT (SELECT COUNT(*) FROM changed_store) AS store_count,
                (SELECT COUNT(*) FROM changed_account) AS account_count`
      : `WITH changed_store AS (
           UPDATE public.stores AS store
              SET store_status = ${sqlText(status)}, updated_at = NOW()
             FROM public.staff_store_assignments AS assignment
            WHERE assignment.store_id = store.id
              AND assignment.staff_account_id = ${staffId}
            RETURNING store.id
         ), changed_account AS (
           UPDATE public.staff_accounts
              SET account_status = ${sqlText(status)}, updated_at = NOW()
            WHERE id = ${staffId}
              AND EXISTS (SELECT 1 FROM changed_store)
            RETURNING id
         )
         SELECT (SELECT COUNT(*) FROM changed_store) AS store_count,
                (SELECT COUNT(*) FROM changed_account) AS account_count`;
    const rows = await executeSql(statement);
    const result = rows?.[0] || {};
    if (Number(result.store_count || 0) < 1 || Number(result.account_count || 0) !== 1) {
      fail("门店账号缺少可同步的门店主档，未修改业务状态。", "STORE_PROFILE_MISSING");
    }
    return;
  }

  await executeSql(
    `UPDATE public.staff_accounts
        SET account_status = ${sqlText(status)}, updated_at = NOW()
      WHERE id = ${staffId}`
  );
}

exports.main = async (event = {}, context = {}) => {
  try {
    return await main(event, context);
  } catch (error) {
    console.error("staffAccount failed", {
      action: event?.action || "session",
      stage: error?.stage,
      code: error?.code || "FUNCTION_ERROR",
      requestId: error?.requestId || requestIdFrom(error) || undefined,
      message: error?.message || String(error),
      stack: error?.stack
    });
    return {
      ok: false,
      code: error?.code || "FUNCTION_ERROR",
      stage: error?.stage || undefined,
      requestId: error?.requestId || requestIdFrom(error) || undefined,
      storeId: error?.storeId || undefined,
      storeCode: error?.storeCode || undefined,
      storeRolledBack: error?.storeRolledBack || undefined,
      causeCode: error?.causeCode || undefined,
      causeMessage: error?.causeMessage || undefined,
      message: error?.message || "员工账号服务暂不可用，请稍后重试"
    };
  }
};
