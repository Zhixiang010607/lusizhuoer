"use strict";

const crypto = require("node:crypto");
const cloudbase = require("@cloudbase/node-sdk");
const CloudBaseManager = require("@cloudbase/manager-node");

const FUNCTION_VERSION = "teacher-create-v3";
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const FACE_MODEL_VERSION = "3.0";
let cloudApp = null;
let managerClient = null;
let iaiClientClass = null;

function app() {
  if (!cloudApp) cloudApp = cloudbase.init({});
  return cloudApp;
}

function envId() {
  const value = String(process.env.CLOUDBASE_ENV_ID || process.env.TCB_ENV || "").trim();
  if (!value) fail("缺少 CLOUDBASE_ENV_ID 或 TCB_ENV。", "CONFIG_MISSING");
  return value;
}

function serviceKey() {
  const value = String(
    process.env.CLOUDBASE_APIKEY || process.env.CLOUDBASE_SERVICE_ROLE_KEY || ""
  ).trim();
  if (!value) fail("缺少 CloudBase 服务端密钥。", "CONFIG_MISSING");
  return value;
}

function manager() {
  if (!managerClient) managerClient = CloudBaseManager.init({ envId: envId() });
  return managerClient;
}

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) fail(`缺少云函数环境变量 ${name}。`, "CONFIG_MISSING");
  return value;
}

function faceClient() {
  if (!iaiClientClass) iaiClientClass = require("tencentcloud-sdk-nodejs").iai.v20200303.Client;
  return new iaiClientClass({
    credential: { secretId: required("FACE_SECRET_ID"), secretKey: required("FACE_SECRET_KEY") },
    region: "ap-guangzhou",
    profile: { httpProfile: { endpoint: "iai.tencentcloudapi.com" } }
  });
}

function fail(message, code = "BAD_REQUEST") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function requestIdFrom(value, depth = 0) {
  if (!value || depth > 4) return "";
  if (typeof value !== "object") return "";
  for (const key of ["requestId", "RequestId", "request_id"]) {
    const found = String(value[key] || "").trim();
    if (found) return found;
  }
  return requestIdFrom(value.cause, depth + 1);
}

function errorResponse(error) {
  console.error("teacherCreate failed", {
    code: error?.code || "INTERNAL_ERROR",
    requestId: requestIdFrom(error) || undefined,
    message: String(error?.message || error || "未知错误").slice(0, 500),
    cleanup: error?.cleanup || undefined
  });
  return {
    ok: false,
    code: String(error?.code || "INTERNAL_ERROR"),
    message: String(error?.message || "老师创建失败。"),
    requestId: requestIdFrom(error) || ""
  };
}

function sqlText(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function parseRows(result) {
  const columns = result?.Columns || [];
  return (result?.Rows || []).map((raw) => {
    const values = Array.isArray(raw) ? raw : JSON.parse(raw);
    return Object.fromEntries(columns.map((column, index) => [column, values[index]]));
  });
}

async function executeSql(sql) {
  return parseRows(await manager().database.executePGSql({ Sql: sql }));
}

function boolSetting(name, fallback = false) {
  if (process.env[name] === undefined || process.env[name] === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(process.env[name]).trim().toLowerCase());
}

function numberSetting(name, fallback, minimum, maximum) {
  if (process.env[name] === undefined || process.env[name] === "") return fallback;
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    fail(`${name} 必须在 ${minimum} 到 ${maximum} 之间。`, "CONFIG_INVALID");
  }
  return value;
}

function faceSettings() {
  return {
    qualityThreshold: numberSetting("FACE_QUALITY_THRESHOLD", 70, 0, 100),
    livenessEnabled: boolSetting("FACE_LIVENESS_ENABLED", false),
    livenessThreshold: numberSetting("FACE_LIVENESS_THRESHOLD", 40, 0, 100),
    maxYaw: numberSetting("FACE_MAX_YAW", 20, 0, 90),
    maxPitch: numberSetting("FACE_MAX_PITCH", 20, 0, 90),
    maxRoll: numberSetting("FACE_MAX_ROLL", 15, 0, 90)
  };
}

function rounded(value) {
  return Math.round(Number(value || 0) * 10) / 10;
}

function jpegImage(value) {
  const text = String(value || "").trim();
  if (!/^data:image\/jpeg;base64,/i.test(text)) {
    fail("老师人脸必须使用现场采集的 JPEG 照片。", "TEACHER_FACE_IMAGE_INVALID");
  }
  const base64 = text.replace(/^data:image\/jpeg;base64,/i, "").trim();
  const canonical = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (!base64 || !canonical.test(base64)) {
    fail("老师人脸照片格式无效。", "TEACHER_FACE_IMAGE_INVALID");
  }
  const buffer = Buffer.from(base64, "base64");
  if (buffer.toString("base64") !== base64 || buffer.length < 4
      || buffer.length > MAX_IMAGE_BYTES
      || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff
      || buffer[buffer.length - 2] !== 0xff || buffer[buffer.length - 1] !== 0xd9) {
    fail("老师人脸照片必须是小于 3 MB 的完整 JPEG。", "TEACHER_FACE_IMAGE_INVALID");
  }
  return {
    base64,
    buffer,
    bytes: buffer.length,
    sha256: crypto.createHash("sha256").update(buffer).digest("hex")
  };
}

function teacherName(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 64) fail("请填写 1-64 个字符的老师姓名。", "BAD_REQUEST");
  return text;
}

function phoneNumber(value) {
  const text = String(value || "").replace(/\D/g, "");
  if (!/^1[3-9]\d{9}$/.test(text)) fail("手机号必须是 11 位中国大陆手机号。", "BAD_REQUEST");
  return text;
}

function passwordValue(value) {
  const text = String(value || "");
  if (!/^[A-Za-z0-9]/.test(text)) {
    fail("初始密码不能以特殊字符开头。", "PASSWORD_START_INVALID");
  }
  const groups = [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z\d]/].filter((rule) => rule.test(text)).length;
  if (text.length < 8 || text.length > 32 || groups < 3) {
    fail("初始密码须为 8-32 位，并包含大写、小写、数字、特殊字符中的至少三类。", "BAD_REQUEST");
  }
  return text;
}

