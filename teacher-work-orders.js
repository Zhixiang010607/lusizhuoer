(() => {
  "use strict";
  const VERSION = "0.15.1";
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const formatDateTime = (value) => window.AppDateTime?.format?.(value, "—") || "—";
  let session = null;
  try { session = JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); } catch (_) { session = null; }
  if (!session || session.role !== "teacher") return;

  const state = { activeType: "VERIFICATION", loading: false, records: { RECHARGE: [], VERIFICATION: [] }, cursors: { RECHARGE: null, VERIFICATION: null }, hasMore: { RECHARGE: false, VERIFICATION: false } };
  function parsedObject(value) { if (value && typeof value === "object") return value; if (typeof value !== "string") return null; try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" ? parsed : null; } catch (_) { return null; } }
  function responseData(result) { return [result?.result, result?.data?.result, result?.data, result].map(parsedObject).find((candidate) => candidate && (Object.prototype.hasOwnProperty.call(candidate, "ok") || Object.prototype.hasOwnProperty.call(candidate, "code"))) || {}; }
  function register(registerFn, name) { if (typeof registerFn !== "function") return; try { registerFn(window.cloudbase); } catch (error) { const message = String(error?.message || error || "").toLowerCase(); if (!(message.includes("duplicate component") && message.includes(name))) throw error; } }
  async function callWorkspace(data) {
    if (!window.cloudbase || !window.CloudBaseAuthConfig || !window.registerFunctions) throw new Error("数据库组件尚未加载，请刷新重试。");
    register(window.registerAuth, "auth"); register(window.registerFunctions, "functions");
    const raw = await window.cloudbase.init(window.CloudBaseAuthConfig).callFunction({ name: "faceRecognition", data: { action: "getTeacherWorkspace", ...data } });
    const result = responseData(raw); if (!result.ok) throw new Error(result.message || "无法读取老师工作台。"); return result;
  }
  const typeLabel = (row) => row.recordType === "RECHARGE" ? (row.originalType === "VOID" ? "历史冲销" : "充值") : ({ NORMAL: "正常核销", SUPPLEMENT: "补录核销", EXPERIENCE: "体验核销" }[row.originalType] || "核销");
  function statusLabel(row) {
    if (row.recordStatus === "VOIDED" || row.voidRequestStatus === "APPROVED") return ["已作废", "void"];
    if (row.recordStatus === "APPROVED" && row.voidRequestStatus === "PENDING") return ["已通过 · 作废待审", "review"];
    if (row.recordStatus === "APPROVED" && row.voidRequestStatus === "REJECTED") return ["已通过 · 作废驳回", "normal"];
    return ({ PENDING: ["待审核", "review"], APPROVED: ["已通过", "normal"], REJECTED: ["已驳回", "void"] }[row.recordStatus] || ["未知状态", "review"]);
  }
  function renderProfile(profile = {}) {
    const values = [["老师姓名", profile.teacherName || session.staffName || "—"], ["老师短编号", profile.teacherCode || session.staffCode || "—"], ["登录手机号", session.phone || session.account || "—"], ["账号状态", "活跃"]];
    $("teacherProfileInfo").innerHTML = values.map(([label, value]) => `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`).join("");
  }
  function renderRecords() {
    const type = state.activeType, verification = type === "VERIFICATION", rows = state.records[type];
    $("teacherRecordsHead").innerHTML = `<tr><th>${verification ? "核销单号" : "充值单号"}</th><th>门店</th><th>客户</th><th>项目</th><th>${verification ? "核销类型／人脸" : "充值次数"}</th><th>提交时间</th><th>状态</th></tr>`;
    $("teacherOrdersBody").innerHTML = rows.length ? rows.map((row) => {
      const [status, statusClass] = statusLabel(row);
      const amount = verification ? `${escapeHtml(typeLabel(row))}${row.hasFaceRequest ? " · 已核验" : " · 无人脸记录"}` : `${row.originalType === "VOID" ? "−" : "+"}${escapeHtml(row.unitCount)} 次`;
      const detailParams = new URLSearchParams({ recordId: String(row.id), recordCode: String(row.recordCode || ""), source: "teacher" });
      const detail = `${verification ? "verification" : "recharge"}-detail.html?${detailParams.toString()}`;
      return `<tr><td><a class="teacher-order-link" href="${detail}">${escapeHtml(row.recordCode)}</a></td><td>${escapeHtml(row.storeName)} · ${escapeHtml(row.storeCode)}</td><td>${escapeHtml(row.customerName)} · ${escapeHtml(row.customerCode)}</td><td>${escapeHtml(row.productName)} · ${escapeHtml(row.productCode)}</td><td>${amount}</td><td>${escapeHtml(formatDateTime(row.submittedAt))}</td><td><span class="teacher-order-status ${statusClass}">${escapeHtml(status)}</span></td></tr>`;
    }).join("") : `<tr><td colspan="7" class="teacher-empty">暂无本人绑定的${verification ? "核销" : "充值"}工单</td></tr>`;
    $("teacherLoadedCount").textContent = `${rows.length} 条`; $("teacherLoadMore").hidden = !state.hasMore[type]; $("teacherLoadMore").disabled = state.loading;
  }
  function mergePage(type, page) {
    const known = new Set(state.records[type].map((row) => String(row.id)));
    for (const row of Array.isArray(page?.records) ? page.records : []) if (!known.has(String(row.id))) state.records[type].push(row);
    state.cursors[type] = page?.nextCursor || null; state.hasMore[type] = Boolean(page?.hasMore && page?.nextCursor);
  }
  async function loadMore() {
    const type = state.activeType; if (state.loading || !state.hasMore[type] || !state.cursors[type]) return;
    state.loading = true; renderRecords(); $("teacherWorkspaceMessage").textContent = "正在继续读取…";
    try { const result = await callWorkspace({ recordType: type, cursorSubmittedAt: state.cursors[type].submittedAt, cursorId: state.cursors[type].id, limit: 50 }); mergePage(type, result.page); $("teacherWorkspaceMessage").textContent = ""; }
    catch (error) { $("teacherWorkspaceMessage").textContent = error?.message || "继续加载失败。"; }
    finally { state.loading = false; renderRecords(); }
  }
  function setType(type) {
    state.activeType = type; $("teacherVerificationTab").classList.toggle("active", type === "VERIFICATION"); $("teacherRechargeTab").classList.toggle("active", type === "RECHARGE");
    $("teacherVerificationTab").setAttribute("aria-selected", String(type === "VERIFICATION")); $("teacherRechargeTab").setAttribute("aria-selected", String(type === "RECHARGE")); renderRecords();
  }
  async function init() {
    try { const result = await callWorkspace({ limit: 50 }); renderProfile(result.profile); mergePage("RECHARGE", result.recharges); mergePage("VERIFICATION", result.verifications); renderRecords(); }
    catch (error) { renderProfile({}); $("teacherWorkspaceMessage").textContent = error?.message || "老师工作台读取失败。"; $("teacherOrdersBody").innerHTML = '<tr><td colspan="7" class="teacher-empty">无法读取数据库工单，请刷新重试</td></tr>'; }
  }
  $("teacherVerificationTab").addEventListener("click", () => setType("VERIFICATION")); $("teacherRechargeTab").addEventListener("click", () => setType("RECHARGE")); $("teacherLoadMore").addEventListener("click", loadMore); init();
})();
