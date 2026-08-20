"use strict";

const cloudbase = require("@cloudbase/node-sdk");
const CloudBaseManager = require("@cloudbase/manager-node");
const crypto = require("crypto");

const PHOTO_ONLY_FUNCTION = String(process.env.VERIFICATION_PHOTO_ONLY_FUNCTION || "").trim() === "1";
const FUNCTION_VERSION = PHOTO_ONLY_FUNCTION ? "v4" : "v73";
const CLEANUP_TIMER_TRIGGER_NAME = PHOTO_ONLY_FUNCTION
  ? "cleanup-verification-photo-uploads-hourly"
  : "cleanup-verification-photo-drafts-hourly";
const EXPECTED_FUNCTION_NAME = PHOTO_ONLY_FUNCTION ? "verificationPhoto" : "faceRecognition";
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
// SCF synchronous events are capped at 6 MB and Base64 adds roughly 33%.
// These verification-photo limits leave room for the JSON envelope while
// retaining a high-quality 1920–2400 px JPEG. Customer enrollment keeps its
// existing independent 4 MB limit above.
const MAX_VERIFICATION_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 384 * 1024;
const FACE_MODEL_VERSION = "3.0";
const TEACHER_FACE_DELEGATION_VERSION = "teacher-face-v1";
const TEACHER_FACE_DELEGATION_MAX_AGE_MS = 2 * 60 * 1000;
let cloudApp = null;
let managerClient = null;
let storeBindingLayout = null;
let iaiClientClass = null;
let verificationPhotoUploadSchemaReady = null;
const signedCustomerPhotoCache = new Map();
const signedVerificationPhotoCache = new Map();

function app() {
  if (!cloudApp) cloudApp = cloudbase.init({});
  return cloudApp;
}

function cloudbaseEnvId() {
  const envId = String(process.env.CLOUDBASE_ENV_ID || process.env.TCB_ENV || "").trim();
  if (!envId) throw new Error("Missing cloud function environment variable: CLOUDBASE_ENV_ID or TCB_ENV");
  return envId;
}

function manager() {
  if (!managerClient) managerClient = CloudBaseManager.init({ envId: cloudbaseEnvId() });
  return managerClient;
}

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`Missing cloud function environment variable: ${name}`);
  return value;
}

function cloudbaseServiceRoleKey() {
  const managedValue = String(process.env.CLOUDBASE_APIKEY || "").trim();
  const legacyValue = String(process.env.CLOUDBASE_SERVICE_ROLE_KEY || "").trim();
  const value = managedValue || legacyValue;
  if (!value) {
    throw new Error(
      "Missing CloudBase service-role API key: CLOUDBASE_APIKEY or CLOUDBASE_SERVICE_ROLE_KEY"
    );
  }
  return value;
}

function cloudbaseServiceRoleKeyConfigured() {
  const managedValue = String(process.env.CLOUDBASE_APIKEY || "").trim();
  const legacyValue = String(process.env.CLOUDBASE_SERVICE_ROLE_KEY || "").trim();
  return Boolean(managedValue || legacyValue);
}

function numberSetting(name, fallback, minimum, maximum) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be a number between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function verificationPhotoUrlTtlSeconds() {
  return Math.trunc(numberSetting("VERIFICATION_PHOTO_URL_TTL_SECONDS", 900, 60, 900));
}

function verificationPhotoUploadTtlSeconds() {
  return Math.trunc(numberSetting("VERIFICATION_PHOTO_UPLOAD_TTL_SECONDS", 600, 120, 900));
}

function booleanSetting(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function fail(message, code = "BAD_REQUEST") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function sqlText(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function parseSqlRows(result) {
  const columns = result?.Columns || [];
  return (result?.Rows || []).map((raw) => {
    const values = Array.isArray(raw) ? raw : JSON.parse(raw);
    return Object.fromEntries(columns.map((column, index) => [column, values[index]]));
  });
}

async function executeSql(sql) {
  return parseSqlRows(await manager().database.executePGSql({ Sql: sql }));
}

function databaseBoolean(value) {
  return [true, "true", "t", 1, "1"].includes(value);
}

async function mapWithConcurrency(items, limit, mapper) {
  const rows = Array.isArray(items) ? items : [];
  const output = new Array(rows.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, Number(limit) || 1), rows.length) }, async () => {
    while (cursor < rows.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(rows[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

async function getStoreBindingLayout() {
  if (storeBindingLayout) return storeBindingLayout;
  const rows = await executeSql(
    `SELECT
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public'
           AND table_name = 'stores'
           AND column_name = 'store_account_id'
       ) AS has_store_account_id,
       EXISTS (
         SELECT 1 FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name = 'staff_store_assignments'
       ) AS has_staff_store_assignments`
  );
  const layout = rows?.[0] || {};
  if (databaseBoolean(layout.has_store_account_id)) storeBindingLayout = "stores";
  else if (databaseBoolean(layout.has_staff_store_assignments)) storeBindingLayout = "assignments";
  else fail("The database has no store-account binding structure.", "DATABASE_SCHEMA_MISSING");
  return storeBindingLayout;
}

function faceClient() {
  // Customer list/detail/photo actions do not use Tencent IAI. Loading the
  // large face SDK only for actual face operations keeps ordinary customer
  // selection fast, especially after a cold start.
  if (!iaiClientClass) iaiClientClass = require("tencentcloud-sdk-nodejs").iai.v20200303.Client;
  return new iaiClientClass({
    credential: { secretId: required("FACE_SECRET_ID"), secretKey: required("FACE_SECRET_KEY") },
    region: "ap-guangzhou",
    profile: { httpProfile: { endpoint: "iai.tencentcloudapi.com" } }
  });
}

function faceSettings() {
  return {
    qualityThreshold: numberSetting("FACE_QUALITY_THRESHOLD", 70, 0, 100),
    livenessEnabled: booleanSetting("FACE_LIVENESS_ENABLED", false),
    livenessThreshold: numberSetting("FACE_LIVENESS_THRESHOLD", 40, 0, 100),
    matchThreshold: numberSetting("FACE_MATCH_THRESHOLD", 85, 0, 99.99),
    verifyThreshold: numberSetting("FACE_VERIFY_THRESHOLD", 60, 0, 99.99),
    matchMargin: numberSetting("FACE_MATCH_MARGIN", 10, 0, 100),
    maxYaw: numberSetting("FACE_MAX_YAW", 20, 0, 90),
    maxPitch: numberSetting("FACE_MAX_PITCH", 20, 0, 90),
    maxRoll: numberSetting("FACE_MAX_ROLL", 15, 0, 90)
  };
}

function photoStorageSettings() {
  return {
    bucketId: String(process.env.CUSTOMER_PHOTO_BUCKET_ID || "customer-photos").trim(),
    accessToken: cloudbaseServiceRoleKey(),
    envId: cloudbaseEnvId()
  };
}

function verificationPhotoStorageSettings() {
  return {
    bucketId: String(process.env.VERIFICATION_PHOTO_BUCKET_ID || "verification-photos").trim(),
    accessToken: cloudbaseServiceRoleKey(),
    envId: cloudbaseEnvId()
  };
}

function verificationPhotoStorageCandidates() {
  const candidates = [verificationPhotoStorageSettings(), photoStorageSettings()];
  return candidates.filter((candidate, index) => candidate.bucketId
    && candidates.findIndex((item) => item.bucketId === candidate.bucketId) === index);
}

function parsePhotoReference(value) {
  const reference = String(value || "").trim();
  if (!reference.startsWith("pg://")) fail("客户照片引用格式无效。", "PHOTO_REFERENCE_INVALID");
  const path = reference.slice(5);
  const separator = path.indexOf("/");
  if (separator <= 0 || separator === path.length - 1) fail("客户照片引用格式无效。", "PHOTO_REFERENCE_INVALID");
  return { bucketId: path.slice(0, separator), objectName: path.slice(separator + 1) };
}

function photoObjectCandidates(bucketId, objectName) {
  const bucket = String(bucketId || "").trim().replace(/^\/+|\/+$/g, "");
  const object = String(objectName || "").trim().replace(/^\/+/, "");
  if (!bucket || !object) return [];
  const prefix = `${bucket}/`;
  const candidates = [object];
  if (object.startsWith(prefix)) candidates.push(object.slice(prefix.length));
  else candidates.push(`${prefix}${object}`);
  return [...new Set(candidates.filter(Boolean))];
}

function storageObjectMissing(error) {
  const detail = [error?.code, error?.message].filter(Boolean).join(" ").toUpperCase();
  return detail.includes("STORAGE_OBJECT_NOT_FOUND") || detail.includes("OBJECT NOT FOUND");
}

function storageBucketMissing(error) {
  const detail = [error?.code, error?.message].filter(Boolean).join(" ").toUpperCase();
  return detail.includes("STORAGE_BUCKET_NOT_FOUND") || detail.includes("BUCKET NOT FOUND");
}

function signedUploadFunctionFallbackAllowed(error) {
  const detail = [error?.code, error?.message, responseErrorText(error)]
    .filter(Boolean).join(" ").toUpperCase();
  return detail.includes("STORAGE_INVALID_REQUEST")
    && detail.includes("RELATED RESOURCE DOES NOT EXIST");
}

function storageUploadResponseMismatch(error) {
  const detail = String(error?.message || "");
  return detail.includes("上传成功但响应格式异常")
    && detail.includes("Id")
    && detail.includes("Key");
}

function verificationPhotoStorageEnvironmentError(error, storage) {
  const mismatch = new Error(
    `腾讯云照片存储无法在环境 ${storage.envId} 中识别私有桶 ${storage.bucketId}。请确认这是 PG 云存储桶的真实 ID，并确认 CLOUDBASE_APIKEY（或兼容变量 CLOUDBASE_SERVICE_ROLE_KEY）属于同一环境。`
  );
  mismatch.code = "PHOTO_STORAGE_ENV_MISMATCH";
  mismatch.requestId = error?.requestId || error?.RequestId || "";
  return mismatch;
}

function verificationPhotoStorageAccessError(error, storage) {
  const detail = [error?.code, error?.message, responseErrorText(error)]
    .filter(Boolean).join(" ").toUpperCase();
  const configurationFailure = storageBucketMissing(error)
    || (detail.includes("STORAGE_INVALID_REQUEST") && detail.includes("RELATED RESOURCE DOES NOT EXIST"))
    || ["401", "403", "AUTH", "JWT", "TOKEN", "EXCEED_AUTHORITY", "ACTION_FORBIDDEN"]
      .some((marker) => detail.includes(marker));
  if (configurationFailure) return verificationPhotoStorageEnvironmentError(error, storage);
  const unavailable = new Error("腾讯云照片存储暂时无法确认服务端上传通道，请稍后重试。");
  unavailable.code = "PHOTO_STORAGE_CHECK_FAILED";
  unavailable.requestId = error?.requestId || error?.RequestId || "";
  return unavailable;
}

function verificationPhotoBucketReady(row, requiredBytes = MAX_VERIFICATION_IMAGE_BYTES) {
  if (!row || databaseBoolean(row.public)) return false;
  const limit = Number(row.file_size_limit || 0);
  if (Number.isFinite(limit) && limit > 0 && limit < requiredBytes) return false;
  const allowed = row.allowed_mime_types;
  if (allowed === null || allowed === undefined || allowed === "") return true;
  const mimeTypes = Array.isArray(allowed) ? allowed : String(allowed).match(/[\w.+-]+\/[\w.+-]+/g) || [];
  return mimeTypes.map((value) => String(value).toLowerCase()).includes("image/jpeg");
}

function signedPhotoUrl(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return "";
  if (typeof value === "string") return /^https:\/\//i.test(value.trim()) ? value.trim() : "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const url = signedPhotoUrl(item, depth + 1);
      if (url) return url;
    }
    return "";
  }
  if (typeof value !== "object") return "";
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:signedurl|fullsignedurl|url)$/i.test(key) && typeof item === "string" && /^https:\/\//i.test(item.trim())) {
      return item.trim();
    }
  }
  for (const item of Object.values(value)) {
    const url = signedPhotoUrl(item, depth + 1);
    if (url) return url;
  }
  return "";
}

function cachedCustomerPhoto(cacheKey) {
  const now = Date.now();
  for (const [key, value] of signedCustomerPhotoCache) {
    if (!value || value.expiresAt <= now + 10000) signedCustomerPhotoCache.delete(key);
  }
  const cached = signedCustomerPhotoCache.get(cacheKey);
  return cached && cached.expiresAt > now + 10000 ? cached : null;
}

function rememberCustomerPhoto(cacheKeys, value) {
  for (const key of new Set(cacheKeys.filter(Boolean))) {
    signedCustomerPhotoCache.delete(key);
    signedCustomerPhotoCache.set(key, value);
  }
  while (signedCustomerPhotoCache.size > 500) {
    signedCustomerPhotoCache.delete(signedCustomerPhotoCache.keys().next().value);
  }
}

function safeResponseShape(value, depth = 0) {
  if (depth > 2 || value === null || value === undefined) return typeof value;
  if (Array.isArray(value)) return value.slice(0, 2).map((item) => safeResponseShape(item, depth + 1));
  if (typeof value !== "object") return typeof value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeResponseShape(item, depth + 1)]));
}

function responseErrorText(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => responseErrorText(item, depth + 1)).filter(Boolean).join(" ");
  if (typeof value !== "object") return "";
  const messages = [];
  for (const [key, item] of Object.entries(value)) {
    if (/^(?:error|code|message)$/i.test(key)) messages.push(responseErrorText(item, depth + 1));
    else if (/^(?:data|result|results|items)$/i.test(key)) messages.push(responseErrorText(item, depth + 1));
  }
  return messages.filter(Boolean).join(" ");
}

function cleanImage(value) {
  if (typeof value !== "string" || !value.trim()) fail("A camera photo is required.");
  const base64 = value.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "").trim();
  if (!/^[A-Za-z0-9+/=]+$/.test(base64)) fail("The camera photo format is invalid.");
  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) fail("The camera photo must be between 1 byte and 4 MB.");
  return { base64, buffer };
}

function teacherFaceDelegationCanonical(fields) {
  return JSON.stringify([
    TEACHER_FACE_DELEGATION_VERSION,
    String(fields.issuedAt),
    String(fields.nonce),
    String(fields.operation),
    String(fields.teacherId),
    String(fields.staffId),
    String(fields.actorStaffId),
    String(fields.personId),
    String(fields.teacherName),
    String(fields.imageDigest)
  ]);
}

function teacherFaceDelegationSigningKey() {
  return crypto.createHash("sha256")
    .update("cloudbase:teacher-face-delegation:\0", "utf8")
    .update(cloudbaseServiceRoleKey(), "utf8")
    .digest();
}

function verifyTeacherFaceDelegation(event = {}) {
  const issuedAt = Number(event.issuedAt);
  const now = Date.now();
  if (!Number.isSafeInteger(issuedAt)
      || issuedAt < now - TEACHER_FACE_DELEGATION_MAX_AGE_MS
      || issuedAt > now + 30 * 1000) {
    fail("老师人脸内部授权已过期。", "TEACHER_FACE_DELEGATION_EXPIRED");
  }
  const nonce = String(event.nonce || "").trim();
  const operation = String(event.operation || "").trim().toUpperCase();
  const personId = String(event.personId || "").trim();
  const teacherName = String(event.teacherName || "").trim();
  const signature = String(event.signature || "").trim().toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(nonce)
      || !["PROVISION", "UPSERT"].includes(operation)
      || !/^T-[A-F0-9]{48}$/.test(personId)
      || !teacherName || teacherName.length > 100
      || !/^[a-f0-9]{64}$/.test(signature)) {
    fail("老师人脸内部授权格式无效。", "TEACHER_FACE_DELEGATION_INVALID");
  }
  const ids = Object.fromEntries(["teacherId", "staffId", "actorStaffId"].map((name) => {
    const value = Number(event[name]);
    if (!Number.isSafeInteger(value) || value < 1) {
      fail("老师人脸内部授权编号无效。", "TEACHER_FACE_DELEGATION_INVALID");
    }
    return [name, value];
  }));
  const image = cleanVerificationJpeg(event.imageBase64, "老师人脸照片", MAX_IMAGE_BYTES);
  const imageDigest = crypto.createHash("sha256").update(image.buffer).digest("hex");
  const fields = { issuedAt, nonce, operation, ...ids, personId, teacherName, imageDigest };
  const expected = crypto.createHmac("sha256", teacherFaceDelegationSigningKey())
    .update(teacherFaceDelegationCanonical(fields), "utf8")
    .digest();
  const supplied = Buffer.from(signature, "hex");
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    fail("老师人脸内部授权签名无效。", "TEACHER_FACE_DELEGATION_FORBIDDEN");
  }
  return { ...fields, image };
}

function cleanVerificationJpeg(value, label, maximumBytes) {
  const text = String(value || "").trim();
  if (!/^data:image\/jpeg;base64,/i.test(text)) {
    fail(`${label}必须是 JPEG 照片。`, "PHOTO_FORMAT_INVALID");
  }
  const base64 = text.replace(/^data:image\/jpeg;base64,/i, "").trim();
  if (!/^[A-Za-z0-9+/=]+$/.test(base64)) fail(`${label}格式无效。`, "PHOTO_FORMAT_INVALID");
  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length || buffer.length > maximumBytes) {
    fail(`${label}必须小于 ${Math.ceil(maximumBytes / 1024 / 1024)} MB。`, "PHOTO_TOO_LARGE");
  }
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
    fail(`${label}内容不是有效 JPEG。`, "PHOTO_FORMAT_INVALID");
  }
  return { base64, buffer };
}

function verificationPhotoDimensions(event = {}) {
  const width = Number(event.imageWidth);
  const height = Number(event.imageHeight);
  if (!Number.isInteger(width) || !Number.isInteger(height)
      || width < 1 || width > 10000 || height < 1 || height > 10000) {
    fail("照片尺寸信息无效。", "PHOTO_DIMENSIONS_INVALID");
  }
  return { width, height };
}

function verificationPhotoReference(value) {
  const reference = String(value || "").trim();
  if (!reference.startsWith("pg://")) fail("核销照片引用格式无效。", "PHOTO_REFERENCE_INVALID");
  const path = reference.slice(5);
  const separator = path.indexOf("/");
  if (separator <= 0 || separator === path.length - 1) fail("核销照片引用格式无效。", "PHOTO_REFERENCE_INVALID");
  return { bucketId: path.slice(0, separator), objectName: path.slice(separator + 1) };
}

function verificationPhotoUploadRequestId(event = {}) {
  const requestId = String(event.requestId || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{15,63}$/.test(requestId)) {
    fail("照片上传请求编号无效，请重新选择照片。", "PHOTO_UPLOAD_REQUEST_INVALID");
  }
  return requestId;
}

function verificationPhotoUploadBytes(event = {}) {
  const bytes = Number(event.originalBytes);
  if (!Number.isInteger(bytes) || bytes < 4 || bytes > MAX_VERIFICATION_IMAGE_BYTES) {
    fail("补充照片必须小于 3 MB。", "PHOTO_TOO_LARGE");
  }
  return bytes;
}

function verificationPhotoFunctionUploadProof(context, request) {
  const payload = [
    "verification-photo-function-upload-v1",
    String(request.request_id || ""),
    String(context.verificationId || ""),
    String(context.caller.staffId || ""),
    String(request.photo_slot || ""),
    String(request.expected_original_bytes || ""),
    String(request.original_object_ref || "")
  ].join("\n");
  return crypto.createHmac("sha256", cloudbaseServiceRoleKey()).update(payload).digest("hex");
}

function requireVerificationPhotoFunctionUploadProof(event, context, request) {
  const supplied = String(event.functionUploadProof || "").trim().toLowerCase();
  const expected = verificationPhotoFunctionUploadProof(context, request);
  if (!/^[a-f0-9]{64}$/.test(supplied)
      || !crypto.timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex"))) {
    fail("该上传任务没有使用云函数兼容通道的授权，请重新选择照片。", "PHOTO_FUNCTION_UPLOAD_NOT_AUTHORIZED");
  }
}

function nestedResponseValue(value, keyPattern, validator, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = nestedResponseValue(item, keyPattern, validator, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (typeof value !== "object") return "";
  for (const [key, item] of Object.entries(value)) {
    if (keyPattern.test(key) && validator(item)) return String(item).trim();
  }
  for (const item of Object.values(value)) {
    const found = nestedResponseValue(item, keyPattern, validator, depth + 1);
    if (found) return found;
  }
  return "";
}

function signedVerificationPhotoUpload(response, storage, objectName) {
  let url = nestedResponseValue(
    response,
    /^(?:url|signedurl|fullsignedurl|uploadurl)$/i,
    (value) => typeof value === "string" && /^https:\/\//i.test(value.trim())
  );
  const token = nestedResponseValue(
    response,
    /^(?:token|uploadtoken|signaturetoken)$/i,
    (value) => typeof value === "string" && value.trim().length > 0
  );
  if (!url) {
    console.error("CloudBase signed upload response has no HTTPS URL", {
      bucketId: storage.bucketId,
      objectName,
      responseShape: safeResponseShape(response)
    });
    fail("核销照片上传地址生成失败，请检查云函数存储配置。", "PHOTO_UPLOAD_SIGN_FAILED");
  }
  // CloudBase's uploadToSignedUrl(path, token, file) sends the short-lived
  // upload token as the signed URL's `token` query parameter. manager-node
  // versions may return that token separately, so normalize the URL on the
  // server. The browser never receives or sends the service-role API key and
  // must not place this upload token in an Authorization header.
  if (token) {
    const target = new URL(url);
    if (!target.searchParams.get("token")) target.searchParams.set("token", token);
    url = target.toString();
  }
  return {
    url,
    bucketId: storage.bucketId,
    objectName,
    method: "PUT",
    contentType: "image/jpeg",
    headers: { "Content-Type": "image/jpeg" }
  };
}

async function signVerificationPhotoUploadReference(referenceValue) {
  const reference = verificationPhotoReference(referenceValue);
  const storage = verificationPhotoStorageForEvidence(reference);
  if (!storage) fail("核销照片不属于允许的私有存储桶。", "PHOTO_BUCKET_MISMATCH");
  const response = await manager().storage.signUploadObject({
    bucketId: reference.bucketId,
    objectName: reference.objectName,
    upsert: false,
    accessToken: storage.accessToken,
    envId: storage.envId
  });
  return signedVerificationPhotoUpload(response, storage, reference.objectName);
}

async function requireVerificationPhotoFunctionFallbackStorage(referenceValue) {
  const reference = verificationPhotoReference(referenceValue);
  const storage = verificationPhotoStorageForEvidence(reference);
  if (!storage) fail("核销照片不属于允许的私有存储桶。", "PHOTO_BUCKET_MISMATCH");
  try {
    await manager().storage.listObjects({
      bucketId: reference.bucketId,
      limit: 1,
      withDelimiter: false,
      accessToken: storage.accessToken,
      envId: storage.envId
    });
  } catch (error) {
    throw verificationPhotoStorageAccessError(error, storage);
  }
  return storage;
}

function verificationPhotoObjectInfoBody(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined || typeof value !== "object") return null;
  if (!Array.isArray(value) && (
    Object.prototype.hasOwnProperty.call(value, "size")
    || Object.prototype.hasOwnProperty.call(value, "content_type")
    || Object.prototype.hasOwnProperty.call(value, "bucket_id")
  )) return value;
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    const found = verificationPhotoObjectInfoBody(item, depth + 1);
    if (found) return found;
  }
  return null;
}

async function inspectVerificationPhotoObject(referenceValue, expectedBytes) {
  const reference = verificationPhotoReference(referenceValue);
  const storage = verificationPhotoStorageForEvidence(reference);
  if (!storage) fail("核销照片不属于允许的私有存储桶。", "PHOTO_BUCKET_MISMATCH");
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
    if (storageObjectMissing(error)) fail("照片尚未上传完成。", "PHOTO_UPLOAD_INCOMPLETE");
    throw error;
  }
  const info = verificationPhotoObjectInfoBody(response);
  if (!info) fail("无法读取已上传照片的信息。", "PHOTO_UPLOAD_INFO_INVALID");
  const bytes = Number(info.size ?? response?.headers?.["content-length"]);
  const contentType = String(info.content_type || response?.headers?.["content-type"] || "")
    .split(";", 1)[0].trim().toLowerCase();
  const returnedBucket = String(info.bucket_id || "").trim();
  const returnedName = String(info.name || "").trim().replace(/^\/+/, "");
  const allowedNames = photoObjectCandidates(reference.bucketId, reference.objectName);
  if (returnedBucket && returnedBucket !== reference.bucketId) {
    fail("已上传照片的存储桶不匹配。", "PHOTO_BUCKET_MISMATCH");
  }
  if (returnedName && !allowedNames.includes(returnedName)) {
    fail("已上传照片的对象路径不匹配。", "PHOTO_OBJECT_MISMATCH");
  }
  if (!Number.isInteger(bytes) || bytes !== expectedBytes || bytes < 4 || bytes > MAX_VERIFICATION_IMAGE_BYTES) {
    fail("已上传照片大小与上传请求不一致，请取消后重试。", "PHOTO_UPLOAD_SIZE_MISMATCH");
  }
  if (contentType !== "image/jpeg") {
    fail("已上传文件不是 JPEG 照片。", "PHOTO_FORMAT_INVALID");
  }
  const buffer = await downloadVerificationPhotoAuthenticated(referenceValue, MAX_VERIFICATION_IMAGE_BYTES);
  if (buffer.length !== bytes) {
    fail("已上传照片内容不完整，请取消后重试。", "PHOTO_UPLOAD_SIZE_MISMATCH");
  }
  return verificationPhotoBufferMetadata(buffer);
}

function verificationPhotoBufferMetadata(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4 || buffer.length > MAX_VERIFICATION_IMAGE_BYTES) {
    fail("补充照片必须是小于 3 MB 的 JPEG。", "PHOTO_TOO_LARGE");
  }
  const dimensions = jpegDimensions(buffer);
  return {
    bytes: buffer.length,
    width: dimensions.width,
    height: dimensions.height,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex")
  };
}

async function downloadVerificationPhotoAuthenticated(referenceValue, maximumBytes, options = {}) {
  const reference = verificationPhotoReference(referenceValue);
  const verificationStorage = verificationPhotoStorageForEvidence(reference);
  const customerStorage = photoStorageSettings();
  const retainedProfile = options.allowRetainedProfile === true
    && reference.bucketId === customerStorage.bucketId;
  const storage = retainedProfile ? customerStorage : verificationStorage;
  if (!storage) fail("核销照片不属于允许的私有存储桶。", "PHOTO_BUCKET_MISMATCH");
  let response;
  const objectNames = retainedProfile
    ? photoObjectCandidates(reference.bucketId, reference.objectName)
    : [reference.objectName];
  for (const objectName of objectNames) {
    try {
      response = await manager().storage.downloadAuthenticatedObject({
        bucketId: reference.bucketId,
        objectName,
        method: "GET",
        accessToken: storage.accessToken,
        envId: storage.envId
      });
      break;
    } catch (error) {
      if (!storageObjectMissing(error)) throw error;
    }
  }
  if (!response) fail("照片尚未上传完成。", "PHOTO_UPLOAD_INCOMPLETE");
  const status = Number(response?.status || 0);
  const declaredBytes = Number(response?.headers?.["content-length"] || 0);
  if (status !== 200 || !response?.body) {
    fail("无法读取已上传照片内容。", "PHOTO_UPLOAD_DOWNLOAD_FAILED");
  }
  if (declaredBytes > maximumBytes) fail("补充照片超过 3 MB。", "PHOTO_TOO_LARGE");
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maximumBytes) {
      response.body.destroy?.();
      fail("补充照片超过 3 MB。", "PHOTO_TOO_LARGE");
    }
    chunks.push(buffer);
  }
  const result = Buffer.concat(chunks);
  if (!result.length) fail("已上传照片内容为空。", "PHOTO_UPLOAD_INCOMPLETE");
  return result;
}

function jpegDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4
      || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) {
    fail("已上传文件不是有效 JPEG 照片。", "PHOTO_FORMAT_INVALID");
  }
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
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      if (width >= 1 && width <= 10000 && height >= 1 && height <= 10000) return { width, height };
      break;
    }
    offset += segmentLength;
  }
  fail("无法读取 JPEG 照片尺寸，请重新拍照。", "PHOTO_DIMENSIONS_INVALID");
}

async function uploadVerificationPhotoObject(objectName, buffer) {
  let missingBucketError = null;
  for (const storage of verificationPhotoStorageCandidates()) {
    try {
      await manager().storage.uploadObject({
        bucketId: storage.bucketId,
        objectName,
        body: buffer,
        contentType: "image/jpeg",
        contentLength: buffer.length,
        cacheControl: "private, max-age=31536000, immutable",
        upsert: false,
        accessToken: storage.accessToken,
        envId: storage.envId
      });
      return {
        bucketId: storage.bucketId,
        objectName,
        reference: `pg://${storage.bucketId}/${objectName}`
      };
    } catch (error) {
      // manager-node 5.6.4 throws this only after the storage gateway has
      // already returned an HTTP success response. We persist the exact
      // bucket/objectName supplied by this function, so missing response
      // metadata must not turn a completed upload into a false failure.
      if (storageUploadResponseMismatch(error)) {
        console.warn("CloudBase upload succeeded without Id/Key response metadata", {
          bucketId: storage.bucketId,
          objectName
        });
        return {
          bucketId: storage.bucketId,
          objectName,
          reference: `pg://${storage.bucketId}/${objectName}`
        };
      }
      if (!storageBucketMissing(error)) throw error;
      missingBucketError = error;
      console.warn("Verification photo bucket missing; trying the existing private customer photo bucket", {
        bucketId: storage.bucketId
      });
    }
  }
  throw missingBucketError || new Error("核销照片私有存储桶不可用。");
}

