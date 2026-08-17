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
    return String(teacher.account_status || teacher.status || "").toUpperCase() === "ARCHIVED";
  }

  function teacherReference(teacher) {
    return String(teacher.auth_uid || teacher.id || "").trim();
  }

  function teacherRow(teacher) {
    const reference = teacherReference(teacher);
    const name = teacherName(teacher) || "未命名老师";
    const nameMarkup = reference
      ? `<a class="record-link teacher-global-link" href="staff-detail.html?role=teacher&id=${encodeURIComponent(reference)}">${escapeHtml(name)}</a>`
      : escapeHtml(name);
    const archived = isArchived(teacher);
    return `<tr>
      <td>${nameMarkup}</td>
      <td>${escapeHtml(teacherCode(teacher) || "—")}</td>
      <td class="teacher-phone-cell">${escapeHtml(teacherPhone(teacher) || "—")}</td>
      <td><span class="teacher-status-badge ${archived ? "archived" : "active"}">${archived ? "封存" : "活跃"}</span></td>
    </tr>`;
  }

  function renderRows(targetId, countId, teachers, emptyText) {
    $(countId).textContent = `${teachers.length} 人`;
    $(targetId).innerHTML = teachers.length
      ? teachers.map(teacherRow).join("")
      : `<tr><td colspan="4" class="teacher-directory-empty">${escapeHtml(emptyText)}</td></tr>`;
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
      $(id).innerHTML = `<tr><td colspan="4" class="teacher-directory-empty error-text">${escapeHtml(message)}</td></tr>`;
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
