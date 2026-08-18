"use strict";

const cloudbase = require("@cloudbase/node-sdk");
const CloudBaseManager = require("@cloudbase/manager-node");
const crypto = require("crypto");

const FUNCTION_VERSION = "v44";
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
// SCF synchronous events are capped at 6 MB and Base64 adds roughly 33%.
// These verification-photo limits leave room for the JSON envelope while
// retaining a high-quality 1920–2400 px JPEG. Customer enrollment keeps its
// existing independent 4 MB limit above.
const MAX_VERIFICATION_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES = 384 * 1024;
const FACE_MODEL_VERSION = "3.0";
let cloudApp = null;
let managerClient = null;
let storeBindingLayout = null;
let iaiClientClass = null;
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

function numberSetting(name, fallback, minimum, maximum) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be a number between ${minimum} and ${maximum}.`);
  }
  return parsed;
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
    accessToken: required("CLOUDBASE_SERVICE_ROLE_KEY"),
    envId: cloudbaseEnvId()
  };
}

function verificationPhotoStorageSettings() {
  return {
    bucketId: String(process.env.VERIFICATION_PHOTO_BUCKET_ID || "verification-photos").trim(),
    accessToken: required("CLOUDBASE_SERVICE_ROLE_KEY"),
    envId: cloudbaseEnvId()
  };
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

async function uploadVerificationPhotoObject(objectName, buffer) {
  const storage = verificationPhotoStorageSettings();
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
}

async function deleteVerificationPhotoObject(referenceValue) {
  if (!referenceValue) return true;
  try {
    const reference = verificationPhotoReference(referenceValue);
    const storage = verificationPhotoStorageSettings();
    if (reference.bucketId !== storage.bucketId) return false;
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
  const verificationStorage = verificationPhotoStorageSettings();
  const customerStorage = photoStorageSettings();
  const isVerificationObject = reference.bucketId === verificationStorage.bucketId;
  const isRetainedProfile = options.allowCustomerProfile === true && reference.bucketId === customerStorage.bucketId;
  if (!isVerificationObject && !isRetainedProfile) {
    fail("核销照片不属于允许的私有存储桶。", "PHOTO_BUCKET_MISMATCH");
  }
  const storage = isVerificationObject ? verificationStorage : customerStorage;
  const transformKey = options.thumbnailTransform === true ? "thumbnail" : "original";
  const cacheKey = `${reference.bucketId}/${reference.objectName}/${transformKey}`;
  const cached = cachedVerificationPhoto(cacheKey);
  if (cached) return cached.url;
  let url = "";
  const candidates = isRetainedProfile
    ? photoObjectCandidates(reference.bucketId, reference.objectName)
    : [reference.objectName];
  for (const objectName of candidates) {
    try {
      const signed = await manager().storage.signObject({
        bucketId: reference.bucketId,
        objectName,
        expiresIn,
        accessToken: storage.accessToken,
        envId: storage.envId
      });
      url = signedPhotoUrl(signed);
      if (url) break;
    } catch (error) {
      if (!storageObjectMissing(error)) throw error;
    }
  }
  if (!url) fail("核销照片临时访问地址生成失败。", "PHOTO_SIGN_FAILED");
  if (options.thumbnailTransform === true) url = thumbnailTransformUrl(url);
  signedVerificationPhotoCache.set(cacheKey, { url, expiresAt: Date.now() + expiresIn * 1000 });
  while (signedVerificationPhotoCache.size > 1000) {
    signedVerificationPhotoCache.delete(signedVerificationPhotoCache.keys().next().value);
  }
  return url;
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
    `SELECT a.id AS staff_id, a.role_code, a.account_status,
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
    storeId: Number(caller.store_id),
    storeCode: String(caller.store_code || ""),
    storeName: String(caller.store_name || "")
  };
}

