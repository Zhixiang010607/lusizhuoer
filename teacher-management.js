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

  function teacherReference(teacher) {
    // A few historical records predate a bound login account.  Their master
    // id/code still opens the same detail page, so do not turn a valid row
    // into an unclickable one merely because auth_uid is absent.
    return String(teacher.auth_uid || teacher.id || teacher.teacher_id || teacher.teacherId || teacher.teacher_code || teacher.person_code || "").trim();
  }

  function teacherRow(teacher) {
    const reference = teacherReference(teacher);
    const name = teacherName(teacher) || "未命名老师";
    const nameMarkup = reference
      ? `<a class="record-link teacher-global-link" href="staff-detail.html?role=teacher&id=${encodeURIComponent(reference)}">${escapeHtml(name)}</a>`
      : escapeHtml(name);
    const archived = isArchived(teacher);
    return `<tr>
      <td data-label="老师姓名">${nameMarkup}</td>
      <td data-label="联系电话" class="teacher-phone-cell">${escapeHtml(teacherPhone(teacher) || "—")}</td>
      <td data-label="状态"><span class="teacher-status-badge ${archived ? "archived" : "active"}">${archived ? "封存" : "活跃"}</span></td>
    </tr>`;
  }

  function renderRows(targetId, countId, teachers, emptyText) {
    $(countId).textContent = `${teachers.length} 人`;
    $(targetId).innerHTML = teachers.length
      ? teachers.map(teacherRow).join("")
      : `<tr><td colspan="3" class="teacher-directory-empty">${escapeHtml(emptyText)}</td></tr>`;
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
      $(id).innerHTML = `<tr><td colspan="3" class="teacher-directory-empty error-text">${escapeHtml(message)}</td></tr>`;
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