function requestKey(value) {
  const text = String(value || "").trim();
  if (text && !/^[A-Za-z0-9_-]{8,96}$/.test(text)) fail("clientRequestId 无效。", "BAD_REQUEST");
  return text || crypto.randomUUID();
}

function normalizedPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 13 && digits.startsWith("86") ? digits.slice(2) : digits;
}

function deterministicUid(phone) {
  return `teacher-${crypto.createHash("sha256").update(`teacher-auth:${phone}`, "utf8").digest("hex").slice(0, 48)}`;
}

function personIdFor(image, teacherId, staffId) {
  const token = crypto.createHash("sha256")
    .update(`teacher-face:${teacherId}:${staffId}:${image.sha256}`, "utf8")
    .digest("hex").slice(0, 48).toUpperCase();
  return `T-${token}`;
}

function storageSettings() {
  const bucketId = String(process.env.CUSTOMER_PHOTO_BUCKET_ID || "customer-photos").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(bucketId)) {
    fail("私有照片存储桶 ID 无效。", "CONFIG_INVALID");
  }
  return { bucketId, accessToken: serviceKey(), envId: envId() };
}

function photoFor(teacherId, personId, image) {
  const { bucketId } = storageSettings();
  const objectName = `teachers/${teacherId}/profile/${personId}-${image.sha256.slice(0, 32)}.jpg`;
  return { bucketId, objectName, reference: `pg://${bucketId}/${objectName}` };
}

async function inspectFace(api, base64) {
  let result;
  try {
    result = await api.DetectFace({
      Image: base64, MaxFaceNum: 2, MinFaceSize: 34,
      NeedFaceAttributes: 1, NeedQualityDetection: 1,
      FaceModelVersion: FACE_MODEL_VERSION, NeedRotateDetection: 0
    });
  } catch (error) {
    if (String(error?.code || "").includes("NoFaceInPhoto")) {
      fail("没有检测到清晰人脸，请正对镜头后重新拍照。", "FACE_NOT_FOUND");
    }
    throw error;
  }
  const faces = Array.isArray(result?.FaceInfos) ? result.FaceInfos : [];
  if (!faces.length) fail("没有检测到清晰人脸。", "FACE_NOT_FOUND");
  if (faces.length !== 1) fail("照片中只能有一位人员。", "MULTIPLE_FACES");
  const face = faces[0] || {};
  if (Number(face.Width || 0) < 100 || Number(face.Height || 0) < 100) {
    fail("人脸距离镜头太远，请靠近后重新拍照。", "FACE_TOO_SMALL");
  }
  const quality = face.FaceQualityInfo || {};
  const attributes = face.FaceAttributesInfo || {};
  const settings = faceSettings();
  const score = Number(quality.Score || 0);
  if (score < settings.qualityThreshold) {
    fail(`照片质量不足（${rounded(score)} 分），请重新拍照。`, "FACE_QUALITY_LOW");
  }
  if (attributes.Mask === true) fail("建档照片不能佩戴口罩。", "FACE_MASKED");
  if (attributes.EyeOpen === false) fail("检测到闭眼，请重新拍照。", "EYES_CLOSED");
  const yaw = Number(attributes.Yaw || 0);
  const pitch = Number(attributes.Pitch || 0);
  const roll = Number(attributes.Roll || 0);
  if (Math.abs(yaw) > settings.maxYaw || Math.abs(pitch) > settings.maxPitch
      || Math.abs(roll) > settings.maxRoll) {
    fail("脸部角度过大，请正对镜头。", "FACE_POSE_INVALID");
  }
  return {
    requestId: result?.RequestId || "",
    qualityScore: rounded(score), qualityThreshold: settings.qualityThreshold,
    faceWidth: Number(face.Width || 0), faceHeight: Number(face.Height || 0),
    yaw: rounded(yaw), pitch: rounded(pitch), roll: rounded(roll)
  };
}

async function inspectLiveness(api, base64) {
  const settings = faceSettings();
  if (!settings.livenessEnabled) {
    return { enabled: false, checked: false, score: null, threshold: settings.livenessThreshold };
  }
  const result = await api.DetectLiveFaceAccurate({ Image: base64, FaceModelVersion: FACE_MODEL_VERSION });
  const score = Number(result?.Score || 0);
  if (score < settings.livenessThreshold) {
    fail(`活体检测未通过（${rounded(score)} 分）。`, "LIVENESS_FAILED");
  }
  return {
    enabled: true, checked: true, score: rounded(score),
    threshold: settings.livenessThreshold, requestId: result?.RequestId || ""
  };
}

async function requireHq() {
  const { uid } = app().auth().getUserInfo();
  if (!uid) fail("请先登录总部账号。", "UNAUTHENTICATED");
  const rows = await executeSql(
    `SELECT id, role_code, account_status FROM public.staff_accounts
      WHERE auth_uid = ${sqlText(uid)} LIMIT 1`
  );
  const caller = rows[0];
  if (!caller || String(caller.role_code) !== "hq") fail("只有总部账号可以创建老师。", "FORBIDDEN");
  if (String(caller.account_status) !== "ACTIVE") fail("总部账号已封存。", "ARCHIVED");
  return { uid: String(uid), staffId: String(caller.id) };
}

async function exactAuthByUid(uid) {
  const response = await manager().user.describeUserList({ uidList: [uid], pageNo: 1, pageSize: 20 });
  const matches = (response?.Data?.UserList || []).filter((user) => String(user?.Uid || "") === uid);
  if (matches.length > 1) fail("认证系统返回多个同 UID 账号。", "AUTH_UID_AMBIGUOUS");
  return matches[0] || null;
}

