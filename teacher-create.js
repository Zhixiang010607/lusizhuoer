(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  let teacherCreateRequestId = "";
  let submitting = false;
  let creationCompleted = false;
  let outcomeUncertain = false;
  let capturedFace = "";
  let cameraStream = null;

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
    ["personCreateName", "personPhone", "personInitialPassword", "teacherFaceConsent"]
      .forEach((id) => { $(id).disabled = locked === true; });
    ["openTeacherFaceCamera", "captureTeacherFace", "retakeTeacherFace"].forEach((id) => { if ($(id)) $(id).disabled = locked === true; });
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
      && passwordIsValid($("personInitialPassword").value)
      && Boolean(capturedFace) && $("teacherFaceConsent").checked;
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
    if (!staffName || !phone || !passwordIsValid(initialPassword) || !capturedFace || !$("teacherFaceConsent").checked) {
      setMessage("请完整填写账号资料、现场拍照并取得老师明确授权。");
      syncSubmit();
      return;
    }
    if (typeof window.CloudBasePhoneAuth?.createTeacher !== "function") {
      setMessage("老师创建服务尚未加载，请部署最新前端和 teacherCreate v7 后刷新。");
      return;
    }

    teacherCreateRequestId ||= requestId();
    submitting = true;
    setFormLocked(true);
    syncSubmit();
    showCreateProgress("正在检测照片并创建账号、老师主档和考勤人脸，请勿重复提交…");
    setMessage("正在等待服务端确认三个部分均已完整创建。");
    try {
      const result = await window.CloudBasePhoneAuth.createTeacher({
        staffName,
        phone,
        initialPassword,
        clientRequestId: teacherCreateRequestId,
        consent: true,
        imageBase64: capturedFace
      });
      const completed = completedTeacherCreation(result);
      if (!completed) {
        const error = new Error("服务端未返回完整的账号与老师主档激活证明，不能显示创建成功。");
        error.code = "TEACHER_CREATE_INCOMPLETE";
        throw error;
      }
      if (result.attendanceFaceEnrolled !== true || result.proof?.attendanceFaceStatus !== "ENROLLED") throw new Error("服务端未确认考勤人脸档案已录入。");
      creationCompleted = true;
      $("generatedPersonCode").textContent = completed.teacherCode || `老师 #${completed.teacherId}`;
      showCreateProgress("老师账号、主档和考勤人脸均已创建并激活。", true);
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

  ["personCreateName", "personPhone", "personInitialPassword", "teacherFaceConsent"].forEach((id) => {
    $(id).addEventListener("input", () => {
      if (!submitting && !creationCompleted && !outcomeUncertain) teacherCreateRequestId = "";
      syncSubmit();
    });
  });
  function stopCamera() { if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop()); cameraStream = null; $("teacherFaceCamera").srcObject = null; }
  $("openTeacherFaceCamera").addEventListener("click", async () => {
    try {
      stopCamera(); capturedFace = ""; syncSubmit();
      cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 960 }, height: { ideal: 1280 } }, audio: false });
      const video = $("teacherFaceCamera"); video.srcObject = cameraStream; video.hidden = false; $("teacherFacePreview").hidden = true; $("teacherFacePlaceholder").hidden = true; await video.play();
      $("captureTeacherFace").disabled = false; $("retakeTeacherFace").hidden = true; $("teacherFaceStatus").textContent = "摄像头已打开，请老师正对镜头";
    } catch (error) { stopCamera(); setMessage(error?.message || "无法打开摄像头"); }
  });
  $("captureTeacherFace").addEventListener("click", () => {
    const video = $("teacherFaceCamera"), canvas = $("teacherFaceCanvas");
    if (!video.videoWidth || !video.videoHeight) return setMessage("摄像头画面尚未就绪");
    const ratio = 3 / 4; let sw = video.videoWidth, sh = video.videoHeight; if (sw / sh > ratio) sw = sh * ratio; else sh = sw / ratio;
    const h = Math.min(Math.round(sh), 1024); canvas.height = h; canvas.width = Math.round(h * ratio);
    canvas.getContext("2d", { alpha: false }).drawImage(video, (video.videoWidth - sw) / 2, (video.videoHeight - sh) / 2, sw, sh, 0, 0, canvas.width, canvas.height);
    capturedFace = canvas.toDataURL("image/jpeg", .85); const preview = $("teacherFacePreview"); preview.src = capturedFace; preview.hidden = false; video.hidden = true; stopCamera();
    $("captureTeacherFace").disabled = true; $("retakeTeacherFace").hidden = false; $("teacherFaceStatus").className = "capture-status complete"; $("teacherFaceStatus").textContent = "照片已拍摄，提交时由服务端检测质量与活体"; syncSubmit();
  });
  $("retakeTeacherFace").addEventListener("click", () => $("openTeacherFaceCamera").click());
  window.addEventListener("pagehide", stopCamera, { once: true });
  $("personCreateForm").addEventListener("submit", submitTeacher);
  syncSubmit();
})();
