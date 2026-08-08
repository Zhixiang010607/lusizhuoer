"use strict";

/*
 * 员工账号云函数
 * CloudBase 身份认证只负责手机号、密码和验证码。
 * 业务身份只保存在 PostgreSQL 的 public.staff_accounts 表，绝不写入 user_desc JSON。
 */
const ROLES = new Set(["hq", "operation", "store", "teacher"]);
let app = null;
let auth = null;
let managerClient = null;

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
    managerClient = CloudBaseManager.init({ envId: process.env.TCB_ENV });
  }
  return managerClient;
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
  const result = await manager().database.executePGSql({ Sql: sql });
  return parseSqlRows(result);
}

function fail(message, code = "BAD_REQUEST") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function validatePhone(phone) {
  const value = String(phone || "").replace(/\D/g, "");
  if (!/^1[3-9]\d{9}$/.test(value)) fail("手机号必须是 11 位中国大陆手机号");
  return value;
}

function validatePassword(password) {
  const value = String(password || "");
  const groups = [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z\d]/].filter((rule) => rule.test(value)).length;
  if (value.length < 8 || value.length > 32 || groups < 3) {
    fail("初始密码须为 8-32 位，并包含大写、小写、数字、特殊字符中的至少三类");
  }
  return value;
}

function asDatabaseError(error, action) {
  if (error) fail(`${action}失败：${error.message || "数据库暂不可用"}`, "DATABASE_ERROR");
}

async function findStaffProfile(uid) {
  let rows;
  try {
    rows = await executeSql(
      `SELECT a.id, a.staff_name, a.role_code, a.account_status,
        sa.store_id, s.store_status, t.id AS teacher_id, t.teacher_status
       FROM public.staff_accounts a
       LEFT JOIN public.staff_store_assignments sa
         ON sa.staff_account_id = a.id AND sa.assignment_status = 'ACTIVE'
       LEFT JOIN public.stores s ON s.id = sa.store_id
       LEFT JOIN public.teachers t ON t.staff_account_id = a.id
       WHERE a.auth_uid = ${sqlText(uid)}
       LIMIT 1`
    );
  } catch (error) {
    asDatabaseError(error, "读取员工身份");
  }
  const staff = rows?.[0];
  if (!staff || !ROLES.has(staff.role_code)) return null;
  if (staff.account_status !== "ACTIVE") fail("该人员账号已封存，无法登录", "ARCHIVED_ACCOUNT");

  let storeId = "";
  if (staff.role_code === "store") {
    storeId = staff.store_id ? String(staff.store_id) : "";
    if (!storeId) fail("该门店账号尚未绑定有效门店", "UNASSIGNED_STORE");
    if (staff.store_status !== "ACTIVE") fail("关联门店已封存，无法登录", "ARCHIVED_STORE");
  }
  if (staff.role_code === "teacher") {
    if (staff.teacher_status === "ARCHIVED") fail("该老师资料已封存，无法登录", "ARCHIVED_TEACHER");
  }
  return { staffId: staff.id, role: staff.role_code, staffName: staff.staff_name, storeId };
}