async function exactAuthByPhone(phone) {
  const responses = await Promise.all([
    manager().user.describeUserList({ phone, pageNo: 1, pageSize: 20 }),
    manager().user.describeUserList({ phone: `+86${phone}`, pageNo: 1, pageSize: 20 })
  ]);
  const users = responses.flatMap((response) => response?.Data?.UserList || []);
  const unique = [...new Map(users.map((user) => [String(user?.Uid || ""), user])).values()];
  const matches = unique.filter((user) => normalizedPhone(user?.Phone) === phone);
  if (matches.length > 1) fail("认证系统返回多个同手机号账号。", "AUTH_PHONE_AMBIGUOUS");
  return matches[0] || null;
}

function assertAuthIdentity(user, uid, phone) {
  if (!user || String(user.Uid || "") !== uid
      || normalizedPhone(user.Phone) !== phone
      || String(user.Name || "") !== `staff_${phone}`) {
    fail("认证账号的 UID、手机号或登录名不匹配。", "AUTH_IDENTITY_CONFLICT");
  }
  return user;
}

async function readBusinessByPhone(phone) {
  const rows = await executeSql(
    `SELECT account.id AS staff_id, account.auth_uid, account.phone,
            account.staff_name, account.role_code, account.account_status,
            teacher.id AS teacher_id, teacher.teacher_code, teacher.teacher_name,
            teacher.teacher_status, teacher.face_person_id,
            teacher.face_enrollment_status, teacher.profile_photo_file_id
       FROM public.staff_accounts AS account
       LEFT JOIN public.teachers AS teacher ON teacher.staff_account_id = account.id
      WHERE account.phone = ${sqlText(phone)}
      ORDER BY account.id ASC LIMIT 2`
  );
  if (rows.length > 1) fail("同一手机号对应多份人员主档。", "PHONE_AMBIGUOUS");
  return rows[0] || null;
}

function assertBusinessIdentity(row, name) {
  if (!row) return;
  if (String(row.role_code || "") !== "teacher") {
    fail("该手机号已绑定其他业务身份。", "PHONE_ROLE_CONFLICT");
  }
  if (String(row.staff_name || "").trim() !== name
      || (row.teacher_name && String(row.teacher_name).trim() !== name)) {
    fail("该手机号已绑定其他老师资料。", "PHONE_ALREADY_PROVISIONED");
  }
}

async function ensureTeacherShell({ existing, uid, phone, name }) {
  if (!existing) {
    await executeSql(
      `WITH account AS (
         INSERT INTO public.staff_accounts
           (auth_uid, phone, staff_name, role_code, account_status)
         VALUES (${sqlText(uid)}, ${sqlText(phone)}, ${sqlText(name)}, 'teacher', 'ARCHIVED')
         RETURNING id
       )
       INSERT INTO public.teachers
         (teacher_code, teacher_name, staff_account_id, teacher_status, face_enrollment_status)
       SELECT 'TCHF' || account.id::text, ${sqlText(name)}, account.id, 'ARCHIVED', 'PENDING'
         FROM account
       ON CONFLICT (staff_account_id) DO UPDATE
         SET teacher_name = EXCLUDED.teacher_name, teacher_status = 'ARCHIVED', updated_at = NOW()`
    );
  } else {
    if (String(existing.auth_uid || "") !== uid) {
      fail("老师主档与认证 UID 不一致。", "AUTH_UID_CONFLICT");
    }
    if (!existing.teacher_id) {
      await executeSql(
        `INSERT INTO public.teachers
          (teacher_code, teacher_name, staff_account_id, teacher_status, face_enrollment_status)
         VALUES ('TCHF' || ${Number(existing.staff_id)}::text, ${sqlText(name)},
                 ${Number(existing.staff_id)}::bigint, 'ARCHIVED', 'PENDING')
         ON CONFLICT (staff_account_id) DO UPDATE
           SET teacher_name = EXCLUDED.teacher_name, updated_at = NOW()`
      );
    }
    if (String(existing.face_enrollment_status || "PENDING") !== "ENROLLED") {
      await executeSql(
        `UPDATE public.teachers SET teacher_status = 'ARCHIVED', updated_at = NOW()
          WHERE staff_account_id = ${Number(existing.staff_id)}::bigint;
         UPDATE public.staff_accounts SET account_status = 'ARCHIVED', updated_at = NOW()
          WHERE id = ${Number(existing.staff_id)}::bigint AND auth_uid = ${sqlText(uid)}`
      );
    }
  }
  const durable = await readBusinessByPhone(phone);
  assertBusinessIdentity(durable, name);
  if (!durable?.staff_id || !durable?.teacher_id || String(durable.auth_uid || "") !== uid) {
    fail("老师临时主档写入后未能精确读回。", "TEACHER_PROFILE_MISSING");
  }
  return durable;
}

function authStatus(user) {
  return String(user?.UserStatus || "").trim().toUpperCase();
}

async function blockAuth(uid, requiredResult = true) {
  await manager().user.modifyUser({ uid, userStatus: "BLOCKED" });
  if (!requiredResult) return;
  const readback = await exactAuthByUid(uid);
  if (!readback || authStatus(readback) !== "BLOCKED") {
    fail("认证账号未能确认为 BLOCKED。", "AUTH_BLOCK_FAILED");
  }
}

