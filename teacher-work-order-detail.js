(() => {
  "use strict";
  const VERSION = "0.15.0", $ = (id) => document.getElementById(id);
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  const formatDateTime = (value) => window.AppDateTime?.format?.(value, "—") || "—";
  let session = null; try { session = JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); } catch (_) { session = null; }
  if (!session || session.role !== "teacher") return;
  const params = new URLSearchParams(location.search), type = String(params.get("type") || "").toLowerCase(), recordId = String(params.get("recordId") || "");
  if (!['verification', 'recharge'].includes(type) || !/^\d+$/.test(recordId)) { location.replace("teacher-work-orders.html"); return; }
  function parsed(value) { if (value && typeof value === "object") return value; if (typeof value !== "string") return null; try { return JSON.parse(value); } catch (_) { return null; } }
  function dataOf(result) { return [result?.result, result?.data?.result, result?.data, result].map(parsed).find((value) => value && (Object.prototype.hasOwnProperty.call(value, "ok") || Object.prototype.hasOwnProperty.call(value, "code"))) || {}; }
  function register(fn, name) { if (typeof fn !== "function") return; try { fn(window.cloudbase); } catch (error) { const message = String(error?.message || error || "").toLowerCase(); if (!(message.includes("duplicate component") && message.includes(name))) throw error; } }
  async function load() {
    if (!window.cloudbase || !window.CloudBaseAuthConfig || !window.registerFunctions) throw new Error("数据库组件尚未加载，请刷新重试。");
    register(window.registerAuth, "auth"); register(window.registerFunctions, "functions");
    const raw = await window.cloudbase.init(window.CloudBaseAuthConfig).callFunction({ name: "faceRecognition", data: { action: "getTeacherWorkspace", recordType: type.toUpperCase(), recordId } });
    const result = dataOf(raw); if (!result.ok || !result.record) throw new Error(result.message || "未找到本人绑定的工单。"); return result.record;
  }
  function statusOf(row) {
    if (row.recordStatus === "VOIDED" || row.voidRequestStatus === "APPROVED") return "已作废";
    if (row.recordStatus === "APPROVED" && row.voidRequestStatus === "PENDING") return "已通过 · 作废待审核";
    if (row.recordStatus === "APPROVED" && row.voidRequestStatus === "REJECTED") return "已通过 · 作废已驳回";
    return ({ PENDING: "待审核", APPROVED: "已通过", REJECTED: "已驳回" }[row.recordStatus] || "未知状态");
  }
  function render(row) {
    const verification = row.recordType === "VERIFICATION", status = statusOf(row);
    const kind = verification ? ({ NORMAL: "正常核销", SUPPLEMENT: "补录核销", EXPERIENCE: "体验核销" }[row.originalType] || "核销") : (row.originalType === "VOID" ? "历史冲销" : "充值");
    const fields = [[verification ? "核销单号" : "充值单号", row.recordCode], ["业务类型", kind], ["门店", `${row.storeName} · ${row.storeCode}`], ["客户", `${row.customerName} · ${row.customerCode}`], ["项目", `${row.productName} · ${row.productCode}`], ["绑定老师", `${row.teacherName} · ${row.teacherCode}`], [verification ? "核销次数" : "充值次数", `${row.originalType === "VOID" ? "−" : verification ? "" : "+"}${row.unitCount} 次`], ["提交时间", formatDateTime(row.submittedAt)], ["审核时间", formatDateTime(row.reviewedAt)]];
    if (verification) fields.splice(7, 0, ["人脸核验", row.hasFaceRequest ? "已记录核验请求" : "无核验请求记录"]);
    $("teacherOrderInfo").innerHTML = fields.map(([label, value]) => `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`).join("");
    $("detailStatus").textContent = status; $("teacherReviewResult").textContent = status; $("teacherReviewMessage").textContent = row.reviewNote || "—";
    document.title = verification ? "我的核销详情" : "我的充值详情"; document.querySelector("h1").textContent = document.title;
  }
  load().then(render).catch((error) => { $("detailStatus").textContent = "读取失败"; $("teacherReviewResult").textContent = "无法读取"; $("teacherDetailMessage").textContent = error?.message || "无法读取本人工单。"; $("teacherOrderInfo").innerHTML = '<article><span>读取结果</span><strong>无权查看或工单不存在</strong></article>'; });
})();