async function uploadVerificationPhotoReference(referenceValue, buffer) {
  const reference = verificationPhotoReference(referenceValue);
  const storage = verificationPhotoStorageForEvidence(reference);
  if (!storage) fail("核销照片不属于允许的私有存储桶。", "PHOTO_BUCKET_MISMATCH");
  try {
    await manager().storage.uploadObject({
      bucketId: reference.bucketId,
      objectName: reference.objectName,
      body: buffer,
      contentType: "image/jpeg",
      contentLength: buffer.length,
      cacheControl: "private, max-age=31536000, immutable",
      upsert: false,
      accessToken: storage.accessToken,
      envId: storage.envId
    });
  } catch (error) {
    if (storageUploadResponseMismatch(error)) {
      console.warn("CloudBase fallback upload succeeded without Id/Key response metadata", {
        bucketId: reference.bucketId,
        objectName: reference.objectName
      });
    } else {
      // The cloud-function response may be lost after Storage committed the
      // object. A retry keeps the same random request path; accept it only if
      // the authenticated bytes are exactly the same JPEG.
      let existing = null;
      try {
        existing = await downloadVerificationPhotoAuthenticated(referenceValue, MAX_VERIFICATION_IMAGE_BYTES);
      } catch (_) { /* preserve the original upload error */ }
      if (existing) {
        const expectedSha = crypto.createHash("sha256").update(buffer).digest("hex");
        const existingSha = crypto.createHash("sha256").update(existing).digest("hex");
        if (existing.length === buffer.length && existingSha === expectedSha) return reference;
        fail("同一上传请求的照片内容与已有文件不一致，请取消后重新上传。", "PHOTO_UPLOAD_CONTENT_CONFLICT");
      }
      if (signedUploadFunctionFallbackAllowed(error)) throw verificationPhotoStorageEnvironmentError(error, storage);
      throw error;
    }
  }
  return reference;
}

