(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let session = null;
  try { session = JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); } catch (_) { session = null; }
  if (!session || session.role !== "teacher") return;
  const hash = Array.from(String(session.cloudbaseUserId || session.account || "teacher")).reduce((total, char) => (total * 31 + char.charCodeAt(0)) >>> 0, 7);
  const teacherId = `T${String(hash % 900 + 100).padStart(3, "0")}`, type = new URLSearchParams(location.search).get("type"), recordId = new URLSearchParams(location.search).get("recordId") || "";
  if (!['verification', 'recharge'].includes(type) || !recordId.includes(`-${teacherId}-`)) { location.replace("teacher-work-orders.html"); return; }
  const number = Number(recordId.split("-").at(-1)) || 1, isVerification = type === "verification", customer = ["王女士", "陈先生", "林女士", "周先生", "张女士", "刘先生"][(hash + number) % 6], project = ["普拉提", "体态评估", "康复训练", "瑜伽", "力量训练", "产后恢复"][(hash + number) % 6];
  const fields = isVerification ? [["核销编号", recordId], ["客户", customer], ["项目", project], ["人脸核验", "人脸核验通过"], ["核销时间", `2026-08-${String(number).padStart(2, "0")} 10:00`], ["负责老师", session.staffName || "当前登录老师"]] : [["充值编号", recordId], ["客户", customer], ["项目", project], ["充值次数", `${10 + number * 5} 次`], ["提交时间", `2026-07-${String(17 + number).padStart(2, "0")} 14:30`], ["负责老师", session.staffName || "当前登录老师"]];
  document.title = isVerification ? "我的核销详情" : "我的充值详情"; document.querySelector("h1").textContent = isVerification ? "我的核销详情" : "我的充值详情"; $("teacherOrderInfo").innerHTML = fields.map(([key, value]) => `<article><span>${key}</span><strong>${value}</strong></article>`).join(""); $("detailStatus").textContent = "正常";
})();
