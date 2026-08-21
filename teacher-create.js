(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  let teacherCreateRequestId = "";
  let submitting = false;
  let creationCompleted = false;
  let outcomeUncertain = false;

  function setMessage(message = "") {
    $("personCreateMessage").textContent = message;
  }

  function passwordIsValid(value) {
    const password = String(value || "");
    const groups = [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z\d]/]
      .filter((rule) => rule.test(password)).length;
    return password.length >= 8 && password.length <= 32
      && /^[A-Za-z0-9]/.test(password) && groups >= 3;
  }

  function requestId() {
    const token = window.crypto?.randomUUID?.().replace(/-/g, "")
      || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    return `teacher_create_${token}`.slice(0, 64);
  }

  function statusValue(...values) {
    return String(values.find((value) => value !== undefined && value !== null && String(value).trim()) || "")
      .trim().toUpperCase();
  }

  function textValue(...values) {
    return String(values.find((value) => value !== undefined && value !== null && String(value).trim()) || "").trim();
  }

  function completedTeacherCreation(result) {
    if (!result || result.ok !== true || result.completed !== true || result.proof?.complete !== true) return null;
    const proof = result.proof;
    const teacherStatus = statusValue(proof.teacherStatus, proof.teacher_status);
    const accountStatus = statusValue(proof.accountStatus, proof.account_status);
    const authStatus = statusValue(proof.authStatus, proof.auth_status);
    const uid = textValue(result.uid, proof.uid);
    const teacherId = textValue(result.teacherId, proof.teacherId, proof.teacher_id);
    if (teacherStatus !== "ACTIVE" || accountStatus !== "ACTIVE" || authStatus !== "ACTIVE"
        || !uid || !teacherId) return null;
    return {
      uid,
      teacherId,
      teacherCode: textValue(result.teacherCode, proof.teacherCode, proof.teacher_code)
    };
  }

  function setFormLocked(locked) {
    ["personCreateName", "personPhone", "personInitialPassword"]
      .forEach((id) => { $(id).disabled = locked === true; });
  }

  function showCreateProgress(message, complete = false) {
    $("teacherCreateProgress").hidden = false;
    $("teacherCreateProgress").className = `capture-status ${complete ? "complete" : "pending"}`;
    $("teacherCreateProgressStage").textContent = message;
  }

  function syncSubmit() {
    const ready = !submitting && !creationCompleted && !outcomeUncertain
      && Boolean($("personCreateName").value.trim())
      && Boolean($("personPhone").value.trim())
      && passwordIsValid($("personInitialPassword").value);
    const submit = $("createTeacherSubmit");
    submit.disabled = !ready;
    submit.setAttribute("aria-disabled", String(!ready));
  }

  async function submitTeacher(event) {
    event.preventDefault();
    if (submitting || creationCompleted || outcomeUncertain) return;
    const staffName = $("personCreateName").value.trim();
    const phone = $("personPhone").value.trim();
    const initialPassword = $("personInitialPassword").value;
    if (!staffName || !phone || !passwordIsValid(initialPassword)) {
      setMessage("请完整填写姓名、有效手机号和符合规则的初始密码。");
      syncSubmit();
      return;
    }
    if (typeof window.CloudBasePhoneAuth?.createTeacher !== "function") {
      setMessage("老师创建服务尚未加载，请部署最新前端和 teacherCreate v6 后刷新。");
      return;
    }

    teacherCreateRequestId ||= requestId();
    submitting = true;
    setFormLocked(true);
    syncSubmit();
    showCreateProgress("正在创建登录账号和老师主档，请勿重复提交…");
    setMessage("老师创建不上传照片；正在等待服务端确认账号和主档均已激活。");
    try {
      const result = await window.CloudBasePhoneAuth.createTeacher({
        staffName,
        phone,
        initialPassword,
        clientRequestId: teacherCreateRequestId
      });
      const completed = completedTeacherCreation(result);
      if (!completed) {
        const error = new Error("服务端未返回完整的账号与老师主档激活证明，不能显示创建成功。");
        error.code = "TEACHER_CREATE_INCOMPLETE";
        throw error;
      }
      creationCompleted = true;
      $("generatedPersonCode").textContent = completed.teacherCode || `老师 #${completed.teacherId}`;
      showCreateProgress("老师账号和主档均已创建并激活。", true);
      setMessage("创建成功，正在返回老师管理。");
      window.setTimeout(() => window.location.assign("teacher-management.html"), 900);
    } catch (error) {
      const signature = `${error?.code || ""} ${error?.message || ""}`.toUpperCase();
      outcomeUncertain = error?.transportUncertain === true
        || signature.includes("CLIENT_REQUEST_TIMEOUT")
        || signature.includes("CLEANUP_INCOMPLETE");
      if (outcomeUncertain) {
        showCreateProgress("创建结果暂时无法确认，请先回老师管理查询，禁止在本页重复提交。");
        setMessage(error?.message || "创建结果无法确认，请先查询老师管理和云函数日志。");
      } else {
        teacherCreateRequestId = "";
        showCreateProgress("创建失败，服务端已明确结束本次请求；修正后可以重试。");
        setMessage(error?.message || "老师创建失败，请检查输入后重试。");
      }
    } finally {
      submitting = false;
      if (!creationCompleted && !outcomeUncertain) setFormLocked(false);
      syncSubmit();
    }
  }

  ["personCreateName", "personPhone", "personInitialPassword"].forEach((id) => {
    $(id).addEventListener("input", () => {
      if (!submitting && !creationCompleted && !outcomeUncertain) teacherCreateRequestId = "";
      syncSubmit();
    });
  });
  $("personCreateForm").addEventListener("submit", submitTeacher);
  syncSubmit();
})();
