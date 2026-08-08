(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const role = params.get("role");
  const personId = params.get("id");
  const labels = { teacher: "老师", operation: "运营", hq: "总部人员" };
  const pages = { teacher: "teacher-management.html", operation: "operation-account-management.html", hq: "hq-management.html" };
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
  let staff = null;

  function renderError(message) {
    $("staffDetailContent").innerHTML = `<article class="panel info-card"><span>人员详情</span><strong>${escapeHtml(message)}</strong></article>`;
    $("staffStatusHint").textContent = "未读取到可操作的账号。";
  }

  function render() {
    const status = staff.account_status === "ARCHIVED" ? "封存" : "活跃";
    $("staffDetailTitle").textContent = `${labels[role]}全局视图`;
    $("backToManagement").href = pages[role];
    $("staffDetailContent").innerHTML = [["编号", staff.person_code], ["姓名", staff.staff_name], ["联系电话", staff.phone || "未填写"], ["身份", labels[role]], ["状态", status]].map(([label, value]) => `<article class="panel info-card"><span>${label}</span><strong>${escapeHtml(value)}</strong></article>`).join("");
    $("staffScopeHint").textContent = role === "teacher" ? "仅显示该老师本人绑定的核销、充值与审核记录。" : role === "operation" ? "仅显示该运营账号被授权范围内的数据。" : "总部账号可查看总部管理范围内的数据。";
    $("staffScopeContent").textContent = "暂无该账号范围内的业务数据";
    const action = $("staffStatusAction");
    action.hidden = false;
    action.textContent = status === "活跃" ? `封存${labels[role]}` : `激活${labels[role]}`;
    action.classList.toggle("danger-button", status === "活跃");
    $("staffStatusHint").textContent = status === "活跃" ? "封存后该人员无法登录，历史业务记录保留。" : "激活后该人员可再次登录。";
  }

  async function load() {
    if (!labels[role] || !personId) { renderError("缺少人员身份或编号。"); return; }
    try {
      const records = await window.CloudBasePhoneAuth.listStaff(role);
      staff = records.find((item) => item.person_code === personId);
      if (!staff) { renderError("未找到该人员，可能已被删除或无权查看。"); return; }
      render();
    } catch (error) { renderError(error?.message || "人员资料读取失败。"); }
  }

  $("staffStatusAction").addEventListener("click", async () => {
    if (!staff) return;
    const archived = staff.account_status === "ARCHIVED";
    const next = archived ? "ACTIVE" : "ARCHIVED";
    const text = archived ? "激活" : "封存";
    if (!window.confirm(`确认${text}${labels[role]}“${staff.staff_name}”？`)) return;
    const button = $("staffStatusAction"); button.disabled = true;
    try {
      await window.CloudBasePhoneAuth.setStaffStatus({ uid: staff.auth_uid, phone: staff.phone, status: next });
      staff.account_status = next;
      render();
    } catch (error) { window.alert(error?.message || `${text}失败，请稍后重试。`); }
    finally { button.disabled = false; }
  });
  void load();
})();
