"use strict";

const crypto = require("node:crypto");
const cloudbase = require("@cloudbase/node-sdk");
const CloudBaseManager = require("@cloudbase/manager-node");
const QRCode = require("qrcode");

const FUNCTION_VERSION = "v1";
let cloudApp = null;
let managerClient = null;
let storeBindingLayout = "";

function fail(message, code = "BAD_REQUEST") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

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

function sqlText(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function sqlId(value, label = "记录") {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text) || text === "0") fail(`${label}编号无效。`, "INVALID_ID");
  return text;
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
  const layout = rows[0] || {};
  if (databaseBoolean(layout.has_store_account_id)) storeBindingLayout = "stores";
  else if (databaseBoolean(layout.has_staff_store_assignments)) storeBindingLayout = "assignments";
  else fail("数据库缺少门店账号绑定结构。", "DATABASE_SCHEMA_MISSING");
  return storeBindingLayout;
}

function numberScore(value, label) {
  const score = Number(value);
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    fail(`${label}必须选择 1 至 5 星。`, "INVALID_SCORE");
  }
  return score;
}

function ratingSigningKey({ required = true } = {}) {
  const value = String(process.env.CUSTOMER_RATING_SIGNING_KEY || "");
  const valid = Buffer.byteLength(value, "utf8") >= 32;
  if (!valid && required) {
    fail("缺少至少 32 字节的 CUSTOMER_RATING_SIGNING_KEY。", "CONFIG_MISSING");
  }
  return valid ? Buffer.from(value, "utf8") : null;
}

function signedRatingToken(row) {
  const id = sqlId(row?.id, "评价");
  const version = Number(row?.token_version || 1);
  if (!Number.isInteger(version) || version < 1) fail("评价链接版本无效。", "INVALID_TOKEN");
  const payload = `${id}.${version}`;
  const signature = crypto.createHmac("sha256", ratingSigningKey())
    .update(`customer-rating:${payload}`, "utf8")
    .digest("base64url");
  return `${payload}.${signature}`;
}

function parseAndVerifyToken(token) {
  const value = String(token || "").trim();
  const match = /^(\d{1,20})\.(\d{1,9})\.([A-Za-z0-9_-]{43})$/.exec(value);
  if (!match) fail("评价链接无效。", "INVALID_TOKEN");
  const payload = `${match[1]}.${match[2]}`;
  const expected = crypto.createHmac("sha256", ratingSigningKey())
    .update(`customer-rating:${payload}`, "utf8")
    .digest("base64url");
  const receivedBytes = Buffer.from(match[3], "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (receivedBytes.length !== expectedBytes.length
      || !crypto.timingSafeEqual(receivedBytes, expectedBytes)) {
    fail("评价链接无效。", "INVALID_TOKEN");
  }
  return {
    id: sqlId(match[1], "评价"),
    version: Number(match[2]),
    tokenHash: crypto.createHash("sha256").update(value, "utf8").digest("hex")
  };
}

