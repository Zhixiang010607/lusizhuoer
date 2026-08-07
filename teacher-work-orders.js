(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let session = null;
  try { session = JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); } catch (_) { session = null; }
  if (!session || session.role !== "teacher") return;

  const hash = Array.from(String(session.cloudbaseUserId || session.account || "teacher"))
    .reduce((total, char) => (total * 31 + char.charCodeAt(0)) >>> 0, 7);
  const teacherCode = `TW${String(hash % 100000).padStart(5, "0")}`;
  const names = ["王女士", "陈先生", "林女士", "周先生", "张女士", "刘先生"];
  const types = ["核销服务", "课程服务", "客户回访"];
  const statuses = ["pending", "progress", "done", "done", "pending", "done"];
  const labels = { pending: "待处理", progress: "处理中", done: "已完成" };
  const orders = Array.from({ length: 12 }, (_, index) => ({
    id: `${teacherCode}-${String(index + 1).padStart(3, "0")}`,
    type: types[(hash + index) % types.length],
    customer: names[(hash + index * 3) % names.length],
    time: `2026-08-${String(8 + index % 12).padStart(2, "0")} ${String(9 + index % 7).padStart(2, "0")}:00`,
    status: statuses[(hash + index) % statuses.length]
  }));

  function renderSummary() {
    const counts = { pending: 0, progress: 0, done: 0 };
    orders.forEach((order) => counts[order.status]++);
    $("teacherSummary").innerHTML = [
      ["primary", session.staffName || "我的账号", "", "仅本人可查看"],
      ["", "待处理", counts.pending, "请优先处理"],
      ["", "处理中", counts.progress, "进行中的服务"],
      ["", "已完成", counts.done, "本周期工单"]
    ].map(([kind, title, value, note]) => `<article class="panel teacher-summary-card ${kind}"><span>${title}</span>${value !== "" ? `<strong>${value}</strong>` : `<strong>老师工作台</strong>`}<small>${note}</small></article>`).join("");
  }

  function filteredOrders() {
    const status = $("teacherOrderStatus").value;
    const type = $("teacherOrderType").value;
    return orders.filter((order) => (status === "all" || order.status === status) && (type === "all" || order.type === type));
  }

  function renderOrders() {
    const list = filteredOrders();
    $("teacherOrderCount").textContent = `${list.length} 张`;
    $("teacherOrdersBody").innerHTML = list.length ? list.map((order) => `<tr><td>${order.id}</td><td>${order.type}</td><td>${order.customer}</td><td>${order.time}</td><td><span class="teacher-order-status ${order.status}">${labels[order.status]}</span></td><td><a class="teacher-order-link" href="teacher-work-order-detail.html?orderId=${encodeURIComponent(order.id)}">查看</a></td></tr>`).join("") : `<tr><td colspan="6" class="teacher-empty">没有符合条件的本人工单</td></tr>`;
  }

  function renderToday() {
    const list = orders.filter((order) => order.status !== "done").slice(0, 4);
    $("teacherTodayList").innerHTML = list.map((order) => `<a class="teacher-today-item" href="teacher-work-order-detail.html?orderId=${encodeURIComponent(order.id)}"><strong>${order.type} · ${order.customer}</strong><span>${order.time} · ${labels[order.status]}</span></a>`).join("") || `<p class="teacher-empty">今天没有待办工单</p>`;
  }

  $("teacherOrderStatus").addEventListener("change", renderOrders);
  $("teacherOrderType").addEventListener("change", renderOrders);
  $("clearTeacherFilters").addEventListener("click", () => { $("teacherOrderStatus").value = "all"; $("teacherOrderType").value = "all"; renderOrders(); });
  renderSummary(); renderOrders(); renderToday();
})();
