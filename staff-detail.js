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

  function formatTime(value) {
    if (!value) return "尚未记录";
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString("zh-CN", { hour12: false });
  }

  function credentialStatus() {
    return [true, "true", "t", 1, "1"].includes(staff.password_change_required)
      ? "临时密码待本人修改"
      : "密码已由本人确认";
  }

  function renderError(message) {
    $("staffDetailContent").innerHTML = `<article class="panel info-card"><span>人员详情</span><strong>${escapeHtml(message)}</strong></article>`;
    $("staffStatusHint").textContent = "未读取到可操作的账号。";
  }

  function render() {
    const status = staff.account_status === "ARCHIVED" ? "封存" : "活跃";
    $("staffDetailTitle").textContent = `${labels[role]}全局视图`;
    $("backToManagement").href = pages[role];
    const cards = [
      ["唯一身份 ID", staff.auth_uid],
      ["业务编号", staff.person_code],
      ["姓名", staff.staff_name],
      ["联系电话", staff.phone || "未填写"],
      ["身份", labels[role]],
      ["状态", status],
      ["密码状态", credentialStatus()],
      ["初始密码设置", formatTime(staff.password_initialized_at)],
      ["最后密码变更", formatTime(staff.password_changed_at)]
    ];
    $("staffDetailContent").innerHTML = cards.map(([label, value]) => `<article class="panel info-card"><span>${label}</span><strong>${escapeHtml(value)}</strong></article>`).join("");
    $("staffScopeHint").textContent = role === "teacher"
      ? "仅显示该老师本人绑定的核销、充值与审核记录。"
      : role === "operation"
        ? "仅显示该运营账号被授权范围内的数据。"
        : "总部账号可查看总部管理范围内的数据。";
    $("staffScopeContent").textContent = "暂无该账号范围内的业务数据";

    const statusAction = $("staffStatusAction");
    statusAction.hidden = false;
    statusAction.textContent = status === "活跃" ? `封存${labels[role]}` : `激活${labels[role]}`;
    statusAction.classList.toggle("danger-button", status === "活跃");
    $("staffStatusHint").textContent = status === "活跃"
      ? "封存后该人员无法登录，历史业务记录保留。"
      : "激活后该人员可再次登录。";

    const credentialAction = $("staffCredentialAction");
    credentialAction.hidden = false;
    credentialAction.textContent = "重置临时密码";
  }

  async function load() {
    if (!labels[role] || !personId) {
      renderError("缺少人员身份或编号。");
      return;
    }
    try {
      const records = await window.CloudBasePhoneAuth.listStaff(role);
      staff = records.find((item) => String(item.auth_uid || "") === personId);
      if (!staff) {
        renderError("未找到该人员，可能已被删除或无权查看。");
        return;
      }
      render();
    } catch (error) {
      renderError(error?.message || "人员资料读取失败。");
    }
  }

  $("staffCredentialAction").addEventListener("click", async () => {
    if (!staff?.auth_uid) return;
    const newPassword = window.prompt("输入新的临时密码（8–32 位，至少包含大写、小写、数字、特殊字符中的三类）：");
    if (newPassword === null) return;
    const groups = [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z\d]/].filter((rule) => rule.test(newPassword)).length;
    if (newPassword.length < 8 || newPassword.length > 32 || groups < 3) {
      window.alert("密码格式不符合要求。");
      return;
    }
    if (!window.confirm(`确认重置“${staff.staff_name}”的密码？旧密码不会显示或保留。`)) return;
    const button = $("staffCredentialAction");
    button.disabled = true;
    try {
      await window.CloudBasePhoneAuth.resetStaffPassword({ uid: staff.auth_uid, newPassword });
      staff.password_change_required = true;
      staff.password_changed_at = new Date().toISOString();
      render();
      window.alert("已重置临时密码。请通过安全渠道单独告知本人。该人员下次应立即修改密码。");
    } catch (error) {
      window.alert(error?.message || "密码重置失败，请稍后重试。");
    } finally {
      button.disabled = false;
    }
  });

  $("staffStatusAction").addEventListener("click", async () => {
    if (!staff) return;
    const archived = staff.account_status === "ARCHIVED";
    const next = archived ? "ACTIVE" : "ARCHIVED";
    const text = archived ? "激活" : "封存";
    if (!window.confirm(`确认${text}${labels[role]}“${staff.staff_name}”？`)) return;
    const button = $("staffStatusAction");
    button.disabled = true;
    try {
      await window.CloudBasePhoneAuth.setStaffStatus({ uid: staff.auth_uid, phone: staff.phone, status: next });
      staff.account_status = next;
      render();
    } catch (error) {
      window.alert(error?.message || `${text}失败，请稍后重试。`);
    } finally {
      button.disabled = false;
    }
  });

  void load();
})();
