"use strict";

const crypto = require("node:crypto");
const cloudbase = require("@cloudbase/node-sdk");
const CloudBaseManager = require("@cloudbase/manager-node");

const FUNCTION_VERSION = "teacher-create-v8";
const FACE_MODEL_VERSION = "3.0";
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
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

function manager() {
  if (!managerClient) managerClient = CloudBaseManager.init({ envId: envId() });
  return managerClient;
}

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) fail(`缺少云函数环境变量 ${name}。`, "CONFIG_MISSING");
  return value;
}

function serviceRoleKey() {
  return required(process.env.CLOUDBASE_APIKEY ? "CLOUDBASE_APIKEY" : "CLOUDBASE_SERVICE_ROLE_KEY");
}

function numberSetting(name, fallback, minimum, maximum) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) fail(`${name} 配置无效。`, "CONFIG_MISSING");
  return parsed;
}

function booleanSetting(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function faceSettings() {
  return {
    qualityThreshold: numberSetting("FACE_QUALITY_THRESHOLD", 70, 0, 100),
    livenessEnabled: booleanSetting("FACE_LIVENESS_ENABLED", false),
    livenessThreshold: numberSetting("FACE_LIVENESS_THRESHOLD", 40, 0, 100),
    maxYaw: numberSetting("FACE_MAX_YAW", 20, 0, 90),
    maxPitch: numberSetting("FACE_MAX_PITCH", 20, 0, 90),
    maxRoll: numberSetting("FACE_MAX_ROLL", 15, 0, 90)
  };
}

function faceClient() {
  if (!iaiClientClass) iaiClientClass = require("tencentcloud-sdk-nodejs").iai.v20200303.Client;
  return new iaiClientClass({
    credential: { secretId: required("FACE_SECRET_ID"), secretKey: required("FACE_SECRET_KEY") },
    region: "ap-guangzhou",
    profile: { httpProfile: { endpoint: "iai.tencentcloudapi.com" } }
  });
}

function cleanImage(value) {
  if (typeof value !== "string" || !value.trim()) fail("必须现场拍摄老师照片。", "PHOTO_REQUIRED");
  const base64 = value.replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, "").trim();
  if (!/^[A-Za-z0-9+/=]+$/.test(base64)) fail("老师照片格式无效。", "PHOTO_FORMAT_INVALID");
  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) fail("老师照片必须在 1 字节至 4MB 之间。", "PHOTO_SIZE_INVALID");
  return { base64, buffer };
}

function rounded(value) { return Math.round((Number(value) || 0) * 100) / 100; }

function storageUploadResponseMismatch(error) {
  const detail = String(error?.message || "");
  return detail.includes("上传成功但响应格式异常")
    && detail.includes("Id")
    && detail.includes("Key");
}

async function inspectFaceImage(api, base64) {
  let result;
  try {
    result = await api.DetectFace({ Image: base64, MaxFaceNum: 2, MinFaceSize: 34, NeedFaceAttributes: 1,
      NeedQualityDetection: 1, FaceModelVersion: FACE_MODEL_VERSION, NeedRotateDetection: 0 });
  } catch (error) {
    if (String(error?.code || "").includes("NoFaceInPhoto")) fail("没有检测到清晰人脸，请让老师正对镜头后重新拍照。", "FACE_NOT_FOUND");
    throw error;
  }
  const faces = Array.isArray(result?.FaceInfos) ? result.FaceInfos : [];
  if (!faces.length) fail("没有检测到清晰人脸，请让老师正对镜头后重新拍照。", "FACE_NOT_FOUND");
  if (faces.length !== 1) fail("照片中只能有一位老师，请移开其他人员后重新拍照。", "MULTIPLE_FACES");
  const face = faces[0] || {};
  if (Number(face.Width || 0) < 100 || Number(face.Height || 0) < 100) fail("人脸距离镜头太远，请靠近后重新拍照。", "FACE_TOO_SMALL");
  const quality = face.FaceQualityInfo || {};
  const attributes = face.FaceAttributesInfo || {};
  const settings = faceSettings();
  const score = Number(quality.Score || 0);
  if (score < settings.qualityThreshold) fail(`照片质量不足（${rounded(score)} 分），请改善光线后重拍。`, "FACE_QUALITY_LOW");
  if (attributes.Mask === true) fail("录入照片不能佩戴口罩。", "FACE_MASKED");
  if (attributes.EyeOpen === false) fail("检测到闭眼，请睁眼后重新拍照。", "EYES_CLOSED");
  const yaw = Number(attributes.Yaw || 0), pitch = Number(attributes.Pitch || 0), roll = Number(attributes.Roll || 0);
  if (Math.abs(yaw) > settings.maxYaw || Math.abs(pitch) > settings.maxPitch || Math.abs(roll) > settings.maxRoll) {
    fail("脸部角度过大，请正对镜头后重新拍照。", "FACE_POSE_INVALID");
  }
  return { qualityScore: rounded(score), qualityThreshold: settings.qualityThreshold, requestId: result?.RequestId || "" };
}

