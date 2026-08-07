(() => {
  "use strict";

  const VERSION = "0.14.19";
  const params = new URLSearchParams(window.location.search);
  const $ = (id) => document.getElementById(id);
  let loginSession = null; try { loginSession = JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); } catch (_) { loginSession = null; }
  const canOpenAggregates = loginSession?.role === "hq";
  const escapeHtml = (value) => String(value).replace(/[&<>\"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
  const numberFrom = (value) => Number(String(value).replace(/\D/g, "")) || 1;
  const projects = ["普拉提", "体态评估", "康复训练", "瑜伽", "力量训练", "产后恢复"];
  const cities = ["悉尼", "墨尔本", "布里斯班", "珀斯"];
  const infoCards = (items) => items.map(([label, value]) => `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></article>`).join("");

  function renderCustomer() {
    const id = params.get("customerId") || "C001001";
    const storeId = params.get("storeId") || `S${String(Math.max(1, numberFrom(id) % 16)).padStart(3, "0")}`;
    const seed = numberFrom(id);
    const storeNo = numberFrom(storeId);
    let customerOverrides = {};
    try { customerOverrides = JSON.parse(sessionStorage.getItem("prototypeCustomerOverrides") || "{}"); } catch (_) { customerOverrides = {}; }
    const current = customerOverrides[id] || {}, name = current.name || params.get("customerName") || `客户 ${String(seed % 100 || 1).padStart(2, "0")}`, birthday = current.birthday || `${1984 + seed % 19}-${String(seed % 12 + 1).padStart(2, "0")}-${String(seed % 27 + 1).padStart(2, "0")}`;
    const store = `${cities[(storeNo - 1) % cities.length]}门店 ${storeNo}`;
    $("profileHero").innerHTML = `<div class="profile-avatar">${name.slice(-2)}</div><div><span class="profile-type">客户编号</span><h2>${escapeHtml(name)}</h2><p><a class="record-link" href="#basicInfo">${escapeHtml(id)}</a> · ${escapeHtml(store)} · 正常客户</p></div><div class="profile-metrics"><span><strong>${3 + seed % 4}</strong>持有项目</span><span><strong>${68 + seed % 90}</strong>累计购买</span><span><strong>${21 + seed % 55}</strong>剩余次数</span></div>`;
    $("basicInfoGrid").innerHTML = infoCards([
      ["客户编号", id], ["客户姓名", name], ["生日", birthday],
      ["当前门店", `${store}（${storeId}）`], ["客户状态", "正常"], ["建档日期", "2024-03-18"], ["手机号码", "按权限脱敏显示"], ["备注", "无特殊备注"]
    ]);
    const rights = projects.slice(0, 3 + seed % 4).map((project, i) => {
      const bought = 18 + (seed + i * 13) % 48;
      const used = Math.min(bought, 4 + (seed + i * 7) % 27);
      const projectId = `P${String(i + 1).padStart(3, "0")}`;
      const projectCode = canOpenAggregates ? `<a class="record-link" href="project-detail.html?projectId=${projectId}">${projectId}</a>` : projectId;
      return `<tr><td>${projectCode}</td><td>${project}</td><td>${bought}</td><td>${used}</td><td><strong>${bought - used}</strong></td><td>2026-0${i + 2}-12</td><td>2026-0${i + 4}-18</td><td>正常</td></tr>`;
    }).join("");
    $("projectRightsBody").innerHTML = rights;
    $("rechargeBody").innerHTML = Array.from({ length: 7 }, (_, i) => { const projectId = `P${String(i % projects.length + 1).padStart(3, "0")}`, recordId = `RC-${id}-${String(i + 1).padStart(2, "0")}`, projectValue = canOpenAggregates ? `<a class="record-link" href="project-detail.html?projectId=${projectId}">${projects[i % projects.length]}</a>` : projects[i % projects.length], status = i === 5 ? "补录" : "正常", progress = status === "正常" ? "已完成" : "审核中", submittedAt = `2026-0${i % 8 + 1}-${String(i * 3 + 2).padStart(2, "0")} ${String(9 + i).padStart(2, "0")}:${String(10 + i).padStart(2, "0")}:${String(5 + i * 7).padStart(2, "0")}`; return `<tr><td><a class="record-link" href="recharge-detail.html?recordId=${encodeURIComponent(recordId)}&customerId=${encodeURIComponent(id)}&customerName=${encodeURIComponent(name)}&storeId=${encodeURIComponent(storeId)}">${recordId}</a></td><td>${submittedAt}</td><td>${projectValue}</td><td>+${10 + i * 2}</td><td>${store}</td><td>${status}</td><td>${progress}</td></tr>`; }).join("");
    $("verificationBody").innerHTML = Array.from({ length: 9 }, (_, i) => { const teacherId = `T${String(i % 8 + 1).padStart(3, "0")}`, projectId = `P${String(i % projects.length + 1).padStart(3, "0")}`, recordId = `VE-${id}-${String(i + 1).padStart(2, "0")}`, kind = i === 6 ? "作废" : "正常", projectValue = canOpenAggregates ? `<a class="record-link" href="project-detail.html?projectId=${projectId}">${projects[i % projects.length]}</a>` : projects[i % projects.length], teacherValue = canOpenAggregates ? `<a class="record-link" href="teacher-detail.html?teacherId=${teacherId}">业务老师 ${String(i % 8 + 1).padStart(2, "0")}（${teacherId}）</a>` : `业务老师 ${String(i % 8 + 1).padStart(2, "0")}（${teacherId}）`, progress = kind === "正常" ? "已完成" : "审核中", submittedAt = `2026-0${i % 8 + 1}-${String(i * 2 + 1).padStart(2, "0")} ${String(10 + i).padStart(2, "0")}:${String(12 + i).padStart(2, "0")}:${String(8 + i * 5).padStart(2, "0")}`; return `<tr><td><a class="record-link" href="verification-detail.html?recordId=${encodeURIComponent(recordId)}&customerId=${encodeURIComponent(id)}&customerName=${encodeURIComponent(name)}&storeId=${encodeURIComponent(storeId)}&kind=${encodeURIComponent(kind)}">${recordId}</a></td><td>${submittedAt}</td><td>${store}</td><td>${projectValue}</td><td>${teacherValue}</td><td>1</td><td><span class="photo-required-status">已拍摄</span></td><td>${kind}</td><td>${progress}</td></tr>`; }).join("");
    $("auditTimeline").innerHTML = `<div><strong>2024-03-18 09:32</strong><span>${store}创建客户，已完成现场拍照</span></div><div><strong>2025-11-02 14:18</strong><span>OP001 · 运营管理员修改客户备注</span></div><div><strong>2026-08-05 16:20</strong><span>${store}提交核销修改申请</span></div>`;
  }

  document.documentElement.dataset.prototypeVersion = VERSION;
  renderCustomer();
})();
