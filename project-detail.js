(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const projectId = new URLSearchParams(location.search).get("projectId");
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
  const read = (key) => { try { return JSON.parse(sessionStorage.getItem(key) || "[]"); } catch (_) { return []; } };
  const projects = read("prototypeCreatedProjects");
  const stores = read("prototypeCreatedStores");
  const teachers = read("prototypeCreatedTeachers");
  const project = projects.find((item) => item.id === projectId);
  const recharges = read("prototypeRechargeApplications");
  const verifications = read("prototypeVerificationRecords");

  function dateAllowed(record, period) {
    if (period === "all") return true;
    const date = new Date(record.createdAt || record.time || record.updatedAt || 0);
    if (!Number.isFinite(date.getTime())) return false;
    const now = new Date();
    if (period === "30") return date >= new Date(now.getFullYear(), now.getMonth(), now.getDate() - 29);
    return date >= new Date(now.getFullYear(), 0, 1);
  }
  function effectiveRecharge(record) { return ["正常", "已通过", "APPROVED", "approved"].includes(record.status); }
  function effectiveVerification(record) { return ["正常", "已通过", "APPROVED", "approved"].includes(record.status); }
  function nameForStore(id) { return stores.find((item) => item.id === id)?.name || id; }
  function nameForTeacher(id) { return teachers.find((item) => item.id === id)?.name || id; }
  function empty(target, colspan) { $(target).innerHTML = `<tr><td colspan="${colspan}" class="query-empty">暂无业务数据</td></tr>`; }

  function renderStores() {
    if (!project) return empty("projectStoreBody", 4);
    const period = $("storePeriod").value;
    const rows = new Map();
    recharges.filter((record) => record.projectId === project.id && effectiveRecharge(record) && dateAllowed(record, period)).forEach((record) => {
      const current = rows.get(record.storeId) || { storeId: record.storeId, recharge: 0, verification: 0 };
      current.recharge += Number(record.count || 0); rows.set(record.storeId, current);
    });
    verifications.filter((record) => record.projectId === project.id && effectiveVerification(record) && dateAllowed(record, period)).forEach((record) => {
      const current = rows.get(record.storeId) || { storeId: record.storeId, recharge: 0, verification: 0 };
      current.verification += Number(record.count || 1); rows.set(record.storeId, current);
    });
    const values = [...rows.values()].sort((a, b) => nameForStore(a.storeId).localeCompare(nameForStore(b.storeId), "zh-CN"));
    if (!values.length) return empty("projectStoreBody", 4);
    $("projectStoreBody").innerHTML = values.map((row) => `<tr><td><a class="record-link" href="store-detail.html?storeId=${encodeURIComponent(row.storeId)}">${escapeHtml(nameForStore(row.storeId))}（${escapeHtml(row.storeId)}）</a></td><td>${row.recharge}</td><td>${row.verification}</td><td><strong>${row.recharge - row.verification}</strong></td></tr>`).join("");
  }
  function renderTeachers() {
    if (!project) return empty("projectTeacherBody", 2);
    const period = $("teacherPeriod").value;
    const rows = new Map();
    verifications.filter((record) => record.projectId === project.id && effectiveVerification(record) && dateAllowed(record, period)).forEach((record) => {
      const current = rows.get(record.teacherId) || { teacherId: record.teacherId, verification: 0 };
      current.verification += Number(record.count || 1); rows.set(record.teacherId, current);
    });
    const values = [...rows.values()].sort((a, b) => b.verification - a.verification);
    if (!values.length) return empty("projectTeacherBody", 2);
    $("projectTeacherBody").innerHTML = values.map((row) => `<tr><td>${escapeHtml(nameForTeacher(row.teacherId))}（${escapeHtml(row.teacherId || "未绑定")}）</td><td>${row.verification}</td></tr>`).join("");
  }
  function renderProfile() {
    if (!project) {
      $("projectHero").innerHTML = `<div><span class="profile-type">产品详情</span><h2>未找到产品</h2><p>该产品不存在或尚未创建。</p></div>`;
      $("projectBasicGrid").innerHTML = ""; renderStores(); renderTeachers(); return;
    }
    $("projectHero").innerHTML = `<div class="profile-avatar project-profile-avatar">产</div><div><span class="profile-type">产品编号</span><h2>${escapeHtml(project.name)}</h2><p>${escapeHtml(project.id)} · ${escapeHtml(project.status || "活跃")}</p></div>`;
    $("projectBasicGrid").innerHTML = [["产品编号", project.id], ["产品名称", project.name], ["状态", project.status || "活跃"], ["说明", project.description || "未填写"]].map(([key, value]) => `<article><span>${key}</span><strong>${escapeHtml(value)}</strong></article>`).join("");
    renderStores(); renderTeachers();
  }
  $("storePeriod").addEventListener("change", renderStores);
  $("teacherPeriod").addEventListener("change", renderTeachers);
  renderProfile();
})();
