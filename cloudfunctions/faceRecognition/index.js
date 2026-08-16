"use strict";

const cloudbase = require("@cloudbase/node-sdk");
const CloudBaseManager = require("@cloudbase/manager-node");
const tencentcloud = require("tencentcloud-sdk-nodejs");
const IaiClient = tencentcloud.iai.v20200303.Client;

const FUNCTION_VERSION = "2026-08-16-private-pg-storage-v9";
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const FACE_MODEL_VERSION = "3.0";
let cloudApp = null;
let managerClient = null;
let storeBindingLayout = null;

function app() {
  if (!cloudApp) cloudApp = cloudbase.init({});
  return cloudApp;
}

function manager() {
  if (!managerClient) managerClient = CloudBaseManager.init({ envId: process.env.TCB_ENV });
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
  return new IaiClient({
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
    accessToken: required("CLOUDBASE_SERVICE_ROLE_KEY")
  };
}

function cleanImage(value) {
  if (typeof value !== "string" || !value.trim()) fail("A camera photo is required.");
  const base64 = value.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "").trim();
  if (!/^[A-Za-z0-9+/=]+$/.test(base64)) fail("The camera photo format is invalid.");
  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) fail("The camera photo must be between 1 byte and 4 MB.");
  return { base64, buffer };
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

function customerCode(storeId) {
  const stamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `C${storeId}-${stamp}-${random}`;
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
    `SELECT a.id AS staff_id, a.role_code, a.account_status, s.id AS store_id, s.store_status
       FROM public.staff_accounts a
       ${storeJoin}
      WHERE a.auth_uid = ${sqlText(uid)}
      LIMIT 1`
  );
  const caller = rows[0];
  if (!caller || caller.role_code !== "store") fail("Only an active store account can create a customer.", "FORBIDDEN");
  if (caller.account_status !== "ACTIVE" || caller.store_status !== "ACTIVE") fail("The store account or store is archived.", "ARCHIVED");
  return { uid: String(uid), staffId: Number(caller.staff_id), storeId: Number(caller.store_id) };
}

async function uploadCustomerPhoto(storeId, personId, buffer) {
  const { bucketId, accessToken } = photoStorageSettings();
  const objectName = `${storeId}/${personId}/${Date.now()}.jpg`;
  const uploaded = await manager().storage.uploadObject({
    bucketId,
    objectName,
    body: buffer,
    contentType: "image/jpeg",
    contentLength: buffer.length,
    cacheControl: "private, no-store",
    xRobotsTag: "noindex, nofollow, noarchive",
    upsert: false,
    accessToken
  });
  const savedObjectName = String(uploaded?.Key || uploaded?.Data?.Key || objectName);
  return {
    bucketId,
    objectName: savedObjectName,
    reference: `pg://${bucketId}/${savedObjectName}`
  };
}

async function deleteUploadedFile(storedPhoto) {
  if (!storedPhoto?.bucketId || !storedPhoto?.objectName) return;
  try {
    const { accessToken } = photoStorageSettings();
    await manager().storage.deleteObject({
      bucketId: storedPhoto.bucketId,
      objectName: storedPhoto.objectName,
      accessToken
    });
  } catch (error) {
    console.warn("Photo cleanup failed", error?.message || error);
  }
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
  const consent = event.consent === true;
  if (!name || name.length > 64) fail("Customer name is required and must not exceed 64 characters.");
  if (!consent) fail("Explicit customer consent is required before collecting a face photo.", "CONSENT_REQUIRED");
  if (notes.length > 500) fail("Notes must not exceed 500 characters.");

  const duplicate = await executeSql(
    `SELECT customer_code FROM public.customers
      WHERE created_store_id = ${caller.storeId}
        AND customer_name = ${sqlText(name)}
        AND birth_date = ${sqlText(birthDate)}::date
        AND customer_status = 'ACTIVE'
      LIMIT 1`
  );
  if (duplicate[0]) fail(`An active customer already exists: ${duplicate[0].customer_code}`, "DUPLICATE_CUSTOMER");

  const { base64, buffer } = cleanImage(event.imageBase64);
  const groupId = required("FACE_GROUP_ID");
  const personId = customerCode(caller.storeId);
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
      UniquePersonControl: 2,
      QualityControl: 3,
      NeedRotateDetection: 0
    });
    if (faceResult?.SimilarPersonId) {
      fail("该客户的人脸疑似已经在人员库中存在，请先查询原客户档案，不要重复建档。", "DUPLICATE_FACE");
    }
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
    `SELECT id, customer_code, customer_name, birth_date, customer_status, customer_process_status,
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
  const caller = await activeStoreCaller();
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

  const { base64 } = cleanImage(event.imageBase64);
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
    message: matched
      ? "所选客户的 1:1 人脸验证已通过。"
      : "现场人脸与所选客户的建档人脸不一致，请核对客户或重新拍照。"
  };
}

exports.main = async (event = {}) => {
  try {
    const action = event.action || "health";
    if (action === "health") return { ok: true, version: FUNCTION_VERSION, groupId: required("FACE_GROUP_ID"), photoBucketId: String(process.env.CUSTOMER_PHOTO_BUCKET_ID || "customer-photos").trim(), livenessEnabled: faceSettings().livenessEnabled, message: "Face customer enrollment is ready." };
    if (action === "validateCapture") return await validateCapture(event);
    if (action === "registerCustomer") return await registerCustomer(event);
    if (action === "searchCustomer") return await searchCustomer(event);
    if (action === "verifyCustomerFace") return await verifyCustomerFace(event);
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
