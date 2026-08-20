(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  let cameraStream = null;
  let capturedFaceImage = "";
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
    return password.length >= 8 && password.length <= 32 && /^[A-Za-z0-9]/.test(password) && groups >= 3;
  }

  function requestId() {
    const token = window.crypto?.randomUUID?.().replace(/-/g, "")
      || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    return `teacher_create_${token}`.slice(0, 64);
  }

  function dataUrlBytes(value) {
    const base64 = String(value || "").split(",")[1] || "";
    return Math.floor(base64.length * 3 / 4);
  }

  function resizeCanvasDataUrl(source, maximumLongSide, quality) {
    const scale = Math.min(1, maximumLongSide / Math.max(source.width, source.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(source.width * scale));
    canvas.height = Math.max(1, Math.round(source.height * scale));
    canvas.getContext("2d", { alpha: false }).drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", quality);
  }

  function stopCamera() {
    cameraStream?.getTracks().forEach((track) => track.stop());
    cameraStream = null;
    $("teacherFaceCamera").srcObject = null;
  }

  function setFormLocked(locked) {
    ["personCreateName", "personPhone", "personInitialPassword", "teacherFaceConsent"]
      .forEach((id) => { $(id).disabled = locked === true; });
    ["openTeacherFaceCamera", "captureTeacherFace", "retakeTeacherFace"]
      .forEach((id) => { if ($(id)) $(id).disabled = locked === true; });
  }

  function syncSubmit() {
    const ready = !submitting && !creationCompleted && !outcomeUncertain
      && Boolean($("personCreateName").value.trim())
      && Boolean($("personPhone").value.trim())
      && passwordIsValid($("personInitialPassword").value)
      && Boolean(capturedFaceImage)
      && Boolean($("teacherFaceConsent").checked);
    const submit = $("createTeacherSubmit");
    submit.disabled = !ready;
    submit.setAttribute("aria-disabled", String(!ready));
  }

  function hideCreateProgress() {
    $("teacherCreateProgress").hidden = true;
  }

  function showCreateProgress(message, complete = false) {
    $("teacherCreateProgress").hidden = false;
    $("teacherCreateProgress").className = `capture-status ${complete ? "complete" : "pending"}`;
    $("teacherCreateProgressStage").textContent = message;
  }

  function resetFaceCapture() {
    stopCamera();
    capturedFaceImage = "";
    teacherCreateRequestId = "";
    const preview = $("teacherFacePreview");
    preview.hidden = true;
    preview.removeAttribute("src");
    $("teacherFaceCanvas").width = 0;
    $("teacherFaceCanvas").height = 0;
    $("teacherFacePlaceholder").hidden = false;
    $("openTeacherFaceCamera").hidden = false;
    $("openTeacherFaceCamera").disabled = false;
    $("captureTeacherFace").disabled = true;
    $("retakeTeacherFace").hidden = true;
    $("teacherFaceCaptureStatus").className = "capture-status pending";
    $("teacherFaceCaptureStatus").textContent = "必填 · 尚未拍摄";
    $("teacherFaceQualityResult").textContent = "待创建时检测";
    $("teacherFaceLivenessResult").textContent = "创建时按服务端配置检测";
    $("teacherFaceEnrollmentState").textContent = "创建前必填";
    hideCreateProgress();
    syncSubmit();
  }

  function statusValue(...values) {
    return String(values.find((value) => value !== undefined && value !== null && String(value).trim()) || "")
      .trim().toUpperCase();
  }

  function textValue(...values) {
    return String(values.find((value) => value !== undefined && value !== null && String(value).trim()) || "").trim();
  }

  // A partially written teacher must never be presented as a successful
  // creation. The dedicated service has to return every final proof together.
  function completedTeacherCreation(result) {
    if (!result || result.ok !== true || result.completed !== true || result.proof?.complete !== true) return null;
    const proof = result.proof;
    const teacherStatus = statusValue(proof.teacherStatus, proof.teacher_status, proof.teacher?.status, result.teacher?.status);
    const accountStatus = statusValue(proof.accountStatus, proof.account_status, proof.account?.status, result.account?.status);
    const authStatus = statusValue(proof.authStatus, proof.auth_status, proof.credentialStatus,
      proof.credential_status, proof.auth?.status, result.auth?.status);
    const faceStatus = statusValue(proof.faceStatus, proof.face_status, proof.faceEnrollmentStatus,
      proof.face_enrollment_status, proof.face?.status, result.face?.status);
    if (teacherStatus !== "ACTIVE" || accountStatus !== "ACTIVE" || authStatus !== "ACTIVE"
        || faceStatus !== "ENROLLED") return null;
    const uid = textValue(result.uid, proof.uid, proof.auth?.uid, result.auth?.uid);
    const teacherId = textValue(result.teacherId, proof.teacherId, proof.teacher?.teacherId, result.teacher?.teacherId);
    const faceId = textValue(result.faceId, proof.faceId, proof.face_id, proof.face?.faceId, result.face?.faceId);
    const photoRef = textValue(result.photoRef, proof.photoRef, proof.photo_ref, proof.profilePhotoFileId,
      proof.profile_photo_file_id, proof.face?.photoRef, result.face?.photoRef);
    const personId = textValue(proof.personId, proof.person_id, proof.face?.personId, result.face?.personId);
    const photoSha256 = textValue(proof.photoSha256, proof.photo_sha256, proof.face?.photoSha256,
      result.face?.photoSha256).toLowerCase();
    const photoBytes = Number(proof.photoBytes ?? proof.photo_bytes ?? proof.face?.photoBytes
      ?? result.face?.photoBytes ?? 0);
    if (!uid || !teacherId || !faceId || !photoRef || !personId
        || !/^[a-f0-9]{64}$/.test(photoSha256)
        || !Number.isSafeInteger(photoBytes) || photoBytes <= 0) return null;
    return {
      uid,
      teacherId,
      faceId,
      photoRef,
      personId,
      photoSha256,
      photoBytes,
      teacherCode: textValue(result.teacherCode, proof.teacherCode, proof.teacher?.teacherCode, result.teacher?.teacherCode)
    };
  }

  async function openCamera() {
    try {
      if (!$("teacherFaceConsent").checked) {
        throw new Error("请先确认已取得老师明确的人脸采集授权，再打开摄像头完成必填的人脸采集。");
      }
      resetFaceCapture();
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前浏览器不支持摄像头访问，请使用最新版 Chrome 或 Edge。");
      $("openTeacherFaceCamera").hidden = true;
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 960 }, height: { ideal: 1280 } },
        audio: false
      });
      const video = $("teacherFaceCamera");
      video.srcObject = cameraStream;
      video.hidden = false;
      $("teacherFacePlaceholder").hidden = true;
      await video.play();
      $("captureTeacherFace").disabled = false;
      $("teacherFaceCaptureStatus").textContent = "摄像头已打开，请让老师正对镜头后拍照。";
      setMessage("");
    } catch (error) {
      stopCamera();
      $("openTeacherFaceCamera").hidden = false;
      $("captureTeacherFace").disabled = true;
      $("teacherFaceCaptureStatus").textContent = "无法打开摄像头";
      setMessage(error?.message || "请检查浏览器的摄像头权限。");
    }
  }

  function captureFace() {
    if (!$("teacherFaceConsent").checked) {
      setMessage("请先确认已取得老师明确的人脸采集授权，再完成必填的人脸采集。");
      return;
    }
    const video = $("teacherFaceCamera");
    if (!cameraStream || !video.videoWidth || !video.videoHeight) {
      setMessage("摄像头画面尚未就绪，请稍后重新拍照。");
      return;
    }
    const targetRatio = 3 / 4;
    let sourceWidth = video.videoWidth;
    let sourceHeight = video.videoHeight;
    if (sourceWidth / sourceHeight > targetRatio) sourceWidth = sourceHeight * targetRatio;
    else sourceHeight = sourceWidth / targetRatio;
    const sourceX = Math.round((video.videoWidth - sourceWidth) / 2);
    const sourceY = Math.round((video.videoHeight - sourceHeight) / 2);
    const outputHeight = Math.round(Math.min(sourceHeight, 1024));
    const canvas = $("teacherFaceCanvas");
    canvas.height = outputHeight;
    canvas.width = Math.round(outputHeight * targetRatio);
    canvas.getContext("2d", { alpha: false })
      .drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
    capturedFaceImage = canvas.toDataURL("image/jpeg", 0.85);
    if (dataUrlBytes(capturedFaceImage) > 3 * 1024 * 1024) capturedFaceImage = resizeCanvasDataUrl(canvas, 1024, 0.86);
    if (dataUrlBytes(capturedFaceImage) > 3 * 1024 * 1024) capturedFaceImage = resizeCanvasDataUrl(canvas, 880, 0.8);
    teacherCreateRequestId = requestId();

    const preview = $("teacherFacePreview");
    preview.src = capturedFaceImage;
    preview.hidden = false;
    video.hidden = true;
    stopCamera();
    $("captureTeacherFace").disabled = true;
    $("retakeTeacherFace").hidden = false;
    $("teacherFaceCaptureStatus").className = "capture-status complete";
    $("teacherFaceCaptureStatus").textContent = "照片已拍摄；创建时由服务端检测质量，并按配置检测活体。";
    $("teacherFaceQualityResult").textContent = "待服务端检测";
    $("teacherFaceLivenessResult").textContent = "待服务端检测";
    $("teacherFaceEnrollmentState").textContent = "待创建并检测";
    setMessage("");
    syncSubmit();
  }

  async function submit(event) {
    event.preventDefault();
    if (submitting || creationCompleted || outcomeUncertain) return;
    const name = $("personCreateName").value.trim();
    const phone = $("personPhone").value.trim();
    const initialPassword = $("personInitialPassword").value;
    if (!name || !phone || !passwordIsValid(initialPassword)) {
      setMessage("请填写老师资料。初始密码须为 8–32 位、首字符为英文字母或数字，并包含大写字母、小写字母、数字、特殊字符中的至少三类。");
      syncSubmit();
      return;
    }
    if (!capturedFaceImage || !$("teacherFaceConsent").checked) {
      setMessage("创建老师账号前，必须取得本人明确授权并完成拍照。照片质量由服务端检测，活体按服务端配置执行。");
      syncSubmit();
      return;
    }
    if (!window.CloudBasePhoneAuth?.createTeacherWithFace) {
      setMessage("老师创建服务尚未加载，请部署最新 teacherCreate 云函数和前端后重试。");
      return;
    }

    submitting = true;
    setFormLocked(true);
    const submitButton = $("createTeacherSubmit");
    const submitIdleLabel = submitButton.textContent;
    submitButton.disabled = true;
    submitButton.setAttribute("aria-busy", "true");
    submitButton.textContent = "正在检测并创建…";
    $("teacherFaceEnrollmentState").textContent = "服务端检测与创建中";
    showCreateProgress("正在一次性完成照片检测、账号创建、人脸和原始照片保存，请稍候…");
    setMessage("本页只提交一次创建请求，浏览器不会自动重发。");

    let succeeded = false;
    try {
      const result = await window.CloudBasePhoneAuth.createTeacherWithFace({
        staffName: name,
        phone,
        initialPassword,
        faceImageBase64: capturedFaceImage,
        clientRequestId: teacherCreateRequestId || (teacherCreateRequestId = requestId()),
        consent: true
      });
      const completed = completedTeacherCreation(result);
      if (!completed) {
        throw new Error("服务端没有同时确认老师、账号和认证均已激活，以及人脸与原始照片均已保存；本次不能视为创建成功。");
      }
      succeeded = true;
      creationCompleted = true;
      const qualityScore = Number(result?.quality?.qualityScore);
      $("teacherFaceQualityResult").textContent = Number.isFinite(qualityScore)
        ? `通过 · ${qualityScore} 分`
        : "通过";
      const livenessChecked = result?.liveness?.checked === true;
      const livenessScore = Number(result?.liveness?.score);
      $("teacherFaceLivenessResult").textContent = livenessChecked
        ? `通过${Number.isFinite(livenessScore) ? ` · ${livenessScore} 分` : ""}`
        : "本环境未启用";
      $("teacherFaceEnrollmentState").textContent = "已创建并绑定";
      showCreateProgress("创建完成，正在进入老师主页…", true);
      setMessage(`创建成功：${name}${completed.teacherCode ? `（${completed.teacherCode}）` : ""} 已激活，人脸和原始照片均已确认保存。`);
      window.setTimeout(() => {
        window.location.assign(`staff-detail.html?role=teacher&id=${encodeURIComponent(completed.teacherId)}`);
      }, 700);
    } catch (error) {
      hideCreateProgress();
      if (error?.code === "CLIENT_REQUEST_TIMEOUT" || error?.transportUncertain === true) {
        outcomeUncertain = true;
        $("teacherFaceEnrollmentState").textContent = "结果待确认 · 禁止重复提交";
        setMessage(`${error?.message || "浏览器未能确认老师创建结果。"} 前端没有自动重发，也不会允许当前页面再次提交。请先返回老师管理确认是否已经创建；不要重复点击创建。`);
      } else {
        $("teacherFaceEnrollmentState").textContent = "创建未完成 · 可修正后重试";
        setMessage(error?.message || "老师账号与人脸创建失败。资料和照片已保留，可直接重试。");
      }
    } finally {
      submitting = false;
      submitButton.textContent = submitIdleLabel;
      submitButton.removeAttribute("aria-busy");
      if (!succeeded) setFormLocked(outcomeUncertain);
      syncSubmit();
    }
  }

  ["personCreateName", "personPhone", "personInitialPassword"].forEach((id) => {
    $(id).addEventListener("input", syncSubmit);
  });
  $("teacherFaceConsent").addEventListener("change", () => {
    if (!$("teacherFaceConsent").checked) resetFaceCapture();
    else syncSubmit();
  });
  $("openTeacherFaceCamera").addEventListener("click", () => void openCamera());
  $("captureTeacherFace").addEventListener("click", captureFace);
  $("retakeTeacherFace").addEventListener("click", () => void openCamera());
  $("personCreateForm").addEventListener("submit", submit);
  window.addEventListener("pagehide", () => {
    capturedFaceImage = "";
    teacherCreateRequestId = "";
    $("teacherFaceCanvas").width = 0;
    $("teacherFaceCanvas").height = 0;
    stopCamera();
  }, { once: true });
  resetFaceCapture();
})();
