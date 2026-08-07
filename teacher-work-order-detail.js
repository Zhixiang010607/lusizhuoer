(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let session = null;
  try { session = JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); } catch (_) { session = null; }
  if (!session || session.role !== "teacher") return;
  const hash = Array.from(String(session.cloudbaseUserId || session.account || "teacher")).reduce((total, char) => (total * 31 + char.charCodeAt(0)) >>> 0, 7);
  const prefix = `TW${String(hash % 100000).padStart(5, "0")}-`;
  const orderId = new URLSearchParams(location.search).get("orderId") || "";
  if (!orderId.startsWith(prefix)) { location.replace("teacher-work-orders.html"); return; }
  const number = Number(orderId.slice(prefix.length)) || 1;
  const type = ["核销服务", "课程服务", "客户回访"][(hash + number) % 3];
  const status = ["待处理", "处理中", "已完成"][(hash + number) % 3];
  const customer = ["王女士", "陈先生", "林女士", "周先生", "张女士", "刘先生"][(hash + number) % 6];
  const fields = [["工单号", orderId], ["工单类型", type], ["客户", customer], ["预约时间", `2026-08-${String(8 + number % 12).padStart(2, "0")} 10:00`], ["当前状态", status], ["负责老师", session.staffName || "当前登录老师"]];
  $("teacherOrderInfo").innerHTML = fields.map(([key, value]) => `<article><span>${key}</span><strong>${value}</strong></article>`).join("");
  $("detailStatus").textContent = status;
})();
