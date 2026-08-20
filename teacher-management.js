(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const state = { teachers: [], searched: false, name: "", phone: "" };

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function normalizedPhone(value) {
    return String(value || "").replace(/\D/g, "");
  }

  function teacherName(teacher) {
    return String(teacher.staff_name || teacher.teacher_name || teacher.name || "").trim();
  }

  function teacherPhone(teacher) {
    return String(teacher.phone || "").trim();
  }

  function teacherCode(teacher) {
    return String(teacher.person_code || teacher.teacher_code || teacher.staff_code || "").trim();
  }

  function isArchived(teacher) {
    const normalized = (value) => String(value || "").toUpperCase();
    // account_status and teacher_status are authoritative.  Some historical
    // list responses also contain a generic `status` compatibility field; it
    // must not make an otherwise ACTIVE staff+teacher pair look archived.
    const authoritative = [teacher.account_status, teacher.teacher_status]
      .map(normalized)
      .filter((value) => ["ACTIVE", "ARCHIVED"].includes(value));
    if (authoritative.length) return authoritative.includes("ARCHIVED");
    return [teacher.status, teacher.profile_status].map(normalized).includes("ARCHIVED");
  }

  function setDirectoryMessage(message = "", tone = "") {
    const target = $("teacherDirectoryMessage");
    if (!target) return;
    target.textContent = message;
    target.dataset.tone = tone;
  }

  function actionableStatusError(error, action, refreshed, actualArchived) {
    const signature = `${error?.code || ""} ${error?.message || ""}`.toUpperCase();
    if (signature.includes("AUTH_CREDENTIAL_MISSING") || signature.includes("AUTH_ACCOUNT_MISSING")) {
      return "该记录没有可恢复的 CloudBase 登录凭据，属于压力测试或历史占位账号，只保留查询数据。激活未生效，账号已安全保持封存；如需登录，请通过“新增老师”创建正式账号。";
    }
    if (signature.includes("TEACHER_PROFILE_MISSING")) {
      return `老师主档同步尚未完成，${action}未生效。本页已重新读取当前状态；请先执行最新的老师资料修复迁移，再刷新后重试。`;
    }
    if (!refreshed) {
      return `${action}结果暂时无法确认，而且当前状态读取失败。请先刷新页面确认状态再重试，避免连续重复提交。`;
    }
    return `${action}未确认生效。本页已重新读取数据库，当前仍为“${actualArchived ? "封存" : "活跃"}”；请刷新后重试，如持续失败请检查老师主档与账号绑定。`;
  }

  function teacherReference(teacher) {
    // A few historical records predate a bound login account.  Their master
    // id/code still opens the same detail page, so do not turn a valid row
    // into an unclickable one merely because auth_uid is absent.
    return String(teacher.auth_uid || teacher.id || teacher.teacher_id || teacher.teacherId || teacher.teacher_code || teacher.person_code || "").trim();
  }

  function teacherMasterId(teacher) {
    return String(teacher.teacher_id || teacher.teacherId || "").trim();
  }

  function teacherRow(teacher) {
    const reference = teacherReference(teacher);
    const name = teacherName(teacher) || "未命名老师";
    const nameMarkup = reference
      ? `<a class="record-link teacher-global-link" href="staff-detail.html?role=teacher&id=${encodeURIComponent(reference)}">${escapeHtml(name)}</a>`
      : escapeHtml(name);
    const archived = isArchived(teacher);
    const experienceHref = reference
      ? `staff-detail.html?role=teacher&id=${encodeURIComponent(reference)}#teacherExperiencePanel`
      : "";
    const experienceMarkup = experienceHref
      ? `<a class="button-link teacher-experience-link" href="${experienceHref}">${archived ? "查看额度记录" : "配置／充值"}</a>`
      : "—";
    const statusAction = reference && (teacherMasterId(teacher) || String(teacher.auth_uid || "").trim() || teacherPhone(teacher))
      ? `<button class="teacher-status-action ${archived ? "teacher-activate-button" : "teacher-archive-button"}" type="button" data-teacher-status-ref="${escapeHtml(reference)}">${archived ? "激活账号" : "封存账号"}</button>`
      : "—";
    return `<tr>
      <td data-label="老师姓名">${nameMarkup}</td>
      <td data-label="老师编号">${escapeHtml(teacherCode(teacher) || "—")}</td>
      <td data-label="联系电话" class="teacher-phone-cell">${escapeHtml(teacherPhone(teacher) || "—")}</td>
      <td data-label="状态"><span class="teacher-status-badge ${archived ? "archived" : "active"}">${archived ? "封存" : "活跃"}</span></td>
      <td data-label="体验额度">${experienceMarkup}</td>
      <td data-label="账号操作">${statusAction}</td>
    </tr>`;
  }

  function renderRows(targetId, countId, teachers, emptyText) {
    $(countId).textContent = `${teachers.length} 人`;
    $(targetId).innerHTML = teachers.length
      ? teachers.map(teacherRow).join("")
      : `<tr><td colspan="6" class="teacher-directory-empty">${escapeHtml(emptyText)}</td></tr>`;
  }

  function renderDirectories() {
    renderRows("activeTeacherRows", "activeTeacherCount", state.teachers.filter((teacher) => !isArchived(teacher)), "暂无活跃老师");
    renderRows("archivedTeacherRows", "archivedTeacherCount", state.teachers.filter(isArchived), "暂无封存老师");
  }

  function renderSearchResults() {
    if (!state.searched) {
      renderRows("searchTeacherRows", "searchTeacherCount", [], "尚未查询");
      return;
    }
    const name = state.name.toLocaleLowerCase("zh-CN");
    const phone = normalizedPhone(state.phone);
    if (!name && !phone) {
      renderRows("searchTeacherRows", "searchTeacherCount", [], "请输入姓名或联系电话后查询");
      return;
    }
    const matches = state.teachers.filter((teacher) => {
      const matchesName = !name || teacherName(teacher).toLocaleLowerCase("zh-CN").includes(name);
      const matchesPhone = !phone || normalizedPhone(teacherPhone(teacher)).includes(phone);
      return matchesName && matchesPhone;
    });
    renderRows("searchTeacherRows", "searchTeacherCount", matches, "没有符合条件的老师");
  }

  function renderLoadError(error) {
    const message = "老师数据读取失败，请刷新页面后重试；如刚执行过状态操作，请勿连续重复提交。";
    console.warn("老师数据读取失败", error);
    setDirectoryMessage(message, "error");
    ["activeTeacherCount", "archivedTeacherCount", "searchTeacherCount"].forEach((id) => { $(id).textContent = "读取失败"; });
    ["activeTeacherRows", "archivedTeacherRows", "searchTeacherRows"].forEach((id) => {
      $(id).innerHTML = `<tr><td colspan="6" class="teacher-directory-empty error-text">${escapeHtml(message)}</td></tr>`;
    });
  }

  async function loadTeachers() {
    if (!window.CloudBasePhoneAuth?.listStaff) {
      renderLoadError(new Error("老师数据库服务尚未加载，请刷新页面后重试。"));
      return false;
    }
    try {
      const records = await window.CloudBasePhoneAuth.listStaff("teacher");
      state.teachers = Array.isArray(records) ? records : [];
      renderDirectories();
      renderSearchResults();
      return true;
    } catch (error) {
      renderLoadError(error);
      return false;
    }
  }

  function search() {
    state.name = $("entityNameSearch").value.trim();
    state.phone = $("entityPhoneSearch").value.trim();
    state.searched = true;
    renderSearchResults();
  }

  async function toggleTeacherStatus(reference) {
    const teacher = state.teachers.find((item) => teacherReference(item) === String(reference || ""));
    if (!teacher) return;
    const archived = isArchived(teacher);
    const next = archived ? "ACTIVE" : "ARCHIVED";
    const action = archived ? "激活" : "封存";
    const name = teacherName(teacher) || "该老师";
    const prompt = archived
      ? `确认激活老师“${name}”？激活后该账号可以再次登录和参与业务。`
      : `确认封存老师“${name}”？老师账号将无法登录，充值、退费、核销、体验均不能再选择该老师；体验额度和历史业务会完整保留。`;
    if (!window.confirm(prompt)) return;
    if (!window.CloudBasePhoneAuth?.setMasterStatus && !window.CloudBasePhoneAuth?.setStaffStatus) {
      setDirectoryMessage("老师账号状态服务尚未加载。请刷新页面；若仍无法操作，请先部署最新后台服务。", "error");
      return;
    }
    const buttons = [...document.querySelectorAll("[data-teacher-status-ref]")]
      .filter((button) => button.dataset.teacherStatusRef === String(reference));
    buttons.forEach((button) => {
      button.dataset.idleLabel = button.textContent;
      button.textContent = `${action}中…`;
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
    });
    setDirectoryMessage(`正在${action}“${name}”…`, "pending");
    let requestError = null;
    try {
      const teacherId = teacherMasterId(teacher);
      if (teacherId && window.CloudBasePhoneAuth.setMasterStatus) {
        await window.CloudBasePhoneAuth.setMasterStatus({ teacherId, status: next });
      } else {
        await window.CloudBasePhoneAuth.setStaffStatus({
          uid: String(teacher.auth_uid || ""), phone: teacherPhone(teacher), status: next
        });
      }
    } catch (error) {
      requestError = error;
      console.warn(`${action}老师请求未确认`, error);
    } finally {
      const refreshed = await loadTeachers();
      const current = state.teachers.find((item) => teacherReference(item) === String(reference))
        || state.teachers.find((item) => teacherMasterId(item) && teacherMasterId(item) === teacherMasterId(teacher))
        || state.teachers.find((item) => teacherPhone(item) && teacherPhone(item) === teacherPhone(teacher));
      const actualArchived = current ? isArchived(current) : archived;
      const expectedArchived = next === "ARCHIVED";
      if (refreshed && current && actualArchived === expectedArchived) {
        setDirectoryMessage(requestError
          ? `${action}已生效。刚才的接口响应中断，但重新读取数据库后已确认状态为“${expectedArchived ? "封存" : "活跃"}”。`
          : `${action}成功，数据库当前状态为“${expectedArchived ? "封存" : "活跃"}”。`, "success");
      } else {
        setDirectoryMessage(actionableStatusError(requestError, action, refreshed, actualArchived), "error");
      }
      buttons.forEach((button) => {
        if (!button.isConnected) return;
        button.textContent = button.dataset.idleLabel || (archived ? "激活账号" : "封存账号");
        button.disabled = false;
        button.removeAttribute("aria-busy");
        delete button.dataset.idleLabel;
      });
    }
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-teacher-status-ref]");
    if (!button || button.disabled) return;
    void toggleTeacherStatus(button.dataset.teacherStatusRef);
  });

  $("searchPeople").addEventListener("click", search);
  ["entityNameSearch", "entityPhoneSearch"].forEach((id) => {
    $(id).addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        search();
      }
    });
  });
  $("addEntity").addEventListener("click", () => {
    window.location.href = "teacher-create.html";
  });

  void loadTeachers();
})();