function verificationPhotoStorageForEvidence(reference) {
  if (!/^(?:face-evidence|records)\//.test(reference.objectName)) return null;
  return verificationPhotoStorageCandidates().find((storage) => storage.bucketId === reference.bucketId) || null;
}

async function deleteVerificationPhotoObject(referenceValue) {
  if (!referenceValue) return true;
  try {
    const reference = verificationPhotoReference(referenceValue);
    const storage = verificationPhotoStorageForEvidence(reference);
    if (!storage) return false;
    await manager().storage.deleteObject({
      bucketId: reference.bucketId,
      objectName: reference.objectName,
      accessToken: storage.accessToken,
      envId: storage.envId
    });
    return true;
  } catch (error) {
    if (storageObjectMissing(error)) return true;
    console.warn("Verification photo cleanup failed", error?.message || error);
    return false;
  }
}

function cachedVerificationPhoto(cacheKey) {
  const now = Date.now();
  for (const [key, value] of signedVerificationPhotoCache) {
    if (!value || value.expiresAt <= now + 10000) signedVerificationPhotoCache.delete(key);
  }
  const cached = signedVerificationPhotoCache.get(cacheKey);
  return cached && cached.expiresAt > now + 10000 ? cached : null;
}

function thumbnailTransformUrl(url) {
  const separator = String(url).includes("?") ? "&" : "?";
  return `${url}${separator}imageMogr2/thumbnail/480x480/format/webp/rquality/82`;
}

async function signVerificationPhoto(referenceValue, expiresIn, options = {}) {
  const reference = verificationPhotoReference(referenceValue);
  const customerStorage = photoStorageSettings();
  const verificationStorage = verificationPhotoStorageForEvidence(reference);
  const isVerificationObject = Boolean(verificationStorage);
  const isRetainedProfile = options.allowRetainedProfile === true && reference.bucketId === customerStorage.bucketId;
  if (!isVerificationObject && !isRetainedProfile) {
    fail("核销照片不属于允许的私有存储桶。", "PHOTO_BUCKET_MISMATCH");
  }
  const storage = isRetainedProfile ? customerStorage : verificationStorage;
  const transformKey = options.thumbnailTransform === true ? "thumbnail" : "original";
  const cacheKey = `${reference.bucketId}/${reference.objectName}/${transformKey}`;
  const cached = cachedVerificationPhoto(cacheKey);
  if (cached) return {
    url: cached.url,
    expiresIn: Math.max(1, Math.floor((cached.expiresAt - Date.now()) / 1000))
  };
  let url = "";
  const candidates = isRetainedProfile
    ? photoObjectCandidates(reference.bucketId, reference.objectName)
    : [reference.objectName];
  const missingFailures = [];
  const signingFailures = [];
  for (const objectName of candidates) {
    let signed = null;
    let batchSigned = null;
    const attemptErrors = [];
    try {
      signed = await manager().storage.signObject({
        bucketId: reference.bucketId,
        objectName,
        expiresIn,
        accessToken: storage.accessToken,
        envId: storage.envId
      });
      url = signedPhotoUrl(signed);
    } catch (error) {
      attemptErrors.push(error);
    }
    // Always try the documented batch endpoint after a single-object error
    // or response-shape mismatch. Some PG Storage gateways intermittently
    // reject one endpoint while the other can still sign the same object.
    if (!url && typeof manager().storage.signObjects === "function") {
      try {
        batchSigned = await manager().storage.signObjects({
          bucketId: reference.bucketId,
          paths: [objectName],
          expiresIn,
          accessToken: storage.accessToken,
          envId: storage.envId
        });
        url = signedPhotoUrl(batchSigned);
      } catch (error) {
        attemptErrors.push(error);
      }
    }
    if (url) break;

    const responseError = responseErrorText([signed, batchSigned]);
    if (responseError) attemptErrors.push({ message: responseError });
    const failures = attemptErrors.map((error) => ({
      objectName,
      code: String(error?.code || ""),
      requestId: error?.requestId || error?.RequestId || "",
      message: String(error?.message || "").slice(0, 240)
    }));
    if (failures.length && failures.every((failure) => storageObjectMissing(failure))) {
      missingFailures.push(...failures);
    } else {
      signingFailures.push(...(failures.length ? failures : [{
        objectName,
        responseShape: safeResponseShape([signed, batchSigned]),
        responseError: responseError.slice(0, 240)
      }]));
    }
  }
  if (!url && missingFailures.length > 0 && signingFailures.length === 0) {
    console.warn("Verification photo object is missing", {
      bucketId: reference.bucketId,
      candidates,
      failures: missingFailures
    });
    fail("该核销照片文件已不存在。", "PHOTO_NOT_FOUND");
  }
  if (!url) {
    console.error("Verification photo signing returned no HTTPS URL", {
      bucketId: reference.bucketId,
      candidates,
      failures: signingFailures
    });
    fail("核销照片临时访问地址生成失败，请查看云函数日志中的签名阶段错误。", "PHOTO_SIGN_FAILED");
  }
  if (options.thumbnailTransform === true) url = thumbnailTransformUrl(url);
  const cacheEntry = { url, expiresAt: Date.now() + expiresIn * 1000 };
  signedVerificationPhotoCache.set(cacheKey, cacheEntry);
  while (signedVerificationPhotoCache.size > 1000) {
    signedVerificationPhotoCache.delete(signedVerificationPhotoCache.keys().next().value);
  }
  return { url, expiresIn: Math.max(1, Math.floor((cacheEntry.expiresAt - Date.now()) / 1000)) };
}

function rounded(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

async function inspectFaceImage(api, base64) {
  let result;
  try {
    result = await api.DetectFace({
      Image: base64,
      MaxFaceNum: 2,
      MinFaceSize: 34,
      NeedFaceAttributes: 1,
      NeedQualityDetection: 1,
      FaceModelVersion: FACE_MODEL_VERSION,
      NeedRotateDetection: 0
    });
  } catch (error) {
    if (String(error?.code || "").includes("NoFaceInPhoto")) fail("没有检测到清晰人脸，请让客户正对镜头后重新拍照。", "FACE_NOT_FOUND");
    throw error;
  }

  const faces = Array.isArray(result?.FaceInfos) ? result.FaceInfos : [];
  if (!faces.length) fail("没有检测到清晰人脸，请让客户正对镜头后重新拍照。", "FACE_NOT_FOUND");
  if (faces.length !== 1) fail("照片中只能有一位客户，请移开其他人员后重新拍照。", "MULTIPLE_FACES");

  const face = faces[0] || {};
  const width = Number(face.Width || 0);
  const height = Number(face.Height || 0);
  if (width < 100 || height < 100) fail("人脸距离镜头太远，请靠近镜头后重新拍照。", "FACE_TOO_SMALL");

  const quality = face.FaceQualityInfo || {};
  const attributes = face.FaceAttributesInfo || {};
  const settings = faceSettings();
  const qualityScore = Number(quality.Score || 0);
  if (qualityScore < settings.qualityThreshold) {
    fail(`照片质量不足（${rounded(qualityScore)} 分），请保证光线均匀、镜头清晰后重新拍照。`, "FACE_QUALITY_LOW");
  }
  if (attributes.Mask === true) fail("建档照片不能佩戴口罩，请摘下口罩后重新拍照。", "FACE_MASKED");
  if (attributes.EyeOpen === false) fail("检测到闭眼，请睁眼后重新拍照。", "EYES_CLOSED");

  const yaw = Number(attributes.Yaw || 0);
  const pitch = Number(attributes.Pitch || 0);
  const roll = Number(attributes.Roll || 0);
  if (Math.abs(yaw) > settings.maxYaw || Math.abs(pitch) > settings.maxPitch || Math.abs(roll) > settings.maxRoll) {
    fail("脸部角度过大，请正对镜头、不要低头或歪头后重新拍照。", "FACE_POSE_INVALID");
  }

  return {
    requestId: result?.RequestId || "",
    imageWidth: Number(result?.ImageWidth || 0),
    imageHeight: Number(result?.ImageHeight || 0),
    faceWidth: width,
    faceHeight: height,
    qualityScore: rounded(qualityScore),
    qualityThreshold: settings.qualityThreshold,
    sharpness: rounded(quality.Sharpness),
    brightness: rounded(quality.Brightness),
    yaw: rounded(yaw),
    pitch: rounded(pitch),
    roll: rounded(roll)
  };
}

async function inspectLiveness(api, base64) {
  const settings = faceSettings();
  if (!settings.livenessEnabled) return { enabled: false, checked: false, score: null, threshold: settings.livenessThreshold };
  const result = await api.DetectLiveFaceAccurate({ Image: base64, FaceModelVersion: FACE_MODEL_VERSION });
  const score = Number(result?.Score || 0);
  if (score < settings.livenessThreshold) {
    fail(`活体检测未通过（${rounded(score)} 分），请确认是真人现场拍摄后重试。`, "LIVENESS_FAILED");
  }
  return { enabled: true, checked: true, score: rounded(score), threshold: settings.livenessThreshold, requestId: result?.RequestId || "" };
}

function validDate(value) {
  const date = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail("Birth date must use YYYY-MM-DD.");
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date) fail("Birth date is invalid.");
  return date;
}

function customerCode(storeId, clientRequestId = "") {
  if (clientRequestId) {
    let storeToken;
    try { storeToken = BigInt(String(storeId)).toString(36).toUpperCase(); }
    catch (_) { storeToken = String(storeId).replace(/[^A-Za-z0-9]/g, "").slice(-12).toUpperCase() || "0"; }
    const requestToken = crypto.createHash("sha256").update(clientRequestId).digest("hex").slice(0, 16).toUpperCase();
    return `C${storeToken}-${requestToken}`;
  }
  const stamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `C${storeId}-${stamp}-${random}`;
}

function optionalClientRequestId(value) {
  const requestId = String(value || "").trim();
  if (!requestId) return "";
  if (!/^[A-Za-z0-9_-]{8,96}$/.test(requestId)) fail("clientRequestId is invalid.", "BAD_REQUEST");
  return requestId;
}

async function activeStoreCaller() {
  const { uid } = app().auth().getUserInfo();
  if (!uid) fail("Please sign in before creating a customer.", "UNAUTHENTICATED");
  const layout = await getStoreBindingLayout();
  const storeJoin = layout === "stores"
    ? "JOIN public.stores s ON s.store_account_id = a.id"
    : `JOIN public.staff_store_assignments sa
         ON sa.staff_account_id = a.id AND sa.assignment_status = 'ACTIVE'
       JOIN public.stores s ON s.id = sa.store_id`;
  const rows = await executeSql(
    `SELECT a.id AS staff_id, a.staff_name, a.role_code, a.account_status,
            s.id AS store_id, s.store_code, s.store_name, s.store_status
       FROM public.staff_accounts a
       ${storeJoin}
      WHERE a.auth_uid = ${sqlText(uid)}
      LIMIT 1`
  );
  const caller = rows[0];
  if (!caller || caller.role_code !== "store") fail("Only an active store account can create a customer.", "FORBIDDEN");
  if (caller.account_status !== "ACTIVE" || caller.store_status !== "ACTIVE") fail("The store account or store is archived.", "ARCHIVED");
  return {
    uid: String(uid),
    staffId: Number(caller.staff_id),
    staffName: String(caller.staff_name || ""),
    storeId: Number(caller.store_id),
    storeCode: String(caller.store_code || ""),
    storeName: String(caller.store_name || "")
  };
}

async function activeTeacherCaller() {
  const { uid } = app().auth().getUserInfo();
  if (!uid) fail("请先登录老师账号后再办理业务。", "UNAUTHENTICATED");
  const rows = await executeSql(
    `SELECT a.id AS staff_id, a.staff_name, a.role_code, a.account_status,
            t.id AS teacher_id, t.teacher_code, t.teacher_name, t.teacher_status,
            t.face_person_id, t.face_enrollment_status, t.profile_photo_file_id
       FROM public.staff_accounts a
       JOIN public.teachers t ON t.staff_account_id = a.id
      WHERE a.auth_uid = ${sqlText(uid)}
      LIMIT 1`
  );
  const caller = rows[0];
  if (!caller || caller.role_code !== "teacher") fail("只有老师账号可以使用老师办理入口。", "FORBIDDEN");
  if (caller.account_status !== "ACTIVE" || caller.teacher_status !== "ACTIVE") {
    fail("老师账号或老师资料已经封存。", "ARCHIVED");
  }
  return {
    uid: String(uid),
    role: "teacher",
    staffId: Number(caller.staff_id),
    staffName: String(caller.staff_name || caller.teacher_name || ""),
    teacherId: String(caller.teacher_id),
    teacherCode: String(caller.teacher_code || ""),
    teacherName: String(caller.teacher_name || ""),
    faceEnrollmentStatus: String(caller.face_enrollment_status || ""),
    facePhotoReady: Boolean(caller.face_person_id && caller.profile_photo_file_id)
  };
}

async function activeBusinessCaller(event = {}) {
  const { uid } = app().auth().getUserInfo();
  if (!uid) fail("请先登录后再办理业务。", "UNAUTHENTICATED");
  const accounts = await executeSql(
    `SELECT a.id AS staff_id, a.role_code, a.account_status,
            t.id AS teacher_id, t.teacher_code, t.teacher_name, t.teacher_status,
            t.face_person_id, t.face_enrollment_status, t.profile_photo_file_id
       FROM public.staff_accounts a
       LEFT JOIN public.teachers t ON t.staff_account_id = a.id
      WHERE a.auth_uid = ${sqlText(uid)}
      LIMIT 1`
  );
  const account = accounts[0];
  if (!account) fail("当前登录账号尚未绑定业务身份。", "STAFF_PROFILE_MISSING");
  if (account.account_status !== "ACTIVE") fail("当前登录账号已经封存。", "ARCHIVED");
  if (account.role_code === "store") {
    const store = await activeStoreCaller();
    const requestedStore = String(event.storeId || "").trim();
    if (requestedStore && requestedStore !== String(store.storeId)) {
      fail("门店账号不能为其他门店办理业务。", "FORBIDDEN");
    }
    return { ...store, role: "store", teacherId: "" };
  }
  if (!["teacher", "hq"].includes(account.role_code)) {
    fail("只有门店、老师或总部账号可以办理业务。", "FORBIDDEN");
  }

  if (account.role_code === "teacher") {
    if (!account.teacher_id) fail("当前老师账号尚未绑定老师资料。", "TEACHER_PROFILE_MISSING");
    if (account.teacher_status !== "ACTIVE") fail("老师资料已经封存。", "ARCHIVED");
  }
  const storeId = positiveDatabaseId(event.storeId, "门店");
  const stores = await executeSql(
    `SELECT id, store_code, store_name, store_status
       FROM public.stores
      WHERE id = ${sqlText(storeId)}::bigint
        AND store_status = 'ACTIVE'
      LIMIT 1`
  );
  const store = stores[0];
  if (!store) fail("所选门店不存在或已经封存，请重新选择。", "STORE_NOT_ACTIVE");
  return {
    uid: String(uid),
    role: String(account.role_code),
    staffId: Number(account.staff_id),
    teacherId: account.role_code === "teacher" ? String(account.teacher_id) : "",
    teacherCode: account.role_code === "teacher" ? String(account.teacher_code || "") : "",
    teacherName: account.role_code === "teacher" ? String(account.teacher_name || "") : "",
    faceEnrollmentStatus: account.role_code === "teacher" ? String(account.face_enrollment_status || "") : "",
    facePhotoReady: account.role_code === "teacher"
      ? Boolean(account.face_person_id && account.profile_photo_file_id)
      : false,
    storeId: Number(store.id),
    storeCode: String(store.store_code || ""),
    storeName: String(store.store_name || "")
  };
}

// Teacher creation is a headquarters-only workflow and intentionally has no
// store scope.  Keep it separate from customer capture validation so the
// browser never has to invent a store ID simply to validate a teacher photo.
async function activeHqTeacherFaceEnrollmentCaller() {
  const { uid } = app().auth().getUserInfo();
  if (!uid) fail("请先登录总部账号后再创建老师。", "UNAUTHENTICATED");
  const rows = await executeSql(
    `SELECT id AS staff_id, role_code, account_status
       FROM public.staff_accounts
      WHERE auth_uid = ${sqlText(uid)}
      LIMIT 1`
  );
  const caller = rows[0];
  if (!caller || caller.role_code !== "hq") fail("只有总部账号可以验证老师建档人脸。", "FORBIDDEN");
  if (caller.account_status !== "ACTIVE") fail("总部账号已经封存。", "ARCHIVED");
  return { uid: String(uid), staffId: Number(caller.staff_id), role: "hq" };
}

async function activeCustomerCreationCaller(event = {}) {
  const caller = await activeBusinessCaller(event);
  if (!["store", "teacher", "hq"].includes(caller.role)) {
    fail("只有门店、老师或总部账号可以建立客户档案。", "FORBIDDEN");
  }
  return caller;
}

async function getHqBusinessContext() {
  const caller = await activeCustomerStatusCaller();
  if (caller.role !== "hq") fail("只有总部账号可以使用总部业务办理入口。", "FORBIDDEN");
  const stores = await executeSql(
    `SELECT id, store_code, store_name
       FROM public.stores
      WHERE store_status = 'ACTIVE'
      ORDER BY store_name, store_code, id
      LIMIT 1000`
  );
  return {
    ok: true,
    headquarters: { staffId: String(caller.staffId) },
    stores: stores.map((store) => ({
      storeId: String(store.id),
      storeCode: String(store.store_code || ""),
      storeName: String(store.store_name || "")
    }))
  };
}

async function getTeacherBusinessContext() {
  const teacher = await activeTeacherCaller();
  const stores = await executeSql(
    `SELECT id, store_code, store_name
       FROM public.stores
      WHERE store_status = 'ACTIVE'
      ORDER BY store_name, store_code, id
      LIMIT 1000`
  );
  return {
    ok: true,
    teacher: {
      teacherId: teacher.teacherId,
      teacherCode: teacher.teacherCode,
      teacherName: teacher.teacherName,
      faceEnrollmentStatus: teacher.faceEnrollmentStatus,
      facePhotoReady: teacher.facePhotoReady
    },
    stores: stores.map((store) => ({
      storeId: String(store.id),
      storeCode: String(store.store_code || ""),
      storeName: String(store.store_name || "")
    }))
  };
}

async function activeCustomerStatusCaller() {
  const { uid } = app().auth().getUserInfo();
  if (!uid) fail("请先登录后再管理客户状态。", "UNAUTHENTICATED");
  const rows = await executeSql(
    `SELECT id AS staff_id, role_code, account_status
       FROM public.staff_accounts
      WHERE auth_uid = ${sqlText(uid)}
      LIMIT 1`
  );
  const account = rows[0];
  if (!account) fail("当前登录账号尚未绑定业务身份。", "STAFF_PROFILE_MISSING");
  if (account.account_status !== "ACTIVE") fail("当前登录账号已封存。", "ARCHIVED");
  if (account.role_code === "hq") {
    return { uid: String(uid), staffId: Number(account.staff_id), role: "hq", storeId: null };
  }
  if (account.role_code === "store") {
    const store = await activeStoreCaller();
    return { ...store, role: "store" };
  }
  fail("只有总部或客户所属门店可以修改客户状态。", "FORBIDDEN");
}

// Customer and business-record query pages are shared by headquarters and
// stores.  The authenticated CloudBase UID is always the source of authority:
// stores are pinned to their active binding, while HQ may optionally narrow an
// otherwise global query to one real store. Retired roles are deliberately not
// included in this contract.
async function activeScopedQueryCaller(event = {}) {
  const caller = await activeCustomerStatusCaller();
  const requestedStore = String(event.storeId || "").trim();
  if (caller.role === "store") {
    if (requestedStore && requestedStore !== String(caller.storeId)) {
      fail("门店账号不能查询其他门店或全部门店。", "FORBIDDEN");
    }
    return { ...caller, storeId: String(caller.storeId), scopeMode: "STORE" };
  }

  if (!requestedStore || requestedStore.toUpperCase() === "ALL") {
    return {
      ...caller,
      storeId: null,
      storeCode: "",
      storeName: "全部门店",
      storeStatus: "",
      scopeMode: "ALL"
    };
  }

  const storeId = businessQueryDatabaseId(requestedStore, "门店");
  const stores = await executeSql(
    `SELECT id, store_code, store_name, store_status
       FROM public.stores
      WHERE id = ${storeId}::bigint
      LIMIT 1`
  );
  const store = stores[0];
  if (!store) fail("所选门店不存在，请刷新门店列表后重试。", "STORE_NOT_FOUND");
  return {
    ...caller,
    storeId: String(store.id),
    storeCode: String(store.store_code || ""),
    storeName: String(store.store_name || ""),
    storeStatus: String(store.store_status || ""),
    scopeMode: "STORE"
  };
}

function scopedStoreClause(caller, column) {
  return caller.storeId ? `${column} = ${caller.storeId}::bigint` : "TRUE";
}

async function activeCustomerProfileCaller() {
  const { uid } = app().auth().getUserInfo();
  if (!uid) fail("请先登录后再查看客户主页。", "UNAUTHENTICATED");
  const rows = await executeSql(
    `SELECT a.id AS staff_id, a.role_code, a.account_status, a.staff_name,
            t.id AS teacher_id, t.teacher_name, t.teacher_status
       FROM public.staff_accounts a
  LEFT JOIN public.teachers t ON t.staff_account_id = a.id
      WHERE a.auth_uid = ${sqlText(uid)}
      LIMIT 1`
  );
  const account = rows[0];
  if (!account) fail("当前登录账号尚未绑定业务身份。", "STAFF_PROFILE_MISSING");
  if (account.account_status !== "ACTIVE") fail("当前登录账号已封存。", "ARCHIVED");
  if (account.role_code === "store") {
    const store = await activeStoreCaller();
    return { ...store, role: "store", staffName: String(account.staff_name || store.staffName || "") };
  }
  if (account.role_code === "hq") {
    return { uid: String(uid), staffId: Number(account.staff_id), staffName: String(account.staff_name || ""), role: "hq", storeId: null, teacherId: "" };
  }
  if (account.role_code === "teacher") {
    if (!account.teacher_id || account.teacher_status !== "ACTIVE") fail("老师资料已经封存。", "ARCHIVED");
    return {
      uid: String(uid), staffId: Number(account.staff_id),
      staffName: String(account.staff_name || account.teacher_name || ""),
      role: "teacher", storeId: null, teacherId: String(account.teacher_id)
    };
  }
  fail("当前登录身份无权查看客户主页。", "FORBIDDEN");
}

async function activeVerificationPhotoCaller() {
  const { uid } = app().auth().getUserInfo();
  if (!uid) fail("请先登录后再查看核销照片。", "UNAUTHENTICATED");
  const rows = await executeSql(
    `SELECT a.id AS staff_id, a.role_code, a.account_status,
            t.id AS teacher_id, t.teacher_status
       FROM public.staff_accounts a
  LEFT JOIN public.teachers t ON t.staff_account_id = a.id
      WHERE a.auth_uid = ${sqlText(uid)}
      LIMIT 1`
  );
  const account = rows[0];
  if (!account) fail("当前登录账号尚未绑定业务身份。", "STAFF_PROFILE_MISSING");
  if (account.account_status !== "ACTIVE") fail("当前登录账号已封存。", "ARCHIVED");
  if (!['hq', 'store', 'teacher'].includes(account.role_code)) {
    fail("当前登录身份无权查看核销照片。", "FORBIDDEN");
  }
  if (account.role_code === "store") {
    const store = await activeStoreCaller();
    return { ...store, role: "store", staffId: Number(account.staff_id), teacherId: "" };
  }
  if (account.role_code === "teacher") {
    if (!account.teacher_id || account.teacher_status !== "ACTIVE") fail("老师资料已经封存。", "ARCHIVED");
    return {
      uid: String(uid), role: "teacher", staffId: Number(account.staff_id),
      storeId: null, teacherId: String(account.teacher_id)
    };
  }
  return { uid: String(uid), role: account.role_code, staffId: Number(account.staff_id), storeId: null, teacherId: "" };
}

async function verificationPhotoContext(event, options = {}) {
  const caller = options.caller || await activeVerificationPhotoCaller();
  const verificationId = businessQueryDatabaseId(event.recordId, "核销工单");
  let scope = "TRUE";
  if (caller.role === "store") scope = `v.store_id = ${Number(caller.storeId)}::bigint`;
  else if (caller.role === "teacher") scope = `v.teacher_id = ${sqlText(caller.teacherId)}::bigint`;
  const rows = await executeSql(
    `SELECT v.id, v.verification_code, v.verification_type, v.store_id,
            v.teacher_id, v.submitted_by_account_id, v.submitted_at,
            v.customer_id, v.face_subject_type, v.face_subject_teacher_id,
            customer.customer_code, customer.customer_name,
            face_teacher.teacher_code AS face_subject_teacher_code,
            face_teacher.teacher_name AS face_subject_teacher_name,
            v.submitted_at + INTERVAL '24 hours' AS editable_until,
            (CLOCK_TIMESTAMP() < v.submitted_at + INTERVAL '24 hours') AS within_edit_window
       FROM public.verification_records v
       JOIN public.customers customer ON customer.id = v.customer_id
  LEFT JOIN public.teachers face_teacher ON face_teacher.id = v.face_subject_teacher_id
      WHERE v.id = ${verificationId}::bigint
        AND ${scope}
      LIMIT 1`
  );
  const record = rows[0];
  if (!record) fail("未找到当前账号有权查看的核销工单。", "VERIFICATION_NOT_FOUND");
  const canEdit = ["hq", "store", "teacher"].includes(caller.role)
    && String(record.submitted_by_account_id) === String(caller.staffId)
    && databaseBoolean(record.within_edit_window);
  return { caller, record, verificationId, canEdit };
}

function customerProfileScope(caller, alias = "c") {
  if (caller.role === "store") return ` AND ${alias}.created_store_id = ${caller.storeId}`;
  if (caller.role === "teacher") return ` AND (
    EXISTS (
      SELECT 1 FROM public.verification_records teacher_verification
       WHERE teacher_verification.customer_id = ${alias}.id
         AND teacher_verification.teacher_id = ${sqlText(caller.teacherId)}::bigint
    )
    OR EXISTS (
      SELECT 1 FROM public.recharge_records teacher_recharge
       WHERE teacher_recharge.customer_id = ${alias}.id
         AND teacher_recharge.teacher_id = ${sqlText(caller.teacherId)}::bigint
    )
  )`;
  return "";
}

function customerStatusCode(event) {
  const customerCodeValue = String(event.customerCode || "").trim();
  if (!customerCodeValue || customerCodeValue.length > 96) fail("必须提供有效客户编号。", "CUSTOMER_REQUIRED");
  return customerCodeValue;
}

function customerStatusScope(caller, tableAlias = "") {
  const column = tableAlias ? `${tableAlias}.created_store_id` : "created_store_id";
  return caller.storeId ? ` AND ${column} = ${caller.storeId}` : "";
}

async function findCustomerStatus(caller, customerCodeValue) {
  const rows = await executeSql(
    `SELECT c.id, c.customer_code, c.customer_name, c.birth_date, c.notes,
            c.created_store_id, c.customer_status, c.created_at, c.updated_at,
            s.store_name, s.store_code
       FROM public.customers c
       JOIN public.stores s ON s.id = c.created_store_id
      WHERE c.customer_code = ${sqlText(customerCodeValue)}
        ${customerStatusScope(caller, "c")}
      LIMIT 1`
  );
  return rows[0] || null;
}

async function findCustomerForNotes(caller, customerCodeValue) {
  const rows = await executeSql(
    `SELECT c.id, c.customer_code, c.customer_name, c.birth_date, c.notes,
            c.created_store_id, c.customer_status, c.created_at, c.updated_at,
            s.store_name, s.store_code
       FROM public.customers c
       JOIN public.stores s ON s.id = c.created_store_id
      WHERE c.customer_code = ${sqlText(customerCodeValue)}
        ${customerProfileScope(caller, "c")}
      LIMIT 1`
  );
  return rows[0] || null;
}

function customerStatusResult(customer) {
  return {
    ok: true,
    customer: {
      id: String(customer.id),
      customerCode: customer.customer_code,
      customerName: customer.customer_name,
      birthDate: customer.birth_date,
      notes: customer.notes || "",
      storeId: String(customer.created_store_id),
      storeName: customer.store_name,
      storeCode: customer.store_code,
      customerStatus: customer.customer_status,
      createdAt: customer.created_at,
      updatedAt: customer.updated_at
    }
  };
}

async function getCustomerStatus(event) {
  const caller = await activeCustomerStatusCaller();
  const customerCodeValue = customerStatusCode(event);
  const customer = await findCustomerStatus(caller, customerCodeValue);
  if (!customer) fail("未找到当前账号有权查看的客户档案。", "CUSTOMER_NOT_FOUND");
  return customerStatusResult(customer);
}

async function updateCustomerStatus(event) {
  const caller = await activeCustomerStatusCaller();
  const customerCodeValue = customerStatusCode(event);
  const targetStatus = String(event.targetStatus || "").trim().toUpperCase();
  const expectedStatus = String(event.expectedStatus || "").trim().toUpperCase();
  if (!["ACTIVE", "ARCHIVED"].includes(targetStatus)) fail("客户状态只能切换为活跃或封存。", "CUSTOMER_STATUS_INVALID");
  if (expectedStatus && !["ACTIVE", "ARCHIVED"].includes(expectedStatus)) fail("原客户状态无效，请刷新后重试。", "CUSTOMER_STATUS_INVALID");

  const before = await findCustomerStatus(caller, customerCodeValue);
  if (!before) fail("未找到当前账号有权管理的客户档案。", "CUSTOMER_NOT_FOUND");
  if (expectedStatus && before.customer_status !== expectedStatus && before.customer_status !== targetStatus) {
    fail("客户状态已被其他人员修改，请刷新后重试。", "CUSTOMER_STATUS_CONFLICT");
  }
  if (before.customer_status !== targetStatus) {
    await executeSql(
      `UPDATE public.customers
          SET customer_status = ${sqlText(targetStatus)}, updated_at = NOW()
        WHERE customer_code = ${sqlText(customerCodeValue)}
          ${customerStatusScope(caller)}
          AND customer_status = ${sqlText(before.customer_status)}`
    );
  }
  const customer = await findCustomerStatus(caller, customerCodeValue);
  if (!customer) fail("客户状态更新后无法读取档案。", "DATABASE_ERROR");
  if (customer.customer_status !== targetStatus) fail("客户状态已被其他人员修改，请刷新后重试。", "CUSTOMER_STATUS_CONFLICT");
  return customerStatusResult(customer);
}

async function updateCustomerNotes(event) {
  const caller = await activeCustomerProfileCaller();
  const customerCodeValue = customerStatusCode(event);
  const notes = String(event.notes ?? "").replace(/\r\n?/g, "\n").trim();
  const hasExpectedNotes = Object.prototype.hasOwnProperty.call(event, "expectedNotes");
  const expectedNotes = String(event.expectedNotes ?? "").replace(/\r\n?/g, "\n").trim();
  if (notes.length > 5000) fail("客户备注不能超过 5000 个字符。", "CUSTOMER_NOTES_TOO_LONG");
  if (expectedNotes.length > 5000) fail("原客户备注无效，请刷新后重试。", "CUSTOMER_NOTES_INVALID");

  const before = await findCustomerForNotes(caller, customerCodeValue);
  if (!before) fail("未找到当前账号有权管理的客户档案。", "CUSTOMER_NOT_FOUND");
  const currentNotes = String(before.notes || "").replace(/\r\n?/g, "\n").trim();
  if (hasExpectedNotes && currentNotes !== expectedNotes) {
    fail("客户备注已被其他人员修改，请刷新后重试。", "CUSTOMER_NOTES_CONFLICT");
  }
  if (currentNotes !== notes) {
    await executeSql(
      `UPDATE public.customers
          SET notes = ${sqlText(notes)}, updated_at = NOW()
        WHERE customer_code = ${sqlText(customerCodeValue)}
          ${customerProfileScope(caller)}
          AND COALESCE(notes, '') = ${sqlText(String(before.notes || ""))}`
    );
  }
  const customer = await findCustomerForNotes(caller, customerCodeValue);
  if (!customer) fail("客户备注更新后无法读取档案。", "DATABASE_ERROR");
  if (String(customer.notes || "").replace(/\r\n?/g, "\n").trim() !== notes) {
    fail("客户备注已被其他人员修改，请刷新后重试。", "CUSTOMER_NOTES_CONFLICT");
  }
  return customerStatusResult(customer);
}

async function executeCustomerMessageSql(sql) {
  try { return await executeSql(sql); }
  catch (error) {
    if (/customer_messages.*does not exist|relation .*customer_messages/i.test(String(error?.message || ""))) {
      fail("客户留言数据库尚未升级，请先执行 042 客户留言迁移。", "DATABASE_SCHEMA_MISSING");
    }
    throw error;
  }
}

function customerMessageOptions(event = {}) {
  const requestedLimit = Number(event.messageLimit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 50)
    : 20;
  const cursorCreatedAt = scopedQueryCursorTimestamp(event.cursorCreatedAt, "客户留言游标时间");
  const cursorId = String(event.cursorMessageId || "").trim();
  if (Boolean(cursorCreatedAt) !== Boolean(cursorId)) fail("客户留言游标不完整。", "BAD_REQUEST");
  return {
    limit,
    cursorCreatedAt,
    cursorId: cursorId ? businessQueryDatabaseId(cursorId, "客户留言游标编号") : ""
  };
}

async function customerMessageCustomer(caller, customerCodeValue) {
  const rows = await executeSql(
    `SELECT c.id, c.customer_code
       FROM public.customers c
      WHERE c.customer_code = ${sqlText(customerCodeValue)}
        ${customerProfileScope(caller, "c")}
      LIMIT 1`
  );
  const customer = rows[0];
  if (!customer) fail("未找到当前账号有权留言的客户档案。", "CUSTOMER_NOT_FOUND");
  return customer;
}

function mapCustomerMessage(row) {
  return {
    id: String(row.id),
    authorName: String(row.author_name_snapshot || ""),
    authorRole: String(row.author_role || ""),
    content: String(row.message_content || ""),
    createdAt: row.created_at
  };
}

async function listCustomerMessages(event) {
  const caller = await activeCustomerProfileCaller();
  const customerCodeValue = customerStatusCode(event);
  const customer = await customerMessageCustomer(caller, customerCodeValue);
  const options = customerMessageOptions(event);
  const cursor = options.cursorCreatedAt
    ? `AND (cm.created_at, cm.id) < (${sqlText(options.cursorCreatedAt)}::timestamptz, ${options.cursorId}::bigint)`
    : "";
  const rows = await executeCustomerMessageSql(
    `SELECT cm.id, cm.author_role, cm.author_name_snapshot,
            cm.message_content, cm.created_at,
            TO_CHAR(cm.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at,
            (SELECT COUNT(*) FROM public.customer_messages total
              WHERE total.customer_id = cm.customer_id) AS total_count
       FROM public.customer_messages cm
      WHERE cm.customer_id = ${sqlText(String(customer.id))}::bigint
        ${cursor}
      ORDER BY cm.created_at DESC, cm.id DESC
      LIMIT ${options.limit + 1}`
  );
  const hasMore = rows.length > options.limit;
  const visibleRows = rows.slice(0, options.limit);
  const last = visibleRows[visibleRows.length - 1];
  return {
    ok: true,
    messages: visibleRows.map(mapCustomerMessage),
    totalCount: Number(rows[0]?.total_count || 0),
    page: {
      hasMore,
      nextCursor: hasMore && last
        ? { createdAt: last.cursor_created_at, id: String(last.id) }
        : null
    }
  };
}

async function addCustomerMessage(event) {
  const caller = await activeCustomerProfileCaller();
  const customerCodeValue = customerStatusCode(event);
  const customer = await customerMessageCustomer(caller, customerCodeValue);
  const content = String(event.content ?? "").replace(/\r\n?/g, "\n").trim();
  const contentLength = Array.from(content).length;
  if (!contentLength) fail("请输入留言内容。", "CUSTOMER_MESSAGE_REQUIRED");
  if (contentLength > 100) fail("单条客户留言不能超过 100 字。", "CUSTOMER_MESSAGE_TOO_LONG");
  const rows = await executeCustomerMessageSql(
    `WITH inserted_message AS (
       INSERT INTO public.customer_messages
         (customer_id, author_account_id, author_role, author_name_snapshot, message_content)
       SELECT ${sqlText(String(customer.id))}::bigint, a.id, a.role_code,
              BTRIM(a.staff_name), ${sqlText(content)}
         FROM public.staff_accounts a
        WHERE a.id = ${positiveDatabaseId(caller.staffId, "当前留言账号")}::bigint
          AND a.account_status = 'ACTIVE'
          AND a.role_code IN ('hq', 'store', 'teacher')
       RETURNING id, author_role, author_name_snapshot, message_content, created_at
     )
     SELECT id, author_role, author_name_snapshot, message_content, created_at
       FROM inserted_message
      LIMIT 1`
  );
  const message = rows[0];
  if (!message) fail("当前登录账号不能提交客户留言。", "FORBIDDEN");
  const totals = await executeCustomerMessageSql(
    `SELECT COUNT(*) AS total_count
       FROM public.customer_messages
      WHERE customer_id = ${sqlText(String(customer.id))}::bigint`
  );
  return { ok: true, message: mapCustomerMessage(message), totalCount: Number(totals[0]?.total_count || 1) };
}

function customerHistoryOptions(event = {}) {
  const requestedLimit = Number(event.historyLimit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100)
    : 50;
  const type = String(event.historyType || "").trim().toUpperCase();
  if (type && !["RECHARGE", "VERIFICATION", "EXPERIENCE"].includes(type)) fail("客户历史类型无效。", "BAD_REQUEST");
  const cursorSubmittedAt = scopedQueryCursorTimestamp(event.cursorSubmittedAt, "客户历史游标时间");
  const cursorId = String(event.cursorId || "").trim();
  if ((cursorSubmittedAt || cursorId) && !type) fail("客户历史游标必须指定记录类型。", "BAD_REQUEST");
  if (Boolean(cursorSubmittedAt) !== Boolean(cursorId)) fail("客户历史游标不完整。", "BAD_REQUEST");
  return {
    limit,
    type,
    cursorSubmittedAt,
    cursorId: cursorId ? businessQueryDatabaseId(cursorId, "客户历史游标编号") : ""
  };
}

function customerHistoryPage(rows, limit) {
  const hasMore = rows.length > limit;
  const visibleRows = rows.slice(0, limit);
  const last = visibleRows[visibleRows.length - 1];
  return {
    rows: visibleRows,
    page: {
      hasMore,
      nextCursor: hasMore && last
        ? { submittedAt: last.cursor_submitted_at, id: String(last.id) }
        : null
    }
  };
}

function mapCustomerRecharges(rows) {
  return rows.map((row) => ({
    id: String(row.id), rechargeCode: row.recharge_code, rechargeType: row.recharge_type,
    unitCount: Number(row.unit_count || 0), recordStatus: row.record_status,
    balanceBeforeCount: row.balance_before_count === null || row.balance_before_count === undefined ? null : Number(row.balance_before_count),
    balanceAfterCount: row.balance_after_count === null || row.balance_after_count === undefined ? null : Number(row.balance_after_count),
    voidRequestStatus: row.void_request_status, submittedAt: row.submitted_at, reviewedAt: row.reviewed_at,
    productId: String(row.product_id), productCode: row.product_code, productName: row.product_name
  }));
}

function mapCustomerVerifications(rows) {
  return rows.map((row) => ({
    id: String(row.id), verificationCode: row.verification_code, verificationType: row.verification_type,
    unitCount: Number(row.unit_count || 1), recordStatus: row.record_status,
    voidRequestStatus: row.void_request_status, submittedAt: row.submitted_at, reviewedAt: row.reviewed_at,
    productId: String(row.product_id), productCode: row.product_code, productName: row.product_name,
    teacherId: row.teacher_id ? String(row.teacher_id) : "", teacherCode: row.teacher_code || "", teacherName: row.teacher_name || ""
  }));
}

async function getCustomerProfile(event) {
  const caller = await activeCustomerProfileCaller();
  const customerCodeValue = customerStatusCode(event);
  const profileScope = customerProfileScope(caller, "c");
  const customerRows = await executeSql(
    `SELECT c.id, c.customer_code, c.customer_name, c.birth_date, c.notes,
            c.customer_status, c.customer_process_status,
            c.total_recharge_count, c.total_verification_count, c.total_experience_count,
            c.latest_recharge_at, c.latest_verification_at, c.created_at, c.updated_at,
            c.created_store_id, s.store_code, s.store_name
      FROM public.customers c
      JOIN public.stores s ON s.id = c.created_store_id
      WHERE c.customer_code = ${sqlText(customerCodeValue)}
        ${profileScope}
      LIMIT 1`
  );
  const customer = customerRows[0];
  if (!customer) fail("未找到当前账号有权查看的客户档案。", "CUSTOMER_NOT_FOUND");
  const customerId = String(customer.id);
  const historyOptions = customerHistoryOptions(event);
  const cursorSql = historyOptions.cursorSubmittedAt
    ? (alias) => `AND (${alias}.submitted_at, ${alias}.id) < (${sqlText(historyOptions.cursorSubmittedAt)}::timestamptz, ${historyOptions.cursorId}::bigint)`
    : () => "";
  const rechargeSql = `SELECT r.id, r.recharge_code, r.recharge_type, r.unit_count,
               r.balance_before_count, r.balance_after_count,
               r.record_status, r.void_request_status, r.submitted_at, r.reviewed_at,
               TO_CHAR(r.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_submitted_at,
               p.id AS product_id, p.product_code, p.product_name
          FROM public.recharge_records r
          JOIN public.products p ON p.id = r.product_id
         WHERE r.customer_id = ${sqlText(customerId)}::bigint
           ${historyOptions.type === "RECHARGE" ? cursorSql("r") : ""}
         ORDER BY r.submitted_at DESC, r.id DESC
         LIMIT ${historyOptions.limit + 1}`;
  const verificationSql = (experienceOnly = false) => `SELECT v.id, v.verification_code, v.verification_type, v.unit_count,
               v.record_status, v.void_request_status, v.submitted_at, v.reviewed_at,
               TO_CHAR(v.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_submitted_at,
               p.id AS product_id, p.product_code, p.product_name,
               t.id AS teacher_id, t.teacher_code, t.teacher_name
          FROM public.verification_records v
          JOIN public.products p ON p.id = v.product_id
         LEFT JOIN public.teachers t ON t.id = v.teacher_id
         WHERE v.customer_id = ${sqlText(customerId)}::bigint
           AND v.verification_type ${experienceOnly ? "=" : "<>"} 'EXPERIENCE'
           ${historyOptions.type === (experienceOnly ? "EXPERIENCE" : "VERIFICATION") ? cursorSql("v") : ""}
         ORDER BY v.submitted_at DESC, v.id DESC
         LIMIT ${historyOptions.limit + 1}`;

  if (historyOptions.type) {
    const historyRows = await executeSql(historyOptions.type === "RECHARGE"
      ? rechargeSql
      : verificationSql(historyOptions.type === "EXPERIENCE"));
    const historyPage = customerHistoryPage(historyRows, historyOptions.limit);
    if (historyOptions.type === "RECHARGE") {
      return { ok: true, recharges: mapCustomerRecharges(historyPage.rows), history: { recharges: historyPage.page } };
    }
    const field = historyOptions.type === "EXPERIENCE" ? "experiences" : "verifications";
    return { ok: true, [field]: mapCustomerVerifications(historyPage.rows), history: { [field]: historyPage.page } };
  }

  const [balances, rechargeRows, verificationRows, experienceRows] = await Promise.all([
    executeSql(
      `SELECT p.id AS product_id, p.product_code, p.product_name, p.product_status,
              b.total_recharge_count, b.total_verification_count, b.remaining_count, b.updated_at
         FROM public.customer_product_balances b
         JOIN public.products p ON p.id = b.product_id
        WHERE b.customer_id = ${sqlText(customerId)}::bigint
        ORDER BY p.product_name, p.product_code`
    ),
    executeSql(rechargeSql),
    executeSql(verificationSql(false)),
    executeSql(verificationSql(true))
  ]);
  const rechargePage = customerHistoryPage(rechargeRows, historyOptions.limit);
  const verificationPage = customerHistoryPage(verificationRows, historyOptions.limit);
  const experiencePage = customerHistoryPage(experienceRows, historyOptions.limit);
  return {
    ok: true,
    customer: {
      customerCode: customer.customer_code, customerName: customer.customer_name,
      birthDate: customer.birth_date, notes: customer.notes || "",
      customerStatus: customer.customer_status,
      customerProcessStatus: customer.customer_process_status,
      totalRechargeCount: Number(customer.total_recharge_count || 0),
      totalVerificationCount: Number(customer.total_verification_count || 0),
      totalExperienceCount: Number(customer.total_experience_count || 0),
      latestRechargeAt: customer.latest_recharge_at,
      latestVerificationAt: customer.latest_verification_at,
      createdAt: customer.created_at, updatedAt: customer.updated_at,
      storeId: String(customer.created_store_id), storeCode: customer.store_code, storeName: customer.store_name
    },
    balances: balances.map((row) => ({
      productId: String(row.product_id), productCode: row.product_code, productName: row.product_name,
      productStatus: row.product_status,
      totalRechargeCount: Number(row.total_recharge_count || 0),
      totalVerificationCount: Number(row.total_verification_count || 0),
      remainingCount: Number(row.remaining_count || 0), updatedAt: row.updated_at
    })),
    recharges: mapCustomerRecharges(rechargePage.rows),
    verifications: mapCustomerVerifications(verificationPage.rows),
    experiences: mapCustomerVerifications(experiencePage.rows),
    history: { recharges: rechargePage.page, verifications: verificationPage.page, experiences: experiencePage.page }
  };
}

async function uploadCustomerPhoto(storeId, personId, buffer) {
  const { bucketId, accessToken, envId } = photoStorageSettings();
  const objectName = `${storeId}/${personId}/${Date.now()}.jpg`;
  try {
    await manager().storage.uploadObject({
      bucketId,
      objectName,
      body: buffer,
      contentType: "image/jpeg",
      contentLength: buffer.length,
      cacheControl: "private, no-store",
      upsert: false,
      accessToken,
      envId
    });
  } catch (error) {
    if (!storageUploadResponseMismatch(error)) throw error;
    console.warn("CloudBase customer photo upload succeeded without Id/Key response metadata", {
      bucketId,
      objectName
    });
  }
  // Persist the objectName supplied to uploadObject. Some manager-node/storage
  // responses include the bucket name in Key; persisting that value produced
  // references such as pg://bucket/bucket/path and later lookups could miss the
  // real object. Retrieval still supports those legacy references below.
  const savedObjectName = objectName;
  return {
    bucketId,
    objectName: savedObjectName,
    reference: `pg://${bucketId}/${savedObjectName}`
  };
}

async function deleteUploadedFile(storedPhoto) {
  if (!storedPhoto?.bucketId || !storedPhoto?.objectName) return;
  try {
    const { accessToken, envId } = photoStorageSettings();
    for (const objectName of photoObjectCandidates(storedPhoto.bucketId, storedPhoto.objectName)) {
      try {
        await manager().storage.deleteObject({
          bucketId: storedPhoto.bucketId,
          objectName,
          accessToken,
          envId
        });
        return;
      } catch (error) {
        if (!storageObjectMissing(error)) throw error;
      }
    }
  } catch (error) {
    console.warn("Photo cleanup failed", error?.message || error);
  }
}

async function uploadTeacherProfilePhoto(teacherId, personId, buffer) {
  const { bucketId, accessToken, envId } = photoStorageSettings();
  const digest = crypto.createHash("sha256").update(buffer).digest("hex");
  const objectName = `teachers/${teacherId}/profile-history/${Date.now()}-${personId}-${digest.slice(0, 16)}.jpg`;
  try {
    await manager().storage.uploadObject({
      bucketId,
      objectName,
      body: buffer,
      contentType: "image/jpeg",
      contentLength: buffer.length,
      cacheControl: "private, max-age=31536000, immutable",
      upsert: false,
      accessToken,
      envId
    });
  } catch (error) {
    if (!storageUploadResponseMismatch(error)) throw error;
    console.warn("CloudBase teacher photo upload succeeded without Id/Key response metadata", {
      bucketId, objectName, teacherId
    });
  }
  return { bucketId, objectName, reference: `pg://${bucketId}/${objectName}` };
}

function duplicateTeacherFacePersonError(error) {
  const detail = `${error?.code || ""} ${error?.Code || ""} ${error?.message || ""}`.toLowerCase();
  return detail.includes("persondup") || detail.includes("person already")
    || detail.includes("duplicate") || detail.includes("已存在");
}

async function confirmTeacherFacePerson(api, personId) {
  const person = await api.GetPersonBaseInfo({ PersonId: personId });
  if (!person || (person.PersonId && String(person.PersonId) !== String(personId))) {
    fail("同一建档编号的人脸资料无法安全确认。", "TEACHER_FACE_PERSON_CONFLICT");
  }
}

async function deleteTeacherFacePerson(api, groupId, personId) {
  if (!api || !groupId || !personId) return false;
  try {
    await api.DeletePerson({ GroupId: groupId, PersonId: personId });
    return true;
  } catch (error) {
    console.warn("Teacher face person cleanup failed", {
      personId, code: error?.code || error?.Code || undefined,
      requestId: error?.RequestId || error?.requestId || undefined
    });
    return false;
  }
}

function teacherFaceResult(row, accountStatus, createdNow, replaced, warning = "") {
  return {
    ok: true,
    createdNow,
    replaced,
    teacher: {
      teacherId: String(row.id),
      teacherCode: String(row.teacher_code || ""),
      teacherName: String(row.teacher_name || ""),
      teacherStatus: String(row.teacher_status || ""),
      accountStatus: String(accountStatus || ""),
      faceEnrollmentStatus: String(row.face_enrollment_status || ""),
      faceEnrolledAt: row.face_enrolled_at || null,
      facePhotoReady: Boolean(row.profile_photo_file_id),
      profilePhotoFileId: String(row.profile_photo_file_id || "")
    },
    warning: warning || undefined
  };
}

// This endpoint is intentionally unreachable with an ordinary browser call.
// staffAccount signs a two-minute, payload-bound command with the service-role
// key already present in both functions. Tencent IAI credentials therefore
// remain only in faceRecognition. The new person and immutable photo are
// created first; one optimistic PostgreSQL UPDATE switches the current face;
// only then is the old Tencent person deleted on a best-effort basis.
async function upsertDelegatedTeacherFace(event = {}) {
  const command = verifyTeacherFaceDelegation(event);
  const rows = await executeSql(
    `SELECT teacher.id, teacher.staff_account_id, teacher.teacher_code,
            teacher.teacher_name, teacher.teacher_status, teacher.face_person_id,
            teacher.face_enrollment_status, teacher.face_enrolled_at,
            teacher.profile_photo_file_id, account.role_code, account.account_status,
            actor.role_code AS actor_role, actor.account_status AS actor_status
       FROM public.teachers AS teacher
       JOIN public.staff_accounts AS account ON account.id = teacher.staff_account_id
       JOIN public.staff_accounts AS actor ON actor.id = ${command.actorStaffId}
      WHERE teacher.id = ${command.teacherId}
        AND teacher.staff_account_id = ${command.staffId}
      LIMIT 1`
  );
  const current = rows[0];
  if (!current || current.role_code !== "teacher") fail("未找到老师资料。", "NOT_FOUND");
  if (current.actor_role !== "hq" || current.actor_status !== "ACTIVE") {
    fail("只有活跃总部账号可以写入老师人脸。", "TEACHER_FACE_DELEGATION_FORBIDDEN");
  }
  if (String(current.teacher_name || "") !== command.teacherName) {
    fail("老师姓名已变更，请刷新后重新拍照。", "TEACHER_FACE_PROFILE_CHANGED");
  }

  const previousPersonId = String(current.face_person_id || "").trim();
  const previousPhotoRef = String(current.profile_photo_file_id || "").trim();
  if (current.face_enrollment_status === "ENROLLED"
      && previousPersonId === command.personId && previousPhotoRef) {
    return teacherFaceResult(current, current.account_status, false, false);
  }

  const api = faceClient();
  const groupId = required("FACE_GROUP_ID");
  const quality = await inspectFaceImage(api, command.image.base64);
  const liveness = await inspectLiveness(api, command.image.base64);
  let createdPerson = false;
  let recoveredPerson = false;
  let storedPhoto = null;
  try {
    try {
      const face = await api.CreatePerson({
        GroupId: groupId,
        PersonId: command.personId,
        PersonName: command.teacherName,
        Image: command.image.base64,
        UniquePersonControl: 0,
        QualityControl: 3,
        FaceModelVersion: FACE_MODEL_VERSION,
        NeedRotateDetection: 0
      });
      createdPerson = true;
      if (!face?.FaceId) fail("人脸服务未返回有效 FaceId。", "TEACHER_FACE_ENROLLMENT_INCOMPLETE");
    } catch (error) {
      if (!duplicateTeacherFacePersonError(error)) throw error;
      await confirmTeacherFacePerson(api, command.personId);
      recoveredPerson = true;
    }
    storedPhoto = await uploadTeacherProfilePhoto(
      command.teacherId, command.personId, command.image.buffer
    );

    let saved;
    try {
      const savedRows = await executeSql(
        `UPDATE public.teachers AS teacher
            SET face_person_id = ${sqlText(command.personId)},
                face_consent_at = NOW(),
                face_enrollment_status = 'ENROLLED',
                face_enrolled_at = NOW(),
                profile_photo_file_id = ${sqlText(storedPhoto.reference)},
                face_enrolled_by_account_id = ${command.actorStaffId},
                updated_at = NOW()
          WHERE teacher.id = ${command.teacherId}
            AND teacher.staff_account_id = ${command.staffId}
            AND teacher.face_person_id IS NOT DISTINCT FROM ${previousPersonId ? sqlText(previousPersonId) : "NULL"}
            AND teacher.profile_photo_file_id IS NOT DISTINCT FROM ${previousPhotoRef ? sqlText(previousPhotoRef) : "NULL"}
          RETURNING teacher.id, teacher.teacher_code, teacher.teacher_name,
                    teacher.teacher_status, teacher.face_enrollment_status,
                    teacher.face_enrolled_at, teacher.profile_photo_file_id`
      );
      saved = savedRows[0] || null;
    } catch (error) {
      const committedRows = await executeSql(
        `SELECT teacher.id, teacher.teacher_code, teacher.teacher_name,
                teacher.teacher_status, teacher.face_enrollment_status,
                teacher.face_enrolled_at, teacher.profile_photo_file_id
           FROM public.teachers AS teacher
          WHERE teacher.id = ${command.teacherId}
            AND teacher.staff_account_id = ${command.staffId}
            AND teacher.face_person_id = ${sqlText(command.personId)}
            AND teacher.profile_photo_file_id = ${sqlText(storedPhoto.reference)}
            AND teacher.face_enrollment_status = 'ENROLLED'
          LIMIT 1`
      ).catch(() => []);
      saved = committedRows[0] || null;
      if (!saved) throw error;
    }
    if (!saved || saved.face_enrollment_status !== "ENROLLED" || !saved.profile_photo_file_id) {
      fail("老师人脸资料已发生并发修改，原人脸保持不变。", "TEACHER_FACE_CONCURRENT_UPDATE");
    }

    let warning = "";
    if (previousPersonId && previousPersonId !== command.personId) {
      const removed = await deleteTeacherFacePerson(api, groupId, previousPersonId);
      if (!removed) warning = "新老师人脸已生效，但旧人脸库记录暂未删除；请由总部稍后清理。";
    }
    return {
      ...teacherFaceResult(saved, current.account_status, createdPerson,
        Boolean(previousPersonId && previousPersonId !== command.personId), warning),
      quality,
      liveness
    };
  } catch (error) {
    const committedRows = storedPhoto ? await executeSql(
      `SELECT id FROM public.teachers
        WHERE id = ${command.teacherId}
          AND face_person_id = ${sqlText(command.personId)}
          AND profile_photo_file_id = ${sqlText(storedPhoto.reference)}
          AND face_enrollment_status = 'ENROLLED'
        LIMIT 1`
    ).catch(() => []) : [];
    if (!committedRows[0]) {
      await deleteUploadedFile(storedPhoto);
      if (createdPerson && !recoveredPerson) {
        await deleteTeacherFacePerson(api, groupId, command.personId);
      }
    }
    throw error;
  }
}

async function getCustomerPhotoUrl(event, options = {}) {
  const requireActiveStoreCustomer = options.requireActiveStoreCustomer === true;
  const caller = options.caller || (requireActiveStoreCustomer
    ? await activeStoreCaller()
    : await activeCustomerStatusCaller());
  const customerCode = String(event.customerCode || "").trim();
  if (!customerCode || customerCode.length > 96) fail("必须提供已选择客户的有效编号。", "CUSTOMER_REQUIRED");

  const rows = await executeSql(
    `SELECT c.customer_code, c.customer_name, c.birth_date, c.notes,
            c.customer_status, c.customer_process_status,
            c.total_recharge_count, c.total_verification_count, c.total_experience_count,
            c.created_store_id, c.created_at, c.profile_photo_file_id
       FROM public.customers c
      WHERE c.customer_code = ${sqlText(customerCode)}
        ${customerStatusScope(caller, "c")}
        ${requireActiveStoreCustomer ? "AND c.customer_status = 'ACTIVE'" : ""}
      LIMIT 1`
  );
  const customer = rows[0];
  if (!customer) fail("未找到当前账号有权查看的客户档案。", "CUSTOMER_NOT_FOUND");
  if (!customer.profile_photo_file_id) fail("该客户没有可用的建档照片。", "CUSTOMER_PHOTO_MISSING");

  const reference = parsePhotoReference(customer.profile_photo_file_id);
  const storage = photoStorageSettings();
  if (reference.bucketId !== storage.bucketId) fail("客户照片不属于指定私有存储桶。", "PHOTO_BUCKET_MISMATCH");
  const expiresIn = Math.floor(numberSetting("CUSTOMER_PHOTO_URL_TTL_SECONDS", 120, 30, 600));
  let photoUrl = "";
  let resolvedObjectName = "";
  let responseExpiresIn = expiresIn;
  const missingFailures = [];
  const signingFailures = [];
  const objectCandidates = photoObjectCandidates(reference.bucketId, reference.objectName);
  const cacheKey = `${reference.bucketId}/${reference.objectName}`;
  const cached = cachedCustomerPhoto(cacheKey);
  if (cached) {
    photoUrl = cached.photoUrl;
    resolvedObjectName = cached.resolvedObjectName;
    responseExpiresIn = Math.max(10, Math.floor((cached.expiresAt - Date.now()) / 1000));
  }
  for (const objectName of photoUrl ? [] : objectCandidates) {
    try {
      const signed = await manager().storage.signObject({
        bucketId: reference.bucketId,
        objectName,
        expiresIn,
        accessToken: storage.accessToken,
        envId: storage.envId
      });
      photoUrl = signedPhotoUrl(signed);

      // manager-node 5.6.x normally returns { signedURL }, while some
      // CloudBase gateways wrap the response. If the single-object response
      // resolves without a URL, try the documented batch endpoint once and
      // parse both response shapes without exposing the signed token.
      let batchSigned = null;
      if (!photoUrl && typeof manager().storage.signObjects === "function") {
        batchSigned = await manager().storage.signObjects({
          bucketId: reference.bucketId,
          paths: [objectName],
          expiresIn,
          accessToken: storage.accessToken,
          envId: storage.envId
        });
        photoUrl = signedPhotoUrl(batchSigned);
      }

      if (photoUrl) {
        resolvedObjectName = objectName;
        const cachedValue = { photoUrl, resolvedObjectName, expiresAt: Date.now() + expiresIn * 1000 };
        rememberCustomerPhoto([
          cacheKey,
          `${reference.bucketId}/${resolvedObjectName}`
        ], cachedValue);
        break;
      }

      const responseError = responseErrorText([signed, batchSigned]);
      if (storageObjectMissing({ message: responseError })) {
        missingFailures.push({ objectName });
      } else {
        signingFailures.push({
          objectName,
          responseShape: safeResponseShape([signed, batchSigned]),
          responseError: responseError.slice(0, 240)
        });
      }
    } catch (error) {
      const failure = {
        objectName,
        code: String(error?.code || ""),
        requestId: error?.requestId || error?.RequestId || "",
        message: String(error?.message || "").slice(0, 240)
      };
      if (storageObjectMissing(error)) missingFailures.push(failure);
      else signingFailures.push(failure);
    }
  }
  if (!photoUrl && missingFailures.length === objectCandidates.length) {
    console.warn("Customer photo object is missing", {
      customerCode: customer.customer_code,
      bucketId: reference.bucketId,
      candidates: objectCandidates,
      failures: missingFailures
    });
    fail("该客户的照片文件已不存在，需要在客户档案中重新采集照片。", "CUSTOMER_PHOTO_OBJECT_MISSING");
  }
  if (!photoUrl) {
    console.error("Customer photo signing returned no HTTPS URL", {
      customerCode: customer.customer_code,
      bucketId: reference.bucketId,
      candidates: objectCandidates,
      failures: signingFailures
    });
    fail("私有客户照片临时访问地址生成失败，请查看云函数日志中的签名阶段错误。", "PHOTO_SIGN_FAILED");
  }

  const resolvedReference = `pg://${reference.bucketId}/${resolvedObjectName}`;
  if (resolvedReference !== String(customer.profile_photo_file_id).trim()) {
    try {
      await executeSql(
        `UPDATE public.customers
            SET profile_photo_file_id = ${sqlText(resolvedReference)}, updated_at = NOW()
          WHERE customer_code = ${sqlText(customer.customer_code)}
            ${customerStatusScope(caller)}
            ${requireActiveStoreCustomer ? "AND customer_status = 'ACTIVE'" : ""}
            AND profile_photo_file_id = ${sqlText(String(customer.profile_photo_file_id).trim())}`
      );
    } catch (error) {
      console.warn("Customer photo reference normalization failed", {
        customerCode: customer.customer_code,
        message: error?.message || String(error)
      });
    }
  }
  return {
    ok: true,
    customerCode: customer.customer_code,
    notes: customer.notes || "",
    customer: {
      customerCode: customer.customer_code,
      customerName: customer.customer_name,
      birthDate: customer.birth_date,
      notes: customer.notes || "",
      customerStatus: customer.customer_status,
      customerProcessStatus: customer.customer_process_status,
      totalRechargeCount: Number(customer.total_recharge_count || 0),
      totalVerificationCount: Number(customer.total_verification_count || 0),
      totalExperienceCount: Number(customer.total_experience_count || 0),
      storeId: String(customer.created_store_id),
      hasProfilePhoto: true,
      createdAt: customer.created_at
    },
    photoUrl,
    expiresIn: responseExpiresIn
  };
}

async function getActiveStoreCustomerDetail(event) {
  const caller = await activeBusinessCaller(event);
  return getCustomerPhotoUrl(event, { requireActiveStoreCustomer: true, caller });
}

async function listActiveStoreCustomers(event = {}) {
  const caller = await activeBusinessCaller(event);
  const requestedLimit = Number(event.limit);
  const limit = Number.isFinite(requestedLimit) ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100) : 100;
  const customerName = String(event.customerName || "").trim();
  const birthDate = optionalBusinessQueryDate(event.birthDate, "客户生日");
  if (customerName.length > 100) fail("客户姓名不能超过 100 个字符。", "BAD_REQUEST");
  if (Boolean(customerName) !== Boolean(birthDate)) fail("按资料查询时必须同时填写客户姓名和生日。", "BAD_REQUEST");
  const rows = await executeSql(
    `SELECT customer_code, customer_name, birth_date
       FROM public.customers
      WHERE created_store_id = ${caller.storeId}
        AND customer_status = 'ACTIVE'
        ${customerName ? `AND customer_name = ${sqlText(customerName)} AND birth_date = ${sqlText(birthDate)}::date` : ""}
      ORDER BY customer_name, birth_date, customer_code
      LIMIT ${limit + 1}`
  );
  const hasMore = rows.length > limit;
  return {
    ok: true,
    storeId: String(caller.storeId),
    storeCode: caller.storeCode,
    storeName: caller.storeName,
    customers: rows.slice(0, limit).map((customer) => ({
      customerCode: customer.customer_code,
      customerName: customer.customer_name,
      birthDate: customer.birth_date
    })),
    hasMore
  };
}