async function activeTeacherCaller() {
  const { uid } = app().auth().getUserInfo();
  if (!uid) fail("请先登录老师账号后再办理业务。", "UNAUTHENTICATED");
  const rows = await executeSql(
    `SELECT a.id AS staff_id, a.role_code, a.account_status,
            t.id AS teacher_id, t.teacher_code, t.teacher_name, t.teacher_status
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
    teacherId: String(caller.teacher_id),
    teacherCode: String(caller.teacher_code || ""),
    teacherName: String(caller.teacher_name || "")
  };
}

async function activeBusinessCaller(event = {}) {
  const { uid } = app().auth().getUserInfo();
  if (!uid) fail("请先登录后再办理业务。", "UNAUTHENTICATED");
  const accounts = await executeSql(
    `SELECT a.id AS staff_id, a.role_code, a.account_status,
            t.id AS teacher_id, t.teacher_code, t.teacher_name, t.teacher_status
       FROM public.staff_accounts a
       LEFT JOIN public.teachers t ON t.staff_account_id = a.id
      WHERE a.auth_uid = ${sqlText(uid)}
      LIMIT 1`
  );
  const account = accounts[0];
  if (!account) fail("当前登录账号尚未绑定业务身份。", "STAFF_PROFILE_MISSING");
  if (account.account_status !== "ACTIVE") fail("当前登录账号已经封存。", "ARCHIVED");
  if (account.role_code === "store") return { ...(await activeStoreCaller()), role: "store", teacherId: "" };
  if (account.role_code !== "teacher") fail("只有门店或老师账号可以办理充值和核销。", "FORBIDDEN");

  if (!account.teacher_id) fail("当前老师账号尚未绑定老师资料。", "TEACHER_PROFILE_MISSING");
  if (account.teacher_status !== "ACTIVE") fail("老师资料已经封存。", "ARCHIVED");
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
    role: "teacher",
    staffId: Number(account.staff_id),
    teacherId: String(account.teacher_id),
    teacherCode: String(account.teacher_code || ""),
    teacherName: String(account.teacher_name || ""),
    storeId: Number(store.id),
    storeCode: String(store.store_code || ""),
    storeName: String(store.store_name || "")
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
      teacherName: teacher.teacherName
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
// otherwise global query to one real store.  Operations are deliberately not
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
    `SELECT id AS staff_id, role_code, account_status
       FROM public.staff_accounts
      WHERE auth_uid = ${sqlText(uid)}
      LIMIT 1`
  );
  const account = rows[0];
  if (!account) fail("当前登录账号尚未绑定业务身份。", "STAFF_PROFILE_MISSING");
  if (account.account_status !== "ACTIVE") fail("当前登录账号已封存。", "ARCHIVED");
  if (account.role_code === "store") {
    const store = await activeStoreCaller();
    return { ...store, role: "store" };
  }
  if (account.role_code === "hq") {
    return { uid: String(uid), staffId: Number(account.staff_id), role: "hq", storeId: null };
  }
  fail("当前登录身份无权查看客户主页。", "FORBIDDEN");
}

async function activeOperationReviewCaller() {
  const { uid } = app().auth().getUserInfo();
  if (!uid) fail("请先登录后再查看审核客户资料。", "UNAUTHENTICATED");
  const rows = await executeSql(
    `SELECT id AS staff_id, role_code, account_status
       FROM public.staff_accounts
      WHERE auth_uid = ${sqlText(uid)}
      LIMIT 1`
  );
  const account = rows[0];
  if (!account) fail("当前登录账号尚未绑定业务身份。", "STAFF_PROFILE_MISSING");
  if (account.account_status !== "ACTIVE") fail("当前登录账号已封存。", "ARCHIVED");
  if (account.role_code !== "operation") fail("只有运营审核账号可以使用审核客户资料入口。", "FORBIDDEN");
  return { uid: String(uid), staffId: Number(account.staff_id), role: "operation", storeId: null };
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
  if (!['hq', 'operation', 'store', 'teacher'].includes(account.role_code)) {
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
  else if (caller.role === "operation") scope = "v.verification_type = 'SUPPLEMENT' AND v.void_request_status = 'NONE'";
  const rows = await executeSql(
    `SELECT v.id, v.verification_code, v.verification_type, v.store_id,
            v.teacher_id, v.submitted_by_account_id, v.submitted_at,
            v.submitted_at + INTERVAL '24 hours' AS editable_until,
            (CLOCK_TIMESTAMP() < v.submitted_at + INTERVAL '24 hours') AS within_edit_window
       FROM public.verification_records v
      WHERE v.id = ${verificationId}::bigint
        AND ${scope}
      LIMIT 1`
  );
  const record = rows[0];
  if (!record) fail("未找到当前账号有权查看的核销工单。", "VERIFICATION_NOT_FOUND");
  const canEdit = ["store", "teacher"].includes(caller.role)
    && String(record.submitted_by_account_id) === String(caller.staffId)
    && databaseBoolean(record.within_edit_window);
  return { caller, record, verificationId, canEdit };
}

function customerProfileScope(caller, alias = "c") {
  if (caller.role === "store") return ` AND ${alias}.created_store_id = ${caller.storeId}`;
  return "";
}

function operationReviewCustomerScope(event, alias = "c") {
  const recordType = String(event.reviewRecordType || "").trim().toUpperCase();
  if (!["RECHARGE", "VERIFICATION"].includes(recordType)) {
    fail("运营客户主页缺少有效审核工单类型。", "REVIEW_CONTEXT_REQUIRED");
  }
  const recordId = businessQueryDatabaseId(event.reviewRecordId, "审核工单");
  if (recordType === "RECHARGE") {
    return ` AND EXISTS (
      SELECT 1
        FROM public.recharge_records review_record
       WHERE review_record.id = ${recordId}::bigint
         AND review_record.customer_id = ${alias}.id
    )`;
  }
  return ` AND EXISTS (
    SELECT 1
      FROM public.verification_records review_record
     WHERE review_record.id = ${recordId}::bigint
       AND review_record.customer_id = ${alias}.id
       AND review_record.verification_type = 'SUPPLEMENT'
       AND review_record.void_request_status = 'NONE'
  )`;
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

function customerHistoryOptions(event = {}) {
  const requestedLimit = Number(event.historyLimit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(Math.trunc(requestedLimit), 1), 100)
    : 50;
  const type = String(event.historyType || "").trim().toUpperCase();
  if (type && !["RECHARGE", "VERIFICATION"].includes(type)) fail("客户历史类型无效。", "BAD_REQUEST");
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

async function getCustomerProfile(event, options = {}) {
  const operationReviewContext = options.operationReviewContext === true;
  const caller = operationReviewContext
    ? await activeOperationReviewCaller()
    : await activeCustomerProfileCaller();
  const customerCodeValue = customerStatusCode(event);
  const profileScope = operationReviewContext
    ? operationReviewCustomerScope(event, "c")
    : customerProfileScope(caller, "c");
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
               r.record_status, r.void_request_status, r.submitted_at, r.reviewed_at,
               TO_CHAR(r.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_submitted_at,
               p.id AS product_id, p.product_code, p.product_name
          FROM public.recharge_records r
          JOIN public.products p ON p.id = r.product_id
         WHERE r.customer_id = ${sqlText(customerId)}::bigint
           ${historyOptions.type === "RECHARGE" ? cursorSql("r") : ""}
         ORDER BY r.submitted_at DESC, r.id DESC
         LIMIT ${historyOptions.limit + 1}`;
  const verificationSql = `SELECT v.id, v.verification_code, v.verification_type, v.unit_count,
               v.record_status, v.void_request_status, v.submitted_at, v.reviewed_at,
               TO_CHAR(v.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_submitted_at,
               p.id AS product_id, p.product_code, p.product_name,
               t.id AS teacher_id, t.teacher_code, t.teacher_name
          FROM public.verification_records v
          JOIN public.products p ON p.id = v.product_id
          LEFT JOIN public.teachers t ON t.id = v.teacher_id
         WHERE v.customer_id = ${sqlText(customerId)}::bigint
           ${historyOptions.type === "VERIFICATION" ? cursorSql("v") : ""}
         ORDER BY v.submitted_at DESC, v.id DESC
         LIMIT ${historyOptions.limit + 1}`;

  if (historyOptions.type) {
    const historyRows = await executeSql(historyOptions.type === "RECHARGE" ? rechargeSql : verificationSql);
    const historyPage = customerHistoryPage(historyRows, historyOptions.limit);
    return historyOptions.type === "RECHARGE"
      ? { ok: true, recharges: mapCustomerRecharges(historyPage.rows), history: { recharges: historyPage.page } }
      : { ok: true, verifications: mapCustomerVerifications(historyPage.rows), history: { verifications: historyPage.page } };
  }

  const [balances, rechargeRows, verificationRows] = await Promise.all([
    executeSql(
      `SELECT p.id AS product_id, p.product_code, p.product_name, p.product_status,
              b.total_recharge_count, b.total_verification_count, b.remaining_count, b.updated_at
         FROM public.customer_product_balances b
         JOIN public.products p ON p.id = b.product_id
        WHERE b.customer_id = ${sqlText(customerId)}::bigint
        ORDER BY p.product_name, p.product_code`
    ),
    executeSql(rechargeSql),
    executeSql(verificationSql)
  ]);
  const rechargePage = customerHistoryPage(rechargeRows, historyOptions.limit);
  const verificationPage = customerHistoryPage(verificationRows, historyOptions.limit);
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
    history: { recharges: rechargePage.page, verifications: verificationPage.page }
  };
}

