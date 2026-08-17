(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const customerId = params.get("customerId") || "";
  const read = (key) => { try { return JSON.parse(sessionStorage.getItem(key) || "[]"); } catch (_) { return []; } };
  const readObject = (key) => { try { return JSON.parse(sessionStorage.getItem(key) || "null"); } catch (_) { return null; } };
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const formatBirthday = (value, fallback = "—") => {
    const raw = String(value ?? "").trim();
    if (!raw) return fallback;
    const match = raw.match(/^(\d{4})[-年](\d{1,2})[-月](\d{1,2})(?:日|[T\s].*)?$/);
    return match ? `${match[1]}年${match[2].padStart(2, "0")}月${match[3].padStart(2, "0")}日` : raw;
  };
  const dateText = (value) => value ? String(value).replace("T", " ").replace(/\.\d{3}Z$/, "").slice(0, 16) : "—";
  const statusText = (value) => ({ pending: "待审核", approved: "已通过", rejected: "已驳回", "待审核": "待审核", "已通过": "已通过", "已驳回": "已驳回", "正常": "已通过", normal: "已通过", "待运营审核": "待审核" }[value] || "待审核");
  const approved = (value) => ["approved", "已通过", "正常", "normal"].includes(value);
  const emptyRow = (columns, text) => `<tr><td colspan="${columns}" class="query-empty">${text}</td></tr>`;
  const normalizeCustomerStatus = (value) => String(value || "").trim().toUpperCase() === "ARCHIVED" || value === "封存" || value === "已存档" ? "ARCHIVED" : "ACTIVE";
  const session = readObject("prototypeSession");
  const canManageCustomerStatus = ["hq", "store"].includes(session?.role);
  const canReadCustomerPhoto = ["hq", "store"].includes(session?.role);

  const customers = read("prototypeCreatedCustomers");
  const customer = customers.find((row) => row.id === customerId) || { id: customerId, name: params.get("customerName") || "", birthday: "", storeId: params.get("storeId") || "", notes: "" };
  const stores = read("prototypeCreatedStores");
  const rechargeRecords = read("prototypeRechargeApplications").filter((row) => row.customerId === customer.id);
  const verificationRecords = read("prototypeVerificationRecords").filter((row) => row.customerId === customer.id);
  const teacherRechargeRecords = read("prototypeTeacherRechargeRecords").filter((row) => row.customerId === customer.id);
  const teacherVerificationRecords = read("prototypeTeacherVerificationRecords").filter((row) => row.customerId === customer.id);
  const recharges = [...rechargeRecords, ...teacherRechargeRecords];
  const verifications = [...verificationRecords, ...teacherVerificationRecords];
  const ordered = (rows) => rows.slice().sort((a, b) => String(b.createdAt || b.time || "").localeCompare(String(a.createdAt || a.time || "")));
  const latest = (rows) => ordered(rows)[0]?.createdAt || ordered(rows)[0]?.time || "";
  const infoCard = (label, value) => `<article><span>${escapeHtml(label)}</span><strong>${escapeHtml(value || "—")}</strong></article>`;

  function customerStoreLabel() {
    if (customer.storeName) return `${customer.storeName}${customer.storeCode ? ` · ${customer.storeCode}` : customer.storeId ? ` · ${customer.storeId}` : ""}`;
    const store = stores.find((row) => String(row.id) === String(customer.storeId));
    return store ? `${store.name} · ${store.code || store.id}` : customer.storeId ? `— · ${customer.storeId}` : "—";
  }
  function renderCustomerBasicInfo() {
    $("customerBasicInfo").innerHTML = [infoCard("客户姓名", customer.name), infoCard("客户编号", customer.id), infoCard("生日", formatBirthday(customer.birthday)), infoCard("所属门店", customerStoreLabel())].join("");
  }

  function parsedObject(value) {
    if (value && typeof value === "object") return value;
    if (typeof value !== "string") return null;
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" ? parsed : null; } catch (_) { return null; }
  }
  function cloudFunctionData(result) {
    return [result?.result, result?.data?.result, result?.data, result].map(parsedObject).find((candidate) => candidate && (
      Object.prototype.hasOwnProperty.call(candidate, "ok") ||
      Object.prototype.hasOwnProperty.call(candidate, "message") ||
      Object.prototype.hasOwnProperty.call(candidate, "code")
    )) || {};
  }
  function registerCloudBaseComponent(register, componentName) {
    if (typeof register !== "function") return;
    try { register(window.cloudbase); }
    catch (error) {
      const detail = String(error?.message || error || "").toLowerCase();
      if (!(detail.includes("duplicate component") && detail.includes(componentName))) throw error;
    }
  }
  async function callCustomerService(payload) {
    if (!window.cloudbase || !window.CloudBaseAuthConfig || !window.registerFunctions) throw new Error("CloudBase 客户服务未加载，请刷新后重试");
    registerCloudBaseComponent(window.registerAuth, "auth");
    registerCloudBaseComponent(window.registerFunctions, "functions");
    const cloudApp = window.cloudbase.init(window.CloudBaseAuthConfig);
    let result;
    try { result = await cloudApp.callFunction({ name: "faceRecognition", data: payload }); }
    catch (error) {
      const diagnostic = [error?.code, error?.requestId || error?.RequestId].filter(Boolean).join(" · ");
      throw new Error(`${error?.message || "客户状态服务调用失败"}${diagnostic ? `（${diagnostic}）` : ""}`);
    }
    const data = cloudFunctionData(result);
    if (!data?.ok) {
      const diagnostic = [data?.code, data?.requestId].filter(Boolean).join(" · ");
      throw new Error(`${data?.message || "客户状态服务没有返回业务结果"}${diagnostic ? `（${diagnostic}）` : ""}`);
    }
    return data;
  }

  let currentCustomerStatus = normalizeCustomerStatus(customer.customerStatus || customer.customer_status);
  let statusRequestPending = false;
  function mirrorCustomerStatus(status) {
    const normalized = normalizeCustomerStatus(status);
    customer.customerStatus = normalized;
    try {
      const localCustomers = read("prototypeCreatedCustomers");
      const index = localCustomers.findIndex((item) => item.id === customerId);
      if (index >= 0) {
        localCustomers[index] = { ...localCustomers[index], customerStatus: normalized };
        sessionStorage.setItem("prototypeCreatedCustomers", JSON.stringify(localCustomers));
      }
      const archived = new Set(read("prototypeArchivedCustomers"));
      if (normalized === "ARCHIVED") archived.add(customerId); else archived.delete(customerId);
      sessionStorage.setItem("prototypeArchivedCustomers", JSON.stringify([...archived]));
    } catch (_) { /* 仅同步页面缓存；数据库状态已经由云函数写入。 */ }
  }
  function renderCustomerStatus(status, message = "") {
    currentCustomerStatus = normalizeCustomerStatus(status);
    const archived = currentCustomerStatus === "ARCHIVED";
    const badge = $("customerStatusBadge"), toggle = $("customerStatusToggle"), output = $("customerStatusMessage");
    badge.textContent = archived ? "已封存" : "活跃";
    badge.className = `record-status ${archived ? "status-已作废" : "status-正常"}`;
    toggle.textContent = archived ? "激活客户" : "封存客户";
    toggle.className = archived ? "customer-status-activate" : "danger-button";
    toggle.hidden = !canManageCustomerStatus;
    toggle.disabled = statusRequestPending || !customerId || !canManageCustomerStatus;
    output.textContent = message;
    output.classList.toggle("error", Boolean(message) && /失败|无权|未找到|刷新|错误/.test(message));
  }
  async function loadCustomerStatus() {
    if (!canManageCustomerStatus || !customerId) { renderCustomerStatus(currentCustomerStatus); return; }
    statusRequestPending = true; renderCustomerStatus(currentCustomerStatus, "正在读取数据库中的客户状态…");
    try {
      const data = await callCustomerService({ action: "getCustomerStatus", customerCode: customerId });
      const profile = data?.customer || {};
      const status = normalizeCustomerStatus(profile.customerStatus);
      customer.name = profile.customerName || customer.name;
      customer.birthday = profile.birthDate || customer.birthday;
      customer.notes = profile.notes ?? customer.notes;
      customer.createdAt = profile.createdAt || customer.createdAt;
      customer.storeId = profile.storeId || customer.storeId;
      customer.storeName = profile.storeName || customer.storeName;
      customer.storeCode = profile.storeCode || customer.storeCode;
      renderCustomerBasicInfo();
      document.title = customer.name ? `${customer.name} · 客户主页` : "客户主页";
      $("customerNotes").value = customer.notes || "";
      mirrorCustomerStatus(status); renderCustomerStatus(status, "");
    } catch (error) {
      renderCustomerStatus(currentCustomerStatus, error?.message || "客户状态读取失败，请刷新后重试");
    } finally { statusRequestPending = false; renderCustomerStatus(currentCustomerStatus, $("customerStatusMessage").textContent); }
  }
  async function toggleCustomerStatus() {
    if (statusRequestPending || !canManageCustomerStatus || !customerId) return;
    const targetStatus = currentCustomerStatus === "ACTIVE" ? "ARCHIVED" : "ACTIVE";
    const actionText = targetStatus === "ARCHIVED" ? "封存" : "激活";
    if (!window.confirm(`${actionText}客户 ${customer.name || customerId}？${targetStatus === "ARCHIVED" ? "封存后不能继续办理充值和核销，但历史资料不会删除。" : "激活后可恢复办理业务。"}`)) return;
    statusRequestPending = true; renderCustomerStatus(currentCustomerStatus, `正在${actionText}客户…`);
    try {
      const data = await callCustomerService({ action: "updateCustomerStatus", customerCode: customerId, expectedStatus: currentCustomerStatus, targetStatus });
      const savedStatus = normalizeCustomerStatus(data?.customer?.customerStatus);
      mirrorCustomerStatus(savedStatus);
      renderCustomerStatus(savedStatus, `客户已${savedStatus === "ARCHIVED" ? "封存" : "激活"}，数据库状态已更新。`);
    } catch (error) {
      renderCustomerStatus(currentCustomerStatus, error?.message || `客户${actionText}失败，请重试`);
    } finally { statusRequestPending = false; renderCustomerStatus(currentCustomerStatus, $("customerStatusMessage").textContent); }
  }

  function renderCustomerPhoto(content, state = "") {
    const frame = $("customerProfilePhoto");
    frame.classList.toggle("customer-photo-error", state === "error");
    frame.innerHTML = content;
  }
  async function loadCustomerPhoto() {
    if (!customerId || !canReadCustomerPhoto) return;
    renderCustomerPhoto(`<div class="customer-photo-placeholder" aria-live="polite">正在读取照片…</div>`);
    try {
      const data = await callCustomerService({ action: "getCustomerPhotoUrl", customerCode: customerId });
      const photoUrl = String(data?.photoUrl || "").trim();
      if (!/^https:\/\//i.test(photoUrl)) throw new Error("客户照片临时地址无效");
      renderCustomerPhoto(`<img id="customerProfilePhotoImage" src="${escapeHtml(photoUrl)}" alt="${escapeHtml(customer.name || "客户")}的建档照片" referrerpolicy="no-referrer">`);
      const image = $("customerProfilePhotoImage");
      image.addEventListener("error", () => renderCustomerPhoto(`<div class="customer-photo-placeholder" aria-live="polite">照片读取失败，请刷新重试</div>`, "error"), { once: true });
    } catch (error) {
      renderCustomerPhoto(`<div class="customer-photo-placeholder" aria-live="polite">${escapeHtml(error?.message || "照片读取失败，请刷新重试")}</div>`, "error");
    }
  }

  document.title = customer.name ? `${customer.name} · 客户主页` : "客户主页";
  const candidatePhotoUrl = String(customer.profilePhotoUrl || customer.photoUrl || customer.photoTemporaryUrl || "");
  const photoUrl = /^(https:|blob:|data:image\/)/i.test(candidatePhotoUrl) ? candidatePhotoUrl : "";
  const photo = photoUrl ? `<img src="${escapeHtml(photoUrl)}" alt="${escapeHtml(customer.name || "客户")}的建档照片">` : `<div class="customer-photo-placeholder" aria-label="暂无可显示的客户建档照片">客户照片</div>`;
  $("customerProfilePhoto").innerHTML = photo;
  renderCustomerBasicInfo();
  const customerCreatedAt = customer.createdAt || customer.created_at || customer.createdTime || "";
  $("customerRecentInfo").innerHTML = `<article><span>最近充值时间</span><strong>${escapeHtml(dateText(latest(recharges)))}</strong></article><article><span>最近核销时间</span><strong>${escapeHtml(dateText(latest(verifications)))}</strong></article><article><span>客户建立时间</span><strong>${escapeHtml(dateText(customerCreatedAt))}</strong></article><article class="customer-status-cell"><span>客户状态</span><div class="customer-status-actions"><span id="customerStatusBadge" class="record-status">正在读取状态</span><button id="customerStatusToggle" type="button" disabled>封存客户</button></div></article>`;
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
  $("customerStatusToggle").addEventListener("click", toggleCustomerStatus);
  renderCustomerStatus(currentCustomerStatus);
  loadCustomerPhoto();
  loadCustomerStatus();
})();
