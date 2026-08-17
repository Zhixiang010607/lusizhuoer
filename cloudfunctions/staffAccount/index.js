"use strict";

/*
 * 员工账号云函数
 * CloudBase 身份认证只负责手机号、密码和验证码。
 * 业务身份只保存在 PostgreSQL 的 public.staff_accounts 表，绝不写入 user_desc JSON。
 */
const ROLES = new Set(["hq", "operation", "store", "teacher"]);
// Change this whenever the function contract changes. It is intentionally
// non-sensitive and lets the CloudBase console confirm the deployed source.
const FUNCTION_VERSION = "2026-08-18-review-query-modes-v13";
let app = null;
let auth = null;
let managerClient = null;
let storeBindingLayout = null;
let storeCreationCapabilities = null;

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

function databaseBoolean(value) {
  return [true, "true", "t", 1, "1"].includes(value);
}

async function getStoreBindingLayout() {
  if (storeBindingLayout) return storeBindingLayout;
  let rows;
  try {
    rows = await executeSql(
      `SELECT
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'stores' AND column_name = 'store_account_id'
        ) AS has_store_account_id,
        EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'staff_store_assignments'
        ) AS has_staff_store_assignments`
    );
  } catch (error) {
    asDatabaseError(error, "读取门店绑定结构");
  }
  const layout = rows?.[0] || {};
  if (databaseBoolean(layout.has_store_account_id)) {
    storeBindingLayout = "stores";
    return storeBindingLayout;
  }
  if (databaseBoolean(layout.has_staff_store_assignments)) {
    storeBindingLayout = "assignments";
    return storeBindingLayout;
  }
  fail("数据库缺少门店账号绑定结构，请先执行完整数据库建表脚本", "DATABASE_SCHEMA_MISSING");
}

async function getStoreCreationCapabilities() {
  if (storeCreationCapabilities) return storeCreationCapabilities;
  let rows;
  try {
    rows = await executeSql(
      `SELECT
        EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'stores'
        ) AS has_stores,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'stores' AND column_name = 'contacts_json'
        ) AS has_contacts_json,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'stores' AND column_name = 'created_by'
        ) AS has_created_by,
        EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'store_contacts'
        ) AS has_store_contacts,
        COALESCE((
          SELECT column_default
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'stores' AND column_name = 'store_code'
          LIMIT 1
        ), '') AS store_code_default`
    );
  } catch (error) {
    asDatabaseError(error, "读取门店创建结构");
  }
  const row = rows?.[0] || {};
  if (!databaseBoolean(row.has_stores)) {
    fail("数据库缺少 stores 表，请先执行完整数据库建表脚本", "DATABASE_SCHEMA_MISSING");
  }
  if (!databaseBoolean(row.has_contacts_json) && !databaseBoolean(row.has_store_contacts)) {
    fail("数据库缺少门店联系人结构，请先执行完整数据库建表脚本", "DATABASE_SCHEMA_MISSING");
  }
  storeCreationCapabilities = {
    contactsJson: databaseBoolean(row.has_contacts_json),
    createdBy: databaseBoolean(row.has_created_by),
    storeContacts: databaseBoolean(row.has_store_contacts),
    storeCodeHasDefault: Boolean(String(row.store_code_default || "").trim())
  };
  return storeCreationCapabilities;
}

function fail(message, code = "BAD_REQUEST") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function requestIdFrom(error) {
  return String(error?.RequestId || error?.requestId || error?.response?.RequestId || "");
}

function cloudErrorDetails(error) {
  const nested = error?.response?.data?.Response?.Error ||
    error?.response?.Response?.Error ||
    error?.data?.Response?.Error ||
    error?.response?.Error ||
    {};
  return {
    code: String(error?.code || error?.Code || nested?.Code || "").trim(),
    message: String(error?.message || error?.Message || nested?.Message || "").trim().slice(0, 300)
  };
}

function stageFail(stage, message, code, cause) {
  const requestId = requestIdFrom(cause);
  const causeDetails = cloudErrorDetails(cause);
  console.error("staff account provision failed", {
    stage,
    code,
    requestId: requestId || undefined,
    causeCode: causeDetails.code || undefined,
    causeMessage: causeDetails.message || undefined
  });
  const error = new Error(message);
  error.code = code;
  error.stage = stage;
  error.requestId = requestId || undefined;
  error.causeCode = causeDetails.code || undefined;
  error.causeMessage = causeDetails.message || undefined;
  throw error;
}

function isDuplicateAuthError(error) {
  const text = `${error?.code || ""} ${error?.message || ""} ${error?.response?.Code || ""} ${error?.response?.Message || ""}`.toLowerCase();
  return text.includes("duplicatedata") ||
    text.includes("duplicate") ||
    text.includes("duplicated") ||
    text.includes("already exist") ||
    text.includes("already registered") ||
    text.includes("已存在") ||
    text.includes("已注册");
}

function managerDependencyInstalled() {
  try {
    require.resolve("@cloudbase/manager-node");
    return true;
  } catch (_) {
    return false;
  }
}

function normalizedMainlandPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length === 13 && digits.startsWith("86") ? digits.slice(2) : digits;
}

async function describeAuthUsersByPhone(phone) {
  try {
    return await manager().user.describeUserList({ phone, pageNo: 1, pageSize: 20 });
  } catch (error) {
    stageFail(
      "AUTH_LOOKUP",
      "无法读取认证账号。请确认云函数已点击“保存并安装依赖”，并检查函数权限。",
      "AUTH_LOOKUP_FAILED",
      error
    );
  }
}

async function describeAuthUsersByName(name) {
  try {
    return await manager().user.describeUserList({ name, pageNo: 1, pageSize: 20 });
  } catch (error) {
    stageFail(
      "AUTH_LOOKUP",
      "无法按登录名读取认证账号。请检查云函数的用户管理权限。",
      "AUTH_LOOKUP_FAILED",
      error
    );
  }
}