async function resolveAuthentication({ existing, phone, name, password, clientRequestId, lifecycle }) {
  const uid = existing?.auth_uid ? String(existing.auth_uid) : deterministicUid(phone);
  const [byUid, byPhone] = await Promise.all([exactAuthByUid(uid), exactAuthByPhone(phone)]);
  if (byUid && byPhone && String(byUid.Uid || "") !== String(byPhone.Uid || "")) {
    fail("该手机号与老师主档指向不同认证账号。", "AUTH_PHONE_AMBIGUOUS");
  }
  let user = byUid || byPhone;
  let created = false;
  if (user) {
    assertAuthIdentity(user, uid, phone);
    const expectedDescription = `teacher-create:${clientRequestId}`;
    const actualDescription = String(user.Description ?? user.description ?? "").trim();
    const completedTeacher = Boolean(existing
      && String(existing.face_enrollment_status || "") === "ENROLLED");
    if (completedTeacher) return { uid, user, created: false };
    if (actualDescription === expectedDescription) {
      if (authStatus(user) !== "BLOCKED") await blockAuth(uid);
      user = assertAuthIdentity(await exactAuthByUid(uid), uid, phone);
      if (lifecycle) lifecycle.authCreated = true;
      return { uid, user, created: true };
    }
    // Fail closed. The direct service never recognizes, resumes, mutates or
    // deletes credentials created by the retired Saga (or by another direct
    // request). Any such orphan must be inspected and removed manually.
    fail("该手机号已存在不属于当前请求的认证账号。", "PHONE_ALREADY_PROVISIONED");
  }
  if (existing) {
    fail("已有老师主档缺少可精确回读的认证账号。", "AUTH_ACCOUNT_MISSING");
  }
  const description = `teacher-create:${clientRequestId}`;
  let response;
  try {
    response = await manager().user.createUser({
      uid, name: `staff_${phone}`, password, type: "externalUser",
      userStatus: "BLOCKED", nickName: name, phone, description
    });
  } catch (createError) {
    if (lifecycle) lifecycle.uid = uid;
    let recovered = null;
    try { recovered = await exactAuthByUid(uid); }
    catch (readError) { createError.cause ||= readError; }
    if (recovered) {
      assertAuthIdentity(recovered, uid, phone);
      if (authStatus(recovered) !== "BLOCKED") {
        fail("新老师认证账号未保持 BLOCKED。", "AUTH_CREATE_INCOMPLETE");
      }
      const ownedByThisRequest = String(
        recovered.Description ?? recovered.description ?? ""
      ).trim() === description;
      if (!ownedByThisRequest) {
        fail("认证账号由另一个创建请求写入，当前请求不会修改或删除它。", "PHONE_ALREADY_PROVISIONED");
      }
      if (lifecycle) lifecycle.authCreated = true;
      return { uid, user: recovered, created: true };
    }
    createError.code ||= "AUTH_CREATE_FAILED";
    throw createError;
  }
  const returnedUid = String(response?.Data?.Uid || "").trim();
  if (lifecycle) {
    lifecycle.uid = returnedUid || uid;
    lifecycle.authCreated = true;
  }
  // CloudBase Manager may commit createUser while omitting Data.Uid. The
  // authoritative exact UID/phone/name readback below decides success.
  created = true;
  user = assertAuthIdentity(await exactAuthByUid(uid), uid, phone);
  if (authStatus(user) !== "BLOCKED") await blockAuth(uid);
  user = assertAuthIdentity(await exactAuthByUid(uid), uid, phone);
  if (authStatus(user) !== "BLOCKED") fail("新老师认证账号未保持 BLOCKED。", "AUTH_CREATE_INCOMPLETE");
  return { uid, user, created };
}

function objectInfo(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return null;
  if (!Array.isArray(value) && (Object.prototype.hasOwnProperty.call(value, "size")
      || Object.prototype.hasOwnProperty.call(value, "content_type")
      || Object.prototype.hasOwnProperty.call(value, "bucket_id"))) return value;
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    const found = objectInfo(item, depth + 1);
    if (found) return found;
  }
  return null;
}

function storageMissing(error) {
  const text = `${error?.code || ""} ${error?.message || ""}`.toUpperCase();
  return text.includes("STORAGE_OBJECT_NOT_FOUND") || text.includes("OBJECT NOT FOUND");
}

async function uploadPhoto(photo, image) {
  const settings = storageSettings();
  await manager().storage.uploadObject({
    bucketId: photo.bucketId, objectName: photo.objectName, body: image.buffer,
    contentType: "image/jpeg", contentLength: image.bytes,
    cacheControl: "private, max-age=31536000, immutable", upsert: false,
    accessToken: settings.accessToken, envId: settings.envId
  });
  return photo;
}

async function downloadPhoto(photo, expectedBytes) {
  const settings = storageSettings();
  let response;
  try {
    response = await manager().storage.downloadAuthenticatedObject({
      bucketId: photo.bucketId, objectName: photo.objectName, method: "GET",
      accessToken: settings.accessToken, envId: settings.envId
    });
  } catch (error) {
    if (storageMissing(error)) fail("老师原始照片未上传完成。", "PHOTO_UPLOAD_INCOMPLETE");
    throw error;
  }
  if (Number(response?.status || 0) !== 200 || !response?.body) {
    fail("无法从私有存储读取老师原图。", "PHOTO_READBACK_FAILED");
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += part.length;
    if (bytes > expectedBytes) {
      response.body.destroy?.();
      fail("老师原图大小与提交内容不一致。", "PHOTO_SIZE_MISMATCH");
    }
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}

async function confirmPhoto(photo, image) {
  const settings = storageSettings();
  let response;
  try {
    response = await manager().storage.getObjectInfoAuthenticated({
      bucketId: photo.bucketId, objectName: photo.objectName, method: "GET",
      accessToken: settings.accessToken, envId: settings.envId
    });
  } catch (error) {
    if (storageMissing(error)) fail("老师原始照片未上传完成。", "PHOTO_UPLOAD_INCOMPLETE");
    throw error;
  }
  const info = objectInfo(response);
  if (!info) fail("无法读取老师原图信息。", "PHOTO_INFO_INVALID");
  const bytes = Number(info.size ?? response?.headers?.["content-length"]);
  const contentType = String(info.content_type || response?.headers?.["content-type"] || "")
    .split(";", 1)[0].trim().toLowerCase();
  if (bytes !== image.bytes || contentType !== "image/jpeg") {
    fail("老师原图的大小或类型不一致。", "PHOTO_METADATA_MISMATCH");
  }
  const downloaded = await downloadPhoto(photo, image.bytes);
  if (downloaded.length !== image.bytes || downloaded[0] !== 0xff || downloaded[1] !== 0xd8
      || downloaded[2] !== 0xff || downloaded[downloaded.length - 2] !== 0xff
      || downloaded[downloaded.length - 1] !== 0xd9) {
    fail("读回的老师原图不是同一张完整 JPEG。", "PHOTO_CONTENT_MISMATCH");
  }
  const digest = crypto.createHash("sha256").update(downloaded).digest("hex");
  if (digest !== image.sha256) fail("读回的老师原图摘要不一致。", "PHOTO_CONTENT_MISMATCH");
  return { reference: photo.reference, bytes: downloaded.length, sha256: digest, contentType };
}

function personReadNotVisible(error) {
  const code = String(error?.code || "").trim();
  return code === "InvalidParameterValue.PersonIdNotExist"
    || code === "FailedOperation.GroupPersonMapNotExist"
    || code === "ResourceNotFound";
}

async function confirmPerson(api, groupId, personId, name, expectedFaceId = "") {
  let person;
  let groups;
  let initialVisibilityError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      [person, groups] = await Promise.all([
        api.GetPersonBaseInfo({ PersonId: personId }),
        api.GetPersonGroupInfo({ PersonId: personId, Offset: 0, Limit: 100 })
      ]);
      break;
    } catch (error) {
      if (!personReadNotVisible(error)) throw error;
      if (attempt === 1) throw initialVisibilityError || error;
      initialVisibilityError = error;
      // Tencent IAI may briefly lag immediately after CreatePerson. Retry the
      // exact read only; never issue a second write.
      await Promise.resolve();
    }
  }
  const faceIds = Array.isArray(person?.FaceIds)
    ? person.FaceIds.map((value) => String(value || "").trim()).filter(Boolean) : [];
  const groupIds = Array.isArray(groups?.PersonGroupInfos)
    ? groups.PersonGroupInfos.map((item) => String(item?.GroupId || "").trim()).filter(Boolean) : [];
  if (String(person?.PersonId || "") !== personId || String(person?.PersonName || "") !== name
      || faceIds.length !== 1 || !groupIds.includes(groupId)
      || (expectedFaceId && !faceIds.includes(expectedFaceId))) {
    fail("人脸库 Person、Group 或 FaceId 精确回读不一致。", "FACE_READBACK_MISMATCH");
  }
  return { personId, groupId, faceId: expectedFaceId || faceIds[0], faceIds };
}

