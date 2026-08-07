"use strict";

/*
 * 员工账号云函数
 *
 * 身份信息仅保存在 CloudBase 内部用户的 description 字段中；前端不能指定角色。
 * 部署前在此云函数环境变量中配置一次 BOOTSTRAP_HQ_UID，用于首次把总部管理员设为 hq。
 */
const cloudbase = require("@cloudbase/node-sdk");
const CloudBaseManager = require("@cloudbase/manager-node");
// 云函数环境会自动使用当前 CloudBase 环境，无需把环境 ID 或密钥写进代码。
const app = cloudbase.init({});
const auth = app.auth();
const manager = CloudBaseManager.init({ envId: process.env.TCB_ENV });

const ROLES = new Set(["hq", "operation", "store", "teacher"]);

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

function cleanProfile(value) {
  if (!value || typeof value !== "object" || !ROLES.has(value.role)) return null;
  return {
    role: value.role,
    staffName: String(value.staffName || ""),
    storeId: value.role === "store" ? String(value.storeId || "") : ""
  };
}

function parseProfile(description) {
  try { return cleanProfile(JSON.parse(description || "")); } catch (_) { return null; }
}

async function currentUser() {
  const { uid } = auth.getUserInfo();
  if (!uid) fail("请先完成手机号登录", "UNAUTHENTICATED");
  const { userInfo } = await auth.getEndUserInfo(uid);
  if (!userInfo) fail("未找到当前登录用户", "UNAUTHENTICATED");
  return { uid, userInfo, profile: parseProfile(userInfo.description) };
}

function requireHq(caller) {
  if (caller.profile?.role !== "hq") fail("仅总部账号可以管理员工账号", "FORBIDDEN");
}

exports.main = async (event = {}) => {
  const action = event.action || "session";

  if (action === "health") return { ok: true, message: "员工账号云函数已就绪" };

  const caller = await currentUser();

  if (action === "session") {
    if (!caller.profile) fail("该手机号尚未被总部绑定业务身份", "UNASSIGNED_PHONE");
    return {
      ok: true,
      uid: caller.uid,
      phone: caller.userInfo.phone || "",
      profile: caller.profile
    };
  }

  if (action === "bootstrapHq") {
    if (!process.env.BOOTSTRAP_HQ_UID || caller.uid !== process.env.BOOTSTRAP_HQ_UID) {
      fail("首次总部初始化未获授权", "FORBIDDEN");
    }
    const staffName = String(event.staffName || caller.userInfo.nickName || "总部管理员").trim();
    const profile = { role: "hq", staffName, storeId: "" };
    await manager.user.modifyUser({ uid: caller.uid, description: JSON.stringify(profile) });
    return { ok: true, profile };
  }

  if (action === "provisionStaff") {
    requireHq(caller);
    const staffName = String(event.staffName || "").trim();
    const phone = validatePhone(event.phone);
    const role = String(event.role || "");
    const storeId = String(event.storeId || "").trim();
    const password = validatePassword(event.initialPassword);
    if (!staffName) fail("请填写员工姓名");
    if (!ROLES.has(role) || role === "hq") fail("员工角色必须是运营、门店或老师");
    if (role === "store" && !storeId) fail("门店员工必须绑定门店");

    const profile = { role, staffName, storeId: role === "store" ? storeId : "" };
    const created = await manager.user.createUser({
      name: `staff_${phone}`,
      password,
      type: "internalUser",
      userStatus: "ACTIVE",
      nickName: staffName,
      phone,
      description: JSON.stringify(profile)
    });
    return { ok: true, uid: created?.Data?.Uid || "", phone, profile };
  }

  if (action === "resetPassword") {
    requireHq(caller);
    const uid = String(event.uid || "").trim();
    if (!uid) fail("缺少员工 UID");
    await manager.user.modifyUser({ uid, password: validatePassword(event.newPassword) });
    return { ok: true };
  }

  fail("不支持的操作");
};