async function inspectLiveness(api, base64) {
  const settings = faceSettings();
  if (!settings.livenessEnabled) return { checked: false, score: null, threshold: settings.livenessThreshold };
  const result = await api.DetectLiveFaceAccurate({ Image: base64, FaceModelVersion: FACE_MODEL_VERSION });
  const score = Number(result?.Score || 0);
  if (score < settings.livenessThreshold) fail(`活体检测未通过（${rounded(score)} 分），请现场重拍。`, "LIVENESS_FAILED");
  return { checked: true, score: rounded(score), threshold: settings.livenessThreshold, requestId: result?.RequestId || "" };
}

function attendancePersonId(clientRequestId) {
  return `AT-${crypto.createHash("sha256").update(clientRequestId).digest("hex").slice(0, 28).toUpperCase()}`;
}

async function uploadAttendancePhoto(personId, buffer) {
  const bucketId = String(process.env.CUSTOMER_PHOTO_BUCKET_ID || "customer-photos").trim();
  const objectName = `attendance-teachers/${personId}/${Date.now()}.jpg`;
  try {
    await manager().storage.uploadObject({ bucketId, objectName, body: buffer, contentType: "image/jpeg",
      contentLength: buffer.length, cacheControl: "private, no-store", upsert: false,
      accessToken: serviceRoleKey(), envId: envId() });
  } catch (error) {
    // Some manager-node releases report a response-shape mismatch after the
    // private object has already been accepted. Only that exact case is safe.
    if (!storageUploadResponseMismatch(error)) throw error;
  }
  return { bucketId, objectName, reference: `pg://${bucketId}/${objectName}` };
}

async function deleteAttendancePhoto(photo) {
  if (!photo?.bucketId || !photo?.objectName) return;
  await manager().storage.deleteObject({ bucketId: photo.bucketId, objectName: photo.objectName,
    accessToken: serviceRoleKey(), envId: envId() });
}

async function deleteFacePerson(api, _groupId, personId) {
  if (!personId) return;
  try { await api.DeletePerson({ PersonId: personId }); }
  catch (error) {
    const detail = `${error?.code || ""} ${error?.message || ""}`;
    if (!/not.?exist|not.?found/i.test(detail)) throw error;
  }
}

