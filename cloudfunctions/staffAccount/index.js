"use strict";

/*
 * 员工账号云函数
 * CloudBase 身份认证只负责手机号、密码和验证码。
 * 业务身份只保存在 PostgreSQL 的 public.staff_accounts 表，绝不写入 user_desc JSON。
 */
const cloudbase = require("@cloudbase/node-sdk");

const app = cloudbase.init({});
const auth = app.auth();
const ROLES = new Set(["hq", "operation", "store", "teacher"]);
let rdbClient = null;
let managerClient = null;

function rdb() {
  if (!rdbClient) rdbClient = app.rdb();
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
    .eq("account_status", "ACTIVE")
    .limit(1);
  asDatabaseError(error, "读取员工身份");
  const staff = data?.[0];
  if (!staff || !ROLES.has(staff.role_code)) return null;

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
  const { uid } = auth.getUserInfo();
  if (!uid) fail("请先完成手机号登录", "UNAUTHENTICATED");
  let userInfo = {};
  try {
    const result = await auth.getEndUserInfo(uid);
    userInfo = result?.userInfo || {};
  } catch (_) {
    // 身份认证资料不完整时，首个总部仍可由 BOOTSTRAP_HQ_UID 恢复登录。
  }
  // 总部会话是登录链路的最低依赖：不等待数据库或管理 SDK 初始化。
  // 因此即使员工管理功能临时故障，总部仍可正常登录、排查和恢复。
  const bootstrapProfile = bootstrapHqProfile(uid, userInfo);
  if (bootstrapProfile) return { uid: String(uid), userInfo, profile: bootstrapProfile };
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
  if (role !== "store") return;
  const staffId = data?.[0]?.id;
  if (!staffId) fail("员工身份保存后未返回账号编号", "DATABASE_ERROR");
  const { error: assignmentError } = await rdb().from("staff_store_assignments").insert({
    staff_account_id: staffId,
    store_id: Number(storeId),
    assignment_status: "ACTIVE"
  });
  asDatabaseError(assignmentError, "绑定门店");
}

exports.main = async (event = {}) => {
  const action = event.action || "session";
  if (action === "health") return { ok: true, message: "员工账号云函数已就绪" };
  const caller = await currentUser();

  if (action === "session") {
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
    await createStaffDatabaseProfile({ uid, phone, staffName, role, storeId });
    return { ok: true, uid, phone, profile: await findStaffProfile(uid) };
  }
  if (action === "resetPassword") {
    requireHq(caller);
    const uid = String(event.uid || "").trim();
    if (!uid) fail("缺少员工 UID");
    await manager().user.modifyUser({ uid, password: validatePassword(event.newPassword) });
    return { ok: true };
  }
  fail("不支持的操作");
};