function scopedQueryCursorTimestamp(value, label) {
  const text = String(value || "").trim();
  if (!text) return "";
  const match = text.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/);
  if (text.length > 100 || !match) fail(`${label}格式无效。`, "BAD_REQUEST");
  optionalBusinessQueryDate(match[1], label);
  if (Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) {
    fail(`${label}格式无效。`, "BAD_REQUEST");
  }
  return text;
}

// The browser supplies filters only. Headquarters may choose all stores or
// one verified store; a store account is always pinned to its own active
// binding by activeScopedQueryCaller.
async function queryStoreCustomers(event = {}) {
  const caller = await activeScopedQueryCaller(event);
  const mode = String(event.mode || "browse").trim().toLowerCase();
  if (!["browse", "manual"].includes(mode)) fail("客户查询方式无效。", "BAD_REQUEST");
  const process = String(event.processStatus || "all").trim().toUpperCase();
  const status = String(event.customerStatus || "all").trim().toUpperCase();
  const allowedProcesses = new Set(["ALL", "INFORMATION_ONLY", "RECHARGED_NO_CONSUMPTION", "RECHARGED_WITH_CONSUMPTION"]);
  if (!allowedProcesses.has(process)) fail("业务阶段筛选无效。", "BAD_REQUEST");
  if (!["ALL", "ACTIVE", "ARCHIVED"].includes(status)) fail("客户状态筛选无效。", "BAD_REQUEST");
  const name = String(event.name || "").trim();
  const birthDate = optionalBusinessQueryDate(event.birthDate, "生日");
  const startDate = optionalBusinessQueryDate(event.startDate, "开始日期");
  const endDate = optionalBusinessQueryDate(event.endDate, "结束日期");
  if (name.length > 100) fail("客户姓名查询不能超过 100 个字符。", "BAD_REQUEST");
  if (startDate && endDate && startDate > endDate) fail("开始日期不能晚于结束日期。", "BAD_REQUEST");

  const requestedLimit = Number(event.limit);
  const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : 100, 1), 100);
  const cursorCreatedAt = scopedQueryCursorTimestamp(event.cursorCreatedAt, "分页时间游标");
  const cursorIdText = String(event.cursorId || "").trim();
  if (Boolean(cursorCreatedAt) !== Boolean(cursorIdText)) fail("分页游标不完整。", "BAD_REQUEST");
  const cursorId = cursorIdText ? businessQueryDatabaseId(cursorIdText, "分页客户") : "";

  const baseClauses = [scopedStoreClause(caller, "c.created_store_id")];
  if (mode === "manual") {
    if (name) baseClauses.push(`c.customer_name ILIKE '%' || ${sqlText(name)} || '%'`);
    if (birthDate) baseClauses.push(`c.birth_date = ${sqlText(birthDate)}::date`);
  } else {
    if (status !== "ALL") baseClauses.push(`c.customer_status = ${sqlText(status)}`);
    if (startDate) baseClauses.push(`c.created_at >= (${sqlText(startDate)}::date::timestamp AT TIME ZONE 'Asia/Shanghai')`);
    if (endDate) baseClauses.push(`c.created_at < ((${sqlText(endDate)}::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai')`);
  }

  const listClauses = [...baseClauses];
  if (mode === "browse" && process !== "ALL") {
    listClauses.push(`c.customer_process_status = ${sqlText(process)}`);
  }
  if (cursorCreatedAt) {
    listClauses.push(`(c.created_at, c.id) < (${sqlText(cursorCreatedAt)}::timestamptz, ${cursorId}::bigint)`);
  }

  const selectedProcessClause = mode === "browse" && process !== "ALL"
    ? `c.customer_process_status = ${sqlText(process)}`
    : "TRUE";
  const summarySql = `SELECT COUNT(*) AS total,
                             COUNT(*) FILTER (WHERE c.customer_status = 'ACTIVE' AND ${selectedProcessClause}) AS active,
                             COUNT(*) FILTER (WHERE c.customer_status = 'ARCHIVED' AND ${selectedProcessClause}) AS archived,
                             COUNT(*) FILTER (WHERE c.customer_process_status = 'INFORMATION_ONLY') AS information_only,
                             COUNT(*) FILTER (WHERE c.customer_process_status = 'RECHARGED_NO_CONSUMPTION') AS recharged_no_consumption,
                             COUNT(*) FILTER (WHERE c.customer_process_status = 'RECHARGED_WITH_CONSUMPTION') AS recharged_with_consumption
                        FROM public.customers c
                       WHERE ${baseClauses.join(" AND ")}`;
  const listSql = `SELECT c.id, c.customer_code, c.customer_name, c.birth_date, c.customer_status,
            c.customer_process_status, c.total_recharge_count, c.total_verification_count,
            c.created_at, c.created_store_id AS store_id, s.store_name, s.store_code,
            TO_CHAR(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
       FROM public.customers c
       JOIN public.stores s ON s.id = c.created_store_id
      WHERE ${listClauses.join(" AND ")}
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT ${limit + 1}`;
  const [rawCustomers, summaryRows] = await Promise.all([executeSql(listSql), executeSql(summarySql)]);
  const hasMore = rawCustomers.length > limit;
  const pageRows = rawCustomers.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  const summary = summaryRows[0] || {};
  const processCounts = {
    INFORMATION_ONLY: Number(summary.information_only || 0),
    RECHARGED_NO_CONSUMPTION: Number(summary.recharged_no_consumption || 0),
    RECHARGED_WITH_CONSUMPTION: Number(summary.recharged_with_consumption || 0)
  };
  const selectedTotal = mode === "browse" && process !== "ALL"
    ? processCounts[process]
    : Number(summary.total || 0);
  return {
    ok: true,
    scopeMode: caller.scopeMode,
    storeId: caller.storeId ? String(caller.storeId) : "",
    storeCode: caller.storeCode,
    storeName: caller.storeName,
    storeStatus: caller.storeStatus || "",
    summary: {
      total: Number(summary.total || 0),
      selectedTotal,
      active: Number(summary.active || 0),
      archived: Number(summary.archived || 0),
      informationOnly: processCounts.INFORMATION_ONLY,
      rechargedNoConsumption: processCounts.RECHARGED_NO_CONSUMPTION,
      rechargedWithConsumption: processCounts.RECHARGED_WITH_CONSUMPTION
    },
    customers: pageRows.map((customer) => ({
      customerCode: customer.customer_code, customerName: customer.customer_name,
      birthDate: customer.birth_date, customerStatus: customer.customer_status,
      customerProcessStatus: customer.customer_process_status,
      totalRechargeCount: Number(customer.total_recharge_count || 0),
      totalVerificationCount: Number(customer.total_verification_count || 0),
      createdAt: customer.created_at, storeId: String(customer.store_id),
      storeName: customer.store_name, storeCode: customer.store_code
    })),
    hasMore,
    nextCursor: hasMore && last ? { createdAt: last.cursor_created_at, id: String(last.id) } : null
  };
}

function optionalBusinessQueryDate(value, label) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) fail(`${label}格式无效。`, "BAD_REQUEST");
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== text) {
    fail(`${label}不是有效日期。`, "BAD_REQUEST");
  }
  return text;
}

function businessQueryDatabaseId(value, label) {
  const id = positiveDatabaseId(value, label);
  if (BigInt(id) > 9223372036854775807n) fail(`${label}超出数据库编号范围。`, "BAD_REQUEST");
  return id;
}

// Business-record search is intentionally separate from the HQ review queue.
// The authenticated UID establishes either one store scope or HQ's verified
// all/single-store scope; browser filters never grant access by themselves.
async function queryStoreBusinessRecords(event = {}) {
  const caller = await activeScopedQueryCaller(event);
  const recordType = String(event.recordType || "").trim().toUpperCase();
  if (!["RECHARGE", "VERIFICATION"].includes(recordType)) fail("工单类型无效。", "BAD_REQUEST");

  const mode = String(event.mode || "browse").trim().toLowerCase();
  if (!["browse", "manual"].includes(mode)) fail("工单查询方式无效。", "BAD_REQUEST");
  const statusCategory = String(event.statusCategory || "ALL").trim().toUpperCase();
  if (!["ALL", "PENDING", "APPROVED", "REJECTED", "CLOSED"].includes(statusCategory)) {
    fail("工单状态筛选无效。", "BAD_REQUEST");
  }
  const verificationType = String(event.verificationType || "ALL").trim().toUpperCase();
  if (!["ALL", "NORMAL", "SUPPLEMENT", "EXPERIENCE"].includes(verificationType)) {
    fail("核销类型筛选无效。", "BAD_REQUEST");
  }

  const customerName = String(event.customerName || "").trim();
  if (customerName.length > 100) fail("客户姓名查询不能超过 100 个字符。", "BAD_REQUEST");
  const birthDate = optionalBusinessQueryDate(event.birthDate, "生日");
  const startDate = optionalBusinessQueryDate(event.startDate, "开始日期");
  const endDate = optionalBusinessQueryDate(event.endDate, "结束日期");
  if (startDate && endDate && startDate > endDate) fail("开始日期不能晚于结束日期。", "BAD_REQUEST");

  const productIdText = String(event.productId || "").trim();
  const productId = productIdText && productIdText.toUpperCase() !== "ALL"
    ? businessQueryDatabaseId(productIdText, "项目")
    : "";
  const requestedLimit = Number(event.limit);
  const limit = Math.min(Math.max(Number.isFinite(requestedLimit) ? Math.trunc(requestedLimit) : 100, 1), 100);
  const cursorSubmittedAt = scopedQueryCursorTimestamp(event.cursorSubmittedAt, "分页时间游标");
  const cursorIdText = String(event.cursorId || "").trim();
  if (Boolean(cursorSubmittedAt) !== Boolean(cursorIdText)) fail("分页游标不完整。", "BAD_REQUEST");
  const cursorId = cursorIdText ? businessQueryDatabaseId(cursorIdText, "分页工单") : "";

  const alias = recordType === "RECHARGE" ? "r" : "v";
  const table = recordType === "RECHARGE" ? "recharge_records" : "verification_records";
  const baseClauses = [scopedStoreClause(caller, `${alias}.store_id`)];
  if (mode === "manual") {
    if (customerName) baseClauses.push(`c.customer_name ILIKE '%' || ${sqlText(customerName)} || '%'`);
    if (birthDate) baseClauses.push(`c.birth_date = ${sqlText(birthDate)}::date`);
  } else {
    if (productId) baseClauses.push(`${alias}.product_id = ${productId}`);
    if (recordType === "VERIFICATION" && verificationType !== "ALL") {
      baseClauses.push(`v.verification_type = ${sqlText(verificationType)}`);
    }
    if (startDate) baseClauses.push(`${alias}.submitted_at >= (${sqlText(startDate)}::date::timestamp AT TIME ZONE 'Asia/Shanghai')`);
    if (endDate) baseClauses.push(`${alias}.submitted_at < ((${sqlText(endDate)}::date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai')`);
  }

  const listClauses = [...baseClauses];
  if (statusCategory === "PENDING") listClauses.push(`${alias}.record_status = 'PENDING'`);
  else if (statusCategory === "APPROVED") listClauses.push(`${alias}.record_status = 'APPROVED'`);
  else if (["REJECTED", "CLOSED"].includes(statusCategory)) listClauses.push(`${alias}.record_status IN ('REJECTED', 'VOIDED')`);
  if (cursorSubmittedAt) {
    listClauses.push(`(${alias}.submitted_at, ${alias}.id) < (${sqlText(cursorSubmittedAt)}::timestamptz, ${cursorId}::bigint)`);
  }

  const recordSelect = recordType === "RECHARGE"
    ? `r.id, r.recharge_code AS record_code, r.recharge_type AS original_type,
       r.unit_count, r.balance_before_count, r.balance_after_count,
       r.record_status, r.void_request_status, r.submitted_at, r.reviewed_at,
       TO_CHAR(r.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_submitted_at,
       FALSE AS has_face_request`
    : `v.id, v.verification_code AS record_code, v.verification_type AS original_type,
       v.unit_count, v.record_status, v.void_request_status, v.submitted_at, v.reviewed_at,
       TO_CHAR(v.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_submitted_at,
       (NULLIF(BTRIM(v.face_request_id), '') IS NOT NULL) AS has_face_request`;
  const teacherJoin = `LEFT JOIN public.teachers t ON t.id = ${alias}.teacher_id`;
  const baseJoin = `JOIN public.customers c
                      ON c.id = ${alias}.customer_id
                     AND c.created_store_id = ${alias}.store_id
                    JOIN public.stores s ON s.id = ${alias}.store_id
                    JOIN public.products p ON p.id = ${alias}.product_id
                    ${teacherJoin}`;
  const summarySql = `SELECT COUNT(*) AS total,
                             COUNT(*) FILTER (WHERE ${alias}.record_status = 'PENDING') AS pending,
                             COUNT(*) FILTER (WHERE ${alias}.record_status = 'APPROVED') AS approved,
                             COUNT(*) FILTER (WHERE ${alias}.record_status IN ('REJECTED', 'VOIDED')) AS rejected
                        FROM public.${table} ${alias}
                        ${baseJoin}
                       WHERE ${baseClauses.join(" AND ")}`;
  const listSql = `SELECT ${recordSelect},
                          c.customer_code, c.customer_name, c.birth_date,
                          s.id AS store_id, s.store_code, s.store_name,
                          s.province AS store_province, s.city AS store_city,
                          s.district AS store_district, s.address_detail AS store_address_detail,
                          p.id AS product_id, p.product_code, p.product_name,
                          t.id AS teacher_id, t.teacher_code, t.teacher_name
                     FROM public.${table} ${alias}
                     ${baseJoin}
                    WHERE ${listClauses.join(" AND ")}
                    ORDER BY ${alias}.submitted_at DESC, ${alias}.id DESC
                    LIMIT ${limit + 1}`;
  const productsSql = `SELECT p.id AS product_id, p.product_code, p.product_name, p.product_status
                          FROM public.products p
                         WHERE p.product_status = 'ACTIVE'
                            OR EXISTS (
                              SELECT 1
                                FROM public.${table} product_record
                               WHERE product_record.product_id = p.id
                                 AND ${scopedStoreClause(caller, "product_record.store_id")}
                            )
                         ORDER BY CASE WHEN p.product_status = 'ACTIVE' THEN 0 ELSE 1 END,
                                  p.product_name, p.product_code`;

  const [rawRecords, summaryRows, productRows] = await Promise.all([
    executeSql(listSql),
    executeSql(summarySql),
    executeSql(productsSql)
  ]);
  const hasMore = rawRecords.length > limit;
  const pageRows = rawRecords.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  const summary = summaryRows[0] || {};
  return {
    ok: true,
    scopeMode: caller.scopeMode,
    storeId: caller.storeId ? String(caller.storeId) : "",
    storeCode: caller.storeCode,
    storeName: caller.storeName,
    storeStatus: caller.storeStatus || "",
    recordType,
    summary: {
      total: Number(summary.total || 0),
      pending: Number(summary.pending || 0),
      approved: Number(summary.approved || 0),
      rejected: Number(summary.rejected || 0),
      closed: Number(summary.rejected || 0)
    },
    products: productRows.map((product) => ({
      productId: String(product.product_id),
      productCode: product.product_code,
      productName: product.product_name,
      productStatus: product.product_status
    })),
    records: pageRows.map((record) => ({
      id: String(record.id),
      recordCode: record.record_code,
      originalType: record.original_type,
      unitCount: Number(record.unit_count || 0),
      balanceBeforeCount: record.balance_before_count === null || record.balance_before_count === undefined ? null : Number(record.balance_before_count),
      balanceAfterCount: record.balance_after_count === null || record.balance_after_count === undefined ? null : Number(record.balance_after_count),
      recordStatus: record.record_status,
      voidRequestStatus: record.void_request_status,
      submittedAt: record.submitted_at,
      reviewedAt: record.reviewed_at,
      customerCode: record.customer_code,
      customerName: record.customer_name,
      birthDate: record.birth_date,
      storeId: String(record.store_id),
      storeCode: record.store_code,
      storeName: record.store_name,
      storeProvince: record.store_province,
      storeCity: record.store_city,
      storeDistrict: record.store_district,
      storeAddressDetail: record.store_address_detail,
      productId: String(record.product_id),
      productCode: record.product_code,
      productName: record.product_name,
      teacherId: record.teacher_id === null || record.teacher_id === undefined ? "" : String(record.teacher_id),
      teacherCode: record.teacher_code || "",
      teacherName: record.teacher_name || "",
      hasFaceRequest: databaseBoolean(record.has_face_request)
    })),
    hasMore,
    nextCursor: hasMore && last ? { submittedAt: last.cursor_submitted_at, id: String(last.id) } : null
  };
}

async function getStoreDashboard(event = {}) {
  const caller = await activeScopedQueryCaller(event);
  if (!caller.storeId) fail("总部查看门店主页时必须选择具体门店。", "STORE_REQUIRED");
  const storeId = businessQueryDatabaseId(caller.storeId, "门店");
  const requestedCustomerPage = Number(event.customerPage || 1);
  if (!Number.isInteger(requestedCustomerPage) || requestedCustomerPage < 1) {
    fail("客户分页必须是正整数。", "BAD_REQUEST");
  }
  const customerPage = Math.min(requestedCustomerPage, 100000);
  const customerPageSize = 10;
  const customerOffset = (customerPage - 1) * customerPageSize;
  const layout = await getStoreBindingLayout();
  const accountJoin = layout === "stores"
    ? "LEFT JOIN public.staff_accounts account ON account.id = s.store_account_id"
    : `LEFT JOIN public.staff_store_assignments assignment
         ON assignment.store_id = s.id AND assignment.assignment_status = 'ACTIVE'
       LEFT JOIN public.staff_accounts account ON account.id = assignment.staff_account_id`;
  // Project totals are derived only from approved orders handled by this
  // store. Customer status and customer.created_store_id must not remove
  // historical business. SUPPLEMENT is a consumptive verification; legacy
  // VOID reduces remaining units but is not reported as a refund. Remaining
  // is floored per customer/product ledger before the project-level sum, and
  // EXPERIENCE never consumes purchased units.
  //
  // A project-wide subtraction is deliberately not used for the displayed
  // balance: one customer's negative raw balance must never cancel another
  // customer's available units. The response therefore also returns the raw
  // aggregate and its customer-level zero-floor adjustment. Refunds are
  // reported along two independent axes: whether a paid verification had
  // already taken effect when the refund took effect, and how much of the
  // final customer-by-product balance the refund actually consumes.
  const [storeRows, projects, customerCountRows, customers] = await Promise.all([
    executeSql(
    `SELECT s.id, s.store_code, s.store_name, s.province, s.city, s.district,
            s.address_detail, s.store_status,
            contact.contact_name, contact.contact_phone, account.auth_uid
       FROM public.stores s
       ${accountJoin}
       LEFT JOIN LATERAL (
         SELECT sc.contact_name, sc.contact_phone
           FROM public.store_contacts sc
          WHERE sc.store_id = s.id
            AND sc.contact_status = 'ACTIVE'
          ORDER BY sc.is_primary DESC, sc.id ASC
          LIMIT 1
       ) contact ON TRUE
      WHERE s.id = ${storeId}::bigint
      LIMIT 1`
    ),
    executeSql(
    `WITH store_business_events AS (
       SELECT r.customer_id, r.product_id,
              COALESCE(r.reviewed_at, r.submitted_at) AS effective_at,
              CASE WHEN r.recharge_type = 'NEW' THEN r.unit_count ELSE 0 END::bigint AS recharge_count,
              CASE WHEN r.recharge_type = 'REFUND' THEN r.unit_count ELSE 0 END::bigint AS refund_count,
              CASE WHEN r.recharge_type = 'VOID' THEN r.unit_count ELSE 0 END::bigint AS legacy_void_count,
              0::bigint AS verification_count,
              0::bigint AS experience_count
         FROM public.recharge_records r
        WHERE r.store_id = ${storeId}::bigint
          AND r.record_status = 'APPROVED'
          AND r.recharge_type IN ('NEW', 'REFUND', 'VOID')
       UNION ALL
       SELECT v.customer_id, v.product_id,
              COALESCE(v.reviewed_at, v.submitted_at) AS effective_at,
              0::bigint AS recharge_count,
              0::bigint AS refund_count,
              0::bigint AS legacy_void_count,
              CASE WHEN v.verification_type IN ('NORMAL', 'SUPPLEMENT') THEN v.unit_count ELSE 0 END::bigint AS verification_count,
              CASE WHEN v.verification_type = 'EXPERIENCE' THEN v.unit_count ELSE 0 END::bigint AS experience_count
         FROM public.verification_records v
        WHERE v.store_id = ${storeId}::bigint
          AND v.record_status = 'APPROVED'
          AND v.verification_type IN ('NORMAL', 'SUPPLEMENT', 'EXPERIENCE')
     ), customer_product_totals AS (
       SELECT event.customer_id, event.product_id,
              SUM(event.recharge_count) AS total_recharge_count,
              SUM(event.verification_count) AS total_verification_count,
              SUM(event.experience_count) AS total_experience_count,
              SUM(event.refund_count) AS total_refund_count,
              SUM(event.legacy_void_count) AS total_legacy_void_count,
              GREATEST(
                SUM(event.recharge_count)
                  - SUM(event.legacy_void_count)
                  - SUM(event.verification_count),
                0
              ) AS balance_before_refund_count,
              LEAST(
                SUM(event.refund_count),
                GREATEST(
                  SUM(event.recharge_count)
                    - SUM(event.legacy_void_count)
                    - SUM(event.verification_count),
                  0
                )
              ) AS refund_from_remaining_count,
              GREATEST(
                SUM(event.refund_count)
                  - GREATEST(
                    SUM(event.recharge_count)
                      - SUM(event.legacy_void_count)
                      - SUM(event.verification_count),
                    0
                  ),
                0
              ) AS refund_excess_over_remaining_count,
              SUM(event.recharge_count)
                - SUM(event.refund_count)
                - SUM(event.legacy_void_count)
                - SUM(event.verification_count) AS raw_remaining_count,
              GREATEST(
                SUM(event.recharge_count)
                  - SUM(event.refund_count)
                  - SUM(event.legacy_void_count)
                  - SUM(event.verification_count),
                0
              ) AS remaining_count,
              GREATEST(
                SUM(event.recharge_count)
                  - SUM(event.refund_count)
                  - SUM(event.legacy_void_count)
                  - SUM(event.verification_count),
                0
              ) - (
                SUM(event.recharge_count)
                  - SUM(event.refund_count)
                  - SUM(event.legacy_void_count)
                  - SUM(event.verification_count)
              ) AS balance_floor_adjustment
         FROM store_business_events event
        GROUP BY event.customer_id, event.product_id
     ), first_paid_verification AS (
       SELECT event.customer_id, event.product_id,
              MIN(event.effective_at) AS first_paid_verification_at
         FROM store_business_events event
        WHERE event.verification_count > 0
        GROUP BY event.customer_id, event.product_id
     ), project_balance_totals AS (
       SELECT customer_product.product_id,
              SUM(customer_product.total_recharge_count) AS total_recharge_count,
              SUM(customer_product.total_verification_count) AS total_verification_count,
              SUM(customer_product.total_experience_count) AS total_experience_count,
              SUM(customer_product.total_refund_count) AS total_refund_count,
              SUM(customer_product.total_legacy_void_count) AS total_legacy_void_count,
              SUM(customer_product.refund_from_remaining_count) AS refund_from_remaining_count,
              SUM(customer_product.refund_excess_over_remaining_count) AS refund_excess_over_remaining_count,
              SUM(customer_product.raw_remaining_count) AS raw_remaining_count,
              SUM(customer_product.balance_floor_adjustment) AS balance_floor_adjustment,
              SUM(customer_product.remaining_count) AS remaining_count
         FROM customer_product_totals customer_product
        GROUP BY customer_product.product_id
     ), project_refund_relationships AS (
       SELECT event.product_id,
              SUM(CASE
                WHEN paid.first_paid_verification_at IS NULL
                  OR paid.first_paid_verification_at > event.effective_at
                THEN event.refund_count ELSE 0 END) AS refund_before_consumption_count,
              SUM(CASE
                WHEN paid.first_paid_verification_at IS NOT NULL
                  AND paid.first_paid_verification_at <= event.effective_at
                THEN event.refund_count ELSE 0 END) AS refund_after_consumption_count,
              COUNT(DISTINCT CASE
                WHEN paid.first_paid_verification_at IS NULL
                  OR paid.first_paid_verification_at > event.effective_at
                THEN event.customer_id END) AS refund_before_consumption_customer_count,
              COUNT(DISTINCT CASE
                WHEN paid.first_paid_verification_at IS NOT NULL
                  AND paid.first_paid_verification_at <= event.effective_at
                THEN event.customer_id END) AS refund_after_consumption_customer_count
         FROM store_business_events event
         LEFT JOIN first_paid_verification paid
           ON paid.customer_id = event.customer_id
          AND paid.product_id = event.product_id
        WHERE event.refund_count > 0
        GROUP BY event.product_id
     ), project_members AS (
       SELECT p.id AS product_id
         FROM public.products p
        WHERE p.product_status = 'ACTIVE'
       UNION
       SELECT event.product_id
         FROM store_business_events event
     )
     SELECT p.id AS product_id, p.product_code, p.product_name, p.product_status,
            COALESCE(totals.total_recharge_count, 0) AS total_recharge_count,
            COALESCE(totals.total_verification_count, 0) AS total_verification_count,
            COALESCE(totals.total_experience_count, 0) AS total_experience_count,
            COALESCE(totals.total_refund_count, 0) AS total_refund_count,
            COALESCE(totals.total_legacy_void_count, 0) AS total_legacy_void_count,
            COALESCE(totals.refund_from_remaining_count, 0) AS refund_from_remaining_count,
            COALESCE(totals.refund_excess_over_remaining_count, 0) AS refund_after_consumption_balance_count,
            COALESCE(relationships.refund_before_consumption_count, 0) AS refund_before_consumption_count,
            COALESCE(relationships.refund_after_consumption_count, 0) AS refund_after_consumption_count,
            COALESCE(relationships.refund_before_consumption_customer_count, 0) AS refund_before_consumption_customer_count,
            COALESCE(relationships.refund_after_consumption_customer_count, 0) AS refund_after_consumption_customer_count,
            0::bigint AS refund_breakdown_unknown_count,
            COALESCE(totals.raw_remaining_count, 0) AS raw_remaining_count,
            COALESCE(totals.balance_floor_adjustment, 0) AS balance_floor_adjustment,
            COALESCE(totals.remaining_count, 0) AS remaining_count
       FROM project_members member
       JOIN public.products p ON p.id = member.product_id
       LEFT JOIN project_balance_totals totals ON totals.product_id = p.id
       LEFT JOIN project_refund_relationships relationships ON relationships.product_id = p.id
      ORDER BY p.product_name, p.product_code`
    ),
    executeSql(
      `SELECT COUNT(*) AS customer_total
         FROM public.customers
        WHERE created_store_id = ${storeId}::bigint
          AND customer_status = 'ACTIVE'`
    ),
    executeSql(
    `SELECT c.id AS customer_id, c.customer_code, c.customer_name, c.birth_date,
            c.customer_status, c.total_recharge_count, c.total_verification_count,
            COALESCE(COUNT(b.product_id) FILTER (
              WHERE b.total_recharge_count > 0 OR b.total_verification_count > 0
            ), 0) AS product_count,
            COALESCE(SUM(b.remaining_count), 0) AS remaining_count,
            GREATEST(c.latest_recharge_at, c.latest_verification_at) AS last_business_at
       FROM public.customers c
       LEFT JOIN public.customer_product_balances b ON b.customer_id = c.id
      WHERE c.created_store_id = ${storeId}::bigint
        AND c.customer_status = 'ACTIVE'
      GROUP BY c.id, c.customer_code, c.customer_name, c.birth_date,
               c.customer_status, c.total_recharge_count, c.total_verification_count,
               c.latest_recharge_at, c.latest_verification_at
      ORDER BY c.created_at DESC, c.id DESC
      LIMIT ${customerPageSize} OFFSET ${customerOffset}`
    )
  ]);
  const store = storeRows[0];
  if (!store) fail("未找到当前登录账号绑定的门店。", "STORE_NOT_FOUND");
  const customerTotal = Number(customerCountRows?.[0]?.customer_total || 0);
  const customerPages = Math.max(1, Math.ceil(customerTotal / customerPageSize));
  if (customerTotal && customerPage > customerPages) fail("客户分页超出有效范围。", "PAGE_OUT_OF_RANGE");

  return {
    ok: true,
    store: {
      ...store,
      auth_uid: String(store.auth_uid || ""),
      projects,
      teachers: [],
      customers,
      customer_total: customerTotal,
      customer_page: customerPage,
      customer_page_size: customerPageSize
    }
  };
}