async function createAndProveRemote({ api, groupId, personId, name, photo, image }) {
  const writes = await Promise.allSettled([
    api.CreatePerson({
      GroupId: groupId, PersonId: personId, PersonName: name, Image: image.base64,
      UniquePersonControl: 0, QualityControl: 3,
      FaceModelVersion: FACE_MODEL_VERSION, NeedRotateDetection: 0
    }),
    uploadPhoto(photo, image)
  ]);
  const personWrite = writes[0];
  const photoWrite = writes[1];
  const returnedFaceId = personWrite.status === "fulfilled"
    ? String(personWrite.value?.FaceId || "").trim() : "";
  const proofs = await Promise.allSettled([
    confirmPerson(api, groupId, personId, name, returnedFaceId),
    confirmPhoto(photo, image)
  ]);
  if (personWrite.status === "fulfilled" && !returnedFaceId) {
    const error = new Error("人脸服务创建响应缺少 FaceId。");
    error.code = "FACE_ENROLLMENT_INCOMPLETE";
    error.RequestId = personWrite.value?.RequestId;
    error.remoteCreated = {
      person: true,
      photo: photoWrite.status === "fulfilled"
    };
    error.remoteRecovered = {
      person: false,
      photo: photoWrite.status === "rejected" && proofs[1].status === "fulfilled"
    };
    throw error;
  }
  if (proofs[0].status !== "fulfilled" || proofs[1].status !== "fulfilled") {
    // If a write and its proof both failed, surface the write failure. A
    // follow-up PersonIdNotExist is only a consequence and must not hide the
    // real CreatePerson/configuration/permission error.
    const error = (personWrite.status === "rejected" && proofs[0].status === "rejected"
      ? personWrite.reason : null)
      || (photoWrite.status === "rejected" && proofs[1].status === "rejected"
        ? photoWrite.reason : null)
      || (proofs[0].status === "rejected" ? proofs[0].reason : null)
      || (proofs[1].status === "rejected" ? proofs[1].reason : null)
      || new Error("远端资料回读失败。");
    error.remoteCreated = {
      person: personWrite.status === "fulfilled",
      photo: photoWrite.status === "fulfilled"
    };
    error.remoteRecovered = {
      person: personWrite.status === "rejected" && proofs[0].status === "fulfilled",
      photo: photoWrite.status === "rejected" && proofs[1].status === "fulfilled"
    };
    throw error;
  }
  return {
    person: proofs[0].value, photo: proofs[1].value,
    created: {
      // A rejected response followed by exact readback proves durability, but
      // cannot prove ownership: another concurrent request may have created
      // the deterministic candidate. Only fulfilled writes are safe to delete
      // during a later rollback.
      person: personWrite.status === "fulfilled",
      photo: photoWrite.status === "fulfilled"
    },
    recovered: {
      person: personWrite.status === "rejected",
      photo: photoWrite.status === "rejected"
    }
  };
}

async function writeFaceReference(shell, actor, personId, photoRef) {
  await executeSql(
    `UPDATE public.teachers
        SET teacher_status = 'ARCHIVED', face_person_id = ${sqlText(personId)},
            face_consent_at = NOW(), face_enrollment_status = 'ENROLLED',
            face_enrolled_at = NOW(), face_enrolled_by_account_id = ${Number(actor.staffId)}::bigint,
            profile_photo_file_id = ${sqlText(photoRef)}, updated_at = NOW()
      WHERE id = ${Number(shell.teacher_id)}::bigint
        AND staff_account_id = ${Number(shell.staff_id)}::bigint
        AND (face_enrollment_status = 'PENDING'
             OR (face_enrollment_status = 'ENROLLED'
                 AND face_person_id = ${sqlText(personId)}
                 AND profile_photo_file_id = ${sqlText(photoRef)}))`
  );
  const row = await readBusinessByPhone(String(shell.phone || ""));
  if (!row || String(row.face_person_id || "") !== personId
      || String(row.profile_photo_file_id || "") !== photoRef
      || String(row.face_enrollment_status || "") !== "ENROLLED") {
    fail("老师人脸数据库引用未能精确读回。", "FACE_DATABASE_READBACK_FAILED");
  }
  return row;
}