function ratingBaseUrl({ required = true } = {}) {
  const configured = String(process.env.CUSTOMER_RATING_BASE_URL || "").trim();
  if (!configured) {
    if (required) fail("缺少 CUSTOMER_RATING_BASE_URL。", "CONFIG_MISSING");
    return "";
  }
  let parsed;
  try { parsed = new URL(configured); }
  catch (_) { fail("评价页面地址无效。", "CONFIG_INVALID"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    fail("评价页面地址必须使用无账号信息的 HTTPS 地址。", "CONFIG_INVALID");
  }
  return parsed.toString();
}

function publicRating(row) {
  const submitted = row?.rating_status === "SUBMITTED" && Boolean(row?.rating_submitted_at);
  return {
    ratingStatus: submitted ? "SUBMITTED" : "OPEN",
    submitted,
    storeName: row?.store_name || "",
    teacherName: row?.teacher_name || "",
    requiresTeacherScore: Boolean(row?.teacher_id),
    verificationType: row?.verification_type === "EXPERIENCE" ? "EXPERIENCE" : "NORMAL",
    storeEnvironmentScore: submitted ? Number(row?.store_environment_score || 0) : 0,
    teacherServiceScore: submitted ? Number(row?.teacher_service_score || 0) : 0,
    overallExperienceScore: submitted ? Number(row?.overall_experience_score || 0) : 0,
    customerComment: submitted ? String(row?.customer_comment || "") : "",
    submittedAt: submitted ? row?.rating_submitted_at : null
  };
}

async function currentStaff() {
  const info = app().auth().getUserInfo();
  const uid = String(info?.uid || "").trim();
  if (!uid) fail("请先登录。", "UNAUTHENTICATED");
  const layout = await getStoreBindingLayout();
  const storeJoin = layout === "stores"
    ? "LEFT JOIN public.stores s ON s.store_account_id = a.id"
    : `LEFT JOIN public.staff_store_assignments sa
         ON sa.staff_account_id = a.id AND sa.assignment_status = 'ACTIVE'
       LEFT JOIN public.stores s ON s.id = sa.store_id`;
  const rows = await executeSql(
    `SELECT a.id, a.role_code, a.account_status,
            s.id AS store_id, s.store_status,
            t.id AS teacher_id, t.teacher_status
       FROM public.staff_accounts a
       ${storeJoin}
       LEFT JOIN public.teachers t ON t.staff_account_id = a.id
      WHERE a.auth_uid = ${sqlText(uid)}
      LIMIT 1`
  );
  const staff = rows[0];
  if (!staff || !["hq", "store", "teacher"].includes(staff.role_code)) {
    fail("当前登录身份未绑定可用业务账号。", "UNASSIGNED_IDENTITY");
  }
  if (staff.account_status !== "ACTIVE") fail("当前账号已封存。", "ARCHIVED_ACCOUNT");
  if (staff.role_code === "store" && (!staff.store_id || staff.store_status !== "ACTIVE")) {
    fail("当前门店不可用。", "ARCHIVED_STORE");
  }
  if (staff.role_code === "teacher" && (!staff.teacher_id || staff.teacher_status !== "ACTIVE")) {
    fail("当前老师不可用。", "ARCHIVED_TEACHER");
  }
  return staff;
}

async function orderForVerification(verificationId) {
  const rows = await executeSql(
    `SELECT vr.id, vr.store_id, vr.teacher_id, vr.verification_type,
            vr.record_status, vr.submitted_at AS order_submitted_at,
            s.store_name, t.teacher_name
       FROM public.verification_records vr
       JOIN public.stores s ON s.id = vr.store_id
       LEFT JOIN public.teachers t ON t.id = vr.teacher_id
      WHERE vr.id = ${verificationId}
        AND vr.verification_type IN ('NORMAL', 'EXPERIENCE')
      LIMIT 1`
  );
  return rows[0] || null;
}

async function ratingForVerification(verificationId) {
  const rows = await executeSql(
    `SELECT r.id, r.verification_id, r.store_id, r.teacher_id, r.token_version,
            r.rating_status, r.store_environment_score, r.teacher_service_score,
            r.overall_experience_score, r.customer_comment,
            r.submitted_at AS rating_submitted_at,
            vr.verification_type, vr.record_status,
            vr.submitted_at AS order_submitted_at,
            s.store_name, t.teacher_name
       FROM public.verification_customer_ratings r
       JOIN public.verification_records vr ON vr.id = r.verification_id
       JOIN public.stores s ON s.id = r.store_id
       LEFT JOIN public.teachers t ON t.id = r.teacher_id
      WHERE r.verification_id = ${verificationId}
      LIMIT 1`
  );
  return rows[0] || null;
}

function canReadRating(staff, order) {
  return staff.role_code === "hq"
    || (staff.role_code === "store" && String(staff.store_id) === String(order.store_id))
    || (staff.role_code === "teacher" && String(staff.teacher_id) === String(order.teacher_id));
}

async function getForStaff(event) {
  const verificationId = sqlId(event.verificationId, "核销工单");
  const [staff, order] = await Promise.all([currentStaff(), orderForVerification(verificationId)]);
  if (!order) fail("核销工单不存在。", "NOT_FOUND");
  if (!canReadRating(staff, order)) fail("无权查看该评价。", "FORBIDDEN");
  const rating = await ratingForVerification(verificationId);
  const view = publicRating(rating || order);
  return {
    exists: view.submitted,
    linkIssued: Boolean(rating),
    canIssue: staff.role_code === "store"
      && String(staff.store_id) === String(order.store_id)
      && order.record_status === "APPROVED"
      && !view.submitted,
    ...view
  };
}

async function issueForStore(event) {
  const verificationId = sqlId(event.verificationId, "核销工单");
  const [staff, order] = await Promise.all([currentStaff(), orderForVerification(verificationId)]);
  if (staff.role_code !== "store") fail("仅工单所属门店可以生成评价二维码。", "FORBIDDEN");
  if (!order) fail("核销工单不存在。", "NOT_FOUND");
  if (String(order.store_id) !== String(staff.store_id)) fail("只能生成本门店工单的评价二维码。", "FORBIDDEN");
  if (order.record_status !== "APPROVED") fail("核销尚未完成，不能生成评价二维码。", "ORDER_NOT_COMPLETED");

  let rating = await ratingForVerification(verificationId);
  if (rating?.rating_status === "SUBMITTED" || rating?.rating_submitted_at) {
    return { alreadySubmitted: true, ...publicRating(rating) };
  }
  if (!rating) {
    const placeholderHash = crypto.randomBytes(32).toString("hex");
    await executeSql(
      `INSERT INTO public.verification_customer_ratings
         (verification_id, store_id, teacher_id, issued_by_account_id,
          token_hash, token_version, rating_status, issued_at, updated_at)
       VALUES
         (${verificationId}, ${sqlId(order.store_id, "门店")},
          ${order.teacher_id ? sqlId(order.teacher_id, "老师") : "NULL"},
          ${sqlId(staff.id, "员工")}, ${sqlText(placeholderHash)}, 1, 'OPEN', NOW(), NOW())
       ON CONFLICT (verification_id) DO NOTHING`
    );
    rating = await ratingForVerification(verificationId);
  }
  if (!rating) fail("评价链接创建失败，请重试。", "RATING_ISSUE_FAILED");
  if (rating.rating_status === "SUBMITTED" || rating.rating_submitted_at) {
    return { alreadySubmitted: true, ...publicRating(rating) };
  }

  const token = signedRatingToken(rating);
  const tokenHash = crypto.createHash("sha256").update(token, "utf8").digest("hex");
  const updated = await executeSql(
    `UPDATE public.verification_customer_ratings
        SET token_hash = ${sqlText(tokenHash)}, updated_at = NOW()
      WHERE id = ${sqlId(rating.id, "评价")}
        AND token_version = ${Number(rating.token_version || 1)}
        AND rating_status = 'OPEN'
        AND submitted_at IS NULL
      RETURNING id`
  );
  if (!updated.length) {
    const latest = await ratingForVerification(verificationId);
    if (latest?.rating_status === "SUBMITTED" || latest?.rating_submitted_at) {
      return { alreadySubmitted: true, ...publicRating(latest) };
    }
    fail("评价链接创建失败，请重试。", "RATING_ISSUE_FAILED");
  }
  const publicUrl = new URL(ratingBaseUrl());
  publicUrl.searchParams.set("token", token);
  const url = publicUrl.toString();
  const qrDataUrl = await QRCode.toDataURL(url, {
    errorCorrectionLevel: "M",
    margin: 2,
    width: 640,
    color: { dark: "#2f281f", light: "#ffffff" }
  });
  return { alreadySubmitted: false, url, qrDataUrl };
}

async function publicRow(token) {
  const verified = parseAndVerifyToken(token);
  const rows = await executeSql(
    `SELECT r.id, r.rating_status, r.teacher_id,
            r.store_environment_score, r.teacher_service_score,
            r.overall_experience_score, r.customer_comment,
            r.submitted_at AS rating_submitted_at,
            vr.verification_type, s.store_name, t.teacher_name
       FROM public.verification_customer_ratings r
       JOIN public.verification_records vr ON vr.id = r.verification_id
       JOIN public.stores s ON s.id = r.store_id
       LEFT JOIN public.teachers t ON t.id = r.teacher_id
      WHERE r.id = ${verified.id}
        AND r.token_version = ${verified.version}
        AND r.token_hash = ${sqlText(verified.tokenHash)}
      LIMIT 1`
  );
  if (!rows[0]) fail("评价链接无效或已被更新。", "NOT_FOUND");
  return { row: rows[0], verified };
}

async function getPublic(event) {
  const result = await publicRow(event.token);
  return publicRating(result.row);
}

async function submitPublic(event) {
  const result = await publicRow(event.token);
  const row = result.row;
  if (row.rating_status === "SUBMITTED" || row.rating_submitted_at) {
    return { alreadySubmitted: true, ...publicRating(row) };
  }
  const storeScore = numberScore(event.storeEnvironmentScore, "门店环境");
  const overallScore = numberScore(event.overallExperienceScore, "整体体验");
  const teacherScore = row.teacher_id
    ? numberScore(event.teacherServiceScore, "老师服务")
    : null;
  const comment = String(event.customerComment || "").trim();
  if (comment.length > 500) fail("文字评价不能超过 500 字。", "COMMENT_TOO_LONG");
  const updated = await executeSql(
    `UPDATE public.verification_customer_ratings
        SET store_environment_score = ${storeScore},
            teacher_service_score = ${teacherScore === null ? "NULL" : teacherScore},
            overall_experience_score = ${overallScore},
            customer_comment = ${sqlText(comment)},
            rating_status = 'SUBMITTED',
            submitted_at = NOW(),
            updated_at = NOW()
      WHERE id = ${result.verified.id}
        AND token_version = ${result.verified.version}
        AND token_hash = ${sqlText(result.verified.tokenHash)}
        AND submitted_at IS NULL
        AND rating_status = 'OPEN'
      RETURNING id`
  );
  if (!updated.length) {
    const latest = await publicRow(event.token);
    if (latest.row.rating_status === "SUBMITTED" || latest.row.rating_submitted_at) {
      return { alreadySubmitted: true, ...publicRating(latest.row) };
    }
    fail("评价提交失败，请重试。", "RATING_SUBMIT_FAILED");
  }
  return { submitted: true, ...(await getPublic(event)) };
}

function health() {
  const signingKeyConfigured = Boolean(ratingSigningKey({ required: false }));
  const baseUrl = ratingBaseUrl({ required: false });
  const ratingBaseUrlConfigured = Boolean(baseUrl);
  return {
    configured: Boolean(process.env.CLOUDBASE_ENV_ID || process.env.TCB_ENV)
      && signingKeyConfigured && ratingBaseUrlConfigured,
    signingKeyConfigured,
    ratingBaseUrlConfigured,
    ratingBaseUrl: baseUrl
  };
}

exports.main = async (event = {}) => {
  try {
    let data;
    switch (String(event.action || "")) {
      case "health": data = health(); break;
      case "getForStaff": data = await getForStaff(event); break;
      case "issueForStore": data = await issueForStore(event); break;
      case "getPublic": data = await getPublic(event); break;
      case "submitPublic": data = await submitPublic(event); break;
      default: fail("不支持的评价操作。", "UNKNOWN_ACTION");
    }
    return { success: true, data, version: FUNCTION_VERSION };
  } catch (error) {
    console.error("[customerRating]", error);
    return {
      success: false,
      error: { code: error?.code || "INTERNAL_ERROR", message: error?.message || "评价服务暂不可用。" },
      version: FUNCTION_VERSION
    };
  }
};