const STORE_ANALYTICS_METRICS = Object.freeze(["recharge", "verification", "experience", "refund"]);

function storeAnalyticsRange(event = {}) {
  const startDate = optionalBusinessQueryDate(event.startDate, "开始日期");
  const endDate = optionalBusinessQueryDate(event.endDate, "结束日期");
  if (Boolean(startDate) !== Boolean(endDate)) fail("开始日期和结束日期必须同时提供。", "BAD_REQUEST");
  if (startDate && startDate > endDate) fail("开始日期不能晚于结束日期。", "BAD_REQUEST");
  if (startDate) {
    const days = Math.floor((Date.parse(`${endDate}T00:00:00.000Z`) - Date.parse(`${startDate}T00:00:00.000Z`)) / 86400000) + 1;
    if (days > 366) fail("单次统计范围不能超过 366 天。", "BAD_REQUEST");
  }
  return {
    startSql: startDate ? `${sqlText(startDate)}::date` : "(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date",
    endSql: endDate ? `${sqlText(endDate)}::date` : "(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date"
  };
}

function storeAnalyticsEventCte(storeId, range) {
  return `date_bounds AS (
      SELECT ${range.startSql} AS start_date, ${range.endSql} AS end_date
    ), time_bounds AS (
      SELECT start_date, end_date,
             start_date::timestamp AT TIME ZONE 'Asia/Shanghai' AS start_at,
             (end_date + 1)::timestamp AT TIME ZONE 'Asia/Shanghai' AS end_at
        FROM date_bounds
    ), business_events AS (
      SELECT CASE WHEN r.recharge_type = 'REFUND' THEN 'refund' ELSE 'recharge' END AS metric,
             r.store_id, r.product_id, r.teacher_id, r.unit_count::bigint AS amount
        FROM public.recharge_records r
        CROSS JOIN time_bounds bounds
       WHERE r.store_id = ${storeId}::bigint
         AND r.record_status = 'APPROVED'
         AND r.recharge_type IN ('NEW', 'REFUND')
         AND r.submitted_at >= bounds.start_at
         AND r.submitted_at < bounds.end_at
      UNION ALL
      SELECT CASE WHEN v.verification_type = 'EXPERIENCE' THEN 'experience' ELSE 'verification' END AS metric,
             v.store_id, v.product_id, v.teacher_id, v.unit_count::bigint AS amount
        FROM public.verification_records v
        CROSS JOIN time_bounds bounds
       WHERE v.store_id = ${storeId}::bigint
         AND v.record_status = 'APPROVED'
         AND v.verification_type IN ('NORMAL', 'EXPERIENCE')
         AND v.submitted_at >= bounds.start_at
         AND v.submitted_at < bounds.end_at
    )`;
}

function storeAnalyticsCounts(row) {
  return {
    recharge: Number(row.recharge_count || 0),
    verification: Number(row.verification_count || 0),
    experience: Number(row.experience_count || 0),
    refund: Number(row.refund_count || 0)
  };
}

function storeAnalyticsDateText(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  const text = String(value || "");
  return text.match(/\d{4}-\d{2}-\d{2}/)?.[0] || text;
}

function storeAnalyticsMetricColumns(alias = "event") {
  return STORE_ANALYTICS_METRICS.map((metric) =>
    `COALESCE(SUM(${alias}.amount) FILTER (WHERE ${alias}.metric = '${metric}'), 0) AS ${metric}_count`
  ).join(",\n             ");
}

async function getStoreBusinessAnalytics(event = {}) {
  const caller = await activeScopedQueryCaller(event);
  if (!caller.storeId) fail("门店全局视图必须选择具体门店。", "STORE_REQUIRED");
  const storeId = businessQueryDatabaseId(caller.storeId, "门店");
  const range = storeAnalyticsRange(event);
  const eventCte = storeAnalyticsEventCte(storeId, range);
  const metricColumns = storeAnalyticsMetricColumns();

  const [storeRows, productRows, teacherRows] = await Promise.all([
    executeSql(
      `WITH ${eventCte}
       SELECT s.id AS store_id, s.store_code, s.store_name, s.store_status,
              COALESCE(contact.contact_phone, '') AS phone,
              bounds.start_date, bounds.end_date,
              ${metricColumns}
         FROM public.stores s
         CROSS JOIN date_bounds bounds
         LEFT JOIN business_events event ON event.store_id = s.id
         LEFT JOIN LATERAL (
           SELECT sc.contact_phone
             FROM public.store_contacts sc
            WHERE sc.store_id = s.id
              AND sc.contact_status = 'ACTIVE'
            ORDER BY sc.is_primary DESC, sc.id ASC
            LIMIT 1
         ) contact ON TRUE
        WHERE s.id = ${storeId}::bigint
        GROUP BY s.id, s.store_code, s.store_name, s.store_status,
                 contact.contact_phone, bounds.start_date, bounds.end_date`
    ),
    executeSql(
      `WITH ${eventCte}, product_members AS (
         SELECT p.id AS product_id
           FROM public.products p
          WHERE p.product_status = 'ACTIVE'
         UNION
         SELECT event.product_id
           FROM business_events event
       )
       SELECT p.id AS product_id, p.product_code, p.product_name, p.product_status,
              ${metricColumns}
         FROM product_members member
         JOIN public.products p ON p.id = member.product_id
         LEFT JOIN business_events event ON event.product_id = p.id
        GROUP BY p.id, p.product_code, p.product_name, p.product_status`
    ),
    executeSql(
      `WITH ${eventCte}, teacher_members AS (
         SELECT t.id AS teacher_id
           FROM public.teachers t
           JOIN public.staff_accounts account ON account.id = t.staff_account_id
          WHERE t.teacher_status = 'ACTIVE'
            AND account.account_status = 'ACTIVE'
         UNION
         SELECT event.teacher_id
           FROM business_events event
          WHERE event.teacher_id IS NOT NULL
       ), teacher_counts AS (
         SELECT t.id AS teacher_id, t.teacher_code, t.teacher_name, t.teacher_status,
                COALESCE(account.phone, '') AS phone,
                ${metricColumns}
           FROM teacher_members member
           JOIN public.teachers t ON t.id = member.teacher_id
           LEFT JOIN public.staff_accounts account ON account.id = t.staff_account_id
           LEFT JOIN business_events event ON event.teacher_id = t.id
          GROUP BY t.id, t.teacher_code, t.teacher_name, t.teacher_status, account.phone
       ), unassigned_counts AS (
         SELECT NULL::bigint AS teacher_id, ''::text AS teacher_code,
                '未指定老师'::text AS teacher_name, 'HISTORICAL'::text AS teacher_status,
                ''::text AS phone,
                ${metricColumns}
           FROM business_events event
          WHERE event.teacher_id IS NULL
         HAVING COALESCE(SUM(event.amount), 0) > 0
       )
       SELECT * FROM teacher_counts
       UNION ALL
       SELECT * FROM unassigned_counts`
    )
  ]);

  const store = storeRows[0];
  if (!store) fail("未找到门店统计资料。", "STORE_NOT_FOUND");
  const products = productRows.map((row) => ({
    productId: String(row.product_id),
    productCode: String(row.product_code || ""),
    productName: String(row.product_name || ""),
    status: String(row.product_status || ""),
    ...storeAnalyticsCounts(row)
  }));
  const teachers = teacherRows.map((row) => ({
    teacherId: row.teacher_id === null || row.teacher_id === undefined ? "" : String(row.teacher_id),
    teacherCode: String(row.teacher_code || ""),
    teacherName: String(row.teacher_name || ""),
    phone: String(row.phone || ""),
    status: String(row.teacher_status || ""),
    ...storeAnalyticsCounts(row)
  }));
  const storeSummary = {
    storeId: String(store.store_id),
    storeCode: String(store.store_code || ""),
    storeName: String(store.store_name || ""),
    phone: String(store.phone || ""),
    status: String(store.store_status || ""),
    ...storeAnalyticsCounts(store)
  };
  const dimensions = {};
  STORE_ANALYTICS_METRICS.forEach((metric) => {
    const descending = (a, b) => Number(b.value || 0) - Number(a.value || 0) || String(a.name || "").localeCompare(String(b.name || ""), "zh-CN");
    dimensions[metric] = {
      stores: [{ id: storeSummary.storeId, name: storeSummary.storeName, phone: storeSummary.phone, value: storeSummary[metric] }],
      teachers: teachers.map((teacher) => ({ id: teacher.teacherId, name: teacher.teacherName, phone: teacher.phone, value: teacher[metric] })).sort(descending),
      products: products.map((product) => ({ id: product.productId, name: product.productName, phone: "", value: product[metric] })).sort(descending)
    };
  });
  return {
    ok: true,
    range: { startDate: storeAnalyticsDateText(store.start_date), endDate: storeAnalyticsDateText(store.end_date) },
    store: storeSummary,
    products: products.sort((a, b) => {
      const aTotal = STORE_ANALYTICS_METRICS.reduce((sum, metric) => sum + a[metric], 0);
      const bTotal = STORE_ANALYTICS_METRICS.reduce((sum, metric) => sum + b[metric], 0);
      return bTotal - aTotal || a.productName.localeCompare(b.productName, "zh-CN");
    }),
    totals: storeAnalyticsCounts(store),
    dimensions
  };
}

async function requireTeacherExperienceQuotaLifecycleSchema() {
  const rows = await executeSql(
    `SELECT TO_REGCLASS('public.teacher_product_experience_quotas') IS NOT NULL AS has_quota_table,
            TO_REGCLASS('public.teacher_experience_quota_usages') IS NOT NULL AS has_quota_usage_table,
            EXISTS (
              SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public'
                 AND table_name = 'teacher_product_experience_quotas'
                 AND column_name = 'quota_status'
            ) AS has_quota_status`
  );
  const schema = rows?.[0] || {};
  if (!databaseBoolean(schema.has_quota_table) || !databaseBoolean(schema.has_quota_usage_table)
      || !databaseBoolean(schema.has_quota_status)) {
    fail("体验额度生命周期尚未启用，请先执行迁移 048。", "DATABASE_SCHEMA_MISSING");
  }
}

async function getTeacherExperienceEntitlements(event = {}) {
  const caller = await activeBusinessCaller(event);
  await requireTeacherExperienceQuotaLifecycleSchema();
  const requestedTeacherId = String(event.teacherId || "").trim();
  if (caller.role === "teacher" && requestedTeacherId && requestedTeacherId !== String(caller.teacherId)) {
    fail("老师账号只能读取自己的体验额度。", "FORBIDDEN");
  }
  const teacherId = positiveDatabaseId(caller.role === "teacher" ? caller.teacherId : requestedTeacherId, "老师");

  // The timer performs the month-boundary reset proactively.  This targeted
  // call is a race-safe fallback for a delayed timer or a newly read quota.
  await executeSql(
    `SELECT public.reset_teacher_experience_quota(q.id)
       FROM public.teacher_product_experience_quotas q
      WHERE q.teacher_id = ${sqlText(teacherId)}::bigint
        AND q.quota_status = 'ACTIVE'
        AND q.quota_month < public.teacher_experience_quota_month()`
  );

  const rows = await executeSql(
    `SELECT q.id, q.teacher_id, q.product_id, q.monthly_allowance, q.quota_month,
            q.available_count, q.used_count, q.manual_recharge_count, q.monthly_reset_at,
            p.product_code, p.product_name, p.product_status,
            COALESCE((
              SELECT SUM(u.unit_count)::bigint
                FROM public.teacher_experience_quota_usages u
               WHERE u.teacher_id = q.teacher_id
                 AND u.product_id = q.product_id
            ), 0)::bigint AS total_experience_count
       FROM public.teacher_product_experience_quotas q
       JOIN public.teachers t ON t.id = q.teacher_id
       JOIN public.staff_accounts a ON a.id = t.staff_account_id
       JOIN public.products p ON p.id = q.product_id
      WHERE q.teacher_id = ${sqlText(teacherId)}::bigint
        AND t.teacher_status = 'ACTIVE'
        AND a.role_code = 'teacher'
        AND a.account_status = 'ACTIVE'
        AND p.product_status = 'ACTIVE'
        AND q.quota_status = 'ACTIVE'
        AND q.available_count > 0
      ORDER BY p.product_name, p.product_code, q.id`
  );
  return {
    ok: true,
    teacherId: String(teacherId),
    entitlements: rows.map((row) => ({
      id: String(row.id),
      teacherId: String(row.teacher_id),
      productId: String(row.product_id),
      productCode: String(row.product_code || ""),
      productName: String(row.product_name || ""),
      productStatus: String(row.product_status || ""),
      monthlyAllowance: Number(row.monthly_allowance || 0),
      quotaMonth: row.quota_month,
      availableCount: Number(row.available_count || 0),
      usedCount: Number(row.used_count || 0),
      totalExperienceCount: Number(row.total_experience_count || 0),
      totalUsedCount: Number(row.total_experience_count || 0),
      manualRechargeCount: Number(row.manual_recharge_count || 0),
      monthlyResetAt: row.monthly_reset_at
    }))
  };
}

async function listActiveTeachers(event = {}) {
  // Teachers are not permanently assigned to one store in the canonical
  // schema. A real active store caller may choose only teachers whose profile
  // and login account are both active.
  const caller = await activeBusinessCaller(event);
  const rows = caller.role === "teacher" ? [{
    teacher_id: caller.teacherId,
    teacher_code: caller.teacherCode,
    teacher_name: caller.teacherName,
    face_enrollment_status: caller.faceEnrollmentStatus,
    face_photo_ready: caller.facePhotoReady
  }] : await executeSql(
    `SELECT t.id AS teacher_id, t.teacher_code, t.teacher_name,
            t.face_enrollment_status,
            (BTRIM(COALESCE(t.face_person_id, '')) <> ''
             AND BTRIM(COALESCE(t.profile_photo_file_id, '')) <> '') AS face_photo_ready
       FROM public.teachers t
      JOIN public.staff_accounts a ON a.id = t.staff_account_id
      WHERE t.teacher_status = 'ACTIVE'
        AND a.role_code = 'teacher'
        AND a.account_status = 'ACTIVE'
      ORDER BY t.teacher_name, t.teacher_code
      LIMIT 1000`
  );
  return {
    ok: true,
    teachers: rows.map((teacher) => ({
      teacherId: String(teacher.teacher_id),
      teacherCode: teacher.teacher_code,
      teacherName: teacher.teacher_name,
      faceEnrollmentStatus: String(teacher.face_enrollment_status || ""),
      facePhotoReady: databaseBoolean(teacher.face_photo_ready)
    }))
  };
}

async function listActiveProducts(event = {}) {
  await activeBusinessCaller(event);
  const rows = await executeSql(
    `SELECT id AS product_id, product_code, product_name
       FROM public.products
      WHERE product_status = 'ACTIVE'
      ORDER BY product_name, product_code
      LIMIT 1000`
  );
  return {
    ok: true,
    products: rows.map((product) => ({
      productId: String(product.product_id),
      productCode: product.product_code,
      productName: product.product_name
    }))
  };
}

function positiveDatabaseId(value, label) {
  const text = String(value ?? "").trim();
  if (!/^[1-9]\d{0,18}$/.test(text)) fail(`必须选择有效的${label}。`, "BAD_REQUEST");
  return text;
}

function rechargeSubmissionKey(value) {
  const text = String(value || "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(text)) {
    fail("充值申请缺少有效的防重复提交编号，请刷新页面后重试。", "IDEMPOTENCY_KEY_REQUIRED");
  }
  return text;
}

async function requireRechargeSubmissionSchema({ refund = false } = {}) {
  const rows = await executeSql(
    `SELECT EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'recharge_records'
          AND column_name = 'idempotency_key'
     ) AS has_idempotency_key,
     EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'recharge_records'
          AND column_name = 'teacher_id'
          AND is_nullable = 'YES'
     ) AS teacher_is_optional,
     EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'recharge_records'
          AND column_name = 'balance_before_count'
     ) AND EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'recharge_records'
          AND column_name = 'balance_after_count'
     ) AS has_refund_snapshots`
  );
  if (!databaseBoolean(rows?.[0]?.has_idempotency_key)) {
    fail("充值单数据库缺少防重复提交字段，请先执行迁移 023。", "DATABASE_SCHEMA_MISSING");
  }
  if (!databaseBoolean(rows?.[0]?.teacher_is_optional)) {
    fail("充值单数据库尚未允许业务老师为空，请先执行迁移 024。", "DATABASE_SCHEMA_MISSING");
  }
  if (refund && !databaseBoolean(rows?.[0]?.has_refund_snapshots)) {
    fail("退费单数据库结构尚未启用，请先执行迁移 044。", "DATABASE_SCHEMA_MISSING");
  }
}

async function createRechargeApplication(event) {
  const caller = await activeBusinessCaller(event);
  const applicationType = String(event.applicationType || "NEW").trim().toUpperCase();
  if (!["NEW", "REFUND"].includes(applicationType)) fail("申请类型只能是充值或退费。", "BAD_REQUEST");
  const refund = applicationType === "REFUND";
  const customerCode = String(event.customerCode || "").trim();
  if (!customerCode || customerCode.length > 96) fail("必须先确认本门店的活跃客户。", "CUSTOMER_REQUIRED");
  const productId = positiveDatabaseId(event.productId, "项目");
  const teacherIdText = String(event.teacherId ?? "").trim();
  if (caller.role === "teacher" && teacherIdText && teacherIdText !== String(caller.teacherId)) {
    fail(`老师账号只能把${refund ? "退费" : "充值"}申请绑定到本人。`, "FORBIDDEN");
  }
  const teacherId = caller.role === "teacher"
    ? positiveDatabaseId(caller.teacherId, "老师")
    : (teacherIdText ? positiveDatabaseId(teacherIdText, "老师") : null);
  const unitCount = Number(event.unitCount);
  if (!Number.isInteger(unitCount) || unitCount < 1 || unitCount > 999) {
    fail(`${refund ? "退费" : "充值"}次数必须是 1 至 999 的整数。`, "INVALID_UNIT_COUNT");
  }
  const message = String(event.message || "").trim();
  if (message.length > 500) fail("门店留言不能超过 500 个字符。", "MESSAGE_TOO_LONG");
  const idempotencyKey = rechargeSubmissionKey(event.clientRequestId);

  await requireRechargeSubmissionSchema({ refund });
  const customers = await executeSql(
    `SELECT id, customer_code, customer_name
       FROM public.customers
      WHERE customer_code = ${sqlText(customerCode)}
        AND created_store_id = ${caller.storeId}
        AND customer_status = 'ACTIVE'
      LIMIT 1`
  );
  const customer = customers[0];
  if (!customer) fail("未找到本门店已确认的活跃客户。", "CUSTOMER_NOT_FOUND");

  const products = await executeSql(
    `SELECT id, product_code, product_name
       FROM public.products
      WHERE id = ${sqlText(productId)}::bigint
        AND product_status = 'ACTIVE'
      LIMIT 1`
  );
  const product = products[0];
  if (!product) fail("所选项目不存在或已经封存，请重新选择。", "PRODUCT_NOT_ACTIVE");

  let teacher = null;
  if (teacherId) {
    const teachers = await executeSql(
      `SELECT t.id, t.teacher_code, t.teacher_name
         FROM public.teachers t
         JOIN public.staff_accounts a ON a.id = t.staff_account_id
        WHERE t.id = ${sqlText(teacherId)}::bigint
          AND t.teacher_status = 'ACTIVE'
          AND a.role_code = 'teacher'
          AND a.account_status = 'ACTIVE'
        LIMIT 1`
    );
    teacher = teachers[0] || null;
    if (!teacher) fail("所选老师不存在或已经封存，请重新选择。", "TEACHER_NOT_ACTIVE");
  }
  const teacherIdSql = teacherId ? `${sqlText(teacherId)}::bigint` : "NULL";

  const rows = await executeSql(
    `WITH current_balance AS (
       SELECT b.total_recharge_count, GREATEST(b.remaining_count, 0) AS remaining_count
         FROM public.customer_product_balances b
        WHERE b.customer_id = ${sqlText(customer.id)}::bigint
          AND b.product_id = ${sqlText(productId)}::bigint
        LIMIT 1
     ), inserted AS (
       INSERT INTO public.recharge_records
         (recharge_type, store_id, teacher_id, customer_id, product_id,
          unit_count, record_status, submitted_by_account_id, message, idempotency_key,
          balance_before_count)
       SELECT ${sqlText(applicationType)}, ${caller.storeId}, ${teacherIdSql},
              ${sqlText(customer.id)}::bigint, ${sqlText(productId)}::bigint,
              ${unitCount}, 'PENDING', ${caller.staffId}, ${sqlText(message)}, ${sqlText(idempotencyKey)},
              CASE WHEN ${sqlText(applicationType)} = 'REFUND'
                   THEN COALESCE((SELECT remaining_count FROM current_balance), 0)
                   ELSE NULL END
        WHERE ${sqlText(applicationType)} = 'NEW'
           OR COALESCE((SELECT total_recharge_count FROM current_balance), 0) >= ${unitCount}
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id, recharge_code, recharge_type, store_id, teacher_id, customer_id,
                 product_id, unit_count, record_status, submitted_by_account_id,
                 submitted_at, message, idempotency_key, balance_before_count, balance_after_count
     )
     SELECT *, TRUE AS created_now FROM inserted
     UNION ALL
     SELECT r.id, r.recharge_code, r.recharge_type, r.store_id, r.teacher_id,
            r.customer_id, r.product_id, r.unit_count, r.record_status,
            r.submitted_by_account_id, r.submitted_at, r.message,
            r.idempotency_key, r.balance_before_count, r.balance_after_count, FALSE AS created_now
       FROM public.recharge_records r
      WHERE r.idempotency_key = ${sqlText(idempotencyKey)}
        AND NOT EXISTS (SELECT 1 FROM inserted)
     LIMIT 1`
  );
  const record = rows[0];
  if (!record) fail(refund ? "退费次数超过该项目尚未退费的总购买次数，请重新填写。" : "充值申请未能写入数据库，请稍后重试。", refund ? "REFUND_COUNT_EXCEEDS_PURCHASED" : "RECHARGE_CREATE_FAILED");

  const sameRequest = record.recharge_type === applicationType
    && String(record.store_id) === String(caller.storeId)
    && String(record.submitted_by_account_id) === String(caller.staffId)
    && String(record.teacher_id || "") === String(teacherId || "")
    && String(record.customer_id) === String(customer.id)
    && String(record.product_id) === String(productId)
    && Number(record.unit_count) === unitCount
    && String(record.message || "") === message;
  if (!sameRequest) {
    fail(`该防重复提交编号已经用于另一张${refund ? "退费" : "充值"}单，请刷新页面后重新提交。`, "IDEMPOTENCY_CONFLICT");
  }

  return {
    ok: true,
    createdNow: databaseBoolean(record.created_now),
    rechargeId: String(record.id),
    rechargeCode: record.recharge_code,
    rechargeType: record.recharge_type,
    recordStatus: record.record_status,
    submittedAt: record.submitted_at,
    unitCount: Number(record.unit_count),
    balanceBeforeCount: record.balance_before_count === null || record.balance_before_count === undefined ? null : Number(record.balance_before_count),
    balanceAfterCount: record.balance_after_count === null || record.balance_after_count === undefined ? null : Number(record.balance_after_count),
    customer: { customerCode: customer.customer_code, customerName: customer.customer_name },
    product: { productId: String(product.id), productCode: product.product_code, productName: product.product_name },
    teacher: teacher ? { teacherId: String(teacher.id), teacherCode: teacher.teacher_code, teacherName: teacher.teacher_name } : null
  };
}

async function requireVerificationSubmissionSchema() {
  const rows = await executeSql(
    `SELECT EXISTS (
       SELECT 1
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'verification_records'
          AND column_name = 'idempotency_key'
     ) AS has_idempotency_key,
     TO_REGPROCEDURE(
       'public.create_verification_with_face_photo(character varying,bigint,bigint,bigint,bigint,character varying,bigint,text,text,character varying,character varying,character varying)'
     ) IS NOT NULL AS has_photo_create_function,
     COALESCE(POSITION(
       'PROFILE_BOUND' IN PG_GET_FUNCTIONDEF(TO_REGPROCEDURE(
         'public.create_verification_with_face_photo(character varying,bigint,bigint,bigint,bigint,character varying,bigint,text,text,character varying,character varying,character varying)'
       ))
     ), 0) > 0 AS has_profile_snapshot,
     TO_REGCLASS('public.device_signal_outbox') IS NOT NULL AS has_device_signal_outbox,
     COALESCE(POSITION(
       'device_signal_outbox' IN PG_GET_FUNCTIONDEF(TO_REGPROCEDURE(
         'public.create_verification_with_face_photo(character varying,bigint,bigint,bigint,bigint,character varying,bigint,text,text,character varying,character varying,character varying)'
       ))
     ), 0) > 0 AS has_atomic_device_signal`
  );
  if (!databaseBoolean(rows?.[0]?.has_idempotency_key)
      || !databaseBoolean(rows?.[0]?.has_photo_create_function)
      || !databaseBoolean(rows?.[0]?.has_profile_snapshot)
      || !databaseBoolean(rows?.[0]?.has_device_signal_outbox)
      || !databaseBoolean(rows?.[0]?.has_atomic_device_signal)) {
    fail("核销单数据库缺少照片证据或设备信号结构，请先依次执行迁移 026、037、038 和 041。", "DATABASE_SCHEMA_MISSING");
  }
}

async function requireTeacherExperienceFaceSubjectSchema() {
  const rows = await executeSql(
    `SELECT EXISTS (
              SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'teachers'
                 AND column_name = 'profile_photo_file_id'
            ) AS teacher_photo_column,
            EXISTS (
              SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'verification_photo_drafts'
                 AND column_name = 'face_subject_type'
            ) AS draft_subject_column,
            EXISTS (
              SELECT 1 FROM information_schema.columns
               WHERE table_schema = 'public' AND table_name = 'verification_records'
                 AND column_name = 'face_subject_type'
            ) AS record_subject_column,
            TO_REGPROCEDURE(
              'public.create_experience_verification_with_teacher_face_photo(bigint,bigint,bigint,bigint,bigint,text,character varying,character varying,character varying)'
            ) IS NOT NULL AS create_function`
  );
  const schema = rows?.[0] || {};
  if (!databaseBoolean(schema.teacher_photo_column)
      || !databaseBoolean(schema.draft_subject_column)
      || !databaseBoolean(schema.record_subject_column)
      || !databaseBoolean(schema.create_function)) {
    fail("老师体验人脸证据结构尚未启用，请先执行迁移 049。", "DATABASE_SCHEMA_MISSING");
  }
}

