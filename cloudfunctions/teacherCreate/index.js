"use strict";

const crypto = require("node:crypto");
const cloudbase = require("@cloudbase/node-sdk");
const CloudBaseManager = require("@cloudbase/manager-node");

const FUNCTION_VERSION = "teacher-create-v6";
let cloudApp = null;
let managerClient = null;

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

async function insertTeacherRecord({ uid, phone, name }) {
  await executeSql(
    `WITH account AS (
       INSERT INTO public.staff_accounts
         (auth_uid, phone, staff_name, role_code, account_status)
       VALUES (${sqlText(uid)}, ${sqlText(phone)}, ${sqlText(name)}, 'teacher', 'ACTIVE')
       RETURNING id
     )
     INSERT INTO public.teachers
       (teacher_code, teacher_name, staff_account_id, teacher_status)
     SELECT 'TCHF' || account.id::text, ${sqlText(name)}, account.id, 'ACTIVE'
       FROM account
     ON CONFLICT (staff_account_id) DO UPDATE
       SET teacher_name = EXCLUDED.teacher_name,
           teacher_status = 'ACTIVE',
           updated_at = NOW()`
  );
  const row = await readBusinessByPhone(phone);
  if (!row?.staff_id || !row?.teacher_id
      || String(row.auth_uid || "") !== uid
      || String(row.role_code || "") !== "teacher"
      || String(row.account_status || "") !== "ACTIVE"
      || String(row.teacher_status || "") !== "ACTIVE") {
    fail("老师资料写入后未读取到完整的活跃账号和老师主档。", "DATABASE_ERROR");
  }
  return row;
}

async function rollbackDatabase({ shell, uid, phone }) {
  if (!shell?.staff_id) return;
  await executeSql(
    `WITH deleted_teacher AS (
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
    await attempt("DATABASE_ROLLBACK", () => rollbackDatabase(context));
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
    proof: {
      complete: true,
      teacherStatus: "ACTIVE",
      accountStatus: "ACTIVE",
      authStatus: "ACTIVE"
    }
  };
}

async function createTeacher(event) {
  await requireHq();
  const name = teacherName(event.staffName || event.teacherName);
  const phone = phoneNumber(event.phone);
  const password = passwordValue(event.initialPassword);
  const clientRequestId = requestKey(event.clientRequestId);
  const context = {
    phone,
    uid: "",
    clientRequestId,
    authAttempted: false,
    authCreated: false,
    databaseAttempted: false,
    shell: null
  };
  try {
    const [existingBusiness, existingAuth] = await Promise.all([
      readBusinessByPhone(phone),
      exactAuthByPhone(phone)
    ]);
    if (existingBusiness || existingAuth) {
      fail("该手机号已存在人员或登录账号，不能重复创建老师。", "PHONE_ALREADY_PROVISIONED");
    }
    const authentication = await createActiveAuthentication({
      phone, name, password, clientRequestId, lifecycle: context
    });
    context.databaseAttempted = true;
    context.shell = await insertTeacherRecord({ uid: authentication.uid, phone, name });
    return successResponse({ uid: authentication.uid, shell: context.shell });
  } catch (error) {
    await cleanupFailure(context, error);
    throw error;
  }
}

function health() {
  const hasEnv = (name) => Boolean(String(process.env[name] || "").trim());
  return {
    ok: true,
    version: FUNCTION_VERSION,
    actions: ["health", "createTeacher"],
    configured: {
      cloudbaseEnv: hasEnv("CLOUDBASE_ENV_ID") || hasEnv("TCB_ENV")
    }
  };
}

exports.main = async (event = {}) => {
  try {
    const action = String(event.action || "health").trim();
    if (action === "health") return health();
    if (action === "createTeacher") return await createTeacher(event);
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