async function recoverStaffProfileByVerifiedPhone(uid, phone) {
  const normalizedPhone = validatePhone(phone);
  let identity;
  try {
    identity = await getAuth().queryUserInfo({ platform: "PHONE", platformId: normalizedPhone });
  } catch (error) {
    console.warn("Could not verify caller phone for staff recovery", error?.message || error);
    return null;
  }

  if (String(identity?.userInfo?.uid || "") !== String(uid)) return null;

  let rows;
  try {
    rows = await executeSql(
      `SELECT id, account_status FROM public.staff_accounts WHERE phone = ${sqlText(normalizedPhone)} LIMIT 1`
    );
  } catch (error) {
    asDatabaseError(error, "Read staff account by verified phone");
  }
  const staff = rows?.[0];
  if (!staff) return null;
  if (staff.account_status !== "ACTIVE") fail("This staff account is archived and cannot sign in", "ARCHIVED_ACCOUNT");

  try {
    await executeSql(
      `UPDATE public.staff_accounts SET auth_uid = ${sqlText(uid)}, updated_at = NOW() WHERE id = ${Number(staff.id)}`
    );
  } catch (error) {
    asDatabaseError(error, "Restore staff account binding");
  }
  return findStaffProfile(uid);
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
  if (!uid) fail("请先完成手机号登录", "UNAUTHENTICATED");
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

async function createStaffDatabaseProfile({ uid, phone, staffName, role, storeId }) {
  let rows;
  try {
    rows = await executeSql(
      `INSERT INTO public.staff_accounts (auth_uid, phone, staff_name, role_code, account_status) VALUES (${sqlText(uid)}, ${sqlText(phone)}, ${sqlText(staffName)}, ${sqlText(role)}, 'ACTIVE') RETURNING id`
    );
  } catch (error) {
    asDatabaseError(error, "保存员工业务身份");
  }
  const profile = { staffId: rows?.[0]?.id || null, role, staffName, storeId: "" };
  if (role !== "store") return profile;
  const staffId = rows?.[0]?.id;
  if (!staffId) fail("员工身份保存后未返回账号编号", "DATABASE_ERROR");
  try {
    await executeSql(
      `INSERT INTO public.staff_store_assignments (staff_account_id, store_id, assignment_status) VALUES (${Number(staffId)}, ${Number(storeId)}, 'ACTIVE')`
    );
  } catch (error) {
    asDatabaseError(error, "绑定门店");
  }
  profile.storeId = String(storeId);
  return profile;
}

async function main(event = {}) {
  const action = event.action || "session";
  if (action === "health") return { ok: true, message: "员工账号云函数已就绪" };
  const caller = await currentUser(false);

  if (action === "session") {
    if (!caller.profile && event.phone) {
      caller.profile = await recoverStaffProfileByVerifiedPhone(caller.uid, event.phone);
    }
    if (!caller.profile && String(caller.uid) === String(process.env.BOOTSTRAP_HQ_UID || "")) {
      caller.profile = await ensureBootstrapHq(caller);
    }
    if (!caller.profile) {
      fail(`该手机号尚未被总部绑定业务身份。Current auth UID: ${caller.uid}`, "UNASSIGNED_PHONE");
    }
    return { ok: true, uid: caller.uid, profile: caller.profile };
  }
  if (action === "bootstrapHq") {
    return { ok: true, profile: await ensureBootstrapHq(caller) };
  }
  if (action === "listStaff") {
    requireHq(caller);
    const role = String(event.role || "");
    if (!ROLES.has(role)) fail("Unsupported staff role");
    const codePrefix = role === "teacher" ? "T" : role === "operation" ? "OP" : role === "hq" ? "HQ" : "S";
    const rows = await executeSql(
      `SELECT id, auth_uid, phone, staff_name, role_code, account_status, ${sqlText(codePrefix)} || LPAD(id::text, 3, '0') AS person_code FROM public.staff_accounts WHERE role_code = ${sqlText(role)} ORDER BY id ASC`
    );
    return { ok: true, staff: rows };
  }
  if (action === "provisionStaff") {
    requireHq(caller);
    const staffName = String(event.staffName || "").trim();
    const phone = validatePhone(event.phone);
    const role = String(event.role || "");
    const storeId = String(event.storeId || "").trim();
    const password = validatePassword(event.initialPassword);
    if (!staffName) fail("请填写员工姓名");
    if (!ROLES.has(role)) fail("员工角色必须是总部、运营、门店或老师");
    if (role === "store" && !/^\d+$/.test(storeId)) fail("门店员工必须绑定已创建门店的数字编号");

    const created = await manager().user.createUser({
      name: `staff_${phone}`,
      password,
      type: "internalUser",
      userStatus: "ACTIVE",
      nickName: staffName,
      phone,
      description: "业务员工登录账号"
    });
    const uid = String(created?.Data?.Uid || "");
    if (!uid) fail("认证账号已创建，但未返回 UID；请勿重复提交并联系总部处理", "AUTH_CREATE_INCOMPLETE");
    const profile = await createStaffDatabaseProfile({ uid, phone, staffName, role, storeId });
    return { ok: true, uid, phone, profile };
  }
  if (action === "resetPassword") {
    requireHq(caller);
    const uid = String(event.uid || "").trim();
    if (!uid) fail("缺少员工 UID");
    await manager().user.modifyUser({ uid, password: validatePassword(event.newPassword) });
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
        `SELECT id, auth_uid, role_code FROM public.staff_accounts WHERE ${column} = ${sqlText(value)} LIMIT 1`
      );
    } catch (error) {
      asDatabaseError(error, "查找人员账号");
    }
    const staff = rows?.[0];
    if (!staff) fail("未找到该人员账号", "NOT_FOUND");
    try {
      await executeSql(
        `UPDATE public.staff_accounts SET account_status = ${sqlText(status)}, updated_at = NOW() WHERE id = ${Number(staff.id)}`
      );
    } catch (error) {
      asDatabaseError(error, "更新人员状态");
    }
    if (staff.role_code === "teacher") {
      try {
        await executeSql(
          `UPDATE public.teachers SET teacher_status = ${sqlText(status)}, updated_at = NOW() WHERE staff_account_id = ${Number(staff.id)}`
        );
      } catch (error) {
        asDatabaseError(error, "同步老师资料状态");
      }
    }
    await manager().user.modifyUser({ uid: staff.auth_uid, userStatus: status === "ACTIVE" ? "ACTIVE" : "BLOCKED" });
    return { ok: true, uid: staff.auth_uid, status };
  }
  fail("不支持的操作");
}

exports.main = async (event = {}) => {
  try {
    return await main(event);
  } catch (error) {
    console.error("staffAccount failed", {
      action: event?.action || "session",
      code: error?.code || "FUNCTION_ERROR",
      message: error?.message || String(error),
      stack: error?.stack
    });
    return { ok: false, code: error?.code || "FUNCTION_ERROR", message: error?.message || "员工账号服务暂不可用，请稍后重试" };
  }
};