async function createVerificationApplication(event) {
  const caller = await activeBusinessCaller(event);
  const customerCode = String(event.customerCode || "").trim();
  if (!customerCode || customerCode.length > 96) fail("必须先确认本门店的活跃客户。", "CUSTOMER_REQUIRED");
  const productId = positiveDatabaseId(event.productId, "项目");
  const requestedTeacherId = String(event.teacherId || "").trim();
  if (caller.role === "teacher" && requestedTeacherId && requestedTeacherId !== String(caller.teacherId)) {
    fail("老师账号只能把核销绑定到本人。", "FORBIDDEN");
  }
  const teacherId = positiveDatabaseId(caller.role === "teacher" ? caller.teacherId : requestedTeacherId, "老师");
  const verificationType = String(event.verificationType || "").trim().toUpperCase();
  if (!["NORMAL", "EXPERIENCE"].includes(verificationType)) {
    fail("仅支持正常核销或体验核销。", "INVALID_VERIFICATION_TYPE");
  }
  const experienceVerification = verificationType === "EXPERIENCE";
  const message = String(event.message || "").trim();
  if (message.length > 500) fail("门店留言不能超过 500 个字符。", "MESSAGE_TOO_LONG");
  const faceRequestId = String(event.faceRequestId || "").trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(faceRequestId)) {
    fail("必须先完成现场拍照及所选客户的 1:1 人脸验证。", "FACE_VERIFICATION_REQUIRED");
  }
  const faceEvidenceToken = String(event.faceEvidenceToken || "").trim();
  if (!/^[0-9a-f]{48}$/.test(faceEvidenceToken)) {
    fail("现场人脸照片尚未安全保存，请重新拍照验证。", "FACE_PHOTO_EVIDENCE_REQUIRED");
  }
  const idempotencyKey = rechargeSubmissionKey(event.clientRequestId);
  await requireVerificationSubmissionSchema();
  if (experienceVerification) {
    await requireTeacherExperienceQuotaLifecycleSchema();
    await requireTeacherExperienceFaceSubjectSchema();
  }

  const customers = await executeSql(
    `SELECT id, customer_code, customer_name
       FROM public.customers
      WHERE customer_code = ${sqlText(customerCode)}
        AND created_store_id = ${caller.storeId}
        AND customer_status = 'ACTIVE'
      LIMIT 1`
  );
  const customer = customers[0];
  if (!customer) fail("未找到本门店已确认的活跃客户。", "CUSTOMER_NOT_FOUND");

  const products = await executeSql(
    `SELECT id, product_code, product_name
       FROM public.products
      WHERE id = ${sqlText(productId)}::bigint
        AND product_status = 'ACTIVE'
      LIMIT 1`
  );
  const product = products[0];
  if (!product) fail("所选项目不存在或已经封存，请重新选择。", "PRODUCT_NOT_ACTIVE");

  const teachers = await executeSql(
    `SELECT t.id, t.teacher_code, t.teacher_name, t.face_person_id,
            t.face_enrollment_status, t.profile_photo_file_id
       FROM public.teachers t
       JOIN public.staff_accounts a ON a.id = t.staff_account_id
      WHERE t.id = ${sqlText(teacherId)}::bigint
        AND t.teacher_status = 'ACTIVE'
        AND a.role_code = 'teacher'
        AND a.account_status = 'ACTIVE'
      LIMIT 1`
  );
  const teacher = teachers[0];
  if (!teacher) fail("所选老师不存在或已经封存，请重新选择。", "TEACHER_NOT_ACTIVE");
  if (experienceVerification && (
    teacher.face_enrollment_status !== "ENROLLED"
    || !String(teacher.face_person_id || "").trim()
    || !String(teacher.profile_photo_file_id || "").trim()
  )) {
    fail("该老师尚未补齐可用的人脸登记照，不能办理体验核销。", "TEACHER_FACE_REQUIRED_FOR_EXPERIENCE");
  }

  const initialStatus = "APPROVED";
  const supplementNote = "";
  let rows;
  try {
    const createSql = experienceVerification
      ? `SELECT * FROM public.create_experience_verification_with_teacher_face_photo(
           ${caller.storeId}::bigint, ${sqlText(teacherId)}::bigint,
           ${sqlText(customer.id)}::bigint, ${sqlText(productId)}::bigint,
           ${caller.staffId}::bigint, ${sqlText(message)}::text,
           ${sqlText(faceRequestId)}::varchar, ${sqlText(faceEvidenceToken)}::varchar,
           ${sqlText(idempotencyKey)}::varchar
         )`
      : `SELECT * FROM public.create_verification_with_face_photo(
           ${sqlText(verificationType)}::varchar, ${caller.storeId}::bigint,
           ${sqlText(teacherId)}::bigint, ${sqlText(customer.id)}::bigint,
           ${sqlText(productId)}::bigint, ${sqlText(initialStatus)}::varchar,
           ${caller.staffId}::bigint, ${sqlText(message)}::text,
           ${sqlText(supplementNote)}::text, ${sqlText(faceRequestId)}::varchar,
           ${sqlText(faceEvidenceToken)}::varchar, ${sqlText(idempotencyKey)}::varchar
         )`;
    rows = await executeSql(createSql);
  } catch (error) {
    const detail = String(error?.message || "").toLowerCase();
    if (detail.includes("insufficient purchased units")) {
      fail("该客户所选项目的剩余次数不足，不能提交正常核销。", "INSUFFICIENT_BALANCE");
    }
    if (detail.includes("insufficient teacher experience quota")) {
      fail("该老师该项目的体验次数不足，不能提交体验核销。", "TEACHER_EXPERIENCE_QUOTA_EXHAUSTED");
    }
    if (detail.includes("no configured experience quota") || detail.includes("no active configured experience quota")) {
      fail("该老师尚未配置这个项目的体验次数，不能提交体验核销。", "TEACHER_EXPERIENCE_QUOTA_NOT_CONFIGURED");
    }
    if (detail.includes("face photo evidence")) {
      fail("现场人脸照片已过期、已使用或不属于当前提交，请重新拍照验证。", "FACE_PHOTO_EVIDENCE_INVALID");
    }
    if (detail.includes("teacher_face_required_for_experience")
        || detail.includes("teacher retained face profile")) {
      fail("该老师尚未补齐可用的人脸登记照，不能办理体验核销。", "TEACHER_FACE_REQUIRED_FOR_EXPERIENCE");
    }
    if (detail.includes("idempotency key belongs")) {
      fail("该防重复提交编号已经用于另一张核销单，请刷新页面后重新提交。", "IDEMPOTENCY_CONFLICT");
    }
    throw error;
  }
  const record = rows[0];
  if (!record) fail("核销申请未能写入数据库，请稍后重试。", "VERIFICATION_CREATE_FAILED");

  const sameRequest = String(record.verification_type) === verificationType
    && String(record.store_id) === String(caller.storeId)
    && String(record.teacher_id) === String(teacherId)
    && String(record.customer_id) === String(customer.id)
    && String(record.product_id) === String(productId)
    && String(record.message || "") === message
    && String(record.face_request_id || "") === faceRequestId;
  if (!sameRequest) {
    fail("该防重复提交编号已经用于另一张核销单，请刷新页面后重新提交。", "IDEMPOTENCY_CONFLICT");
  }

  const signalRows = await executeSql(
    `SELECT id, signal_type, signal_status, created_at
       FROM public.device_signal_outbox
      WHERE verification_id = ${sqlText(record.id)}::bigint
      LIMIT 1`
  );
  const signal = signalRows[0];
  if (!signal) {
    fail("核销单已创建，但设备开启信号没有进入虚拟端口队列，请立即联系管理员。", "DEVICE_SIGNAL_NOT_QUEUED");
  }

  let experienceQuota = null;
  if (experienceVerification) {
    const quotaRows = await executeSql(
      `SELECT q.id AS quota_id, q.monthly_allowance, q.quota_month,
              q.available_count, q.used_count, q.manual_recharge_count, q.monthly_reset_at,
              u.available_before_count, u.available_after_count, u.consumed_at
         FROM public.teacher_experience_quota_usages u
         JOIN public.teacher_product_experience_quotas q ON q.id = u.quota_id
        WHERE u.verification_id = ${sqlText(record.id)}::bigint
        LIMIT 1`
    );
    const quota = quotaRows[0];
    if (!quota) fail("体验核销缺少老师体验额度扣减记录，请立即联系管理员。", "TEACHER_EXPERIENCE_QUOTA_AUDIT_MISSING");
    experienceQuota = {
      quotaId: String(quota.quota_id),
      monthlyAllowance: Number(quota.monthly_allowance || 0),
      quotaMonth: quota.quota_month,
      availableCount: Number(quota.available_count || 0),
      usedCount: Number(quota.used_count || 0),
      manualRechargeCount: Number(quota.manual_recharge_count || 0),
      monthlyResetAt: quota.monthly_reset_at,
      availableBeforeCount: Number(quota.available_before_count || 0),
      availableAfterCount: Number(quota.available_after_count || 0),
      consumedAt: quota.consumed_at
    };
  }

  return {
    ok: true,
    createdNow: databaseBoolean(record.created_now),
    verificationId: String(record.id),
    verificationCode: record.verification_code,
    verificationType: record.verification_type,
    recordStatus: record.record_status,
    submittedAt: record.submitted_at,
    unitCount: Number(record.unit_count || 1),
    customer: { customerCode: customer.customer_code, customerName: customer.customer_name },
    product: { productId: String(product.id), productCode: product.product_code, productName: product.product_name },
    teacher: { teacherId: String(teacher.id), teacherCode: teacher.teacher_code, teacherName: teacher.teacher_name },
    experienceQuota,
    deviceSignal: {
      id: String(signal.id),
      port: "VIRTUAL_DEVICE_START",
      type: signal.signal_type,
      status: signal.signal_status,
      queuedAt: signal.created_at
    }
  };
}

async function getCustomerProductBalances(event) {
  const caller = await activeBusinessCaller(event);
  const customerCode = String(event.customerCode || "").trim();
  if (!customerCode || customerCode.length > 96) fail("必须提供已选择客户的有效编号。", "CUSTOMER_REQUIRED");

  const customers = await executeSql(
    `SELECT id, customer_code
       FROM public.customers
      WHERE customer_code = ${sqlText(customerCode)}
        AND created_store_id = ${caller.storeId}
        AND customer_status = 'ACTIVE'
      LIMIT 1`
  );
  const customer = customers[0];
  if (!customer) fail("未找到本门店已选择的活跃客户。", "CUSTOMER_NOT_FOUND");

  const rows = await executeSql(
    `SELECT p.id AS product_id, p.product_code, p.product_name,
            b.total_recharge_count, b.total_verification_count, b.remaining_count,
            b.updated_at
       FROM public.customer_product_balances b
       JOIN public.products p ON p.id = b.product_id
      WHERE b.customer_id = ${sqlText(customer.id)}::bigint
        AND p.product_status = 'ACTIVE'
      ORDER BY p.product_name, p.product_code`
  );

  return {
    ok: true,
    customerCode: customer.customer_code,
    balances: rows.map((row) => ({
      productId: String(row.product_id),
      productCode: row.product_code,
      productName: row.product_name,
      purchasedCount: Number(row.total_recharge_count || 0),
      effectiveVerificationCount: Number(row.total_verification_count || 0),
      remainingCount: Number(row.remaining_count || 0),
      updatedAt: row.updated_at
    }))
  };
}

function teacherWorkspaceOptions(event = {}) {
  const recordType = String(event.recordType || "").trim().toUpperCase();
  if (recordType && !["RECHARGE", "VERIFICATION"].includes(recordType)) {
    fail("老师工单类型无效。", "BAD_REQUEST");
  }
  const requestedLimit = Number(event.limit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100)
    : 50;
  const cursorSubmittedAt = scopedQueryCursorTimestamp(event.cursorSubmittedAt, "老师工单游标时间");
  const cursorIdText = String(event.cursorId || "").trim();
  if (Boolean(cursorSubmittedAt) !== Boolean(cursorIdText)) fail("老师工单游标不完整。", "BAD_REQUEST");
  if (cursorSubmittedAt && !recordType) fail("老师工单游标必须指定记录类型。", "BAD_REQUEST");
  const recordIdText = String(event.recordId || "").trim();
  return {
    recordType,
    limit,
    cursorSubmittedAt,
    cursorId: cursorIdText ? businessQueryDatabaseId(cursorIdText, "老师工单游标编号") : "",
    recordId: recordIdText ? businessQueryDatabaseId(recordIdText, "老师工单编号") : ""
  };
}

function teacherOrderRows(rows, recordType, teacher = {}) {
  return rows.map((row) => ({
    id: String(row.id),
    recordType,
    recordCode: String(row.record_code || ""),
    originalType: String(row.original_type || ""),
    unitCount: Number(row.unit_count || (recordType === "VERIFICATION" ? 1 : 0)),
    balanceBeforeCount: row.balance_before_count === null || row.balance_before_count === undefined ? null : Number(row.balance_before_count),
    balanceAfterCount: row.balance_after_count === null || row.balance_after_count === undefined ? null : Number(row.balance_after_count),
    recordStatus: String(row.record_status || ""),
    voidRequestStatus: String(row.void_request_status || "NONE"),
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    message: String(row.message || ""),
    supplementNote: String(row.supplement_note || ""),
    reviewNote: String(row.review_note || ""),
    hasFaceRequest: Boolean(row.face_request_id),
    teacherCode: String(teacher.teacherCode || ""),
    teacherName: String(teacher.teacherName || ""),
    storeId: String(row.store_id || ""),
    storeCode: String(row.store_code || ""),
    storeName: String(row.store_name || ""),
    storeProvince: String(row.store_province || ""),
    storeCity: String(row.store_city || ""),
    storeDistrict: String(row.store_district || ""),
    storeAddressDetail: String(row.store_address_detail || ""),
    customerCode: String(row.customer_code || ""),
    customerName: String(row.customer_name || ""),
    productCode: String(row.product_code || ""),
    productName: String(row.product_name || "")
  }));
}

function teacherOrderPage(rows, recordType, limit, teacher) {
  const hasMore = rows.length > limit;
  const visible = rows.slice(0, limit);
  const last = visible[visible.length - 1];
  return {
    records: teacherOrderRows(visible, recordType, teacher),
    page: {
      hasMore,
      nextCursor: hasMore && last
        ? { submittedAt: String(last.cursor_submitted_at || ""), id: String(last.id) }
        : null
    }
  };
}

async function getTeacherWorkspace(event = {}) {
  const caller = await activeTeacherCaller();
  const options = teacherWorkspaceOptions(event);
  const profile = {
    teacherId: caller.teacherId,
    teacherCode: caller.teacherCode,
    teacherName: caller.teacherName
  };
  const query = async (recordType) => {
    const alias = recordType === "RECHARGE" ? "r" : "v";
    const table = recordType === "RECHARGE" ? "recharge_records" : "verification_records";
    const codeColumn = recordType === "RECHARGE" ? "recharge_code" : "verification_code";
    const typeColumn = recordType === "RECHARGE" ? "recharge_type" : "verification_type";
    const cursorClause = options.cursorSubmittedAt && options.recordType === recordType
      ? `AND (${alias}.submitted_at, ${alias}.id) < (${sqlText(options.cursorSubmittedAt)}::timestamptz, ${options.cursorId}::bigint)`
      : "";
    const recordClause = options.recordId && options.recordType === recordType
      ? `AND ${alias}.id = ${options.recordId}::bigint`
      : "";
    return executeSql(
      `SELECT ${alias}.id, ${alias}.${codeColumn} AS record_code,
              ${alias}.${typeColumn} AS original_type, ${alias}.unit_count,
              ${recordType === "RECHARGE" ? `${alias}.balance_before_count, ${alias}.balance_after_count` : "NULL::integer AS balance_before_count, NULL::integer AS balance_after_count"},
              ${alias}.record_status, ${alias}.void_request_status,
              ${alias}.submitted_at, ${alias}.reviewed_at,
              ${alias}.message,
              ${recordType === "VERIFICATION" ? `${alias}.supplement_note` : "NULL::text AS supplement_note"},
              ${alias}.review_note,
              ${recordType === "VERIFICATION" ? `${alias}.face_request_id` : "NULL::text AS face_request_id"},
              TO_CHAR(${alias}.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_submitted_at,
              s.id AS store_id, s.store_code, s.store_name,
              s.province AS store_province, s.city AS store_city,
              s.district AS store_district, s.address_detail AS store_address_detail,
              c.customer_code, c.customer_name,
              p.product_code, p.product_name
         FROM public.${table} ${alias}
         JOIN public.stores s ON s.id = ${alias}.store_id
         JOIN public.customers c ON c.id = ${alias}.customer_id
         JOIN public.products p ON p.id = ${alias}.product_id
        WHERE ${alias}.teacher_id = ${sqlText(caller.teacherId)}::bigint
          ${recordClause}
          ${cursorClause}
        ORDER BY ${alias}.submitted_at DESC, ${alias}.id DESC
        LIMIT ${options.recordId ? 1 : options.limit + 1}`
    );
  };

  if (options.recordId) {
    if (!options.recordType) fail("读取老师工单详情时必须指定工单类型。", "BAD_REQUEST");
    const rows = await query(options.recordType);
    const order = teacherOrderRows(rows, options.recordType, profile)[0];
    if (!order) fail("未找到当前老师本人绑定的工单。", "ORDER_NOT_FOUND");
    return { ok: true, profile, record: order };
  }
  if (options.recordType) {
    const page = teacherOrderPage(await query(options.recordType), options.recordType, options.limit, profile);
    return { ok: true, profile, page: { records: page.records, ...page.page } };
  }
  const [rechargeRows, verificationRows] = await Promise.all([query("RECHARGE"), query("VERIFICATION")]);
  const rechargePage = teacherOrderPage(rechargeRows, "RECHARGE", options.limit, profile);
  const verificationPage = teacherOrderPage(verificationRows, "VERIFICATION", options.limit, profile);
  return {
    ok: true,
    profile,
    recharges: { records: rechargePage.records, ...rechargePage.page },
    verifications: { records: verificationPage.records, ...verificationPage.page }
  };
}

async function deleteFacePerson(api, groupId, personId) {
  if (!personId) return;
  try { await api.DeletePerson({ GroupId: groupId, PersonId: personId }); } catch (error) { console.warn("Face person cleanup failed", error?.message || error); }
}

async function findCustomerByFacePerson(storeId, personId) {
  const rows = await executeSql(
    `SELECT id, customer_code, profile_photo_file_id, face_person_id,
            customer_status, customer_process_status,
            total_recharge_count, total_verification_count, total_experience_count, created_at
       FROM public.customers
      WHERE created_store_id = ${storeId}
        AND face_person_id = ${sqlText(personId)}
      LIMIT 1`
  );
  return rows[0] || null;
}

async function findCustomerByCode(customerCodeValue) {
  const rows = await executeSql(
    `SELECT id, customer_code, customer_name, birth_date, notes,
            profile_photo_file_id, face_person_id, created_store_id,
            customer_status, customer_process_status,
            total_recharge_count, total_verification_count, total_experience_count, created_at
       FROM public.customers
      WHERE customer_code = ${sqlText(customerCodeValue)}
      LIMIT 1`
  );
  return rows[0] || null;
}

async function deleteCustomerRecord(storeId, personId) {
  if (!personId) return;
  try {
    await executeSql(
      `DELETE FROM public.customers
        WHERE created_store_id = ${storeId}
          AND face_person_id = ${sqlText(personId)}`
    );
  } catch (error) {
    console.warn("Customer database cleanup failed", error?.message || error);
  }
}

async function registerCustomer(event) {
  const caller = await activeCustomerCreationCaller(event);
  const name = String(event.customerName || "").trim();
  const birthDate = validDate(event.birthDate);
  const notes = String(event.notes || "").trim();
  const clientRequestId = optionalClientRequestId(event.clientRequestId);
  const consent = event.consent === true;
  if (!name || name.length > 64) fail("Customer name is required and must not exceed 64 characters.");
  if (!consent) fail("Explicit customer consent is required before collecting a face photo.", "CONSENT_REQUIRED");
  if (notes.length > 500) fail("Notes must not exceed 500 characters.");

  let personId = customerCode(caller.storeId, clientRequestId);
  if (clientRequestId) {
    const existing = await findCustomerByCode(personId);
    if (existing) {
      const sameRequestData = String(existing.created_store_id) === String(caller.storeId)
        && String(existing.customer_name) === name
        && String(existing.birth_date || "").slice(0, 10) === birthDate
        && String(existing.notes || "") === notes;
      if (!sameRequestData) fail("同一个 clientRequestId 已用于另一份客户资料，请重新发起建档。", "IDEMPOTENCY_CONFLICT");
      return {
        ok: true,
        idempotentReplay: true,
        customer: {
          id: String(existing.id),
          customerCode: existing.customer_code,
          customerName: existing.customer_name,
          birthDate: String(existing.birth_date || "").slice(0, 10),
          notes: existing.notes || "",
          photoFileId: existing.profile_photo_file_id,
          facePersonId: existing.face_person_id,
          faceId: "",
          customerStatus: existing.customer_status,
          customerProcessStatus: existing.customer_process_status,
          totalRechargeCount: Number(existing.total_recharge_count || 0),
          totalVerificationCount: Number(existing.total_verification_count || 0),
          totalExperienceCount: Number(existing.total_experience_count || 0),
          storeId: String(existing.created_store_id),
          captureQuality: null,
          liveness: null,
          createdAt: existing.created_at
        }
      };
    }
  }

  const { base64, buffer } = cleanImage(event.imageBase64);
  const groupId = required("FACE_GROUP_ID");
  const api = faceClient();
  let storedPhoto = null;
  let personCreated = false;
  try {
    const quality = await inspectFaceImage(api, base64);
    const liveness = await inspectLiveness(api, base64);
    const faceResult = await api.CreatePerson({
      GroupId: groupId,
      PersonId: personId,
      PersonName: name,
      Image: base64,
      // One natural person may intentionally own multiple independent customer
      // profiles. Each profile gets its own customer code and PersonId. The
      // selected profile is verified later with a 1:1 face comparison, so a
      // group-wide duplicate-face rejection must not be used here.
      UniquePersonControl: 0,
      QualityControl: 3,
      NeedRotateDetection: 0
    });
    personCreated = true;
    if (!faceResult?.FaceId) fail("人脸服务没有返回有效 FaceId，客户档案未创建。", "FACE_ENROLLMENT_INCOMPLETE");
    storedPhoto = await uploadCustomerPhoto(caller.storeId, personId, buffer);
    const fileID = storedPhoto.reference;
    const saved = await executeSql(
      `INSERT INTO public.customers
        (customer_code, customer_name, birth_date, notes, profile_photo_file_id,
         face_person_id, customer_status, customer_process_status,
         total_recharge_count, total_verification_count, total_experience_count, created_store_id)
       VALUES
        (${sqlText(personId)}, ${sqlText(name)}, ${sqlText(birthDate)}::date, ${sqlText(notes)}, ${sqlText(fileID)},
         ${sqlText(personId)}, 'ACTIVE', 'INFORMATION_ONLY', 0, 0, 0, ${caller.storeId})
       RETURNING id, customer_code, profile_photo_file_id, face_person_id,
                 customer_status, customer_process_status,
                 total_recharge_count, total_verification_count, total_experience_count, created_at`
    );
    // CloudBase can successfully execute a writable statement without exposing
    // the rows produced by RETURNING. Read the persisted row back before
    // treating an empty write result as a failure.
    const customer = saved[0] || await findCustomerByFacePerson(caller.storeId, personId);
    if (!customer) fail("Customer record was not returned after creation.", "DATABASE_ERROR");
    return {
      ok: true,
      customer: {
        id: String(customer.id),
        customerCode: customer.customer_code,
        customerName: name,
        birthDate,
        notes,
        photoFileId: customer.profile_photo_file_id,
        facePersonId: customer.face_person_id,
        faceId: faceResult.FaceId || "",
        customerStatus: customer.customer_status,
        customerProcessStatus: customer.customer_process_status,
        totalRechargeCount: Number(customer.total_recharge_count || 0),
        totalVerificationCount: Number(customer.total_verification_count || 0),
        totalExperienceCount: Number(customer.total_experience_count || 0),
        storeId: String(caller.storeId),
        captureQuality: quality,
        liveness,
        createdAt: customer.created_at
      }
    };
  } catch (error) {
    await deleteCustomerRecord(caller.storeId, personId);
    await deleteUploadedFile(storedPhoto);
    if (personCreated) await deleteFacePerson(api, groupId, personId);
    throw error;
  }
}

async function validateCapture(event) {
  await activeCustomerCreationCaller(event);
  const { base64 } = cleanImage(event.imageBase64);
  const api = faceClient();
  const quality = await inspectFaceImage(api, base64);
  const liveness = await inspectLiveness(api, base64);
  return { ok: true, accepted: true, quality, liveness };
}

async function validateTeacherFaceEnrollmentCapture(event) {
  await activeHqTeacherFaceEnrollmentCaller();
  const { base64 } = cleanImage(event.imageBase64);
  const api = faceClient();
  const quality = await inspectFaceImage(api, base64);
  const liveness = await inspectLiveness(api, base64);
  return { ok: true, accepted: true, quality, liveness };
}

async function searchCustomer(event) {
  const caller = await activeStoreCaller();
  const { base64 } = cleanImage(event.imageBase64);
  const api = faceClient();
  const quality = await inspectFaceImage(api, base64);
  const liveness = await inspectLiveness(api, base64);
  const settings = faceSettings();
  const result = await api.SearchPersons({
    Image: base64,
    GroupIds: [required("FACE_GROUP_ID")],
    MaxFaceNum: 1,
    MinFaceSize: 80,
    MaxPersonNum: 10,
    QualityControl: 3,
    FaceMatchThreshold: 0,
    NeedPersonInfo: 0,
    NeedRotateDetection: 0
  });
  const searchResult = result?.Results?.[0];
  if (Number(searchResult?.RetCode || 0) === -1601) fail("当前照片不符合人脸搜索质量要求，请重新拍照。", "FACE_QUALITY_LOW");

  const storePrefix = `C${caller.storeId}-`;
  const candidates = (searchResult?.Candidates || [])
    .filter((candidate) => String(candidate?.PersonId || "").startsWith(storePrefix))
    .sort((left, right) => Number(right?.Score || 0) - Number(left?.Score || 0));
  const best = candidates[0];
  const second = candidates[1];
  const bestScore = Number(best?.Score || 0);
  const secondScore = Number(second?.Score || 0);
  if (!best || bestScore < settings.matchThreshold) {
    return { ok: true, matched: false, reason: "NO_MATCH", message: "未匹配到本门店已建档客户，请核对客户资料或重新拍照。", quality, liveness };
  }
  if (second && bestScore - secondScore < settings.matchMargin) {
    return { ok: true, matched: false, reason: "AMBIGUOUS", message: "识别结果过于接近，不能自动确认客户，请人工核对后重新拍照。", quality, liveness };
  }

  const rows = await executeSql(
    `SELECT id, customer_code, customer_name, birth_date, notes, customer_status, customer_process_status,
            total_recharge_count, total_verification_count, total_experience_count, created_store_id
       FROM public.customers
      WHERE face_person_id = ${sqlText(best.PersonId)}
        AND created_store_id = ${caller.storeId}
        AND customer_status = 'ACTIVE'
      LIMIT 1`
  );
  const customer = rows[0];
  if (!customer) return { ok: true, matched: false, reason: "PROFILE_UNAVAILABLE", message: "人脸已识别，但对应客户档案不存在或已封存。", quality, liveness };
  return {
    ok: true,
    matched: true,
    customerId: String(customer.id),
    customerCode: customer.customer_code,
    customerName: customer.customer_name,
    birthDate: customer.birth_date,
    notes: customer.notes || "",
    customerStatus: customer.customer_status,
    customerProcessStatus: customer.customer_process_status,
    totalRechargeCount: Number(customer.total_recharge_count || 0),
    totalVerificationCount: Number(customer.total_verification_count || 0),
    totalExperienceCount: Number(customer.total_experience_count || 0),
    storeId: String(customer.created_store_id),
    score: rounded(bestScore),
    runnerUpScore: second ? rounded(secondScore) : null,
    quality,
    liveness
  };
}