async function activateDatabase(shell, personId, photoRef) {
  await executeSql(
    `UPDATE public.teachers SET teacher_status = 'ACTIVE', updated_at = NOW()
      WHERE id = ${Number(shell.teacher_id)}::bigint
        AND staff_account_id = ${Number(shell.staff_id)}::bigint
        AND face_person_id = ${sqlText(personId)}
        AND profile_photo_file_id = ${sqlText(photoRef)}
        AND face_enrollment_status = 'ENROLLED';
     UPDATE public.staff_accounts SET account_status = 'ACTIVE', updated_at = NOW()
      WHERE id = ${Number(shell.staff_id)}::bigint
        AND auth_uid = ${sqlText(shell.auth_uid)} AND role_code = 'teacher'`
  );
}

async function finalReadback({ phone, uid, teacherId, staffId, personId, photoRef }) {
  const rows = await executeSql(
    `SELECT account.id AS staff_id, account.auth_uid, account.phone,
            account.account_status, teacher.id AS teacher_id, teacher.teacher_code,
            teacher.teacher_status, teacher.face_person_id,
            teacher.face_enrollment_status, teacher.profile_photo_file_id
       FROM public.staff_accounts AS account
       JOIN public.teachers AS teacher ON teacher.staff_account_id = account.id
      WHERE account.id = ${Number(staffId)}::bigint
        AND account.auth_uid = ${sqlText(uid)} AND account.phone = ${sqlText(phone)}
        AND account.role_code = 'teacher' AND account.account_status = 'ACTIVE'
        AND teacher.id = ${Number(teacherId)}::bigint AND teacher.teacher_status = 'ACTIVE'
        AND teacher.face_person_id = ${sqlText(personId)}
        AND teacher.face_enrollment_status = 'ENROLLED'
        AND teacher.profile_photo_file_id = ${sqlText(photoRef)} LIMIT 1`
  );
  const database = rows[0] || null;
  const identity = assertAuthIdentity(await exactAuthByUid(uid), uid, phone);
  if (!database || authStatus(identity) !== "ACTIVE") {
    fail("老师最终激活状态未能精确读回。", "TEACHER_FINAL_READBACK_FAILED");
  }
  return { database, identity };
}

async function deletePhoto(photo) {
  const settings = storageSettings();
  try {
    await manager().storage.deleteObject({
      bucketId: photo.bucketId, objectName: photo.objectName,
      accessToken: settings.accessToken, envId: settings.envId
    });
  } catch (error) {
    if (!storageMissing(error)) throw error;
  }
}

async function deletePerson(api, groupId, personId) {
  try {
    await api.DeletePersonFromGroup({ GroupId: groupId, PersonId: personId });
  } catch (error) {
    const code = String(error?.code || "").trim();
    const alreadyAbsent = code === "InvalidParameterValue.PersonIdNotExist"
      || code === "FailedOperation.GroupPersonMapNotExist";
    if (!alreadyAbsent) throw error;
  }
}

async function rollbackDatabase({ shell, uid, phone, personId, photoRef, created, preserveFace }) {
  if (!shell?.staff_id) return;
  if (created) {
    await executeSql(
      `WITH deleted_teacher AS (
         DELETE FROM public.teachers
          WHERE id = ${Number(shell.teacher_id)}::bigint
            AND staff_account_id = ${Number(shell.staff_id)}::bigint
            AND (face_person_id IS NULL OR face_person_id = ${sqlText(personId)})
            AND (profile_photo_file_id IS NULL OR profile_photo_file_id = ${sqlText(photoRef)})
         RETURNING staff_account_id
       )
       DELETE FROM public.staff_accounts AS account
       USING deleted_teacher
       WHERE account.id = deleted_teacher.staff_account_id
         AND account.id = ${Number(shell.staff_id)}::bigint
         AND account.auth_uid = ${sqlText(uid)}
         AND account.phone = ${sqlText(phone)}
         AND account.role_code = 'teacher'`
    );
    const remaining = await readBusinessByPhone(phone);
    if (remaining && String(remaining.auth_uid || "") === uid) {
      fail("本次新建的老师临时主档未清理完成。", "DATABASE_CLEANUP_INCOMPLETE");
    }
    return;
  }
  if (preserveFace) {
    await executeSql(
      `UPDATE public.teachers SET teacher_status = 'ARCHIVED', updated_at = NOW()
        WHERE id = ${Number(shell.teacher_id)}::bigint
          AND staff_account_id = ${Number(shell.staff_id)}::bigint
          AND face_person_id = ${sqlText(personId)}
          AND profile_photo_file_id = ${sqlText(photoRef)}
          AND face_enrollment_status = 'ENROLLED';
       UPDATE public.staff_accounts SET account_status = 'ARCHIVED', updated_at = NOW()
        WHERE id = ${Number(shell.staff_id)}::bigint AND auth_uid = ${sqlText(uid)}`
    );
    const retained = await readBusinessByPhone(phone);
    if (!retained || String(retained.teacher_status || "") !== "ARCHIVED"
        || String(retained.account_status || "") !== "ARCHIVED"
        || String(retained.face_enrollment_status || "") !== "ENROLLED"
        || String(retained.face_person_id || "") !== personId
        || String(retained.profile_photo_file_id || "") !== photoRef) {
      fail("已有老师人脸在失败后未保持封存。", "DATABASE_CLEANUP_INCOMPLETE");
    }
    return;
  }
  await executeSql(
    `UPDATE public.teachers
        SET teacher_status = 'ARCHIVED', face_person_id = NULL, face_consent_at = NULL,
            face_enrollment_status = 'PENDING', face_enrolled_at = NULL,
            face_enrolled_by_account_id = NULL, profile_photo_file_id = NULL, updated_at = NOW()
      WHERE id = ${Number(shell.teacher_id)}::bigint
        AND staff_account_id = ${Number(shell.staff_id)}::bigint
        AND face_person_id = ${sqlText(personId)}
        AND profile_photo_file_id = ${sqlText(photoRef)};
     UPDATE public.staff_accounts SET account_status = 'ARCHIVED', updated_at = NOW()
     WHERE id = ${Number(shell.staff_id)}::bigint AND auth_uid = ${sqlText(uid)}`
  );
  const reset = await readBusinessByPhone(phone);
  if (!reset || String(reset.teacher_status || "") !== "ARCHIVED"
      || String(reset.account_status || "") !== "ARCHIVED"
      || String(reset.face_enrollment_status || "") !== "PENDING"
      || String(reset.face_person_id || "").trim()
      || String(reset.profile_photo_file_id || "").trim()) {
    fail("旧的不完整老师主档未恢复为封存待建档状态。", "DATABASE_CLEANUP_INCOMPLETE");
  }
}