function fail(message, code = "BAD_REQUEST") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function requestIdFrom(value, depth = 0) {
  if (!value || depth > 4 || typeof value !== "object") return "";
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
  if (!/^[A-Za-z0-9]/.test(text)) fail("初始密码不能以特殊字符开头。", "PASSWORD_START_INVALID");
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

async function readBusinessByPhone(phone) {
  const rows = await executeSql(
    `SELECT account.id AS staff_id, account.auth_uid, account.phone,
            account.staff_name, account.role_code, account.account_status,
            teacher.id AS teacher_id, teacher.teacher_code,
            teacher.teacher_name, teacher.teacher_status
       FROM public.staff_accounts AS account
       LEFT JOIN public.teachers AS teacher ON teacher.staff_account_id = account.id
      WHERE account.phone = ${sqlText(phone)}
      ORDER BY account.id ASC LIMIT 2`
  );
  if (rows.length > 1) fail("同一手机号对应多份人员主档。", "PHONE_AMBIGUOUS");
  return rows[0] || null;
}

async function readCompletedTeacherByPersonId(personId) {
  const rows = await executeSql(
    `SELECT account.auth_uid, account.phone, account.account_status,
            teacher.id AS teacher_id, teacher.teacher_code, teacher.teacher_status,
            profile.face_person_id
       FROM public.teacher_attendance_face_profiles AS profile
       JOIN public.teachers AS teacher
         ON teacher.id = profile.teacher_id
        AND teacher.staff_account_id = profile.staff_account_id
       JOIN public.staff_accounts AS account
         ON account.id = profile.staff_account_id
      WHERE profile.face_person_id = ${sqlText(personId)}
      LIMIT 1`
  );
  return rows[0] || null;
}

async function deleteAttendancePhotoPrefix(personId) {
  const bucketId = String(process.env.CUSTOMER_PHOTO_BUCKET_ID || "customer-photos").trim();
  const prefix = `attendance-teachers/${personId}/`;
  const rows = await executeSql(
    `SELECT name FROM storage.objects
      WHERE bucket_id = ${sqlText(bucketId)}
        AND name LIKE ${sqlText(`${prefix}%`)}
      ORDER BY name`
  );
  for (const row of rows) {
    const objectName = String(row.name || "");
    if (!objectName.startsWith(prefix)) continue;
    await manager().storage.deleteObject({
      bucketId, objectName, accessToken: serviceRoleKey(), envId: envId()
    });
  }
}

async function recoverTeacherCreation(event) {
  await requireHq();
  const rawRequestId = String(event.clientRequestId || "").trim();
  if (!rawRequestId) fail("缺少待核对的老师创建请求编号。", "BAD_REQUEST");
  const clientRequestId = requestKey(rawRequestId);
  const phone = event.phone ? phoneNumber(event.phone) : "";
  const personId = attendancePersonId(clientRequestId);
  const completed = await readCompletedTeacherByPersonId(personId);
  if (completed?.teacher_id && completed?.auth_uid) {
    return successResponse({ uid: String(completed.auth_uid), shell: {
      ...completed,
      face_person_id: completed.face_person_id
    } });
  }
  if (phone) {
    const business = await readBusinessByPhone(phone);
    if (business) {
      fail("检测到该手机号已存在老师资料，请返回老师管理核对，系统没有删除任何业务资料。", "RECOVERY_REVIEW_REQUIRED");
    }
  }
  const api = faceClient();
  const failures = [];
  const attempt = async (stage, task) => {
    try { await task(); }
    catch (error) { failures.push({ stage, code: error?.code || "CLEANUP_FAILED" }); }
  };
  await attempt("PHOTO_DELETE", () => deleteAttendancePhotoPrefix(personId));
  await attempt("FACE_DELETE", () => deleteFacePerson(api, required("FACE_GROUP_ID"), personId));
  if (phone) {
    const existingAuth = await exactAuthByPhone(phone);
    if (existingAuth) {
      const description = String(existingAuth?.Description ?? existingAuth?.description ?? "").trim();
      if (description !== `teacher-create:${clientRequestId}`) {
        fail("检测到该手机号已有非本次创建的登录账号，请返回老师管理核对。", "RECOVERY_REVIEW_REQUIRED");
      }
      await attempt("AUTH_DELETE", () => deleteCreatedAuth(String(existingAuth.Uid || "")));
    }
  }
  if (failures.length) {
    const error = new Error("上一笔老师创建尚未清理完整，请稍后重新进入本页继续恢复。");
    error.code = "TEACHER_CREATE_CLEANUP_INCOMPLETE";
    error.cleanup = failures;
    throw error;
  }
  return { ok: true, completed: false, cleaned: true };
}

async function createActiveAuthentication({ phone, name, password, clientRequestId, lifecycle }) {
  if (await exactAuthByPhone(phone)) {
    fail("该手机号已存在登录账号，不能重复创建老师。", "PHONE_ALREADY_PROVISIONED");
  }
  const description = `teacher-create:${clientRequestId}`;
  lifecycle.authAttempted = true;
  let created;
  try {
    created = await manager().user.createUser({
      name: `staff_${phone}`,
      password,
      type: "externalUser",
      userStatus: "ACTIVE",
      nickName: name,
      phone,
      description
    });
  } catch (error) {
    error.code ||= "AUTH_CREATE_FAILED";
    throw error;
  }
  const uid = String(created?.Data?.Uid || "").trim();
  if (!uid) fail("认证账号创建后未返回 UID，请检查认证用户后再重试。", "AUTH_CREATE_INCOMPLETE");
  lifecycle.uid = uid;
  lifecycle.authCreated = true;
  return { uid };
}

async function insertTeacherRecord({ uid, phone, name, face, hqStaffId }) {
  await executeSql(
    `WITH account AS (
       INSERT INTO public.staff_accounts
         (auth_uid, phone, staff_name, role_code, account_status)
       VALUES (${sqlText(uid)}, ${sqlText(phone)}, ${sqlText(name)}, 'teacher', 'ACTIVE')
       RETURNING id
     ), teacher AS (
     INSERT INTO public.teachers
       (teacher_code, teacher_name, staff_account_id, teacher_status)
     SELECT 'TCHF' || account.id::text, ${sqlText(name)}, account.id, 'ACTIVE'
       FROM account
     RETURNING id, staff_account_id
     )
     INSERT INTO public.teacher_attendance_face_profiles
       (teacher_id, staff_account_id, face_person_id, face_id,
        profile_photo_file_id, enrolled_by_account_id, consent_at,
        quality_score, liveness_score, face_request_id)
     SELECT teacher.id, teacher.staff_account_id, ${sqlText(face.personId)}, ${sqlText(face.faceId)},
            ${sqlText(face.photo.reference)}, ${Number(hqStaffId)}::bigint, CLOCK_TIMESTAMP(),
            ${Number(face.quality.qualityScore)}::numeric,
            ${face.liveness.score === null ? "NULL" : `${Number(face.liveness.score)}::numeric`},
            ${sqlText(face.requestId)}
       FROM teacher`
  );
  const row = await readBusinessByPhone(phone);
  if (!row?.staff_id || !row?.teacher_id
      || String(row.auth_uid || "") !== uid
      || String(row.role_code || "") !== "teacher"
      || String(row.account_status || "") !== "ACTIVE"
      || String(row.teacher_status || "") !== "ACTIVE") {
    fail("老师资料写入后未读取到完整的活跃账号和老师主档。", "DATABASE_ERROR");
  }
  const profiles = await executeSql(
    `SELECT face_person_id, profile_photo_file_id FROM public.teacher_attendance_face_profiles
      WHERE teacher_id = ${Number(row.teacher_id)}::bigint
        AND staff_account_id = ${Number(row.staff_id)}::bigint LIMIT 1`
  );
  if (String(profiles?.[0]?.face_person_id || "") !== face.personId
      || String(profiles?.[0]?.profile_photo_file_id || "") !== face.photo.reference) {
    fail("老师资料写入后未读取到完整的考勤人脸档案。", "DATABASE_ERROR");
  }
  row.face_person_id = profiles[0].face_person_id;
  return row;
}

async function rollbackDatabase({ shell, uid, phone }) {
  if (!shell?.staff_id) return;
  await executeSql(
    `WITH deleted_profile AS (
       DELETE FROM public.teacher_attendance_face_profiles
        WHERE teacher_id = ${Number(shell.teacher_id)}::bigint
          AND staff_account_id = ${Number(shell.staff_id)}::bigint
       RETURNING teacher_id
     ), deleted_teacher AS (
       DELETE FROM public.teachers
        WHERE id = ${Number(shell.teacher_id)}::bigint
          AND staff_account_id = ${Number(shell.staff_id)}::bigint
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
    fail("本次新建的老师资料未清理完成。", "DATABASE_CLEANUP_INCOMPLETE");
  }
  return true;
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
  if (!context.shell && context.databaseAttempted && context.phone && context.uid) {
    context.shell = await readBusinessByPhone(context.phone).catch(() => null);
    if (context.shell && String(context.shell.auth_uid || "") !== context.uid) context.shell = null;
  }
  if (context.shell && context.databaseAttempted) {
    await attempt("DATABASE_ROLLBACK", async () => {
      await rollbackDatabase(context);
      context.databaseClean = true;
    });
  } else {
    context.databaseClean = true;
  }
  if (context.authAttempted && context.phone) {
    const createdAuth = await exactAuthByPhone(context.phone).catch(() => null);
    const description = String(createdAuth?.Description ?? createdAuth?.description ?? "").trim();
    if (createdAuth && normalizedPhone(createdAuth.Phone) === context.phone
        && (context.authCreated || description === `teacher-create:${context.clientRequestId}`)) {
      await attempt("AUTH_DELETE", () => deleteCreatedAuth(String(createdAuth.Uid || context.uid || "")));
    }
  }
  if (failures.length) {
    const error = new Error(`${originalError.message} 失败资料尚未全部清理，请查看云函数日志。`);
    error.code = "TEACHER_CREATE_CLEANUP_INCOMPLETE";
    error.cause = originalError;
    error.cleanup = failures;
    throw error;
  }
}

function successResponse({ uid, shell }) {
  return {
    ok: true,
    completed: true,
    uid,
    teacherId: String(shell.teacher_id),
    teacherCode: String(shell.teacher_code || ""),
    attendanceFaceEnrolled: Boolean(shell.face_person_id),
    proof: {
      complete: true,
      teacherStatus: "ACTIVE",
      accountStatus: "ACTIVE",
      authStatus: "ACTIVE",
      attendanceFaceStatus: "ENROLLED"
    }
  };
}

async function createTeacher(event) {
  const hq = await requireHq();
  const name = teacherName(event.staffName || event.teacherName);
  const phone = phoneNumber(event.phone);
  const password = passwordValue(event.initialPassword);
  const clientRequestId = requestKey(event.clientRequestId);
  if (event.consent !== true) fail("必须取得老师明确授权后才能采集考勤面容。", "CONSENT_REQUIRED");
  const { base64, buffer } = cleanImage(event.imageBase64);
  const api = faceClient();
  const groupId = required("FACE_GROUP_ID");
  const personId = attendancePersonId(clientRequestId);
  const context = {
    phone,
    uid: "",
    clientRequestId,
    authAttempted: false,
    authCreated: false,
    databaseAttempted: false,
    shell: null,
    databaseClean: false,
    faceApi: api,
    faceGroupId: groupId,
    facePersonId: "",
    storedPhoto: null
  };
  try {
    const [existingBusiness, existingAuth] = await Promise.all([
      readBusinessByPhone(phone),
      exactAuthByPhone(phone)
    ]);
    if (existingBusiness || existingAuth) {
      fail("该手机号已存在人员或登录账号，不能重复创建老师。", "PHONE_ALREADY_PROVISIONED");
    }
    const quality = await inspectFaceImage(api, base64);
    const liveness = await inspectLiveness(api, base64);
    const faceResult = await api.CreatePerson({ GroupId: groupId, PersonId: personId, PersonName: name,
      Image: base64, UniquePersonControl: 0, QualityControl: 3, NeedRotateDetection: 0 });
    if (!faceResult?.FaceId) fail("人脸服务没有返回有效 FaceId，老师未创建。", "FACE_ENROLLMENT_INCOMPLETE");
    context.facePersonId = personId;
    context.storedPhoto = await uploadAttendancePhoto(personId, buffer);
    const authentication = await createActiveAuthentication({
      phone, name, password, clientRequestId, lifecycle: context
    });
    context.databaseAttempted = true;
    context.shell = await insertTeacherRecord({
      uid: authentication.uid, phone, name, hqStaffId: hq.staffId,
      face: { personId, faceId: faceResult.FaceId, photo: context.storedPhoto, quality, liveness,
        requestId: faceResult.RequestId || quality.requestId || "" }
    });
    return successResponse({ uid: authentication.uid, shell: context.shell });
  } catch (error) {
    let cleanupError = null;
    try { await cleanupFailure(context, error); }
    catch (failure) { cleanupError = failure; }
    const externalFailures = [];
    if (context.databaseClean) {
      await deleteAttendancePhoto(context.storedPhoto).catch((failure) => {
        externalFailures.push({ stage: "PHOTO_DELETE", code: failure?.code || "CLEANUP_FAILED" });
        console.error("attendance photo cleanup failed", failure);
      });
      await deleteFacePerson(context.faceApi, context.faceGroupId, context.facePersonId)
        .catch((failure) => {
          externalFailures.push({ stage: "FACE_DELETE", code: failure?.code || "CLEANUP_FAILED" });
          console.error("attendance face cleanup failed", failure);
        });
    }
    if (externalFailures.length) {
      const incomplete = cleanupError || new Error(`${error.message} 失败资料尚未全部清理，请查看云函数日志。`);
      incomplete.code = "TEACHER_CREATE_CLEANUP_INCOMPLETE";
      incomplete.cause ||= error;
      incomplete.cleanup = [...(incomplete.cleanup || []), ...externalFailures];
      throw incomplete;
    }
    if (cleanupError) throw cleanupError;
    throw error;
  }
}

function health() {
  const hasEnv = (name) => Boolean(String(process.env[name] || "").trim());
  return {
    ok: true,
    version: FUNCTION_VERSION,
    actions: ["health", "createTeacher", "recoverTeacherCreation"],
    configured: {
      cloudbaseEnv: hasEnv("CLOUDBASE_ENV_ID") || hasEnv("TCB_ENV"),
      face: hasEnv("FACE_SECRET_ID") && hasEnv("FACE_SECRET_KEY") && hasEnv("FACE_GROUP_ID"),
      privatePhotoStorage: hasEnv("CLOUDBASE_APIKEY") || hasEnv("CLOUDBASE_SERVICE_ROLE_KEY")
    }
  };
}

exports.main = async (event = {}) => {
  try {
    const action = String(event.action || "health").trim();
    if (action === "health") return health();
    if (action === "createTeacher") return await createTeacher(event);
    if (action === "recoverTeacherCreation") return await recoverTeacherCreation(event);
    fail("不支持的 teacherCreate 动作。", "UNKNOWN_ACTION");
  } catch (error) {
    return errorResponse(error);
  }
};

exports._test = {
  successResponse,
  errorResponse,
  teacherName,
  phoneNumber,
  passwordValue
};
