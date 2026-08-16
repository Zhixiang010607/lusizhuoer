(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const customerId = params.get("customerId") || "";
  const read = (key) => { try { return JSON.parse(sessionStorage.getItem(key) || "[]"); } catch (_) { return []; } };
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const dateText = (value) => value ? String(value).replace("T", " ").replace(/\.\d{3}Z$/, "").slice(0, 16) : "—";
  const statusText = (value) => ({ pending: "待审核", approved: "已通过", rejected: "已驳回", "待审核": "待审核", "已通过": "已通过", "已驳回": "已驳回", "正常": "已通过", normal: "已通过", "待运营审核": "待审核" }[value] || "待审核");
  const approved = (value) => ["approved", "已通过", "正常", "normal"].includes(value);
  const emptyRow = (columns, text) => `<tr><td colspan="${columns}" class="query-empty">${text}</td></tr>`;

  const customers = read("prototypeCreatedCustomers");
  const customer = customers.find((row) => row.id === customerId) || { id: customerId, name: params.get("customerName") || "", birthday: "", storeId: params.get("storeId") || "", notes: "" };
  const stores = read("prototypeCreatedStores");
  const store = stores.find((row) => row.id === customer.storeId);
  const storeLabel = store ? `${store.name} · ${store.id}` : customer.storeId ? `— · ${customer.storeId}` : "—";
  const rechargeRecords = read("prototypeRechargeApplications").filter((row) => row.customerId === customer.id);
  const verificationRecords = read("prototypeVerificationRecords").filter((row) => row.customerId === customer.id);
  const teacherRechargeRecords = read("prototypeTeacherRechargeRecords").filter((row) => row.customerId === customer.id);
  const teacherVerificationRecords = read("prototypeTeacherVerificationRecords").filter((row) => row.customerId === customer.id);
  const recharges = [...rechargeRecords, ...teacherRechargeRecords];
  const verifications = [...verificationRecords, ...teacherVerificationRecords];
  const ordered = (rows) => rows.slice().sort((a, b) => String(b.createdAt || b.time || "").localeCompare(String(a.createdAt || a.time || "")));
  const latest = (rows) => ordered(rows)[0]?.createdAt || ordered(rows)[0]?.time || "";
  const infoCard = (label, value) => `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || "—")}</strong></article>`;

  document.title = customer.name ? `${customer.name} · 客户主页` : "客户主页";
  const candidatePhotoUrl = String(customer.profilePhotoUrl || customer.photoUrl || customer.photoTemporaryUrl || "");
  const photoUrl = /^(https:|blob:|data:image\/)/i.test(candidatePhotoUrl) ? candidatePhotoUrl : "";
  const photo = photoUrl ? `<img src="${escapeHtml(photoUrl)}" alt="${escapeHtml(customer.name || "客户")}的建档照片">` : `<div class="customer-photo-placeholder" aria-label="暂无可显示的客户建档照片">客户照片</div>`;
  $("customerProfilePhoto").innerHTML = photo;
  $("customerBasicInfo").innerHTML = [infoCard("客户姓名", customer.name), infoCard("客户编号", customer.id), infoCard("生日", customer.birthday), infoCard("所属门店", storeLabel)].join("");
  const customerCreatedAt = customer.createdAt || customer.created_at || customer.createdTime || "";
  $("customerRecentInfo").innerHTML = `<article><span>最近充值时间</span><strong>${escapeHtml(dateText(latest(recharges)))}</strong></article><article><span>最近核销时间</span><strong>${escapeHtml(dateText(latest(verifications)))}</strong></article><article><span>客户建立时间</span><strong>${escapeHtml(dateText(customerCreatedAt))}</strong></article>`;
  $("customerNotes").value = customer.notes || "";

  const projects = new Map();
  recharges.forEach((row) => {
    const projectId = row.projectId || "", projectName = row.projectName || row.project || projectId || "未填写项目";
    if (!projects.has(projectId)) projects.set(projectId, { name: projectName, recharge: 0, verification: 0 });
    if (approved(row.status)) projects.get(projectId).recharge += Number(row.count || 0);
  });
  verifications.forEach((row) => {
    const projectId = row.projectId || "", item = projects.get(projectId);
    if (item && approved(row.status) && row.verificationType !== "作废") item.verification += Number(row.count || 1);
  });
  $("customerProjectSummary").innerHTML = projects.size ? [...projects.entries()].map(([id, row]) => `<tr><td>${escapeHtml(row.name)}${id ? ` · ${escapeHtml(id)}` : ""}</td><td>${row.recharge}</td><td>${row.verification}</td><td><strong>${Math.max(0, row.recharge - row.verification)}</strong></td></tr>`).join("") : emptyRow(4, "暂无已充值项目");
  $("customerRechargeRecords").innerHTML = recharges.length ? ordered(recharges).map((row) => `<tr><td>${escapeHtml(row.id)}</td><td>${escapeHtml(row.projectName || row.project || row.projectId)}</td><td>+${Number(row.count || 0)}</td><td>${escapeHtml(dateText(row.createdAt || row.time))}</td><td>${escapeHtml(statusText(row.status))}</td></tr>`).join("") : emptyRow(5, "暂无充值记录");
  $("customerVerificationRecords").innerHTML = verifications.length ? ordered(verifications).map((row) => `<tr><td>${escapeHtml(row.id)}</td><td>${escapeHtml(row.projectName || row.project || row.projectId)}</td><td>${escapeHtml(row.verificationType || "正常核销")}</td><td>${escapeHtml(dateText(row.createdAt || row.time))}</td><td>${escapeHtml(statusText(row.status))}</td></tr>`).join("") : emptyRow(5, "暂无核销记录");
})();