async function deleteCreatedAuth(uid) {
  const response = await manager().user.deleteUsers({ uids: [uid] });
  const success = Number(response?.Data?.SuccessCount);
  const failed = Number(response?.Data?.FailedCount);
  if (success !== 1 || failed !== 0) fail("本次新建认证账号未确认删除。", "AUTH_CLEANUP_INCOMPLETE");
}

async function cleanupFailure(context, originalError) {
  const failures = [];
  const attempt = async (stage, task) => {
    try { await task(); }
    catch (error) {
      failures.push({ stage, code: error?.code || "CLEANUP_FAILED", message: String(error?.message || "") });
    }
  };
  if (context.uid && (context.authCreated || context.authTouched
      || context.databaseCreated || context.faceWritten || context.databaseActivated)) {
    await attempt("AUTH_BLOCK", () => blockAuth(context.uid, false));
  }
  if (!context.shell && context.databaseCreated && context.phone && context.uid) {
    context.shell = await readBusinessByPhone(context.phone).catch(() => null);
    if (context.shell && String(context.shell.auth_uid || "") !== context.uid) context.shell = null;
  }
  let databaseDetached = true;
  if (context.shell && (context.databaseCreated || context.faceWritten || context.databaseActivated)) {
    try {
      await rollbackDatabase({
        shell: context.shell, uid: context.uid, phone: context.phone,
        personId: context.personId, photoRef: context.photo?.reference || "",
        created: context.databaseCreated,
        preserveFace: context.originalEnrolled === true
      });
    } catch (error) {
      databaseDetached = false;
      failures.push({
        stage: "DATABASE_ROLLBACK", code: error?.code || "CLEANUP_FAILED",
        message: String(error?.message || "")
      });
    }
  }
  // Do not remove retained external evidence while PostgreSQL may still point
  // at it. A cleanup-incomplete error is safer than a dangling database row.
  if (databaseDetached && context.remoteCreated?.photo && context.photo) {
    await attempt("PHOTO_DELETE", () => deletePhoto(context.photo));
  }
  if (databaseDetached && context.remoteCreated?.person && context.api && context.personId) {
    await attempt("FACE_DELETE", () => deletePerson(context.api, context.groupId, context.personId));
  }
  if (databaseDetached && context.authCreated && context.uid) {
    await attempt("AUTH_DELETE", () => deleteCreatedAuth(context.uid));
  }
  if (failures.length) {
    const error = new Error(`${originalError.message} 失败资料尚未全部清理，请查看云函数日志。`);
    error.code = "TEACHER_CREATE_CLEANUP_INCOMPLETE";
    error.cause = originalError;
    error.cleanup = failures;
    throw error;
  }
}

function successResponse({ uid, shell, person, photo, quality, liveness, idempotent }) {
  const proof = {
    complete: true,
    teacherStatus: "ACTIVE", accountStatus: "ACTIVE", authStatus: "ACTIVE",
    faceStatus: "ENROLLED", faceId: person.faceId,
    photoRef: photo.reference, personId: person.personId,
    photoSha256: photo.sha256, photoBytes: photo.bytes
  };
  return {
    ok: true, completed: true, uid,
    teacherId: String(shell.teacher_id), teacherCode: String(shell.teacher_code || ""),
    idempotent: idempotent === true,
    proof, quality, liveness
  };
}

async function validateCapture(event) {
  await requireHq();
  const image = jpegImage(event.imageBase64);
  const api = faceClient();
  const quality = await inspectFace(api, image.base64);
  const liveness = await inspectLiveness(api, image.base64);
  return { ok: true, accepted: true, quality, liveness };
}