async function verifyCustomerFace(event) {
  const caller = await activeBusinessCaller(event);
  await requireVerificationSubmissionSchema();
  await requireTeacherExperienceFaceSubjectSchema();
  const customerCode = String(event.customerCode || "").trim();
  if (!customerCode || customerCode.length > 96) fail("必须提供已选择客户的有效编号。", "CUSTOMER_REQUIRED");

  // 客户编号只能用于定位本门店已经确认的客户。真正送给腾讯云的 PersonId
  // 始终由服务端从数据库读取，不能信任浏览器传入的人脸 ID。
  const rows = await executeSql(
    `SELECT id, customer_code, customer_name, face_person_id, profile_photo_file_id
       FROM public.customers
      WHERE customer_code = ${sqlText(customerCode)}
        AND created_store_id = ${caller.storeId}
        AND customer_status = 'ACTIVE'
      LIMIT 1`
  );
  const customer = rows[0];
  if (!customer) fail("未找到本门店已选择的活跃客户。", "CUSTOMER_NOT_FOUND");
  if (!customer.face_person_id || !customer.profile_photo_file_id) {
    fail("该客户缺少有效建档照片或人脸档案，暂时不能进行核销。", "FACE_PROFILE_MISSING");
  }

  const original = cleanVerificationJpeg(event.imageBase64, "现场人脸照片", MAX_VERIFICATION_IMAGE_BYTES);
  const thumbnail = cleanVerificationJpeg(event.thumbnailBase64, "现场人脸缩略图", MAX_THUMBNAIL_BYTES);
  const dimensions = verificationPhotoDimensions(event);
  const { base64 } = original;
  const api = faceClient();
  const quality = await inspectFaceImage(api, base64);
  const liveness = await inspectLiveness(api, base64);
  const settings = faceSettings();
  const result = await api.VerifyFace({
    PersonId: String(customer.face_person_id),
    Image: base64,
    QualityControl: 3,
    NeedRotateDetection: 0
  });
  const score = Number(result?.Score || 0);
  const matched = result?.IsMatch === true && score >= settings.verifyThreshold;

  let faceEvidenceToken = "";
  if (matched) {
    faceEvidenceToken = crypto.randomBytes(24).toString("hex");
    const objectPrefix = `face-evidence/${caller.storeId}/${caller.staffId}/${faceEvidenceToken}`;
    let uploadedOriginal = null;
    let uploadedThumbnail = null;
    try {
      const uploadResults = await Promise.allSettled([
        uploadVerificationPhotoObject(`${objectPrefix}/original.jpg`, original.buffer),
        uploadVerificationPhotoObject(`${objectPrefix}/thumbnail.jpg`, thumbnail.buffer)
      ]);
      if (uploadResults[0].status === "fulfilled") uploadedOriginal = uploadResults[0].value;
      if (uploadResults[1].status === "fulfilled") uploadedThumbnail = uploadResults[1].value;
      const uploadFailure = uploadResults.find((item) => item.status === "rejected");
      if (uploadFailure) throw uploadFailure.reason;
      const evidenceTtlMinutes = Math.trunc(numberSetting("VERIFICATION_FACE_EVIDENCE_TTL_MINUTES", 30, 5, 120));
      await executeSql(
        `INSERT INTO public.verification_photo_drafts
          (evidence_token, store_id, customer_id, submitted_by_account_id,
           face_subject_type, face_subject_teacher_id,
           face_request_id, original_object_ref, thumbnail_object_ref,
           original_bytes, thumbnail_bytes, image_width, image_height,
           sha256, expires_at)
         VALUES
           (${sqlText(faceEvidenceToken)}, ${caller.storeId}, ${sqlText(customer.id)}::bigint,
            ${caller.staffId}, 'CUSTOMER', NULL, ${sqlText(result?.RequestId || "")},
           ${sqlText(uploadedOriginal.reference)}, ${sqlText(uploadedThumbnail.reference)},
           ${original.buffer.length}, ${thumbnail.buffer.length},
           ${dimensions.width}, ${dimensions.height},
           ${sqlText(crypto.createHash("sha256").update(original.buffer).digest("hex"))},
           NOW() + (${evidenceTtlMinutes} * INTERVAL '1 minute'))`
      );
    } catch (error) {
      await Promise.all([
        deleteVerificationPhotoObject(uploadedOriginal?.reference),
        deleteVerificationPhotoObject(uploadedThumbnail?.reference)
      ]);
      throw error;
    }
  }

  return {
    ok: true,
    matched,
    customerCode: customer.customer_code,
    customerName: customer.customer_name,
    score: rounded(score),
    threshold: settings.verifyThreshold,
    quality,
    liveness,
    requestId: result?.RequestId || "",
    faceEvidenceToken,
    message: matched
      ? "所选客户的 1:1 人脸验证已通过。"
      : "现场人脸与所选客户的建档人脸不一致，请核对客户或重新拍照。"
  };
}

async function verifyTeacherExperienceFace(event) {
  const caller = await activeBusinessCaller(event);
  await requireVerificationSubmissionSchema();
  await requireTeacherExperienceFaceSubjectSchema();
  const customerCode = String(event.customerCode || "").trim();
  if (!customerCode || customerCode.length > 96) fail("必须提供已选择客户的有效编号。", "CUSTOMER_REQUIRED");
  const requestedTeacherId = String(event.teacherId || "").trim();
  if (caller.role === "teacher" && requestedTeacherId && requestedTeacherId !== String(caller.teacherId)) {
    fail("老师账号只能使用本人人脸办理体验核销。", "FORBIDDEN");
  }
  const teacherId = positiveDatabaseId(
    caller.role === "teacher" ? caller.teacherId : requestedTeacherId,
    "老师"
  );

  const customerRows = await executeSql(
    `SELECT id, customer_code, customer_name
       FROM public.customers
      WHERE customer_code = ${sqlText(customerCode)}
        AND created_store_id = ${caller.storeId}
        AND customer_status = 'ACTIVE'
      LIMIT 1`
  );
  const customer = customerRows[0];
  if (!customer) fail("未找到本门店已选择的活跃客户。", "CUSTOMER_NOT_FOUND");

  const teacherRows = await executeSql(
    `SELECT t.id, t.teacher_code, t.teacher_name, t.face_person_id,
            t.face_enrollment_status, t.profile_photo_file_id
       FROM public.teachers t
       JOIN public.staff_accounts a ON a.id = t.staff_account_id
      WHERE t.id = ${sqlText(teacherId)}::bigint
        AND t.teacher_status = 'ACTIVE'
        AND a.role_code = 'teacher'
        AND a.account_status = 'ACTIVE'
      LIMIT 1`
  );
  const teacher = teacherRows[0];
  if (!teacher) fail("所选老师不存在或已经封存。", "TEACHER_NOT_ACTIVE");
  if (teacher.face_enrollment_status !== "ENROLLED"
      || !String(teacher.face_person_id || "").trim()
      || !String(teacher.profile_photo_file_id || "").trim()) {
    fail("该老师尚未补齐可用的人脸登记照，不能办理体验核销。", "TEACHER_FACE_REQUIRED_FOR_EXPERIENCE");
  }

  const original = cleanVerificationJpeg(event.imageBase64, "老师现场人脸照片", MAX_VERIFICATION_IMAGE_BYTES);
  const thumbnail = cleanVerificationJpeg(event.thumbnailBase64, "老师现场人脸缩略图", MAX_THUMBNAIL_BYTES);
  const dimensions = verificationPhotoDimensions(event);
  const api = faceClient();
  const quality = await inspectFaceImage(api, original.base64);
  const liveness = await inspectLiveness(api, original.base64);
  const settings = faceSettings();
  const result = await api.VerifyFace({
    PersonId: String(teacher.face_person_id),
    Image: original.base64,
    QualityControl: 3,
    NeedRotateDetection: 0
  });
  const score = Number(result?.Score || 0);
  const matched = result?.IsMatch === true && score >= settings.verifyThreshold;

  let faceEvidenceToken = "";
  if (matched) {
    faceEvidenceToken = crypto.randomBytes(24).toString("hex");
    const objectPrefix = `face-evidence/${caller.storeId}/${caller.staffId}/${faceEvidenceToken}`;
    let uploadedOriginal = null;
    let uploadedThumbnail = null;
    try {
      const uploadResults = await Promise.allSettled([
        uploadVerificationPhotoObject(`${objectPrefix}/original.jpg`, original.buffer),
        uploadVerificationPhotoObject(`${objectPrefix}/thumbnail.jpg`, thumbnail.buffer)
      ]);
      if (uploadResults[0].status === "fulfilled") uploadedOriginal = uploadResults[0].value;
      if (uploadResults[1].status === "fulfilled") uploadedThumbnail = uploadResults[1].value;
      const uploadFailure = uploadResults.find((item) => item.status === "rejected");
      if (uploadFailure) throw uploadFailure.reason;
      const evidenceTtlMinutes = Math.trunc(numberSetting("VERIFICATION_FACE_EVIDENCE_TTL_MINUTES", 30, 5, 120));
      await executeSql(
        `INSERT INTO public.verification_photo_drafts
          (evidence_token, store_id, customer_id, submitted_by_account_id,
           face_subject_type, face_subject_teacher_id, face_request_id,
           original_object_ref, thumbnail_object_ref, original_bytes,
           thumbnail_bytes, image_width, image_height, sha256, expires_at)
         VALUES
          (${sqlText(faceEvidenceToken)}, ${caller.storeId}, ${sqlText(customer.id)}::bigint,
           ${caller.staffId}, 'TEACHER', ${sqlText(teacherId)}::bigint,
           ${sqlText(result?.RequestId || "")}, ${sqlText(uploadedOriginal.reference)},
           ${sqlText(uploadedThumbnail.reference)}, ${original.buffer.length},
           ${thumbnail.buffer.length}, ${dimensions.width}, ${dimensions.height},
           ${sqlText(crypto.createHash("sha256").update(original.buffer).digest("hex"))},
           NOW() + (${evidenceTtlMinutes} * INTERVAL '1 minute'))`
      );
    } catch (error) {
      await Promise.all([
        deleteVerificationPhotoObject(uploadedOriginal?.reference),
        deleteVerificationPhotoObject(uploadedThumbnail?.reference)
      ]);
      throw error;
    }
  }

  return {
    ok: true,
    matched,
    teacher: {
      teacherId: String(teacher.id),
      teacherCode: String(teacher.teacher_code || ""),
      teacherName: String(teacher.teacher_name || "")
    },
    customer: {
      customerCode: String(customer.customer_code || ""),
      customerName: String(customer.customer_name || "")
    },
    score: rounded(score),
    threshold: settings.verifyThreshold,
    quality,
    liveness,
    requestId: result?.RequestId || "",
    faceEvidenceToken,
    message: matched
      ? "老师本人的 1:1 人脸验证已通过。"
      : "现场人脸与所选老师的登记人脸不一致，请核对老师或重新拍照。"
  };
}

async function getVerificationPhotos(event) {
  const context = await verificationPhotoContext(event);
  const rows = await executeSql(
    `SELECT photo_slot, photo_kind, thumbnail_object_ref, original_object_ref,
            face_subject_type, face_subject_teacher_id,
            original_bytes, thumbnail_bytes, image_width, image_height,
            created_at, updated_at
       FROM public.verification_photos
      WHERE verification_id = ${context.verificationId}::bigint
      ORDER BY photo_slot`
  );
  const expiresIn = verificationPhotoUrlTtlSeconds();
  // The grid needs only thumbnails. Signing five thumbnails with a bounded
  // concurrency avoids the former 10-24 simultaneous storage-sign requests
  // (thumbnail + original + compatibility retry). A full-size URL is issued
  // only after the user opens or exports that photo, with fresh authorization.
  const photos = await mapWithConcurrency(rows, 2, async (row) => {
    let thumbnailUrl = "";
    let thumbnailUrlExpiresIn = 0;
    let thumbnailError = "";
    const retainedProfile = String(row.photo_kind || "") === "PROFILE";
    const generatedExtraThumbnail = String(row.photo_kind || "") === "EXTRA"
      && String(row.thumbnail_object_ref || "") === String(row.original_object_ref || "");
    const [thumbnailResult] = await Promise.allSettled([
      signVerificationPhoto(row.thumbnail_object_ref, expiresIn, {
        allowRetainedProfile: retainedProfile,
        thumbnailTransform: retainedProfile || generatedExtraThumbnail
      })
    ]);
    if (thumbnailResult.status === "fulfilled") {
      thumbnailUrl = thumbnailResult.value.url;
      thumbnailUrlExpiresIn = thumbnailResult.value.expiresIn;
    }
    else thumbnailError = String(thumbnailResult.reason?.code || "PHOTO_THUMBNAIL_UNAVAILABLE");
    return {
      slot: Number(row.photo_slot),
      kind: String(row.photo_kind || ""),
      faceSubjectType: String(row.face_subject_type || context.record.face_subject_type || "CUSTOMER"),
      faceSubjectTeacherId: row.face_subject_teacher_id
        ? String(row.face_subject_teacher_id)
        : "",
      thumbnailUrl,
      thumbnailUrlExpiresIn,
      thumbnailError,
      originalUrl: "",
      originalUrlExpiresIn: 0,
      originalError: "",
      originalBytes: Number(row.original_bytes || 0),
      thumbnailBytes: Number(row.thumbnail_bytes || 0),
      width: Number(row.image_width || 0),
      height: Number(row.image_height || 0),
      uploadedAt: row.updated_at || row.created_at
    };
  });
  return {
    ok: true,
    recordId: String(context.record.id),
    recordCode: String(context.record.verification_code || ""),
    submittedAt: context.record.submitted_at,
    editableUntil: context.record.editable_until,
    isSubmitter: String(context.record.submitted_by_account_id) === String(context.caller.staffId),
    canEdit: context.canEdit,
    faceSubjectType: String(context.record.face_subject_type || "CUSTOMER"),
    faceSubjectTeacherId: context.record.face_subject_teacher_id
      ? String(context.record.face_subject_teacher_id)
      : "",
    faceSubject: String(context.record.face_subject_type || "CUSTOMER") === "TEACHER"
      ? {
          type: "TEACHER",
          teacherId: String(context.record.face_subject_teacher_id || ""),
          teacherCode: String(context.record.face_subject_teacher_code || ""),
          teacherName: String(context.record.face_subject_teacher_name || "")
        }
      : {
          type: "CUSTOMER",
          customerId: String(context.record.customer_id || ""),
          customerCode: String(context.record.customer_code || ""),
          customerName: String(context.record.customer_name || "")
        },
    maxPhotos: 5,
    expiresIn,
    photos
  };
}

async function verificationPhotoOriginalContext(event) {
  const context = await verificationPhotoContext(event);
  const slot = Number(event.slot);
  if (!Number.isInteger(slot) || slot < 0 || slot > 4) fail("核销照片位置无效。", "PHOTO_SLOT_INVALID");
  const rows = await executeSql(
    `SELECT photo_kind, original_object_ref, original_bytes, image_width, image_height
       FROM public.verification_photos
      WHERE verification_id = ${context.verificationId}::bigint
        AND photo_slot = ${slot}
      LIMIT 1`
  );
  const photo = rows[0];
  if (!photo) fail("该照片位置尚未上传。", "PHOTO_NOT_FOUND");
  await executeSql(
    `INSERT INTO public.verification_photo_events
      (verification_id, photo_slot, event_type, actor_account_id)
     VALUES
      (${context.verificationId}::bigint, ${slot}::smallint,
       'VIEW_ORIGINAL', ${context.caller.staffId}::bigint)`
  );
  return { context, slot, photo };
}

async function getVerificationPhotoOriginalUrl(event) {
  const { slot, photo } = await verificationPhotoOriginalContext(event);
  const expiresIn = verificationPhotoUrlTtlSeconds();
  const signedPhoto = await signVerificationPhoto(photo.original_object_ref, expiresIn, {
    allowRetainedProfile: String(photo.photo_kind || "") === "PROFILE"
  });
  return {
    ok: true,
    slot,
    photoUrl: signedPhoto.url,
    originalBytes: Number(photo.original_bytes || 0),
    width: Number(photo.image_width || 0),
    height: Number(photo.image_height || 0),
    expiresIn: signedPhoto.expiresIn
  };
}

async function getVerificationPhotoExportData(event) {
  // Export uses the same live authorization and VIEW_ORIGINAL audit as an
  // interactive view, but reads the private object through the authenticated
  // storage API. It therefore remains reliable when temporary URL signing is
  // degraded and never makes the evidence bucket public.
  const { slot, photo } = await verificationPhotoOriginalContext(event);
  if (Number(photo.original_bytes || 0) > MAX_IMAGE_BYTES) {
    fail("核销照片原图超过安全导出大小。", "PHOTO_EXPORT_TOO_LARGE");
  }
  let buffer;
  try {
    buffer = await downloadVerificationPhotoAuthenticated(photo.original_object_ref, MAX_IMAGE_BYTES, {
      allowRetainedProfile: String(photo.photo_kind || "") === "PROFILE"
    });
  } catch (error) {
    if (String(error?.code || "") === "PHOTO_UPLOAD_INCOMPLETE") {
      fail("核销照片存储文件未找到。", "PHOTO_NOT_FOUND");
    }
    throw error;
  }
  if (Number(photo.original_bytes || 0) > 0 && buffer.length !== Number(photo.original_bytes)) {
    fail("核销照片存储内容与数据库记录不一致。", "PHOTO_EXPORT_INVALID");
  }
  const dimensions = jpegDimensions(buffer);
  return {
    ok: true,
    slot,
    imageBase64: `data:image/jpeg;base64,${buffer.toString("base64")}`,
    bytes: buffer.length,
    width: dimensions.width,
    height: dimensions.height
  };
}

async function requireVerificationPhotoUploadSchema() {
  if (verificationPhotoUploadSchemaReady === true) return;
  const rows = await executeSql(
    `SELECT
       TO_REGCLASS('public.verification_photo_upload_requests') IS NOT NULL AS has_table,
       TO_REGPROCEDURE(
         'public.begin_verification_photo_upload(character varying,bigint,smallint,bigint,character varying,character varying,integer,integer)'
       ) IS NOT NULL AS has_begin,
       TO_REGPROCEDURE(
         'public.commit_verification_photo_upload(character varying,bigint,bigint,integer,integer,integer,character)'
       ) IS NOT NULL AS has_commit,
       TO_REGPROCEDURE(
         'public.cancel_verification_photo_upload(character varying,bigint,bigint)'
       ) IS NOT NULL AS has_cancel`
  );
  const schema = rows[0] || {};
  if (![schema.has_table, schema.has_begin, schema.has_commit, schema.has_cancel].every(databaseBoolean)) {
    fail("核销照片直传数据库尚未升级，请先执行迁移 039。", "DATABASE_SCHEMA_MISSING");
  }
  verificationPhotoUploadSchemaReady = true;
}

async function verificationPhotoUploadSchemaHealth() {
  try {
    const rows = await executeSql(
      `SELECT
         TO_REGCLASS('public.verification_photo_upload_requests') IS NOT NULL AS has_table,
         TO_REGPROCEDURE(
           'public.begin_verification_photo_upload(character varying,bigint,smallint,bigint,character varying,character varying,integer,integer)'
         ) IS NOT NULL AS has_begin,
         TO_REGPROCEDURE(
           'public.commit_verification_photo_upload(character varying,bigint,bigint,integer,integer,integer,character)'
         ) IS NOT NULL AS has_commit,
         TO_REGPROCEDURE(
           'public.cancel_verification_photo_upload(character varying,bigint,bigint)'
         ) IS NOT NULL AS has_cancel`
    );
    const schema = rows[0] || {};
    return {
      ready: [schema.has_table, schema.has_begin, schema.has_commit, schema.has_cancel].every(databaseBoolean),
      error: ""
    };
  } catch (error) {
    return { ready: false, error: String(error?.code || "DATABASE_CHECK_FAILED") };
  }
}

function requireVerificationPhotoUploadOwner(context, options = {}) {
  const isOwner = ["hq", "store", "teacher"].includes(context.caller.role)
    && String(context.record.submitted_by_account_id) === String(context.caller.staffId);
  if (!isOwner) fail("只有提交该核销单的账号可以管理补充照片。", "PHOTO_SUBMITTER_ONLY");
  if (options.requireWindow === true && !context.canEdit) {
    fail("该核销单已超过提交后的 24 小时，不能再上传或替换照片。", "PHOTO_WINDOW_EXPIRED");
  }
}

function verificationPhotoUploadSlot(event = {}) {
  const slot = Number(event.slot);
  if (!Number.isInteger(slot) || slot < 2 || slot > 4) {
    fail("只能上传补充照片 1 至 3。", "PHOTO_SLOT_INVALID");
  }
  return slot;
}

function verificationPhotoUploadState(row) {
  return {
    requestId: String(row.request_id || ""),
    status: String(row.request_status || row.status || ""),
    slot: Number(row.photo_slot),
    expectedBytes: Number(row.expected_original_bytes || 0),
    expiresAt: row.expires_at || null,
    committedAt: row.committed_at || null,
    cancelledAt: row.cancelled_at || null
  };
}

function verificationPhotoUploadConflict(row) {
  return {
    ok: false,
    code: "PHOTO_UPLOAD_ALREADY_ACTIVE",
    message: "该核销单已有一张照片正在上传，请先等待完成或取消当前上传。",
    activeRequest: verificationPhotoUploadState(row)
  };
}

async function availableVerificationPhotoUploadStorage(requiredBytes) {
  const candidates = verificationPhotoStorageCandidates();
  if (!candidates.length) fail("未配置核销照片私有存储桶。", "PHOTO_BUCKET_NOT_CONFIGURED");
  const rows = await executeSql(
    `SELECT id, name, public, file_size_limit, allowed_mime_types
       FROM storage.buckets
      WHERE id IN (${candidates.map((candidate) => sqlText(candidate.bucketId)).join(",")})`
  );
  const metadata = new Map(rows.map((row) => [String(row.id || ""), row]));
  const storage = candidates.find((candidate) => verificationPhotoBucketReady(metadata.get(candidate.bucketId), requiredBytes));
  if (!storage) {
    fail(
      `当前 PostgreSQL 环境中找不到配置合格的私有照片桶 ${candidates.map((candidate) => candidate.bucketId).join(" / ")}；请确认桶存在、保持私有、允许 image/jpeg，且单文件上限不少于照片大小。`,
      metadata.size ? "PHOTO_BUCKET_CONFIGURATION_INVALID" : "PHOTO_BUCKET_NOT_FOUND"
    );
  }
  return storage;
}

async function verificationPhotoStorageHealth() {
  const configuredBucketIds = [...new Set([
    String(process.env.VERIFICATION_PHOTO_BUCKET_ID || "verification-photos").trim(),
    String(process.env.CUSTOMER_PHOTO_BUCKET_ID || "customer-photos").trim()
  ].filter(Boolean))];
  try {
    const rows = configuredBucketIds.length ? await executeSql(
      `SELECT id, name, public, file_size_limit, allowed_mime_types
         FROM storage.buckets
        WHERE id IN (${configuredBucketIds.map(sqlText).join(",")})
        ORDER BY id`
    ) : [];
    const availableBucketIds = rows.map((row) => String(row.id || "")).filter(Boolean);
    const readyBucketIds = rows.filter((row) => verificationPhotoBucketReady(row))
      .map((row) => String(row.id || "")).filter(Boolean);
    const serviceRoleKeyConfigured = cloudbaseServiceRoleKeyConfigured();
    let serviceRoleStorageReady = false;
    let serviceRoleStorageError = "";
    let serviceRoleStorageRequestId = "";
    if (!availableBucketIds.length) {
      serviceRoleStorageError = "PHOTO_BUCKET_NOT_FOUND";
    } else if (!readyBucketIds.length) {
      serviceRoleStorageError = "PHOTO_BUCKET_CONFIGURATION_INVALID";
    } else if (!serviceRoleKeyConfigured) {
      serviceRoleStorageError = "SERVICE_ROLE_KEY_MISSING";
    } else {
      const storage = verificationPhotoStorageCandidates()
        .find((candidate) => readyBucketIds.includes(candidate.bucketId));
      if (!storage) {
        serviceRoleStorageError = "PHOTO_BUCKET_CONFIG_MISMATCH";
      } else {
        try {
          await manager().storage.listObjects({
            bucketId: storage.bucketId,
            limit: 1,
            withDelimiter: false,
            accessToken: storage.accessToken,
            envId: storage.envId
          });
          serviceRoleStorageReady = true;
        } catch (error) {
          serviceRoleStorageError = String(error?.code || "PHOTO_STORAGE_ACCESS_FAILED");
          serviceRoleStorageRequestId = String(error?.requestId || error?.RequestId || "");
        }
      }
    }
    return {
      configuredBucketIds,
      availableBucketIds,
      readyBucketIds,
      bucketMetadataReady: readyBucketIds.length > 0,
      bucketCheckError: "",
      serviceRoleStorageReady,
      serviceRoleStorageError,
      serviceRoleStorageRequestId
    };
  } catch (error) {
    return {
      configuredBucketIds,
      availableBucketIds: [],
      readyBucketIds: [],
      bucketMetadataReady: false,
      bucketCheckError: String(error?.code || "DATABASE_CHECK_FAILED"),
      serviceRoleStorageReady: false,
      serviceRoleStorageError: "DATABASE_CHECK_FAILED",
      serviceRoleStorageRequestId: ""
    };
  }
}

async function beginVerificationPhotoUpload(event) {
  await requireVerificationPhotoUploadSchema();
  const context = await verificationPhotoContext(event);
  requireVerificationPhotoUploadOwner(context);
  const requestId = verificationPhotoUploadRequestId(event);
  const slot = verificationPhotoUploadSlot(event);
  const originalBytes = verificationPhotoUploadBytes(event);
  const existingRows = await executeSql(
    `SELECT request_id, status AS request_status, photo_slot, bucket_id,
            original_object_ref, expected_original_bytes, expires_at,
            committed_at, cancelled_at
       FROM public.verification_photo_upload_requests
      WHERE verification_id = ${context.verificationId}::bigint
        AND actor_account_id = ${context.caller.staffId}::bigint
        AND (request_id = ${sqlText(requestId)}
             OR (status = 'UPLOADING' AND expires_at > CLOCK_TIMESTAMP()))
      ORDER BY (request_id = ${sqlText(requestId)}) DESC, created_at
      LIMIT 1`
  );
  const existing = existingRows[0];
  if (existing && String(existing.request_id) === requestId
      && String(existing.request_status) === "COMMITTED") {
    if (Number(existing.photo_slot) !== slot
        || Number(existing.expected_original_bytes) !== originalBytes) {
      fail("同一上传请求编号不能对应不同照片或照片位。", "PHOTO_UPLOAD_REQUEST_MISMATCH");
    }
    return {
      ok: true,
      ...verificationPhotoUploadState(existing),
      editableUntil: context.record.editable_until,
      alreadyCommitted: true
    };
  }
  if (existing && String(existing.request_id) !== requestId
      && String(existing.request_status) === "UPLOADING") {
    return verificationPhotoUploadConflict(existing);
  }
  requireVerificationPhotoUploadOwner(context, { requireWindow: true });

  let uploadMode = PHOTO_ONLY_FUNCTION ? "FUNCTION" : "DIRECT";
  let signedUploadFailure = null;
  let objectReference = String(existing?.original_object_ref || "");
  let bucketId = String(existing?.bucket_id || "");
  if (!objectReference) {
    const storage = await availableVerificationPhotoUploadStorage(originalBytes);
    const nonce = crypto.randomBytes(24).toString("hex");
    const objectName = `records/${context.verificationId}/slot-${slot}/direct-${Date.now()}-${nonce}.jpg`;
    bucketId = storage.bucketId;
    objectReference = `pg://${bucketId}/${objectName}`;
  }

  let rows;
  try {
    rows = await executeSql(
      `SELECT *
         FROM public.begin_verification_photo_upload(
           ${sqlText(requestId)}::varchar,
           ${context.verificationId}::bigint,
           ${slot}::smallint,
           ${context.caller.staffId}::bigint,
           ${sqlText(bucketId)}::varchar,
           ${sqlText(objectReference)}::varchar,
           ${originalBytes}::integer,
           ${verificationPhotoUploadTtlSeconds()}::integer
         )`
    );
  } catch (error) {
    if (String(error?.message || "").includes("PHOTO_UPLOAD_RATE_LIMITED")) {
      fail("该核销单短时间内发起的照片上传过多，请一小时后再试。", "PHOTO_UPLOAD_RATE_LIMITED");
    }
    throw error;
  }
  const request = rows[0];
  if (!request) fail("照片上传请求未能建立。", "PHOTO_UPLOAD_BEGIN_FAILED");
  if (!databaseBoolean(request.request_matches)) return verificationPhotoUploadConflict(request);
  const state = verificationPhotoUploadState(request);
  if (state.status === "COMMITTED") {
    return { ok: true, ...state, editableUntil: context.record.editable_until, alreadyCommitted: true };
  }
  if (state.status !== "UPLOADING") {
    return {
      ok: false,
      code: "PHOTO_UPLOAD_REQUEST_CLOSED",
      message: "该照片上传请求已经取消或过期，请重新选择照片。",
      ...state
    };
  }
  const storedReference = String(request.original_object_ref || objectReference);
  let upload = null;
  if (!PHOTO_ONLY_FUNCTION) {
    try {
      upload = await signVerificationPhotoUploadReference(storedReference);
    } catch (error) {
      if (!signedUploadFunctionFallbackAllowed(error)) throw error;
      await requireVerificationPhotoFunctionFallbackStorage(storedReference);
      uploadMode = "FUNCTION";
      signedUploadFailure = error;
    }
  }
  if (uploadMode === "FUNCTION" && signedUploadFailure) {
    console.warn("Signed verification-photo upload unavailable; using the authenticated cloud-function fallback", {
      verificationId: context.verificationId,
      slot,
      bucketId,
      code: String(signedUploadFailure?.code || "PHOTO_UPLOAD_SIGN_FAILED"),
      requestId: signedUploadFailure?.requestId || signedUploadFailure?.RequestId || ""
    });
  }
  return {
    ok: true,
    ...state,
    editableUntil: context.record.editable_until,
    uploadMode,
    functionUploadProof: uploadMode === "FUNCTION"
      ? verificationPhotoFunctionUploadProof(context, request)
      : undefined,
    originalUpload: upload ? { ...upload, expectedBytes: state.expectedBytes } : null,
    thumbnailUpload: null
  };
}

async function getVerificationPhotoUploadStatus(event) {
  await requireVerificationPhotoUploadSchema();
  const context = await verificationPhotoContext(event);
  requireVerificationPhotoUploadOwner(context);
  const requestId = verificationPhotoUploadRequestId(event);
  await executeSql(
    `UPDATE public.verification_photo_upload_requests
        SET status = 'EXPIRED', updated_at = NOW()
      WHERE request_id = ${sqlText(requestId)}
        AND verification_id = ${context.verificationId}::bigint
        AND actor_account_id = ${context.caller.staffId}::bigint
        AND status = 'UPLOADING'
        AND expires_at <= CLOCK_TIMESTAMP()`
  );
  const rows = await executeSql(
    `SELECT request_id, status AS request_status, photo_slot,
            original_object_ref, expected_original_bytes, expires_at,
            committed_at, cancelled_at
       FROM public.verification_photo_upload_requests
      WHERE request_id = ${sqlText(requestId)}
        AND verification_id = ${context.verificationId}::bigint
        AND actor_account_id = ${context.caller.staffId}::bigint
      LIMIT 1`
  );
  const request = rows[0];
  if (!request) fail("未找到照片上传请求。", "PHOTO_UPLOAD_REQUEST_NOT_FOUND");
  let objectUploaded = false;
  let uploadedBytes = 0;
  if (String(request.request_status) === "UPLOADING") {
    try {
      const reference = verificationPhotoReference(request.original_object_ref);
      const storage = verificationPhotoStorageForEvidence(reference);
      if (!storage) fail("核销照片不属于允许的私有存储桶。", "PHOTO_BUCKET_MISMATCH");
      const response = await manager().storage.getObjectInfoAuthenticated({
        bucketId: reference.bucketId,
        objectName: reference.objectName,
        method: "GET",
        accessToken: storage.accessToken,
        envId: storage.envId
      });
      const info = verificationPhotoObjectInfoBody(response);
      uploadedBytes = Number(info?.size || 0);
      objectUploaded = uploadedBytes > 0;
    } catch (error) {
      if (!storageObjectMissing(error)) throw error;
    }
  }
  return {
    ok: true,
    ...verificationPhotoUploadState(request),
    editableUntil: context.record.editable_until,
    objectUploaded,
    uploadedBytes
  };
}