async function findAuthUserByExactPhone(phone) {
  const responses = [await describeAuthUsersByPhone(phone)];
  let users = responses[0]?.Data?.UserList || [];
  let matches = users.filter((user) => normalizedMainlandPhone(user?.Phone) === phone);

  // Some CloudBase accounts are returned with an E.164-style +86 prefix.
  // The phone filter is fuzzy, but not every console/runtime version treats
  // the 11-digit and +86 forms identically, so retry the prefixed form once.
  if (!matches.length) {
    const prefixed = await describeAuthUsersByPhone(`+86${phone}`);
    responses.push(prefixed);
    users = [...users, ...(prefixed?.Data?.UserList || [])];
    const uniqueUsers = Array.from(new Map(users.map((user) => [String(user?.Uid || ""), user])).values());
    matches = uniqueUsers.filter((user) => normalizedMainlandPhone(user?.Phone) === phone);
  }
  if (!matches.length) {
    const username = `staff_${phone}`;
    const byName = await describeAuthUsersByName(username);
    responses.push(byName);
    const nameMatches = (byName?.Data?.UserList || []).filter((user) => String(user?.Name || "") === username);
    if (nameMatches.length > 1) {
      const error = new Error("Multiple identity users share this generated username");
      error.RequestId = byName?.RequestId;
      stageFail(
        "AUTH_LOOKUP",
        "认证系统返回多个同登录名账号，请由总部先处理认证账号。",
        "AUTH_USERNAME_AMBIGUOUS",
        error
      );
    }
    const namedUser = nameMatches[0] || null;
    if (namedUser) {
      const namedPhone = normalizedMainlandPhone(namedUser?.Phone);
      if (namedPhone && namedPhone !== phone) {
        fail("该登录名已绑定其他手机号，请由总部先处理认证账号", "AUTH_USERNAME_CONFLICT");
      }
      if (!namedPhone) {
        try {
          await manager().user.modifyUser({ uid: String(namedUser.Uid), phone });
          namedUser.Phone = phone;
        } catch (error) {
          const cause = cloudErrorDetails(error);
          const diagnostic = [cause.code, cause.message].filter(Boolean).join("：");
          stageFail(
            "AUTH_REPAIR",
            `检测到未绑定手机号的已有登录账号，但补充手机号失败。${diagnostic ? `腾讯云返回 ${diagnostic}。` : "请检查云函数的用户管理权限。"}`,
            "AUTH_PHONE_REPAIR_FAILED",
            error
          );
        }
      }
      matches = [namedUser];
    }
  }
  if (matches.length > 1) {
    const error = new Error("Multiple identity users share this phone");
    error.RequestId = responses.map((response) => response?.RequestId).filter(Boolean).join(",");
    stageFail(
      "AUTH_LOOKUP",
      "认证系统返回了多个同手机号账号，请由总部先处理认证账号。",
      "AUTH_PHONE_AMBIGUOUS",
      error
    );
  }
  return matches[0] || null;
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
    const layout = await getStoreBindingLayout();
    const storeJoin = layout === "stores"
      ? "LEFT JOIN public.stores s ON s.store_account_id = a.id"
      : "LEFT JOIN public.staff_store_assignments sa ON sa.staff_account_id = a.id AND sa.assignment_status = 'ACTIVE' LEFT JOIN public.stores s ON s.id = sa.store_id";
    rows = await executeSql(
      `SELECT a.id, a.staff_name, a.role_code, a.account_status,
        a.password_initialized_at, a.password_changed_at, a.password_change_required,
        s.id AS store_id, s.store_status, t.id AS teacher_id, t.teacher_status
       FROM public.staff_accounts a
       ${storeJoin}
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
  return {
    staffId: staff.id,
    staffCode: `${staff.role_code === "hq" ? "HQ" : staff.role_code === "operation" ? "OP" : staff.role_code === "teacher" ? "TCH" : "S"}${String(staff.id).padStart(3, "0")}`,
    role: staff.role_code,
    staffName: staff.staff_name,
    storeId,
    passwordChangeRequired: [true, "true", "t", 1, "1"].includes(staff.password_change_required),
    passwordInitializedAt: staff.password_initialized_at || null,
    passwordChangedAt: staff.password_changed_at || null
  };
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

function requireReviewer(caller) {
  if (!["hq", "operation"].includes(caller.profile?.role)) {
    fail("仅总部或运营账号可以审核业务工单", "FORBIDDEN");
  }
}

function requireStore(caller) {
  if (caller.profile?.role !== "store" || !caller.profile?.storeId) {
    fail("仅已绑定门店的门店账号可以提交作废申请", "FORBIDDEN");
  }
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
  let existingRows;
  try {
    existingRows = await executeSql(
      `SELECT id, auth_uid, role_code FROM public.staff_accounts WHERE phone = ${sqlText(phone)} LIMIT 1`
    );
  } catch (error) {
    asDatabaseError(error, "Read existing staff profile");
  }

  const existing = existingRows?.[0];
  if (existing && existing.role_code !== role) {
    fail("该手机号已经绑定其他业务身份；一个手机号只能有一个身份", "PHONE_ROLE_CONFLICT");
  }
  if (existing?.auth_uid && String(existing.auth_uid) !== String(uid)) {
    fail("该手机号已经有可用登录账号；请使用修改密码功能，不要重复创建", "PHONE_ALREADY_PROVISIONED");
  }

  let rows;
  try {
    rows = existing
      ? await executeSql(
        `WITH updated_account AS (
           UPDATE public.staff_accounts
           SET auth_uid = ${sqlText(uid)}, staff_name = ${sqlText(staffName)}, account_status = 'ACTIVE', updated_at = NOW()
           WHERE id = ${Number(existing.id)}
           RETURNING id
         )
         SELECT id FROM updated_account`
      )
      : await executeSql(
        `WITH created_account AS (
           INSERT INTO public.staff_accounts (auth_uid, phone, staff_name, role_code, account_status)
           VALUES (${sqlText(uid)}, ${sqlText(phone)}, ${sqlText(staffName)}, ${sqlText(role)}, 'ACTIVE')
           RETURNING id
         )
         SELECT id FROM created_account`
      );
  } catch (error) {
    asDatabaseError(error, "保存员工业务身份");
  }
  const profile = { staffId: rows?.[0]?.id || null, role, staffName, storeId: "" };
  if (role !== "store") return profile;
  const staffId = rows?.[0]?.id;
  if (!staffId) fail("员工身份保存后未返回账号编号", "DATABASE_ERROR");
  try {
    const layout = await getStoreBindingLayout();
    const targetStoreId = numericId(storeId, "门店编号");
    let storeRows;
    if (layout === "stores") {
      const activeRows = await executeSql(
        `SELECT id FROM public.stores
         WHERE store_account_id = ${Number(staffId)} AND store_status = 'ACTIVE'
         LIMIT 1`
      );
      if (activeRows?.[0] && Number(activeRows[0].id) !== targetStoreId) {
        fail("该门店账号已绑定其他门店；一个联系人账号只能绑定一个门店", "STORE_ACCOUNT_ALREADY_ASSIGNED");
      }
      storeRows = await executeSql(
        `WITH bound_store AS (
           UPDATE public.stores
           SET store_account_id = ${Number(staffId)}, updated_at = NOW()
           WHERE id = ${targetStoreId}
             AND store_status = 'ACTIVE'
             AND (store_account_id IS NULL OR store_account_id = ${Number(staffId)})
           RETURNING id
         )
         SELECT id FROM bound_store`
      );
    } else {
      const activeRows = await executeSql(
        `SELECT store_id FROM public.staff_store_assignments
         WHERE staff_account_id = ${Number(staffId)} AND assignment_status = 'ACTIVE'
         LIMIT 1`
      );
      if (activeRows?.[0] && Number(activeRows[0].store_id) !== targetStoreId) {
        fail("该门店账号已绑定其他门店；一个联系人账号只能绑定一个门店", "STORE_ACCOUNT_ALREADY_ASSIGNED");
      }
      storeRows = await executeSql(
        `WITH bound_assignment AS (
           INSERT INTO public.staff_store_assignments (staff_account_id, store_id, assignment_status)
           VALUES (${Number(staffId)}, ${targetStoreId}, 'ACTIVE')
           ON CONFLICT (staff_account_id, store_id)
           DO UPDATE SET assignment_status = 'ACTIVE'
           RETURNING store_id
         )
         SELECT store_id FROM bound_assignment`
      );
    }
    if (!storeRows?.[0]) fail("门店不存在、已封存或已绑定其他门店账号", "STORE_BINDING_FAILED");
  } catch (error) {
    if (["STORE_BINDING_FAILED", "STORE_ACCOUNT_ALREADY_ASSIGNED"].includes(error?.code)) throw error;
    asDatabaseError(error, "绑定门店");
  }
  profile.storeId = String(storeId);
  return profile;
}

async function assertPhoneCanUseRole(phone, role) {
  let rows;
  try {
    rows = await executeSql(
      `SELECT id, role_code, account_status
       FROM public.staff_accounts
       WHERE phone = ${sqlText(phone)}
       LIMIT 1`
    );
  } catch (error) {
    asDatabaseError(error, "检查手机号业务身份");
  }
  const account = rows?.[0] || null;
  if (account && account.role_code !== role) {
    fail("该手机号已经绑定其他业务身份；一个手机号只能有一个身份", "PHONE_ROLE_CONFLICT");
  }
  return account;
}

async function writeCredentialEvent({ targetStaffId, actorStaffId = null, eventType, passwordChangeRequired }) {
  const targetId = Number(targetStaffId);
  const actorId = actorStaffId === null || actorStaffId === undefined ? "NULL" : String(Number(actorStaffId));
  if (!Number.isInteger(targetId) || targetId <= 0) fail("Credential event is missing a staff account", "DATABASE_ERROR");
  if (!['ACCOUNT_CREATED', 'HQ_PASSWORD_RESET', 'SELF_PASSWORD_CHANGED'].includes(eventType)) {
    fail("Unsupported credential event", "BAD_REQUEST");
  }
  try {
    await executeSql(
      `UPDATE public.staff_accounts
       SET password_initialized_at = CASE WHEN ${sqlText(eventType)} = 'ACCOUNT_CREATED'
                                            THEN COALESCE(password_initialized_at, NOW())
                                          ELSE password_initialized_at END,
           password_changed_at = NOW(),
           password_change_required = ${passwordChangeRequired ? "TRUE" : "FALSE"},
           updated_at = NOW()
       WHERE id = ${targetId}`
    );
    await executeSql(
      `INSERT INTO public.credential_events
        (target_staff_account_id, actor_staff_account_id, event_type)
       VALUES (${targetId}, ${actorId}, ${sqlText(eventType)})`
    );
  } catch (error) {
    asDatabaseError(error, "Record credential management event");
  }
}

function requiredText(value, label, maxLength) {
  const text = String(value || "").trim();
  if (!text) fail(`请填写${label}`);
  if (text.length > maxLength) fail(`${label}不能超过 ${maxLength} 个字符`);
  return text;
}

function numericId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) fail(`${label}无效`, "BAD_REQUEST");
  return id;
}

function storeInputFromEvent(event) {
  return {
    storeName: requiredText(event.storeName, "门店名称", 100),
    province: requiredText(event.province, "省", 32),
    city: requiredText(event.city, "市", 32),
    district: requiredText(event.district, "区", 32),
    addressDetail: requiredText(event.addressDetail, "详细地址", 255),
    contactName: requiredText(event.contactName, "登录联系人姓名", 64),
    contactPhone: validatePhone(event.contactPhone),
    existingStoreId: String(event.existingStoreId || "").trim()
  };
}

function storeMatchesInput(store, input) {
  return [
    [store.store_name, input.storeName],
    [store.province, input.province],
    [store.city, input.city],
    [store.district, input.district],
    [store.address_detail, input.addressDetail]
  ].every(([actual, expected]) => String(actual || "").trim() === String(expected || "").trim());
}

function storeAccountJoin(layout) {
  return layout === "stores"
    ? "LEFT JOIN public.staff_accounts account ON account.id = store.store_account_id"
    : "LEFT JOIN public.staff_store_assignments assignment ON assignment.store_id = store.id AND assignment.assignment_status = 'ACTIVE' LEFT JOIN public.staff_accounts account ON account.id = assignment.staff_account_id";
}

async function findStoreByContactPhone(phone, capabilities) {
  const layout = await getStoreBindingLayout();
  const phoneChecks = ["account.phone = " + sqlText(phone)];
  let contactJoin = "";
  if (capabilities.storeContacts) {
    contactJoin = "LEFT JOIN public.store_contacts contact ON contact.store_id = store.id AND contact.contact_status = 'ACTIVE'";
    phoneChecks.push("contact.contact_phone = " + sqlText(phone));
  }
  if (capabilities.contactsJson) {
    phoneChecks.push(`store.contacts_json @> jsonb_build_array(jsonb_build_object('phone', ${sqlText(phone)}))`);
  }
  try {
    const rows = await executeSql(
      `SELECT DISTINCT store.id, store.store_code, store.store_name, store.province, store.city,
              store.district, store.address_detail, store.store_status
       FROM public.stores store
       ${storeAccountJoin(layout)}
       ${contactJoin}
       WHERE ${phoneChecks.join(" OR ")}
       ORDER BY store.id ASC
       LIMIT 2`
    );
    if (rows.length > 1) fail("该登录联系电话已关联多个门店，请先由总部处理历史数据", "STORE_CONTACT_AMBIGUOUS");
    return rows[0] || null;
  } catch (error) {
    if (error?.code) throw error;
    asDatabaseError(error, "查询门店登录联系人");
  }
}

async function findRecoverableStoreByProfile(input, capabilities) {
  const layout = await getStoreBindingLayout();
  const noActiveContact = capabilities.storeContacts
    ? `AND NOT EXISTS (
         SELECT 1 FROM public.store_contacts contact
         WHERE contact.store_id = store.id AND contact.contact_status = 'ACTIVE'
       )`
    : "";
  const noJsonContact = capabilities.contactsJson
    ? "AND COALESCE(jsonb_array_length(store.contacts_json), 0) = 0"
    : "";
  let rows;
  try {
    rows = await executeSql(
      `SELECT DISTINCT store.id, store.store_code, store.store_name, store.province, store.city,
              store.district, store.address_detail, store.store_status
       FROM public.stores store
       ${storeAccountJoin(layout)}
       WHERE store.store_name = ${sqlText(input.storeName)}
         AND store.province = ${sqlText(input.province)}
         AND store.city = ${sqlText(input.city)}
         AND store.district = ${sqlText(input.district)}
         AND store.address_detail = ${sqlText(input.addressDetail)}
         AND store.store_status = 'ACTIVE'
         AND account.id IS NULL
         ${noActiveContact}
         ${noJsonContact}
       ORDER BY store.id ASC
       LIMIT 2`
    );
  } catch (error) {
    asDatabaseError(error, "读取未完成门店资料");
  }
  if (rows.length > 1) {
    fail("发现多条相同的未完成门店资料，请先由总部在数据库中核对后再绑定账号", "INCOMPLETE_STORE_AMBIGUOUS");
  }
  return rows[0] || null;
}

async function ensureSingleStoreContact(storeId, input, capabilities) {
  if (!capabilities.storeContacts) return;
  let contacts;
  try {
    contacts = await executeSql(
      `SELECT id, contact_name, contact_phone
       FROM public.store_contacts
       WHERE store_id = ${numericId(storeId, "门店编号")}
         AND contact_status = 'ACTIVE'
       ORDER BY is_primary DESC, id ASC
       LIMIT 2`
    );
  } catch (error) {
    asDatabaseError(error, "查询门店联系人");
  }
  if (contacts.length > 1) {
    fail("该门店已有多个活跃联系人，不能再绑定登录账号", "STORE_CONTACT_AMBIGUOUS");
  }
  const contact = contacts[0];
  if (contact) {
    const nameMatches = String(contact.contact_name || "").trim() === input.contactName;
    const phoneMatches = String(contact.contact_phone || "").replace(/\D/g, "") === input.contactPhone;
    if (!nameMatches || !phoneMatches) {
      fail("该门店已有不同的登录联系人，不能覆盖原账号", "STORE_CONTACT_CONFLICT");
    }
    return;
  }
  try {
    await executeSql(
      `INSERT INTO public.store_contacts
        (store_id, contact_name, contact_phone, contact_status, is_primary)
       VALUES (${numericId(storeId, "门店编号")}, ${sqlText(input.contactName)}, ${sqlText(input.contactPhone)}, 'ACTIVE', TRUE)`
    );
  } catch (error) {
    asDatabaseError(error, "保存门店登录联系人");
  }
}

async function loadStoreById(storeId) {
  try {
    const rows = await executeSql(
      `SELECT id, store_code, store_name, province, city, district, address_detail, store_status
       FROM public.stores WHERE id = ${numericId(storeId, "门店编号")} LIMIT 1`
    );
    return rows[0] || null;
  } catch (error) {
    asDatabaseError(error, "读取已有门店");
  }
}

async function createOrRecoverStore(caller, input) {
  const capabilities = await getStoreCreationCapabilities();
  let existing = input.existingStoreId ? await loadStoreById(input.existingStoreId) : null;
  if (!existing) existing = await findStoreByContactPhone(input.contactPhone, capabilities);
  if (!existing) existing = await findRecoverableStoreByProfile(input, capabilities);
  if (existing) {
    if (existing.store_status !== "ACTIVE") {
      fail("该门店已封存，不能绑定或恢复登录账号", "ARCHIVED_STORE");
    }
    if (!storeMatchesInput(existing, input)) {
      fail("该联系电话已关联其他门店；一个手机号只能绑定一个业务身份", "PHONE_ROLE_CONFLICT");
    }
    await ensureSingleStoreContact(existing.id, input, capabilities);
    return { id: String(existing.id), code: String(existing.store_code) };
  }

  const columns = ["store_name", "province", "city", "district", "address_detail"];
  const values = [
    sqlText(input.storeName),
    sqlText(input.province),
    sqlText(input.city),
    sqlText(input.district),
    sqlText(input.addressDetail)
  ];
  let prefix = "";
  if (!capabilities.storeCodeHasDefault) {
    let sequenceRows;
    try {
      sequenceRows = await executeSql("SELECT nextval(pg_get_serial_sequence('public.stores', 'id')) AS reserved_store_id");
    } catch (error) {
      asDatabaseError(error, "生成门店编号");
    }
    const reservedId = numericId(sequenceRows?.[0]?.reserved_store_id, "门店编号");
    columns.unshift("id", "store_code");
    values.unshift(String(reservedId), sqlText(`STR${String(reservedId).padStart(6, "0")}`));
    prefix = "OVERRIDING SYSTEM VALUE ";
  }
  if (capabilities.contactsJson) {
    columns.push("contacts_json");
    values.push(`jsonb_build_array(jsonb_build_object('name', ${sqlText(input.contactName)}, 'phone', ${sqlText(input.contactPhone)}))`);
  }
  if (capabilities.createdBy && caller.profile?.staffId) {
    columns.push("created_by");
    values.push(String(numericId(caller.profile.staffId, "总部账号编号")));
  }

  let rows;
  try {
    rows = await executeSql(
      `WITH created_store AS (
         INSERT INTO public.stores (${columns.join(", ")})
         ${prefix}VALUES (${values.join(", ")})
         RETURNING id, store_code
       )
       SELECT id, store_code FROM created_store`
    );
  } catch (error) {
    asDatabaseError(error, "创建门店资料");
  }
  const store = rows?.[0];
  if (!store?.id || !store?.store_code) fail("门店资料创建后未返回编号", "DATABASE_ERROR");
  await ensureSingleStoreContact(store.id, input, capabilities);
  return { id: String(store.id), code: String(store.store_code) };
}

async function removeUnboundStore(storeId) {
  const targetStoreId = numericId(storeId, "门店编号");
  try {
    const layout = await getStoreBindingLayout();
    const unboundCondition = layout === "stores"
      ? "store.store_account_id IS NULL"
      : `NOT EXISTS (
           SELECT 1 FROM public.staff_store_assignments assignment
           WHERE assignment.store_id = store.id AND assignment.assignment_status = 'ACTIVE'
         )`;
    await executeSql(
      `DELETE FROM public.stores store
       WHERE store.id = ${targetStoreId}
         AND ${unboundCondition}`
    );
    const remaining = await executeSql(
      `SELECT id FROM public.stores WHERE id = ${targetStoreId} LIMIT 1`
    );
    return !remaining?.[0];
  } catch (error) {
    console.error("unbound store cleanup failed", {
      storeId: targetStoreId,
      code: error?.code,
      requestId: requestIdFrom(error) || undefined,
      message: error?.message
    });
    return false;
  }
}

async function getProductCreationCapabilities() {
  let rows;
  try {
    rows = await executeSql(
      `SELECT
        EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'products'
        ) AS has_products,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'description'
        ) AS has_description,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'product_type'
        ) AS has_product_type,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'product_status'
        ) AS has_product_status,
        EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'idempotency_key'
        ) AS has_idempotency_key,
        EXISTS (
          SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public' AND tablename = 'products'
            AND indexname = 'uq_products_normalized_name'
        ) AS has_unique_product_name,
        COALESCE((
          SELECT column_default
          FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'product_code'
          LIMIT 1
        ), '') AS product_code_default`
    );
  } catch (error) {
    asDatabaseError(error, "读取产品表结构");
  }
  const row = rows?.[0] || {};
  if (!databaseBoolean(row.has_products)) {
    fail("数据库缺少 products 表，请先执行完整数据库建表脚本", "DATABASE_SCHEMA_MISSING");
  }
  if (!databaseBoolean(row.has_product_type) || !databaseBoolean(row.has_product_status)) {
    fail("products 表缺少基础字段，请先执行完整数据库建表脚本", "DATABASE_SCHEMA_MISSING");
  }
  const baseReady = databaseBoolean(row.has_description) &&
    databaseBoolean(row.has_idempotency_key) &&
    Boolean(String(row.product_code_default || "").trim());
  if (!baseReady) {
    fail("产品表尚未完成升级，请先执行 018_product_creation_idempotency.sql", "DATABASE_SCHEMA_MISSING");
  }
  if (!databaseBoolean(row.has_unique_product_name)) {
    fail("产品表尚未启用名称唯一约束，请先执行 019_unique_product_name.sql", "DATABASE_SCHEMA_MISSING");
  }
  return { ready: true };
}

function productInputFromEvent(event) {
  const clientRequestId = String(event.clientRequestId || "").trim();
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientRequestId)) {
    fail("产品创建请求编号格式无效", "BAD_REQUEST");
  }
  const description = String(event.description || "").trim();
  if (description.length > 1000) fail("产品介绍不能超过 1000 个字符", "BAD_REQUEST");
  return {
    productName: requiredText(event.productName, "产品名称", 100),
    productType: requiredText(event.productType, "产品类别", 32),
    description,
    clientRequestId
  };
}

async function findProductByRequestId(clientRequestId) {
  let rows;
  try {
    rows = await executeSql(
      `SELECT id, product_code, product_name, product_type, description, product_status,
              created_at, updated_at
       FROM public.products
       WHERE idempotency_key = ${sqlText(clientRequestId)}
       LIMIT 1`
    );
  } catch (error) {
    asDatabaseError(error, "读取产品创建请求");
  }
  return rows?.[0] || null;
}

async function findProductByName(productName) {
  let rows;
  try {
    rows = await executeSql(
      `SELECT id, product_code, product_name, product_type, description, product_status,
              created_at, updated_at
       FROM public.products
       WHERE LOWER(BTRIM(product_name)) = LOWER(BTRIM(${sqlText(productName)}))
       ORDER BY id ASC
       LIMIT 1`
    );
  } catch (error) {
    asDatabaseError(error, "检查产品名称");
  }
  return rows?.[0] || null;
}

function failProductNameExists(product) {
  const code = String(product?.product_code || "").trim();
  fail(`已存在同名产品${code ? `（${code}）` : ""}，不能重复创建`, "PRODUCT_NAME_EXISTS");
}

function assertSameProductRequest(product, input) {
  const same = String(product?.product_name || "").trim() === input.productName &&
    String(product?.product_type || "").trim() === input.productType &&
    String(product?.description || "").trim() === input.description;
  if (!same) {
    fail("同一产品创建请求编号已用于其他产品，请刷新创建页面后重试", "IDEMPOTENCY_CONFLICT");
  }
}

async function createProductRecord(event) {
  const input = productInputFromEvent(event);
  await getProductCreationCapabilities();
  const recovered = await findProductByRequestId(input.clientRequestId);
  if (recovered) {
    assertSameProductRequest(recovered, input);
    return { product: recovered, created: false };
  }
  const duplicateName = await findProductByName(input.productName);
  if (duplicateName) failProductNameExists(duplicateName);

  let rows;
  try {
    rows = await executeSql(
      `WITH created_product AS (
         INSERT INTO public.products
           (product_name, product_type, description, product_status, idempotency_key)
         VALUES
           (${sqlText(input.productName)}, ${sqlText(input.productType)}, ${sqlText(input.description)},
            'ACTIVE', ${sqlText(input.clientRequestId)})
         RETURNING id, product_code, product_name, product_type, description, product_status,
                   created_at, updated_at
       )
       SELECT id, product_code, product_name, product_type, description, product_status,
              created_at, updated_at
       FROM created_product`
    );
  } catch (error) {
    try {
      const concurrent = await findProductByRequestId(input.clientRequestId);
      if (concurrent) {
        assertSameProductRequest(concurrent, input);
        return { product: concurrent, created: false };
      }
      const concurrentName = await findProductByName(input.productName);
      if (concurrentName) failProductNameExists(concurrentName);
    } catch (recoveryError) {
      if (["IDEMPOTENCY_CONFLICT", "PRODUCT_NAME_EXISTS"].includes(recoveryError?.code)) {
        throw recoveryError;
      }
    }
    asDatabaseError(error, "创建产品资料");
  }
  // CloudBase executePGSql can report a successful writable statement without
  // exposing the rows produced by RETURNING. Always read the persisted record
  // back through a plain SELECT before deciding that creation failed. The
  // idempotency key makes this safe for retries and concurrent submissions.
  const returnedProduct = rows?.[0];
  const product = returnedProduct?.id && returnedProduct?.product_code
    ? returnedProduct
    : await findProductByRequestId(input.clientRequestId);
  if (!product?.id || !product?.product_code) {
    fail("产品创建后数据库未返回产品编号", "DATABASE_ERROR");
  }
  assertSameProductRequest(product, input);
  return { product, created: true };
}

function reviewFilterSql(event, alias, recordCodeExpression, statusExpression, typeExpression) {
  const clauses = [];
  const recordId = String(event.recordId || "").trim();
  const recordCode = String(event.recordCode || "").trim().toUpperCase();
  const storeId = String(event.storeId || "").trim();
  const status = String(event.status || "").trim().toUpperCase();
  const applicationType = String(event.applicationType || "").trim().toUpperCase();
  if (recordId) clauses.push(`${alias}.id = ${numericId(recordId, "工单编号")}`);
  if (recordCode) {
    if (!/^[A-Z0-9_-]{2,40}$/.test(recordCode)) fail("工单编号格式不正确", "BAD_REQUEST");
    clauses.push(`UPPER(${recordCodeExpression}) = ${sqlText(recordCode)}`);
  }
  if (storeId) clauses.push(`${alias}.store_id = ${numericId(storeId, "门店编号")}`);
  if (["PENDING", "APPROVED", "REJECTED"].includes(status)) clauses.push(`${statusExpression} = ${sqlText(status)}`);
  if (applicationType) clauses.push(`${typeExpression} = ${sqlText(applicationType)}`);
  return clauses.length ? `AND ${clauses.join(" AND ")}` : "";
}

async function listReviewOrders(caller, event) {
  requireReviewer(caller);
  const recordType = String(event.recordType || "").trim().toUpperCase();
  if (!["RECHARGE", "VERIFICATION"].includes(recordType)) fail("不支持的审核工单类型", "BAD_REQUEST");
  const limit = Math.min(Math.max(Number(event.limit) || 200, 1), 500);
  let sql;
  if (recordType === "RECHARGE") {
    const statusExpression = "CASE WHEN r.void_request_status <> 'NONE' THEN r.void_request_status ELSE r.record_status END";
    const typeExpression = "CASE WHEN r.void_request_status <> 'NONE' THEN 'VOID' ELSE 'NEW' END";
    const timeExpression = "CASE WHEN r.void_request_status <> 'NONE' THEN r.void_requested_at ELSE r.submitted_at END";
    sql = `SELECT r.id, r.recharge_code AS record_code, 'RECHARGE'::text AS record_type,
                  ${typeExpression} AS application_type,
                  ${statusExpression} AS application_status,
                  ${timeExpression} AS application_time,
                  r.record_status AS original_status, r.recharge_type AS original_type,
                  r.unit_count, r.message AS initial_store_note, r.review_note AS initial_review_note,
                  r.submitted_at AS original_submitted_at, r.reviewed_at AS original_reviewed_at,
                  r.void_request_status, r.void_request_note, r.void_requested_at,
                  r.void_review_note, r.void_reviewed_at,
                  s.id AS store_id, s.store_code, s.store_name,
                  c.id AS customer_id, c.customer_code, c.customer_name,
                  p.id AS product_id, p.product_code, p.product_name,
                  t.id AS teacher_id, t.teacher_code, t.teacher_name
             FROM public.recharge_records r
             JOIN public.stores s ON s.id = r.store_id
             JOIN public.customers c ON c.id = r.customer_id
             JOIN public.products p ON p.id = r.product_id
        LEFT JOIN public.teachers t ON t.id = r.teacher_id
            WHERE TRUE
              ${reviewFilterSql(event, "r", "r.recharge_code", statusExpression, typeExpression)}
         ORDER BY (${statusExpression} = 'PENDING') DESC, ${timeExpression} DESC, r.id DESC
            LIMIT ${limit}`;
  } else {
    const statusExpression = "CASE WHEN v.void_request_status <> 'NONE' THEN v.void_request_status ELSE v.record_status END";
    const typeExpression = "CASE WHEN v.void_request_status <> 'NONE' THEN 'VOID' ELSE v.verification_type END";
    const timeExpression = "CASE WHEN v.void_request_status <> 'NONE' THEN v.void_requested_at ELSE v.submitted_at END";
    sql = `SELECT v.id, v.verification_code AS record_code, 'VERIFICATION'::text AS record_type,
                  ${typeExpression} AS application_type,
                  ${statusExpression} AS application_status,
                  ${timeExpression} AS application_time,
                  v.record_status AS original_status, v.verification_type AS original_type,
                  v.unit_count, v.message AS initial_store_note, v.review_note AS initial_review_note,
                  v.supplement_note, v.submitted_at AS original_submitted_at,
                  v.reviewed_at AS original_reviewed_at,
                  v.void_request_status, v.void_request_note, v.void_requested_at,
                  v.void_review_note, v.void_reviewed_at,
                  s.id AS store_id, s.store_code, s.store_name,
                  c.id AS customer_id, c.customer_code, c.customer_name,
                  p.id AS product_id, p.product_code, p.product_name,
                  t.id AS teacher_id, t.teacher_code, t.teacher_name
             FROM public.verification_records v
             JOIN public.stores s ON s.id = v.store_id
             JOIN public.customers c ON c.id = v.customer_id
             JOIN public.products p ON p.id = v.product_id
             JOIN public.teachers t ON t.id = v.teacher_id
            WHERE (v.void_request_status <> 'NONE' OR v.verification_type = 'SUPPLEMENT')
              ${reviewFilterSql(event, "v", "v.verification_code", statusExpression, typeExpression)}
         ORDER BY (${statusExpression} = 'PENDING') DESC, ${timeExpression} DESC, v.id DESC
            LIMIT ${limit}`;
  }
  try {
    return await executeSql(sql);
  } catch (error) {
    asDatabaseError(error, "读取审核工单");
  }
}

async function requestOrderVoid(caller, event) {
  requireStore(caller);
  const recordType = String(event.recordType || "").trim().toUpperCase();
  if (!["RECHARGE", "VERIFICATION"].includes(recordType)) fail("不支持的工单类型", "BAD_REQUEST");
  const recordId = numericId(event.recordId || event.verificationId, "工单编号");
  const note = String(event.note || event.voidNote || "").trim();
  if (!note) fail("提交作废申请必须填写说明", "VOID_NOTE_REQUIRED");
  if (note.length > 1000) fail("作废说明不能超过 1000 个字符", "BAD_REQUEST");
  let rows;
  try {
    rows = await executeSql(
      `SELECT record_id, record_code, record_status, void_request_status, void_requested_at
         FROM public.request_order_void(${sqlText(recordType)}, ${recordId},
              ${numericId(caller.profile.staffId, "当前门店账号")}, ${sqlText(note)})`
    );
  } catch (error) {
    asDatabaseError(error, "提交作废申请");
  }
  if (!rows?.[0]) fail("未找到该工单", "NOT_FOUND");
  return rows[0];
}

async function reviewOrder(caller, event) {
  requireReviewer(caller);
  const recordType = String(event.recordType || "").trim().toUpperCase();
  const decision = String(event.decision || "").trim().toUpperCase();
  if (!["RECHARGE", "VERIFICATION"].includes(recordType)) fail("不支持的工单类型", "BAD_REQUEST");
  if (!["APPROVED", "REJECTED"].includes(decision)) fail("审核结果只能是通过或驳回", "BAD_REQUEST");
  const recordId = numericId(event.recordId, "工单编号");
  const note = String(event.note || "").trim();
  if (note.length > 1000) fail("审核留言不能超过 1000 个字符", "BAD_REQUEST");
  let rows;
  try {
    rows = await executeSql(
      `SELECT record_id, record_code, record_status, void_request_status, reviewed_at
         FROM public.review_order_application(${sqlText(recordType)}, ${recordId},
              ${numericId(caller.profile.staffId, "当前审核账号")}, ${sqlText(decision)}, ${sqlText(note)})`
    );
  } catch (error) {
    const databaseMessage = String(error?.message || "");
    if (
      recordType === "RECHARGE" &&
      decision === "APPROVED" &&
      /cannot approve recharge void|insufficient purchased units/i.test(databaseMessage)
    ) {
      fail("该项目剩余次数不足，批准充值作废会导致剩余次数小于 0。", "INSUFFICIENT_PRODUCT_BALANCE");
    }
    asDatabaseError(error, "审核业务工单");
  }
  if (!rows?.[0]) fail("未找到该工单", "NOT_FOUND");
  return rows[0];
}

async function main(event = {}) {
  const action = event.action || "session";
  if (action === "health") {
    return {
      ok: true,
      message: "员工账号云函数已就绪",
      version: FUNCTION_VERSION,
      managerNodeInstalled: managerDependencyInstalled()
    };
  }
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
    return { ok: true, version: FUNCTION_VERSION, uid: caller.uid, profile: caller.profile };
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
      `SELECT id, auth_uid, phone, staff_name, role_code, account_status,
              password_initialized_at, password_changed_at, password_change_required,
              ${sqlText(codePrefix)} || LPAD(id::text, 3, '0') AS person_code
       FROM public.staff_accounts
       WHERE role_code = ${sqlText(role)} ORDER BY id ASC`
    );
    return { ok: true, staff: rows };
  }
  if (action === "listProducts") {
    if (!caller.profile?.role) fail("当前登录账号没有有效业务身份", "UNASSIGNED_PHONE");
    await getProductCreationCapabilities();
    const statusFilter = caller.profile.role === "hq" ? "" : "WHERE product_status = 'ACTIVE'";
    let rows;
    try {
      rows = await executeSql(
        `SELECT id, product_code, product_name, product_type, description, product_status,
                created_at, updated_at
         FROM public.products
         ${statusFilter}
         ORDER BY id ASC`
      );
    } catch (error) {
      asDatabaseError(error, "读取产品列表");
    }
    return { ok: true, products: rows };
  }
  if (action === "createProduct") {
    requireHq(caller);
    const result = await createProductRecord(event);
    return { ok: true, product: result.product, created: result.created };
  }
  if (action === "setProductStatus") {
    requireHq(caller);
    const productRef = String(event.productRef || "").trim();
    const status = String(event.status || "").toUpperCase();
    if (!productRef) fail("缺少产品编号", "BAD_REQUEST");
    if (!["ACTIVE", "ARCHIVED"].includes(status)) {
      fail("产品状态只能是 ACTIVE（活跃）或 ARCHIVED（封存）", "BAD_REQUEST");
    }
    const idCondition = /^\d+$/.test(productRef)
      ? `id = ${numericId(productRef, "产品编号")}`
      : "FALSE";
    let rows;
    try {
      rows = await executeSql(
        `WITH updated_product AS (
           UPDATE public.products
           SET product_status = ${sqlText(status)}, updated_at = NOW()
           WHERE (${idCondition}) OR product_code = ${sqlText(productRef)}
           RETURNING id, product_code, product_name, product_type, description, product_status,
                     created_at, updated_at
         )
         SELECT id, product_code, product_name, product_type, description, product_status,
                created_at, updated_at
         FROM updated_product`
      );
    } catch (error) {
      asDatabaseError(error, "更新产品状态");
    }
    if (!rows?.[0]) fail("未找到该产品", "NOT_FOUND");
    return { ok: true, product: rows[0] };
  }
  if (action === "listReviewOrders") {
    return { ok: true, orders: await listReviewOrders(caller, event) };
  }
  if (action === "reviewOrder") {
    return { ok: true, order: await reviewOrder(caller, event) };
  }
  if (action === "requestOrderVoid") {
    return { ok: true, order: await requestOrderVoid(caller, event) };
  }
  if (action === "voidVerification") {
    const order = await requestOrderVoid(caller, {
      recordType: "VERIFICATION",
      recordId: event.verificationId,
      note: event.voidNote
    });
    return { ok: true, order, verification: order };
  }
  if (action === "listStores") {
    requireHq(caller);
    const capabilities = await getStoreCreationCapabilities();
    const layout = await getStoreBindingLayout();
    const contactJoin = capabilities.storeContacts
      ? `LEFT JOIN LATERAL (
           SELECT contact_name, contact_phone
           FROM public.store_contacts
           WHERE store_id = store.id AND contact_status = 'ACTIVE'
           ORDER BY is_primary DESC, id ASC
           LIMIT 1
         ) contact ON TRUE`
      : "";
    const contactName = capabilities.storeContacts ? "contact.contact_name" : "NULL::varchar";
    const contactPhone = capabilities.storeContacts ? "contact.contact_phone" : "NULL::varchar";
    const jsonName = capabilities.contactsJson ? "store.contacts_json -> 0 ->> 'name'" : "NULL::text";
    const jsonPhone = capabilities.contactsJson ? "store.contacts_json -> 0 ->> 'phone'" : "NULL::text";
    const rows = await executeSql(
      `SELECT store.id, store.store_code, store.store_name, store.province, store.city,
              store.district, store.address_detail, store.store_status,
              COALESCE(${contactName}, ${jsonName}, account.staff_name) AS contact_name,
              COALESCE(${contactPhone}, ${jsonPhone}, account.phone) AS contact_phone,
              account.auth_uid, account.id AS staff_account_id
       FROM public.stores store
       ${storeAccountJoin(layout)}
       ${contactJoin}
       ORDER BY store.id ASC`
    );
    return { ok: true, stores: rows };
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

    let authUser = await findAuthUserByExactPhone(phone);
    let authCreated = false;

    if (!authUser) {
      try {
        const created = await manager().user.createUser({
          name: `staff_${phone}`,
          password,
          // Business permissions are resolved from PostgreSQL staff_accounts.
          // Creating these as external users avoids consuming the CloudBase
          // package's limited internal/organization-member quota.
          type: "externalUser",
          userStatus: "ACTIVE",
          nickName: staffName,
          phone,
          description: "业务员工登录账号"
        });
        const uid = String(created?.Data?.Uid || "");
        if (!uid) {
          const error = new Error("CreateUser did not return a UID");
          error.RequestId = created?.RequestId;
          stageFail(
            "AUTH_CREATE",
            "认证账号创建后未返回 UID。请勿重复提交，先由总部检查认证用户。",
            "AUTH_CREATE_INCOMPLETE",
            error
          );
        }
        authUser = { Uid: uid };
        authCreated = true;
      } catch (error) {
        if (!isDuplicateAuthError(error)) {
          const cause = cloudErrorDetails(error);
          const diagnostic = [cause.code, cause.message].filter(Boolean).join("：");
          stageFail(
            "AUTH_CREATE",
            `认证登录账号创建失败。${diagnostic ? `腾讯云返回 ${diagnostic}。` : "请检查云函数的用户管理权限。"}`,
            "AUTH_CREATE_FAILED",
            error
          );
        }
        // Two HQ requests may arrive together. Re-query by the exact phone and
        // then continue safely without overwriting an existing password.
        authUser = await findAuthUserByExactPhone(phone);
        if (!authUser?.Uid) {
          stageFail(
            "AUTH_CREATE",
            "认证账号创建冲突，但无法读取已有账号。请勿重复提交。",
            "AUTH_CREATE_CONFLICT",
            error
          );
        }
      }
    }

    const uid = String(authUser?.Uid || "");
    if (!uid) fail("认证账号无有效 UID，请勿重复提交", "AUTH_CREATE_INCOMPLETE");

    let profile;
    try {
      profile = await createStaffDatabaseProfile({ uid, phone, staffName, role, storeId });
    } catch (error) {
      stageFail(
        "DB_PROFILE",
        error?.code === "PHONE_ROLE_CONFLICT" || error?.code === "PHONE_ALREADY_PROVISIONED" || error?.code === "STORE_BINDING_FAILED"
          ? error.message
          : "认证账号已存在，但员工业务资料绑定失败。请勿重复创建，稍后可用同一手机号继续恢复。",
        error?.code || "STAFF_PROFILE_SAVE_FAILED",
        error
      );
    }

    let warning = "";
    if (authCreated) {
      try {
        await writeCredentialEvent({
          targetStaffId: profile.staffId,
          actorStaffId: caller.profile.staffId,
          eventType: "ACCOUNT_CREATED",
          passwordChangeRequired: true
        });
      } catch (error) {
        // The login account and business identity are already usable. Do not
        // make the HQ create screen look like it failed solely due to audit.
        console.error("credential audit write failed after provision", {
          code: error?.code,
          requestId: requestIdFrom(error) || undefined,
          message: error?.message
        });
        warning = "账号已创建，但密码审计记录未写入；请稍后检查数据库迁移。";
      }
    }
    return {
      ok: true,
      uid,
      phone,
      profile,
      authAccount: authCreated ? "created" : "recovered",
      passwordInitialized: authCreated,
      warning: warning || undefined
    };
  }
  if (action === "createStoreWithAccount") {
    requireHq(caller);
    const input = storeInputFromEvent(event);
    const password = validatePassword(event.initialPassword);
    try {
      await assertPhoneCanUseRole(input.contactPhone, "store");
    } catch (error) {
      stageFail(
        "ACCOUNT_PREFLIGHT",
        error?.message || "门店登录手机号检查失败",
        error?.code || "ACCOUNT_PREFLIGHT_FAILED",
        error
      );
    }
    let store;
    try {
      store = await createOrRecoverStore(caller, input);
    } catch (error) {
      stageFail(
        "STORE_PROFILE",
        error?.message || "门店资料创建失败",
        error?.code || "STORE_PROFILE_SAVE_FAILED",
        error
      );
    }
    try {
      // Reuse the same idempotent account path as all other business roles.
      // It rechecks the currently authenticated HQ before it writes the account.
      const account = await main({
        action: "provisionStaff",
        staffName: input.contactName,
        phone: input.contactPhone,
        role: "store",
        storeId: store.id,
        initialPassword: password
      });
      return {
        ok: true,
        storeId: store.id,
        storeCode: store.code,
        store: { id: store.id, code: store.code },
        account: {
          uid: account.uid,
          staffId: account.profile?.staffId || null,
          authAccount: account.authAccount,
          passwordInitialized: account.passwordInitialized
        },
        warning: account.warning || undefined
      };
    } catch (error) {
      // CloudBase Identity and PostgreSQL cannot share one transaction. Roll
      // back only an unbound store, and never delete a store whose account was
      // bound by a concurrent request. If cleanup cannot be confirmed, retain
      // the identifiers so the same form can safely resume the binding.
      const removed = await removeUnboundStore(store.id);
      if (!removed) {
        error.storeId = store.id;
        error.storeCode = store.code;
      } else {
        error.storeRolledBack = true;
      }
      error.stage = error.stage || "ACCOUNT_BINDING";
      throw error;
    }
  }
  if (action === "resetPassword") {
    requireHq(caller);
    const uid = String(event.uid || "").trim();
    if (!uid) fail("缺少员工 UID");
    const newPassword = validatePassword(event.newPassword);
    const rows = await executeSql(
      `SELECT id, auth_uid FROM public.staff_accounts WHERE auth_uid = ${sqlText(uid)} LIMIT 1`
    );
    const target = rows?.[0];
    if (!target) fail("Target staff account was not found", "NOT_FOUND");
    await manager().user.modifyUser({ uid, password: newPassword });
    await writeCredentialEvent({
      targetStaffId: target.id,
      actorStaffId: caller.profile.staffId,
      eventType: "HQ_PASSWORD_RESET",
      passwordChangeRequired: true
    });
    return { ok: true };
  }
  if (action === "changeOwnPassword") {
    const newPassword = validatePassword(event.newPassword);
    if (!caller.profile?.staffId) fail("This login account has no staff identity", "UNASSIGNED_PHONE");
    await manager().user.modifyUser({ uid: caller.uid, password: newPassword });
    await writeCredentialEvent({
      targetStaffId: caller.profile.staffId,
      actorStaffId: caller.profile.staffId,
      eventType: "SELF_PASSWORD_CHANGED",
      passwordChangeRequired: false
    });
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
    if (staff.role_code === "store") {
      try {
        const layout = await getStoreBindingLayout();
        if (layout === "stores") {
          await executeSql(
            `UPDATE public.stores SET store_status = ${sqlText(status)}, updated_at = NOW() WHERE store_account_id = ${Number(staff.id)}`
          );
        } else {
          await executeSql(
            `UPDATE public.stores s
             SET store_status = ${sqlText(status)}, updated_at = NOW()
             FROM public.staff_store_assignments sa
             WHERE sa.store_id = s.id AND sa.staff_account_id = ${Number(staff.id)}`
          );
        }
      } catch (error) {
        asDatabaseError(error, "同步门店资料状态");
      }
    }
    if (staff.auth_uid) {
      await manager().user.modifyUser({ uid: staff.auth_uid, userStatus: status === "ACTIVE" ? "ACTIVE" : "BLOCKED" });
    }
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
      stage: error?.stage,
      code: error?.code || "FUNCTION_ERROR",
      requestId: error?.requestId || requestIdFrom(error) || undefined,
      message: error?.message || String(error),
      stack: error?.stack
    });
    return {
      ok: false,
      code: error?.code || "FUNCTION_ERROR",
      stage: error?.stage || undefined,
      requestId: error?.requestId || requestIdFrom(error) || undefined,
      storeId: error?.storeId || undefined,
      storeCode: error?.storeCode || undefined,
      storeRolledBack: error?.storeRolledBack || undefined,
      causeCode: error?.causeCode || undefined,
      causeMessage: error?.causeMessage || undefined,
      message: error?.message || "员工账号服务暂不可用，请稍后重试"
    };
  }
};