async function createTeacher(event) {
  const actor = await requireHq();
  const name = teacherName(event.staffName || event.teacherName);
  const phone = phoneNumber(event.phone);
  const password = passwordValue(event.initialPassword);
  if (event.consent !== true) fail("必须取得老师人脸采集授权。", "CONSENT_REQUIRED");
  const clientRequestId = requestKey(event.clientRequestId);
  const image = jpegImage(event.imageBase64);
  const api = faceClient();
  // This is the single authoritative quality/liveness pass for this create call.
  const quality = await inspectFace(api, image.base64);
  const liveness = await inspectLiveness(api, image.base64);

  const context = {
    api, groupId: required("FACE_GROUP_ID"), phone,
    uid: "", authCreated: false, authTouched: false, databaseCreated: false,
    shell: null, personId: "", photo: null,
    remoteCreated: { person: false, photo: false },
    remoteRecovered: { person: false, photo: false },
    faceWritten: false, databaseActivated: false, originalEnrolled: false
  };
  try {
    let existing = await readBusinessByPhone(phone);
    assertBusinessIdentity(existing, name);
    // Reject a creation-page face replacement before looking up or mutating
    // Auth. Replacement belongs to the teacher detail workflow.
    if (existing && String(existing.face_enrollment_status || "") === "ENROLLED") {
      const expectedPersonId = personIdFor(image, existing.teacher_id, existing.staff_id);
      const expectedPhoto = photoFor(existing.teacher_id, expectedPersonId, image);
      if (String(existing.face_person_id || "") !== expectedPersonId
          || String(existing.profile_photo_file_id || "") !== expectedPhoto.reference) {
        fail("该手机号已完成其他人脸建档，不能在创建页替换。", "PHONE_ALREADY_PROVISIONED");
      }
    }
    context.uid = existing?.auth_uid ? String(existing.auth_uid) : deterministicUid(phone);
    const authentication = await resolveAuthentication({
      existing, phone, name, password, clientRequestId, lifecycle: context
    });
    context.uid = authentication.uid;
    context.authCreated = authentication.created;
    const existingFullyActive = Boolean(existing
      && String(existing.face_enrollment_status || "") === "ENROLLED"
      && String(existing.teacher_status || "") === "ACTIVE"
      && String(existing.account_status || "") === "ACTIVE"
      && authStatus(authentication.user) === "ACTIVE");
    if (existing) {
      const expectedDescription = `teacher-create:${clientRequestId}`;
      const actualDescription = String(
        authentication.user?.Description ?? authentication.user?.description ?? ""
      ).trim();
      if (actualDescription !== expectedDescription) {
        fail("该手机号的老师账号不属于当前创建请求，不会把旧密码账号当作本次创建成功。", "PHONE_ALREADY_PROVISIONED");
      }
    }
    if (existing && String(existing.face_enrollment_status || "") === "ENROLLED"
        && !existingFullyActive) {
      fail("该老师已建档但当前处于封存或禁用状态，不能通过创建页重新激活。", "PHONE_ALREADY_PROVISIONED");
    }
    if (existing && authStatus(authentication.user) === "ACTIVE" && !existingFullyActive) {
      await blockAuth(authentication.uid);
      context.authTouched = true;
    }
    context.databaseCreated = !existing;
    const shell = await ensureTeacherShell({ existing, uid: authentication.uid, phone, name });
    context.shell = shell;
    existing = shell;
    const personId = personIdFor(image, shell.teacher_id, shell.staff_id);
    const photo = photoFor(shell.teacher_id, personId, image);
    context.personId = personId;
    context.photo = photo;

    const alreadyEnrolled = String(shell.face_enrollment_status || "") === "ENROLLED";
    context.originalEnrolled = alreadyEnrolled;
    if (alreadyEnrolled && (String(shell.face_person_id || "") !== personId
        || String(shell.profile_photo_file_id || "") !== photo.reference)) {
      fail("该手机号已完成其他人脸建档，不能在创建页替换。", "PHONE_ALREADY_PROVISIONED");
    }

    let remote;
    if (alreadyEnrolled) {
      const [person, retainedPhoto] = await Promise.all([
        confirmPerson(api, context.groupId, personId, name),
        confirmPhoto(photo, image)
      ]);
      remote = { person, photo: retainedPhoto, created: { person: false, photo: false } };
      if (existingFullyActive) {
        const final = await finalReadback({
          phone, uid: authentication.uid, teacherId: shell.teacher_id,
          staffId: shell.staff_id, personId, photoRef: photo.reference
        });
        return successResponse({
          uid: authentication.uid, shell: final.database,
          person, photo: retainedPhoto, quality, liveness, idempotent: true
        });
      }
    } else {
      remote = await createAndProveRemote({
        api, groupId: context.groupId, personId, name, photo, image
      });
      context.remoteCreated = remote.created;
      context.remoteRecovered = remote.recovered;
      await writeFaceReference(shell, actor, personId, photo.reference);
      context.faceWritten = true;
    }

    await activateDatabase(shell, personId, photo.reference);
    context.databaseActivated = true;
    context.authTouched = true;
    await manager().user.modifyUser({ uid: authentication.uid, userStatus: "ACTIVE", nickName: name });
    await finalReadback({
      phone, uid: authentication.uid, teacherId: shell.teacher_id,
      staffId: shell.staff_id, personId, photoRef: photo.reference
    });
    // Prove the external retained data again after both activation writes.
    const [finalPerson, finalPhoto] = await Promise.all([
      confirmPerson(api, context.groupId, personId, name, remote.person.faceId),
      confirmPhoto(photo, image)
    ]);
    const finalDatabase = await finalReadback({
      phone, uid: authentication.uid, teacherId: shell.teacher_id,
      staffId: shell.staff_id, personId, photoRef: photo.reference
    });
    if (!finalDatabase.database || finalPerson.faceId !== remote.person.faceId
        || finalPhoto.sha256 !== image.sha256 || finalPhoto.bytes !== image.bytes) {
      fail("老师建档最终证明不完整。", "TEACHER_FINAL_READBACK_FAILED");
    }
    return successResponse({
      uid: authentication.uid, shell: finalDatabase.database,
      person: finalPerson, photo: finalPhoto, quality, liveness,
      idempotent: alreadyEnrolled
    });
  } catch (error) {
    if (error?.remoteCreated) context.remoteCreated = error.remoteCreated;
    if (error?.remoteRecovered) {
      context.remoteRecovered = error.remoteRecovered;
    }
    try { await cleanupFailure(context, error); }
    catch (cleanupError) { throw cleanupError; }
    throw error;
  }
}

function health() {
  const hasEnv = (name) => Boolean(String(process.env[name] || "").trim());
  return {
    ok: true,
    version: FUNCTION_VERSION,
    actions: ["health", "validateCapture", "createTeacher"],
    configured: {
      cloudbaseEnv: hasEnv("CLOUDBASE_ENV_ID") || hasEnv("TCB_ENV"),
      serviceKey: hasEnv("CLOUDBASE_APIKEY") || hasEnv("CLOUDBASE_SERVICE_ROLE_KEY"),
      faceCredentials: hasEnv("FACE_SECRET_ID") && hasEnv("FACE_SECRET_KEY"),
      faceGroup: hasEnv("FACE_GROUP_ID"),
      photoBucket: Boolean(String(process.env.CUSTOMER_PHOTO_BUCKET_ID || "customer-photos").trim())
    }
  };
}

exports.main = async (event = {}) => {
  try {
    const action = String(event.action || "health").trim();
    if (action === "health") return health();
    if (action === "validateCapture") return await validateCapture(event);
    if (action === "createTeacher") return await createTeacher(event);
    fail("不支持的 teacherCreate 动作。", "UNKNOWN_ACTION");
  } catch (error) {
    return errorResponse(error);
  }
};

exports._test = {
  jpegImage,
  deterministicUid,
  personIdFor,
  photoFor,
  successResponse,
  errorResponse
};