async function uploadCustomerPhoto(storeId, personId, buffer) {
  const { bucketId, accessToken, envId } = photoStorageSettings();
  const objectName = `${storeId}/${personId}/${Date.now()}.jpg`;
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
  if (!["ALL", "PENDING", "APPROVED", "CLOSED"].includes(statusCategory)) {
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
  else if (statusCategory === "CLOSED") listClauses.push(`${alias}.record_status IN ('REJECTED', 'VOIDED')`);
  if (cursorSubmittedAt) {
    listClauses.push(`(${alias}.submitted_at, ${alias}.id) < (${sqlText(cursorSubmittedAt)}::timestamptz, ${cursorId}::bigint)`);
  }

  const recordSelect = recordType === "RECHARGE"
    ? `r.id, r.recharge_code AS record_code, r.recharge_type AS original_type,
       r.unit_count, r.record_status, r.void_request_status, r.submitted_at, r.reviewed_at,
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
                             COUNT(*) FILTER (WHERE ${alias}.record_status IN ('REJECTED', 'VOIDED')) AS closed,
                             ${recordType === "RECHARGE"
                               ? `COUNT(*) FILTER (WHERE ${alias}.void_request_status = 'PENDING')`
                               : "0::bigint"} AS void_pending
                        FROM public.${table} ${alias}
                        ${baseJoin}
                       WHERE ${baseClauses.join(" AND ")}`;
  const listSql = `SELECT ${recordSelect},
                          c.customer_code, c.customer_name, c.birth_date,
                          s.id AS store_id, s.store_code, s.store_name,
                          p.id AS product_id, p.product_code, p.product_name,
                          t.id AS teacher_id, t.teacher_code, t.teacher_name
                     FROM public.${table} ${alias}
                     ${baseJoin}
                    WHERE ${listClauses.join(" AND ")}
                    ORDER BY ${alias}.submitted_at DESC, ${alias}.id DESC
                    LIMIT ${limit + 1}`;
  const productsSql = `SELECT DISTINCT p.id AS product_id, p.product_code, p.product_name
                          FROM public.${table} ${alias}
                          JOIN public.products p ON p.id = ${alias}.product_id
                         WHERE ${scopedStoreClause(caller, `${alias}.store_id`)}
                         ORDER BY p.product_name, p.product_code`;

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
      closed: Number(summary.closed || 0),
      voidPending: Number(summary.void_pending || 0)
    },
    products: productRows.map((product) => ({
      productId: String(product.product_id),
      productCode: product.product_code,
      productName: product.product_name
    })),
    records: pageRows.map((record) => ({
      id: String(record.id),
      recordCode: record.record_code,
      originalType: record.original_type,
      unitCount: Number(record.unit_count || 0),
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
  const [storeRows, projects, teachers, customerCountRows, customers] = await Promise.all([
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
    `WITH balance_totals AS (
       SELECT b.product_id,
              SUM(b.total_recharge_count) AS total_recharge_count,
              SUM(b.remaining_count) AS remaining_count
         FROM public.customer_product_balances b
         JOIN public.customers c ON c.id = b.customer_id
        WHERE c.created_store_id = ${storeId}::bigint
        GROUP BY b.product_id
     ), verification_totals AS (
       SELECT v.product_id, SUM(v.unit_count) AS total_verification_count
         FROM public.verification_records v
        WHERE v.store_id = ${storeId}::bigint
          AND v.record_status = 'APPROVED'
        GROUP BY v.product_id
     ), used_products AS (
       SELECT product_id FROM balance_totals
       UNION
       SELECT product_id FROM verification_totals
     )
     SELECT p.id AS product_id, p.product_code, p.product_name, p.product_status,
            COALESCE(b.total_recharge_count, 0) AS total_recharge_count,
            COALESCE(v.total_verification_count, 0) AS total_verification_count,
            COALESCE(b.remaining_count, 0) AS remaining_count
       FROM used_products u
       JOIN public.products p ON p.id = u.product_id
       LEFT JOIN balance_totals b ON b.product_id = p.id
       LEFT JOIN verification_totals v ON v.product_id = p.id
      ORDER BY p.product_name, p.product_code`
    ),
    executeSql(
    `SELECT t.id AS teacher_id, t.teacher_code, t.teacher_name, t.teacher_status,
            p.id AS product_id, p.product_code, p.product_name,
            COALESCE(SUM(v.unit_count), 0) AS valid_verification_count
       FROM public.verification_records v
       JOIN public.teachers t ON t.id = v.teacher_id
       JOIN public.products p ON p.id = v.product_id
      WHERE v.store_id = ${storeId}::bigint
        AND v.record_status = 'APPROVED'
      GROUP BY t.id, t.teacher_code, t.teacher_name, t.teacher_status,
               p.id, p.product_code, p.product_name
      ORDER BY valid_verification_count DESC, t.teacher_name, p.product_name`
    ),
    executeSql(
      `SELECT COUNT(*) AS customer_total
         FROM public.customers
        WHERE created_store_id = ${storeId}::bigint`
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
      teachers,
      customers,
      customer_total: customerTotal,
      customer_page: customerPage,
      customer_page_size: customerPageSize
    }
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
    teacher_name: caller.teacherName
  }] : await executeSql(
    `SELECT t.id AS teacher_id, t.teacher_code, t.teacher_name
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
      teacherName: teacher.teacher_name
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

async function requireRechargeSubmissionSchema() {
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
     ) AS teacher_is_optional`
  );
  if (!databaseBoolean(rows?.[0]?.has_idempotency_key)) {
    fail("充值单数据库缺少防重复提交字段，请先执行迁移 023。", "DATABASE_SCHEMA_MISSING");
  }
  if (!databaseBoolean(rows?.[0]?.teacher_is_optional)) {
    fail("充值单数据库尚未允许业务老师为空，请先执行迁移 024。", "DATABASE_SCHEMA_MISSING");
  }
}

async function createRechargeApplication(event) {
  const caller = await activeBusinessCaller(event);
  const customerCode = String(event.customerCode || "").trim();
  if (!customerCode || customerCode.length > 96) fail("必须先确认本门店的活跃客户。", "CUSTOMER_REQUIRED");
  const productId = positiveDatabaseId(event.productId, "项目");
  const teacherIdText = String(event.teacherId ?? "").trim();
  if (caller.role === "teacher" && teacherIdText && teacherIdText !== String(caller.teacherId)) {
    fail("老师账号只能把充值绑定到本人。", "FORBIDDEN");
  }
  const teacherId = caller.role === "teacher"
    ? positiveDatabaseId(caller.teacherId, "老师")
    : (teacherIdText ? positiveDatabaseId(teacherIdText, "老师") : null);
  const unitCount = Number(event.unitCount);
  if (!Number.isInteger(unitCount) || unitCount < 1 || unitCount > 999) {
    fail("充值次数必须是 1 至 999 的整数。", "INVALID_UNIT_COUNT");
  }
  const message = String(event.message || "").trim();
  if (message.length > 500) fail("门店留言不能超过 500 个字符。", "MESSAGE_TOO_LONG");
  const idempotencyKey = rechargeSubmissionKey(event.clientRequestId);

  await requireRechargeSubmissionSchema();
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
    `WITH inserted AS (
       INSERT INTO public.recharge_records
         (recharge_type, store_id, teacher_id, customer_id, product_id,
          unit_count, record_status, submitted_by_account_id, message, idempotency_key)
       VALUES
         ('NEW', ${caller.storeId}, ${teacherIdSql},
          ${sqlText(customer.id)}::bigint, ${sqlText(productId)}::bigint,
          ${unitCount}, 'PENDING', ${caller.staffId}, ${sqlText(message)}, ${sqlText(idempotencyKey)})
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id, recharge_code, recharge_type, store_id, teacher_id, customer_id,
                 product_id, unit_count, record_status, submitted_by_account_id,
                 submitted_at, message, idempotency_key
     )
     SELECT *, TRUE AS created_now FROM inserted
     UNION ALL
     SELECT r.id, r.recharge_code, r.recharge_type, r.store_id, r.teacher_id,
            r.customer_id, r.product_id, r.unit_count, r.record_status,
            r.submitted_by_account_id, r.submitted_at, r.message,
            r.idempotency_key, FALSE AS created_now
       FROM public.recharge_records r
      WHERE r.idempotency_key = ${sqlText(idempotencyKey)}
        AND NOT EXISTS (SELECT 1 FROM inserted)
     LIMIT 1`
  );
  const record = rows[0];
  if (!record) fail("充值申请未能写入数据库，请稍后重试。", "RECHARGE_CREATE_FAILED");

  const sameRequest = record.recharge_type === "NEW"
    && String(record.store_id) === String(caller.storeId)
    && String(record.teacher_id || "") === String(teacherId || "")
    && String(record.customer_id) === String(customer.id)
    && String(record.product_id) === String(productId)
    && Number(record.unit_count) === unitCount
    && String(record.message || "") === message;
  if (!sameRequest) {
    fail("该防重复提交编号已经用于另一张充值单，请刷新页面后重新提交。", "IDEMPOTENCY_CONFLICT");
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
     ), 0) > 0 AS has_profile_snapshot`
  );
  if (!databaseBoolean(rows?.[0]?.has_idempotency_key)
      || !databaseBoolean(rows?.[0]?.has_photo_create_function)
      || !databaseBoolean(rows?.[0]?.has_profile_snapshot)) {
    fail("核销单数据库缺少五张照片证据结构，请先依次执行迁移 026、037 和 038。", "DATABASE_SCHEMA_MISSING");
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
  if (!["NORMAL", "SUPPLEMENT"].includes(verificationType)) {
    fail("仅支持正常核销或补录核销。", "INVALID_VERIFICATION_TYPE");
  }
  const message = String(event.message || "").trim();
  if (message.length > 500) fail("门店留言不能超过 500 个字符。", "MESSAGE_TOO_LONG");
  if (verificationType === "SUPPLEMENT" && !message) {
    fail("补录核销必须填写补录原因。", "SUPPLEMENT_NOTE_REQUIRED");
  }
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
    `SELECT t.id, t.teacher_code, t.teacher_name
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

  const initialStatus = verificationType === "NORMAL" ? "APPROVED" : "PENDING";
  const supplementNote = verificationType === "SUPPLEMENT" ? message : "";
  let rows;
  try {
    rows = await executeSql(
      `SELECT *
         FROM public.create_verification_with_face_photo(
           ${sqlText(verificationType)}::varchar,
           ${caller.storeId}::bigint,
           ${sqlText(teacherId)}::bigint,
           ${sqlText(customer.id)}::bigint,
           ${sqlText(productId)}::bigint,
           ${sqlText(initialStatus)}::varchar,
           ${caller.staffId}::bigint,
           ${sqlText(message)}::text,
           ${sqlText(supplementNote)}::text,
           ${sqlText(faceRequestId)}::varchar,
           ${sqlText(faceEvidenceToken)}::varchar,
           ${sqlText(idempotencyKey)}::varchar
         )`
    );
  } catch (error) {
    const detail = String(error?.message || "").toLowerCase();
    if (detail.includes("insufficient purchased units")) {
      fail("该客户所选项目的剩余次数不足，不能提交正常核销。", "INSUFFICIENT_BALANCE");
    }
    if (detail.includes("face photo evidence")) {
      fail("现场人脸照片已过期、已使用或不属于当前提交，请重新拍照验证。", "FACE_PHOTO_EVIDENCE_INVALID");
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
    teacher: { teacherId: String(teacher.id), teacherCode: teacher.teacher_code, teacherName: teacher.teacher_name }
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
              ${alias}.record_status, ${alias}.void_request_status,
              ${alias}.submitted_at, ${alias}.reviewed_at,
              ${alias}.message,
              ${recordType === "VERIFICATION" ? `${alias}.supplement_note` : "NULL::text AS supplement_note"},
              ${alias}.review_note,
              ${recordType === "VERIFICATION" ? `${alias}.face_request_id` : "NULL::text AS face_request_id"},
              TO_CHAR(${alias}.submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_submitted_at,
              s.id AS store_id, s.store_code, s.store_name,
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
  const caller = await activeStoreCaller();
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
  await activeStoreCaller();
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
           face_request_id, original_object_ref, thumbnail_object_ref,
           original_bytes, thumbnail_bytes, image_width, image_height,
           sha256, expires_at)
         VALUES
          (${sqlText(faceEvidenceToken)}, ${caller.storeId}, ${sqlText(customer.id)}::bigint,
           ${caller.staffId}, ${sqlText(result?.RequestId || "")},
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

async function getVerificationPhotos(event) {
  const context = await verificationPhotoContext(event);
  const rows = await executeSql(
    `SELECT photo_slot, photo_kind, thumbnail_object_ref,
            original_bytes, thumbnail_bytes, image_width, image_height,
            created_at, updated_at
       FROM public.verification_photos
      WHERE verification_id = ${context.verificationId}::bigint
      ORDER BY photo_slot`
  );
  const expiresIn = Math.trunc(numberSetting("VERIFICATION_PHOTO_URL_TTL_SECONDS", 300, 60, 900));
  const photos = await Promise.all(rows.map(async (row) => {
    let thumbnailUrl = "";
    let thumbnailError = "";
    const retainedProfile = String(row.photo_kind || "") === "PROFILE";
    try {
      thumbnailUrl = await signVerificationPhoto(row.thumbnail_object_ref, expiresIn, {
        allowCustomerProfile: retainedProfile,
        thumbnailTransform: retainedProfile
      });
    }
    catch (error) { thumbnailError = String(error?.code || "PHOTO_THUMBNAIL_UNAVAILABLE"); }
    return {
      slot: Number(row.photo_slot),
      kind: String(row.photo_kind || ""),
      thumbnailUrl,
      thumbnailError,
      originalBytes: Number(row.original_bytes || 0),
      thumbnailBytes: Number(row.thumbnail_bytes || 0),
      width: Number(row.image_width || 0),
      height: Number(row.image_height || 0),
      uploadedAt: row.updated_at || row.created_at
    };
  }));
  return {
    ok: true,
    recordId: String(context.record.id),
    recordCode: String(context.record.verification_code || ""),
    submittedAt: context.record.submitted_at,
    editableUntil: context.record.editable_until,
    isSubmitter: String(context.record.submitted_by_account_id) === String(context.caller.staffId),
    canEdit: context.canEdit,
    maxPhotos: 5,
    expiresIn,
    photos
  };
}

async function getVerificationPhotoOriginalUrl(event) {
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
  const expiresIn = Math.trunc(numberSetting("VERIFICATION_PHOTO_URL_TTL_SECONDS", 300, 60, 900));
  const photoUrl = await signVerificationPhoto(photo.original_object_ref, expiresIn, {
    allowCustomerProfile: String(photo.photo_kind || "") === "PROFILE"
  });
  await executeSql(
    `INSERT INTO public.verification_photo_events
      (verification_id, photo_slot, event_type, actor_account_id)
     VALUES
      (${context.verificationId}::bigint, ${slot}::smallint,
       'VIEW_ORIGINAL', ${context.caller.staffId}::bigint)`
  );
  return {
    ok: true,
    slot,
    photoUrl,
    originalBytes: Number(photo.original_bytes || 0),
    width: Number(photo.image_width || 0),
    height: Number(photo.image_height || 0),
    expiresIn
  };
}

async function uploadVerificationExtraPhoto(event) {
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
    const expiresIn = Math.trunc(numberSetting("VERIFICATION_PHOTO_URL_TTL_SECONDS", 300, 60, 900));
    return {
      ok: true,
      recordId: String(context.record.id),
      editableUntil: context.record.editable_until,
      canEdit: true,
      photo: {
        slot,
        kind: "EXTRA",
        thumbnailUrl: await signVerificationPhoto(uploadedThumbnail.reference, expiresIn),
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

async function cleanupVerificationPhotoDrafts(event) {
  const expectedToken = required("VERIFICATION_PHOTO_CLEANUP_TOKEN");
  const suppliedToken = String(event.cleanupToken || "");
  const expectedBuffer = Buffer.from(expectedToken);
  const suppliedBuffer = Buffer.from(suppliedToken);
  if (expectedBuffer.length !== suppliedBuffer.length || !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)) {
    fail("核销照片草稿清理凭证无效。", "FORBIDDEN");
  }
  const rows = await executeSql(
    `SELECT evidence_token, original_object_ref, thumbnail_object_ref
       FROM public.verification_photo_drafts
      WHERE consumed_at IS NULL
        AND expires_at <= NOW()
      ORDER BY expires_at, evidence_token
      LIMIT 100`
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
          AND expires_at <= NOW()
      RETURNING evidence_token`
    );
    if (deleted.length) cleaned += 1;
  }
  return { ok: true, cleaned, remainingBatchPossible: rows.length === 100 };
}

exports.main = async (event = {}) => {
  try {
    const action = event.action || "health";
    if (action === "health") return {
      ok: true,
      version: FUNCTION_VERSION,
      groupId: required("FACE_GROUP_ID"),
      photoBucketId: String(process.env.CUSTOMER_PHOTO_BUCKET_ID || "customer-photos").trim(),
      verificationPhotoBucketId: String(process.env.VERIFICATION_PHOTO_BUCKET_ID || "verification-photos").trim(),
      verificationPhotoCleanupConfigured: Boolean(String(process.env.VERIFICATION_PHOTO_CLEANUP_TOKEN || "").trim()),
      livenessEnabled: faceSettings().livenessEnabled,
      message: "Face customer enrollment and private verification photos are ready."
    };
    if (action === "validateCapture") return await validateCapture(event);
    if (action === "registerCustomer") return await registerCustomer(event);
    if (action === "listActiveStoreCustomers") return await listActiveStoreCustomers(event);
    if (action === "queryStoreCustomers") return await queryStoreCustomers(event);
    if (action === "queryStoreBusinessRecords") return await queryStoreBusinessRecords(event);
    if (action === "getStoreDashboard") return await getStoreDashboard(event);
    if (action === "getTeacherBusinessContext") return await getTeacherBusinessContext();
    if (action === "getTeacherWorkspace") return await getTeacherWorkspace(event);
    if (action === "listActiveTeachers") return await listActiveTeachers(event);
    if (action === "listActiveProducts") return await listActiveProducts(event);
    if (action === "createRechargeApplication") return await createRechargeApplication(event);
    if (action === "createVerificationApplication") return await createVerificationApplication(event);
    if (action === "getActiveStoreCustomerDetail") return await getActiveStoreCustomerDetail(event);
    if (action === "getCustomerPhotoUrl") return await getCustomerPhotoUrl(event);
    if (action === "getCustomerProductBalances") return await getCustomerProductBalances(event);
    if (action === "getCustomerStatus") return await getCustomerStatus(event);
    if (action === "getCustomerProfile") return await getCustomerProfile(event);
    if (action === "getReviewCustomerProfile") return await getCustomerProfile(event, { operationReviewContext: true });
    if (action === "updateCustomerStatus") return await updateCustomerStatus(event);
    if (action === "searchCustomer") return await searchCustomer(event);
    if (action === "verifyCustomerFace") return await verifyCustomerFace(event);
    if (action === "getVerificationPhotos") return await getVerificationPhotos(event);
    if (action === "getVerificationPhotoOriginalUrl") return await getVerificationPhotoOriginalUrl(event);
    if (action === "uploadVerificationExtraPhoto") return await uploadVerificationExtraPhoto(event);
    if (action === "cleanupVerificationPhotoDrafts") return await cleanupVerificationPhotoDrafts(event);
    fail("Unsupported action.");
  } catch (error) {
    console.error("faceRecognition failed", { action: event?.action || "health", code: error?.code || "FUNCTION_ERROR", message: error?.message || String(error) });
    return {
      ok: false,
      code: error?.code || "FUNCTION_ERROR",
      requestId: String(error?.RequestId || error?.requestId || "") || undefined,
      message: error?.message || "Customer enrollment failed."
    };
  }
};
