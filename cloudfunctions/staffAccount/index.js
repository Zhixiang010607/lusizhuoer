"use strict";

/*
 * 员工账号云函数
 * CloudBase 身份认证只负责手机号、密码和验证码。
 * 业务身份只保存在 PostgreSQL 的 public.staff_accounts 表，绝不写入 user_desc JSON。
 */
const ROLES = new Set(["hq", "operation", "store", "teacher"]);
let app = null;
let auth = null;
let rdbClient = null;
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

function rdb() {
  if (!rdbClient) rdbClient = getApp().rdb();
  return rdbClient;
}

function manager() {
  if (!managerClient) {
    const CloudBaseManager = require("@cloudbase/manager-node");
    managerClient = CloudBaseManager.init({ envId: process.env.TCB_ENV });
  }
  return managerClient;
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
  const { data, error } = await rdb()
    .from("staff_accounts")
    .select("id, staff_name, role_code, account_status")
    .eq("auth_uid", String(uid))
    .limit(1);
  asDatabaseError(error, "读取员工身份");
  const staff = data?.[0];
  if (!staff || !ROLES.has(staff.role_code)) return null;
  if (staff.account_status !== "ACTIVE") fail("该人员账号已封存，无法登录", "ARCHIVED_ACCOUNT");

  let storeId = "";
  if (staff.role_code === "store") {
    const assignment = await rdb()
      .from("staff_store_assignments")
      .select("store_id")
      .eq("staff_account_id", staff.id)
      .eq("assignment_status", "ACTIVE")
      .limit(1);
    asDatabaseError(assignment.error, "读取门店绑定");
    storeId = assignment.data?.[0]?.store_id ? String(assignment.data[0].store_id) : "";
    if (!storeId) fail("该门店账号尚未绑定有效门店", "UNASSIGNED_STORE");
    const store = await rdb().from("stores").select("store_status").eq("id", Number(storeId)).limit(1);
    asDatabaseError(store.error, "读取门店状态");
    if (store.data?.[0]?.store_status !== "ACTIVE") fail("关联门店已封存，无法登录", "ARCHIVED_STORE");
  }
  if (staff.role_code === "teacher") {
    const teacher = await rdb().from("teachers").select("teacher_status").eq("staff_account_id", staff.id).limit(1);
    asDatabaseError(teacher.error, "读取老师状态");
    if (teacher.data?.[0]?.teacher_status === "ARCHIVED") fail("该老师资料已封存，无法登录", "ARCHIVED_TEACHER");
  }
  return { staffId: staff.id, role: staff.role_code, staffName: staff.staff_name, storeId };
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

async function currentUser() {
  const { uid } = getAuth().getUserInfo();
  if (!uid) fail("请先完成手机号登录", "UNAUTHENTICATED");
  let userInfo = {};
  try {
    const result = await getAuth().getEndUserInfo(uid);
    userInfo = result?.userInfo || {};
  } catch (_) {
    // User details are only needed when the bootstrap HQ account is first created.
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
  const phone = validatePhone(caller.userInfo?.phone || caller.userInfo?.phoneNumber || caller.userInfo?.phone_number);
  const staffName = String(caller.userInfo?.nickName || caller.userInfo?.name || "总部管理员");
  const { error } = await rdb().from("staff_accounts").insert({
    auth_uid: caller.uid,
    phone,
    staff_name: staffName,
    role_code: "hq",
    account_status: "ACTIVE"
  });
  asDatabaseError(error, "初始化总部账户");
  return findStaffProfile(caller.uid);
}

async function createStaffDatabaseProfile({ uid, phone, staffName, role, storeId }) {
  const { data, error } = await rdb().from("staff_accounts").insert({
    auth_uid: uid,
    phone,
    staff_name: staffName,
    role_code: role,
    account_status: "ACTIVE"
  });
  asDatabaseError(error, "保存员工业务身份");
  const profile = { staffId: data?.[0]?.id || null, role, staffName, storeId: "" };
  if (role !== "store") return profile;
  const staffId = data?.[0]?.id;
  if (!staffId) fail("员工身份保存后未返回账号编号", "DATABASE_ERROR");
  const { error: assignmentError } = await rdb().from("staff_store_assignments").insert({
    staff_account_id: staffId,
    store_id: Number(storeId),
    assignment_status: "ACTIVE"
  });
  asDatabaseError(assignmentError, "绑定门店");
  profile.storeId = String(storeId);
  return profile;
}

async function main(event = {}) {
  const action = event.action || "session";
  if (action === "health") return { ok: true, message: "员工账号云函数已就绪" };
  const caller = await currentUser();

  if (action === "session") {
    if (!caller.profile && String(caller.uid) === String(process.env.BOOTSTRAP_HQ_UID || "")) {
      caller.profile = await ensureBootstrapHq(caller);
    }
    if (!caller.profile) fail("该手机号尚未被总部绑定业务身份", "UNASSIGNED_PHONE");
    return { ok: true, uid: caller.uid, profile: caller.profile };
  }
  if (action === "bootstrapHq") {
    return { ok: true, profile: await ensureBootstrapHq(caller) };
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
    let lookup = rdb().from("staff_accounts").select("id, auth_uid, role_code");
    lookup = uid ? lookup.eq("auth_uid", uid) : lookup.eq("phone", phone);
    const { data, error } = await lookup.limit(1);
    asDatabaseError(error, "查找人员账号");
    const staff = data?.[0];
    if (!staff) fail("未找到该人员账号", "NOT_FOUND");
    const updated = await rdb().from("staff_accounts").update({ account_status: status, updated_at: new Date().toISOString() }).eq("id", staff.id);
    asDatabaseError(updated.error, "更新人员状态");
    if (staff.role_code === "teacher") {
      const teacherUpdate = await rdb().from("teachers").update({ teacher_status: status, updated_at: new Date().toISOString() }).eq("staff_account_id", staff.id);
      asDatabaseError(teacherUpdate.error, "同步老师资料状态");
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