async function cancelVerificationPhotoUpload(event) {
  await requireVerificationPhotoUploadSchema();
  const context = await verificationPhotoContext(event);
  requireVerificationPhotoUploadOwner(context);
  const requestId = verificationPhotoUploadRequestId(event);
  const rows = await executeSql(
    `SELECT *
       FROM public.cancel_verification_photo_upload(
         ${sqlText(requestId)}::varchar,
         ${context.verificationId}::bigint,
         ${context.caller.staffId}::bigint
       )`
  );
  const request = rows[0];
  if (!request) fail("未找到照片上传请求。", "PHOTO_UPLOAD_REQUEST_NOT_FOUND");
  const state = verificationPhotoUploadState(request);
  if (state.status === "COMMITTED") {
    return {
      ok: false,
      code: "PHOTO_UPLOAD_ALREADY_COMMITTED",
      message: "照片已经保存，不能再取消本次上传。",
      ...state
    };
  }
  return {
    ok: true,
    ...state,
    cancelledNow: databaseBoolean(request.cancelled_now),
    cleanupPending: true
  };
}

async function commitVerificationPhotoUpload(event) {
  await requireVerificationPhotoUploadSchema();
  const context = await verificationPhotoContext(event);
  requireVerificationPhotoUploadOwner(context);
  const requestId = verificationPhotoUploadRequestId(event);
  const requestRows = await executeSql(
    `SELECT request_id, status AS request_status, photo_slot,
            original_object_ref, expected_original_bytes, expires_at,
            committed_at, cancelled_at
       FROM public.verification_photo_upload_requests
      WHERE request_id = ${sqlText(requestId)}
        AND verification_id = ${context.verificationId}::bigint
        AND actor_account_id = ${context.caller.staffId}::bigint
      LIMIT 1`
  );
  const request = requestRows[0];
  if (!request) fail("未找到照片上传请求。", "PHOTO_UPLOAD_REQUEST_NOT_FOUND");
  const initialState = verificationPhotoUploadState(request);
  if (initialState.status === "CANCELLED" || initialState.status === "EXPIRED") {
    return {
      ok: false,
      code: "PHOTO_UPLOAD_REQUEST_CLOSED",
      message: "该照片上传请求已经取消或过期，请重新选择照片。",
      ...initialState
    };
  }
  if (initialState.status === "COMMITTED") {
    return { ok: true, ...initialState, alreadyCommitted: true };
  }
  requireVerificationPhotoUploadOwner(context, { requireWindow: true });
  if (PHOTO_ONLY_FUNCTION && !event.imageBase64) {
    fail("独立核销照片服务必须通过云函数提交照片内容。", "PHOTO_FUNCTION_UPLOAD_REQUIRED");
  }
  let inspected;
  if (event.imageBase64) {
    requireVerificationPhotoFunctionUploadProof(event, context, request);
    const fallbackPhoto = cleanVerificationJpeg(
      event.imageBase64,
      "补充照片",
      MAX_VERIFICATION_IMAGE_BYTES
    );
    if (fallbackPhoto.buffer.length !== Number(request.expected_original_bytes)) {
      fail("补充照片大小与上传请求不一致，请取消后重试。", "PHOTO_UPLOAD_SIZE_MISMATCH");
    }
    await uploadVerificationPhotoReference(request.original_object_ref, fallbackPhoto.buffer);
    // The cloud function supplied these exact bytes to the private storage
    // API. Validate the JPEG once in memory and avoid immediately downloading
    // the same object again. uploadVerificationPhotoReference already performs
    // an authenticated byte-for-byte comparison when a retry finds an object
    // at the request-bound immutable path, so lost-response idempotency remains
    // fail-closed without adding two storage round trips to every upload.
    inspected = verificationPhotoBufferMetadata(fallbackPhoto.buffer);
  } else {
    inspected = await inspectVerificationPhotoObject(
      request.original_object_ref,
      Number(request.expected_original_bytes)
    );
  }
  const rows = await executeSql(
    `SELECT *
       FROM public.commit_verification_photo_upload(
         ${sqlText(requestId)}::varchar,
         ${context.verificationId}::bigint,
         ${context.caller.staffId}::bigint,
         ${inspected.bytes}::integer,
         ${inspected.width}::integer,
         ${inspected.height}::integer,
         ${sqlText(inspected.sha256)}::char(64)
       )`
  );
  const committed = rows[0];
  if (!committed) fail("照片保存事务没有返回结果。", "PHOTO_UPLOAD_COMMIT_FAILED");
  const status = String(committed.request_status || "");
  if (status !== "COMMITTED") {
    return {
      ok: false,
      code: "PHOTO_UPLOAD_REQUEST_CLOSED",
      message: "照片上传请求已在其他页面取消或过期，请重新选择照片。",
      requestId,
      status
    };
  }
  const staleReferences = [...new Set([
    committed.old_original_object_ref,
    committed.old_thumbnail_object_ref
  ].filter((value) => value && value !== request.original_object_ref))];
  await Promise.all(staleReferences.map((reference) => deleteVerificationPhotoObject(reference)));
  const expiresIn = verificationPhotoUrlTtlSeconds();
  let thumbnailUrl = "";
  let thumbnailError = "";
  try {
    const signedThumbnail = await signVerificationPhoto(request.original_object_ref, expiresIn, {
      thumbnailTransform: true
    });
    thumbnailUrl = signedThumbnail.url;
  } catch (error) {
    thumbnailError = String(error?.code || "PHOTO_THUMBNAIL_UNAVAILABLE");
  }
  return {
    ok: true,
    requestId,
    status,
    committedNow: databaseBoolean(committed.committed_now),
    recordId: String(context.record.id),
    editableUntil: context.record.editable_until,
    canEdit: true,
    photo: {
      slot: Number(committed.photo_slot),
      kind: "EXTRA",
      thumbnailUrl,
      thumbnailError,
      originalBytes: Number(committed.original_bytes || 0),
      thumbnailBytes: 0,
      width: Number(committed.image_width || 0),
      height: Number(committed.image_height || 0),
      uploadedAt: committed.uploaded_at || committed.committed_at || new Date().toISOString()
    }
  };
}

async function uploadVerificationExtraPhoto(event) {
  // Migration 039 makes direct-upload intents the only write path. Keeping the
  // implementation below lets v51 remain deployable before the migration, but
  // once the intent table exists an old page or manual API call cannot bypass
  // the single-active-upload lock with a legacy Base64 request.
  const directUploadRows = await executeSql(
    `SELECT TO_REGCLASS('public.verification_photo_upload_requests') IS NOT NULL AS direct_upload_ready`
  );
  if (databaseBoolean(directUploadRows[0]?.direct_upload_ready)) {
    fail("当前版本必须使用可取消的照片直传流程，请刷新页面后重试。", "PHOTO_UPLOAD_DIRECT_REQUIRED");
  }
  const context = await verificationPhotoContext(event);
  if (!context.canEdit) {
    if (String(context.record.submitted_by_account_id) !== String(context.caller.staffId)) {
      fail("只有提交该核销单的账号可以上传或替换照片。", "PHOTO_SUBMITTER_ONLY");
    }
    fail("该核销单已超过提交后的 24 小时，不能再上传或替换照片。", "PHOTO_WINDOW_EXPIRED");
  }
  const slot = Number(event.slot);
  if (!Number.isInteger(slot) || slot < 2 || slot > 4) fail("只能上传补充照片 1 至 3。", "PHOTO_SLOT_INVALID");
  const original = cleanVerificationJpeg(event.imageBase64, "补充照片", MAX_VERIFICATION_IMAGE_BYTES);
  const thumbnail = cleanVerificationJpeg(event.thumbnailBase64, "补充照片缩略图", MAX_THUMBNAIL_BYTES);
  const dimensions = verificationPhotoDimensions(event);
  const nonce = crypto.randomBytes(12).toString("hex");
  const objectPrefix = `records/${context.verificationId}/slot-${slot}/${Date.now()}-${nonce}`;
  let uploadedOriginal = null;
  let uploadedThumbnail = null;
  let databaseSaved = false;
  try {
    const uploadResults = await Promise.allSettled([
      uploadVerificationPhotoObject(`${objectPrefix}-original.jpg`, original.buffer),
      uploadVerificationPhotoObject(`${objectPrefix}-thumbnail.jpg`, thumbnail.buffer)
    ]);
    if (uploadResults[0].status === "fulfilled") uploadedOriginal = uploadResults[0].value;
    if (uploadResults[1].status === "fulfilled") uploadedThumbnail = uploadResults[1].value;
    const uploadFailure = uploadResults.find((item) => item.status === "rejected");
    if (uploadFailure) throw uploadFailure.reason;
    const savedRows = await executeSql(
      `SELECT *
         FROM public.upsert_verification_extra_photo(
           ${context.verificationId}::bigint,
           ${slot}::smallint,
           ${context.caller.staffId}::bigint,
           ${sqlText(uploadedOriginal.reference)}::varchar,
           ${sqlText(uploadedThumbnail.reference)}::varchar,
           ${original.buffer.length}, ${thumbnail.buffer.length},
           ${dimensions.width}, ${dimensions.height},
           ${sqlText(crypto.createHash("sha256").update(original.buffer).digest("hex"))}::char(64)
         )`
    );
    databaseSaved = true;
    const saved = savedRows[0];
    await Promise.all([
      saved?.old_original_object_ref && saved.old_original_object_ref !== uploadedOriginal.reference
        ? deleteVerificationPhotoObject(saved.old_original_object_ref) : Promise.resolve(),
      saved?.old_thumbnail_object_ref && saved.old_thumbnail_object_ref !== uploadedThumbnail.reference
        ? deleteVerificationPhotoObject(saved.old_thumbnail_object_ref) : Promise.resolve()
    ]);
    const expiresIn = verificationPhotoUrlTtlSeconds();
    let thumbnailUrl = "";
    let thumbnailError = "";
    try {
      const signedThumbnail = await signVerificationPhoto(uploadedThumbnail.reference, expiresIn);
      thumbnailUrl = signedThumbnail.url;
    } catch (error) {
      // The immutable object references and database row are already saved.
      // A temporary preview-signing problem must not report the upload itself
      // as failed; the normal gallery refresh will retry signing separately.
      thumbnailError = String(error?.code || "PHOTO_THUMBNAIL_UNAVAILABLE");
      console.warn("Supplemental photo saved but immediate thumbnail signing failed", {
        verificationId: context.verificationId,
        slot,
        code: thumbnailError
      });
    }
    return {
      ok: true,
      recordId: String(context.record.id),
      editableUntil: context.record.editable_until,
      canEdit: true,
      photo: {
        slot,
        kind: "EXTRA",
        thumbnailUrl,
        thumbnailError,
        originalBytes: original.buffer.length,
        thumbnailBytes: thumbnail.buffer.length,
        width: dimensions.width,
        height: dimensions.height,
        uploadedAt: saved?.uploaded_at || new Date().toISOString()
      }
    };
  } catch (error) {
    if (!databaseSaved) {
      await Promise.all([
        deleteVerificationPhotoObject(uploadedOriginal?.reference),
        deleteVerificationPhotoObject(uploadedThumbnail?.reference)
      ]);
    }
    throw error;
  }
}

function requireVerificationPhotoCleanupToken(event) {
  requireCleanupControlPlaneCaller();
  const expectedToken = required("VERIFICATION_PHOTO_CLEANUP_TOKEN");
  if (expectedToken.length < 32) {
    fail("核销照片清理凭证配置无效，必须至少包含 32 个字符。", "CLEANUP_CONFIGURATION_INVALID");
  }
  const suppliedToken = String(event.cleanupToken || "");
  const expectedBuffer = Buffer.from(expectedToken);
  const suppliedBuffer = Buffer.from(suppliedToken);
  if (expectedBuffer.length !== suppliedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)) {
    fail("核销照片草稿清理凭证无效。", "FORBIDDEN");
  }
}

function verificationPhotoCleanupTokenConfigured() {
  return String(process.env.VERIFICATION_PHOTO_CLEANUP_TOKEN || "").trim().length >= 32;
}

function requireCleanupControlPlaneCaller() {
  let caller;
  try {
    caller = app().auth().getUserInfo();
  } catch (_) {
    fail("无法验证核销照片清理调用来源。", "CLEANUP_CALLER_UNVERIFIED");
  }
  if (String(caller?.uid || "").trim()) {
    fail("普通客户端不能执行核销照片清理。", "FORBIDDEN");
  }
}

function trustedCleanupTimerKind(event = {}, context = {}) {
  const eventType = String(event?.Type || "").trim();
  // A warm SCF instance may retain process environment state between calls.
  // Only the platform Timer event shape opts into this branch; once inside,
  // the reserved runtime source marker is mandatory as the trust boundary.
  if (eventType !== "Timer") return "";

  // TRIGGER_SRC and SCF_FUNCTIONNAME are reserved SCF runtime values. Unlike
  // event fields, an ordinary callFunction caller cannot manufacture them.
  const triggerSource = String(process.env.TRIGGER_SRC || "").trim();
  if (triggerSource !== "timer") {
    fail("核销照片定时清理调用来源无效。", "UNTRUSTED_TIMER_EVENT");
  }
  if (String(event?.TriggerName || "").trim() !== CLEANUP_TIMER_TRIGGER_NAME) {
    fail("核销照片定时清理触发器名称无效。", "UNTRUSTED_TIMER_EVENT");
  }
  const environmentFunctionName = String(process.env.SCF_FUNCTIONNAME || "").trim();
  const contextFunctionName = String(context?.function_name || "").trim();
  if (environmentFunctionName !== EXPECTED_FUNCTION_NAME
      || (contextFunctionName && contextFunctionName !== EXPECTED_FUNCTION_NAME)) {
    fail("核销照片定时清理函数身份无效。", "UNTRUSTED_TIMER_EVENT");
  }
  if (!Number.isFinite(Date.parse(String(event?.Time || "")))) {
    fail("核销照片定时清理时间无效。", "UNTRUSTED_TIMER_EVENT");
  }
  requireCleanupControlPlaneCaller();
  return PHOTO_ONLY_FUNCTION ? "UPLOADS" : "DRAFTS";
}

async function cleanupVerificationPhotoUploadRequests() {
  let uploadRequestsCleaned = 0;
  let uploadRequestBatchSize = 0;
  const schemaRows = await executeSql(
    `SELECT TO_REGCLASS('public.verification_photo_upload_requests') IS NOT NULL AS has_upload_requests`
  );
  if (!databaseBoolean(schemaRows[0]?.has_upload_requests)) {
    return { uploadRequestsCleaned, uploadRequestBatchSize };
  }
  await executeSql(
    `UPDATE public.verification_photo_upload_requests
        SET status = 'EXPIRED', updated_at = NOW()
      WHERE status = 'UPLOADING'
        AND expires_at <= CLOCK_TIMESTAMP()`
  );
  const uploadRows = await executeSql(
    `SELECT upload.request_id, upload.original_object_ref, upload.thumbnail_object_ref
       FROM public.verification_photo_upload_requests upload
      WHERE upload.status IN ('CANCELLED', 'EXPIRED')
        AND upload.cleanup_after <= CLOCK_TIMESTAMP()
        AND upload.objects_cleaned_at IS NULL
        AND NOT EXISTS (
          SELECT 1
            FROM public.verification_photos photo
           WHERE photo.verification_id = upload.verification_id
             AND (photo.original_object_ref = upload.original_object_ref
                  OR photo.thumbnail_object_ref = upload.original_object_ref
                  OR (upload.thumbnail_object_ref IS NOT NULL
                      AND (photo.original_object_ref = upload.thumbnail_object_ref
                           OR photo.thumbnail_object_ref = upload.thumbnail_object_ref)))
        )
      ORDER BY upload.cleanup_after, upload.request_id
      LIMIT 100`
  );
  uploadRequestBatchSize = uploadRows.length;
  for (const row of uploadRows) {
    const references = [...new Set([
      row.original_object_ref,
      row.thumbnail_object_ref
    ].filter(Boolean))];
    const deletionResults = await Promise.all(references.map((reference) => deleteVerificationPhotoObject(reference)));
    if (!deletionResults.every(Boolean)) continue;
    const updated = await executeSql(
      `UPDATE public.verification_photo_upload_requests
          SET objects_cleaned_at = NOW(), updated_at = NOW()
        WHERE request_id = ${sqlText(row.request_id)}
          AND status IN ('CANCELLED', 'EXPIRED')
          AND objects_cleaned_at IS NULL
      RETURNING request_id`
    );
    if (updated.length) uploadRequestsCleaned += 1;
  }
  await executeSql(
    `DELETE FROM public.verification_photo_upload_requests
      WHERE status IN ('CANCELLED', 'EXPIRED')
        AND objects_cleaned_at IS NOT NULL
        AND updated_at < NOW() - INTERVAL '7 days'`
  );
  await executeSql(
    `DELETE FROM public.verification_photo_upload_requests
      WHERE status = 'COMMITTED'
        AND committed_at < NOW() - INTERVAL '7 days'`
  );
  return { uploadRequestsCleaned, uploadRequestBatchSize };
}

async function runVerificationPhotoUploadsCleanup() {
  const uploadCleanup = await cleanupVerificationPhotoUploadRequests();
  return {
    ok: true,
    uploadRequestsCleaned: uploadCleanup.uploadRequestsCleaned,
    remainingBatchPossible: uploadCleanup.uploadRequestBatchSize === 100
  };
}

async function cleanupVerificationPhotoUploads(event) {
  requireVerificationPhotoCleanupToken(event);
  return runVerificationPhotoUploadsCleanup();
}

async function runVerificationPhotoDraftsCleanup() {
  // Claim candidates with a no-op UPDATE before touching storage. SKIP LOCKED
  // excludes a still-running order-creation transaction; the new row version
  // also forces any waiter to recheck the now-expired predicate. The grace
  // period and evidence anti-join are repeated again before final deletion.
  const rows = await executeSql(
    `WITH candidates AS (
       SELECT draft.evidence_token
         FROM public.verification_photo_drafts AS draft
        WHERE draft.consumed_at IS NULL
          AND draft.expires_at <= CLOCK_TIMESTAMP() - INTERVAL '10 minutes'
          AND NOT EXISTS (
            SELECT 1
              FROM public.verification_photos AS photo
             WHERE photo.source_evidence_token = draft.evidence_token
                OR photo.original_object_ref = draft.original_object_ref
                OR photo.thumbnail_object_ref = draft.original_object_ref
                OR photo.original_object_ref = draft.thumbnail_object_ref
                OR photo.thumbnail_object_ref = draft.thumbnail_object_ref
          )
        ORDER BY draft.expires_at, draft.evidence_token
        LIMIT 100
          FOR UPDATE OF draft SKIP LOCKED
     )
     UPDATE public.verification_photo_drafts AS draft
        SET expires_at = draft.expires_at
       FROM candidates
      WHERE draft.evidence_token = candidates.evidence_token
        AND draft.consumed_at IS NULL
        AND draft.expires_at <= CLOCK_TIMESTAMP() - INTERVAL '10 minutes'
        AND NOT EXISTS (
          SELECT 1
            FROM public.verification_photos AS photo
           WHERE photo.source_evidence_token = draft.evidence_token
              OR photo.original_object_ref = draft.original_object_ref
              OR photo.thumbnail_object_ref = draft.original_object_ref
              OR photo.original_object_ref = draft.thumbnail_object_ref
              OR photo.thumbnail_object_ref = draft.thumbnail_object_ref
        )
    RETURNING draft.evidence_token, draft.original_object_ref, draft.thumbnail_object_ref`
  );
  let cleaned = 0;
  for (const row of rows) {
    const deletionResults = await Promise.all([
      deleteVerificationPhotoObject(row.original_object_ref),
      deleteVerificationPhotoObject(row.thumbnail_object_ref)
    ]);
    if (!deletionResults.every(Boolean)) continue;
    const deleted = await executeSql(
      `DELETE FROM public.verification_photo_drafts
        WHERE evidence_token = ${sqlText(row.evidence_token)}
          AND consumed_at IS NULL
          AND expires_at <= CLOCK_TIMESTAMP() - INTERVAL '10 minutes'
          AND NOT EXISTS (
            SELECT 1
              FROM public.verification_photos AS photo
             WHERE photo.source_evidence_token = verification_photo_drafts.evidence_token
                OR photo.original_object_ref = verification_photo_drafts.original_object_ref
                OR photo.thumbnail_object_ref = verification_photo_drafts.original_object_ref
                OR photo.original_object_ref = verification_photo_drafts.thumbnail_object_ref
                OR photo.thumbnail_object_ref = verification_photo_drafts.thumbnail_object_ref
          )
      RETURNING evidence_token`
    );
    if (deleted.length) cleaned += 1;
  }
  return {
    ok: true,
    cleaned,
    remainingBatchPossible: rows.length === 100
  };
}

async function cleanupVerificationPhotoDrafts(event) {
  requireVerificationPhotoCleanupToken(event);
  return runVerificationPhotoDraftsCleanup();
}

async function handleTrustedCleanupTimer(event, context) {
  const kind = trustedCleanupTimerKind(event, context);
  if (!kind) return null;
  if (kind === "UPLOADS") return runVerificationPhotoUploadsCleanup();
  return runVerificationPhotoDraftsCleanup();
}

exports.main = async (event = {}, context = {}) => {
  try {
    const scheduledCleanup = await handleTrustedCleanupTimer(event, context);
    if (scheduledCleanup) return scheduledCleanup;
    const action = event.action || "health";
    if (action === "health") {
      const storageHealth = await verificationPhotoStorageHealth();
      if (PHOTO_ONLY_FUNCTION) {
        const schemaHealth = await verificationPhotoUploadSchemaHealth();
        const ready = schemaHealth.ready
          && storageHealth.bucketMetadataReady
          && storageHealth.serviceRoleStorageReady;
        return {
          ok: true,
          ready,
          version: FUNCTION_VERSION,
          service: "verificationPhoto",
          uploadMode: "FUNCTION",
          photoBucketId: String(process.env.CUSTOMER_PHOTO_BUCKET_ID || "customer-photos").trim(),
          verificationPhotoBucketId: String(process.env.VERIFICATION_PHOTO_BUCKET_ID || "verification-photos").trim(),
          verificationPhotoFallbackBucketId: String(process.env.CUSTOMER_PHOTO_BUCKET_ID || "customer-photos").trim(),
          verificationPhotoUrlTtlSeconds: verificationPhotoUrlTtlSeconds(),
          verificationPhotoUploadTtlSeconds: verificationPhotoUploadTtlSeconds(),
          verificationPhotoCleanupConfigured: verificationPhotoCleanupTokenConfigured(),
          verificationPhotoServiceRoleKeyConfigured: cloudbaseServiceRoleKeyConfigured(),
          verificationPhotoCleanupTimerTriggerName: CLEANUP_TIMER_TRIGGER_NAME,
          verificationPhotoConfiguredBucketIds: storageHealth.configuredBucketIds,
          verificationPhotoAvailableBucketIds: storageHealth.availableBucketIds,
          verificationPhotoReadyBucketIds: storageHealth.readyBucketIds,
          verificationPhotoBucketMetadataReady: storageHealth.bucketMetadataReady,
          verificationPhotoBucketCheckError: storageHealth.bucketCheckError || undefined,
          verificationPhotoServiceRoleStorageReady: storageHealth.serviceRoleStorageReady,
          verificationPhotoServiceRoleStorageError: storageHealth.serviceRoleStorageError || undefined,
          verificationPhotoServiceRoleStorageRequestId: storageHealth.serviceRoleStorageRequestId || undefined,
          verificationPhotoUploadSchemaReady: schemaHealth.ready,
          verificationPhotoUploadSchemaError: schemaHealth.error || undefined,
          message: ready
            ? "Private verification photo service is ready."
            : "Verification photo service is reachable but its database or private storage configuration is incomplete."
        };
      }
      return {
        ok: true,
        version: FUNCTION_VERSION,
        groupId: required("FACE_GROUP_ID"),
        photoBucketId: String(process.env.CUSTOMER_PHOTO_BUCKET_ID || "customer-photos").trim(),
        verificationPhotoBucketId: String(process.env.VERIFICATION_PHOTO_BUCKET_ID || "verification-photos").trim(),
        verificationPhotoFallbackBucketId: String(process.env.CUSTOMER_PHOTO_BUCKET_ID || "customer-photos").trim(),
        verificationPhotoUrlTtlSeconds: verificationPhotoUrlTtlSeconds(),
        verificationPhotoUploadTtlSeconds: verificationPhotoUploadTtlSeconds(),
        verificationPhotoCleanupConfigured: verificationPhotoCleanupTokenConfigured(),
        verificationPhotoServiceRoleKeyConfigured: cloudbaseServiceRoleKeyConfigured(),
        verificationPhotoCleanupTimerTriggerName: CLEANUP_TIMER_TRIGGER_NAME,
        verificationPhotoConfiguredBucketIds: storageHealth.configuredBucketIds,
        verificationPhotoAvailableBucketIds: storageHealth.availableBucketIds,
        verificationPhotoReadyBucketIds: storageHealth.readyBucketIds,
        verificationPhotoBucketMetadataReady: storageHealth.bucketMetadataReady,
        verificationPhotoBucketCheckError: storageHealth.bucketCheckError || undefined,
        verificationPhotoServiceRoleStorageReady: storageHealth.serviceRoleStorageReady,
        verificationPhotoServiceRoleStorageError: storageHealth.serviceRoleStorageError || undefined,
        verificationPhotoServiceRoleStorageRequestId: storageHealth.serviceRoleStorageRequestId || undefined,
        livenessEnabled: faceSettings().livenessEnabled,
        message: "Face customer enrollment and private verification photos are ready."
      };
    }
    if (PHOTO_ONLY_FUNCTION) {
      if (action === "getVerificationPhotos") return await getVerificationPhotos(event);
      if (action === "getVerificationPhotoOriginalUrl") return await getVerificationPhotoOriginalUrl(event);
      if (action === "getVerificationPhotoExportData") return await getVerificationPhotoExportData(event);
      if (action === "beginVerificationPhotoUpload") return await beginVerificationPhotoUpload(event);
      if (action === "getVerificationPhotoUploadStatus") return await getVerificationPhotoUploadStatus(event);
      if (action === "cancelVerificationPhotoUpload") return await cancelVerificationPhotoUpload(event);
      if (action === "commitVerificationPhotoUpload") return await commitVerificationPhotoUpload(event);
      if (action === "cleanupVerificationPhotoUploads") return await cleanupVerificationPhotoUploads(event);
      fail("Unsupported verification photo action.", "ACTION_NOT_FOUND");
    }
    if (action === "validateCapture") return await validateCapture(event);
    if (action === "validateTeacherFaceEnrollmentCapture") return await validateTeacherFaceEnrollmentCapture(event);
    if (action === "upsertDelegatedTeacherFace") return await upsertDelegatedTeacherFace(event);
    if (action === "registerCustomer") return await registerCustomer(event);
    if (action === "listActiveStoreCustomers") return await listActiveStoreCustomers(event);
    if (action === "queryStoreCustomers") return await queryStoreCustomers(event);
    if (action === "queryStoreBusinessRecords") return await queryStoreBusinessRecords(event);
    if (action === "getStoreDashboard") return await getStoreDashboard(event);
    if (action === "getStoreBusinessAnalytics") return await getStoreBusinessAnalytics(event);
    if (action === "getHqBusinessContext") return await getHqBusinessContext();
    if (action === "getTeacherBusinessContext") return await getTeacherBusinessContext();
    if (action === "getTeacherWorkspace") return await getTeacherWorkspace(event);
    if (action === "listActiveTeachers") return await listActiveTeachers(event);
    if (action === "listActiveProducts") return await listActiveProducts(event);
    if (action === "getTeacherExperienceEntitlements") return await getTeacherExperienceEntitlements(event);
    if (action === "createRechargeApplication") return await createRechargeApplication(event);
    if (action === "createVerificationApplication") return await createVerificationApplication(event);
    if (action === "getActiveStoreCustomerDetail") return await getActiveStoreCustomerDetail(event);
    if (action === "getCustomerPhotoUrl") return await getCustomerPhotoUrl(event);
    if (action === "getCustomerProductBalances") return await getCustomerProductBalances(event);
    if (action === "getCustomerStatus") return await getCustomerStatus(event);
    if (action === "getCustomerProfile") return await getCustomerProfile(event);
    if (action === "updateCustomerStatus") return await updateCustomerStatus(event);
    if (action === "updateCustomerNotes") return await updateCustomerNotes(event);
    if (action === "listCustomerMessages") return await listCustomerMessages(event);
    if (action === "addCustomerMessage") return await addCustomerMessage(event);
    if (action === "searchCustomer") return await searchCustomer(event);
    if (action === "verifyCustomerFace") return await verifyCustomerFace(event);
    if (action === "verifyTeacherExperienceFace") return await verifyTeacherExperienceFace(event);
    if (action === "getVerificationPhotos") return await getVerificationPhotos(event);
    if (action === "getVerificationPhotoOriginalUrl") return await getVerificationPhotoOriginalUrl(event);
    if (action === "getVerificationPhotoExportData") return await getVerificationPhotoExportData(event);
    if (action === "beginVerificationPhotoUpload") return await beginVerificationPhotoUpload(event);
    if (action === "getVerificationPhotoUploadStatus") return await getVerificationPhotoUploadStatus(event);
    if (action === "cancelVerificationPhotoUpload") return await cancelVerificationPhotoUpload(event);
    if (action === "commitVerificationPhotoUpload") return await commitVerificationPhotoUpload(event);
    if (action === "uploadVerificationExtraPhoto") return await uploadVerificationExtraPhoto(event);
    if (action === "cleanupVerificationPhotoDrafts") return await cleanupVerificationPhotoDrafts(event);
    fail("Unsupported action.");
  } catch (error) {
    console.error("faceRecognition failed", {
      action: event?.action || (event?.Type === "Timer" ? `Timer:${event?.TriggerName || "unknown"}` : "health"),
      code: error?.code || "FUNCTION_ERROR",
      message: error?.message || String(error)
    });
    return {
      ok: false,
      code: error?.code || "FUNCTION_ERROR",
      requestId: String(error?.RequestId || error?.requestId || "") || undefined,
      message: error?.message || "Customer enrollment failed."
    };
  }
};
