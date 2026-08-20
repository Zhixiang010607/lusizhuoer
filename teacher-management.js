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
    return String(teacher.staff_name || teacher.name || "").trim();
  }

  function teacherPhone(teacher) {
    return String(teacher.phone || "").trim();
  }

  function teacherCode(teacher) {
    return String(teacher.person_code || teacher.staff_code || "").trim();
  }

  function isArchived(teacher) {
    return [teacher.account_status, teacher.teacher_status, teacher.status]
      .some((value) => String(value || "").toUpperCase() === "ARCHIVED");
  }

  function teacherReference(teacher) {
    return String(teacher.auth_uid || teacher.id || "").trim();
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
      ? `<a class="button-link secondary-button teacher-experience-link" href="${experienceHref}">${archived ? "查看额度记录" : "配置／充值"}</a>`
      : "—";
    const statusAction = reference && (teacherMasterId(teacher) || String(teacher.auth_uid || "").trim() || teacherPhone(teacher))
      ? `<button class="secondary-button teacher-status-action ${archived ? "" : "danger-button"}" type="button" data-teacher-status-ref="${escapeHtml(reference)}">${archived ? "激活账号" : "封存账号"}</button>`
      : "—";
    return `<tr>
      <td>${nameMarkup}</td>
      <td>${escapeHtml(teacherCode(teacher) || "—")}</td>
      <td class="teacher-phone-cell">${escapeHtml(teacherPhone(teacher) || "—")}</td>
      <td><span class="teacher-status-badge ${archived ? "archived" : "active"}">${archived ? "封存" : "活跃"}</span></td>
      <td>${experienceMarkup}</td>
      <td>${statusAction}</td>
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
    const message = error?.message || "老师数据读取失败，请刷新页面后重试。";
    ["activeTeacherCount", "archivedTeacherCount", "searchTeacherCount"].forEach((id) => { $(id).textContent = "读取失败"; });
    ["activeTeacherRows", "archivedTeacherRows", "searchTeacherRows"].forEach((id) => {
      $(id).innerHTML = `<tr><td colspan="6" class="teacher-directory-empty error-text">${escapeHtml(message)}</td></tr>`;
    });
  }

  async function loadTeachers() {
    if (!window.CloudBasePhoneAuth?.listStaff) {
      renderLoadError(new Error("老师数据库服务尚未加载，请刷新页面后重试。"));
      return;
    }
    try {
      const records = await window.CloudBasePhoneAuth.listStaff("teacher");
      state.teachers = Array.isArray(records) ? records : [];
      renderDirectories();
      renderSearchResults();
    } catch (error) {
      console.warn("老师列表读取失败", error);
      renderLoadError(error);
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
      window.alert("老师账号状态服务尚未加载，请刷新页面后重试。");
      return;
    }
    const buttons = [...document.querySelectorAll("[data-teacher-status-ref]")]
      .filter((button) => button.dataset.teacherStatusRef === String(reference));
    buttons.forEach((button) => { button.disabled = true; });
    try {
      const teacherId = teacherMasterId(teacher);
      if (teacherId && window.CloudBasePhoneAuth.setMasterStatus) {
        await window.CloudBasePhoneAuth.setMasterStatus({ teacherId, status: next });
      } else {
        await window.CloudBasePhoneAuth.setStaffStatus({
          uid: String(teacher.auth_uid || ""), phone: teacherPhone(teacher), status: next
        });
      }
      await loadTeachers();
    } catch (error) {
      window.alert(error?.message || `${action}老师失败，请稍后重试。`);
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
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
