(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  let cameraStream = null;
  let capturedFaceImage = "";
  let faceValidated = false;
  // Kept for the lifetime of one successfully validated capture so a retry
  // after a lost response is idempotent at the account service.
  let teacherProvisionRequestId = "";
  let submitting = false;
  let provisionRecoveryPending = false;
  let provisionRecoveryGeneration = 0;
  let faceServiceApp = null;

  function setMessage(message = "") {
    $("personCreateMessage").textContent = message;
  }

  function passwordIsValid(value) {
    const groups = [/[A-Z]/, /[a-z]/, /\d/, /[^A-Za-z\d]/].filter((rule) => rule.test(value)).length;
    return value.length >= 8 && value.length <= 32 && groups >= 3;
  }

  function requestId() {
    const token = window.crypto?.randomUUID?.().replace(/-/g, "") || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    return `teacher_face_${token}`.slice(0, 64);
  }

  function wait(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, Math.max(0, Number(milliseconds) || 0)));
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

  function registerComponent(register, name) {
    if (typeof register !== "function") return;
    try { register(window.cloudbase); }
    catch (error) {
      const message = String(error?.message || error || "").toLowerCase();
      if (!(message.includes("duplicate component") && message.includes(name))) throw error;
    }
  }

  function responseData(result) {
    const candidates = [result?.result, result?.data?.result, result?.data, result];
    for (const candidate of candidates) {
      if (candidate && typeof candidate === "object" && (Object.hasOwn(candidate, "ok") || Object.hasOwn(candidate, "code"))) return candidate;
      if (typeof candidate === "string") {
        try {
          const parsed = JSON.parse(candidate);
          if (parsed && typeof parsed === "object") return parsed;
        } catch (_) { /* Ignore an unrelated response wrapper. */ }
      }
    }
    return {};
  }

  async function callFaceValidation(imageBase64) {
    if (!window.cloudbase || !window.CloudBaseAuthConfig || !window.registerFunctions) {
      throw new Error("人脸服务组件尚未加载，请刷新页面后重试。");
    }
    registerComponent(window.registerAuth, "auth");
    registerComponent(window.registerFunctions, "functions");
    faceServiceApp ||= window.cloudbase.init(window.CloudBaseAuthConfig);
    const raw = await faceServiceApp.callFunction({
      name: "faceRecognition",
      // Teacher provisioning is an HQ workflow rather than a store business
      // action, so it uses the dedicated no-store validation endpoint.
      data: { action: "validateTeacherFaceEnrollmentCapture", imageBase64 }
    });
    const result = responseData(raw);
    if (!result.ok) {
      const error = new Error(result.message || "老师人脸照片检测失败。");
      error.code = result.code || "FACE_CAPTURE_FAILED";
      throw error;
    }
    return result;
  }

  function stopCamera() {
    cameraStream?.getTracks().forEach((track) => track.stop());
    cameraStream = null;
    $("teacherFaceCamera").srcObject = null;
  }

  function syncSubmit() {
    const ready = !submitting && !provisionRecoveryPending
      && Boolean($("personCreateName").value.trim())
      && Boolean($("personPhone").value.trim())
      && passwordIsValid($("personInitialPassword").value)
      && Boolean(capturedFaceImage)
      && Boolean($("teacherFaceConsent").checked)
      && faceValidated;
    const submit = $("createTeacherSubmit");
    submit.disabled = !ready;
    submit.setAttribute("aria-disabled", String(!ready));
  }

  function resetFaceCapture() {
    provisionRecoveryGeneration += 1;
    provisionRecoveryPending = false;
    stopCamera();
    capturedFaceImage = "";
    faceValidated = false;
    teacherProvisionRequestId = "";
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
    $("teacherFaceQualityResult").textContent = "未采集";
    $("teacherFaceLivenessResult").textContent = "未采集";
    $("teacherFaceEnrollmentState").textContent = "创建前必填";
    syncSubmit();
  }

  async function monitorTeacherProvisionRecovery(error) {
    const operationId = String(error?.operationId || "").trim();
    if (!operationId || !window.CloudBasePhoneAuth?.getTeacherFaceOperationStatus) return false;
    provisionRecoveryPending = true;
    const generation = ++provisionRecoveryGeneration;
    $("retakeTeacherFace").disabled = true;
    syncSubmit();
    const deadline = Date.now() + 3 * 60 * 1000;
    let remaining = Math.max(1, Number(error?.retryAfterSeconds) || 90);
    while (generation === provisionRecoveryGeneration && Date.now() < deadline) {
      setMessage(`登录账号正在后台安全确认，预计 ${remaining} 秒内完成；当前页面会自动恢复，请勿重复提交。`);
      await wait(Math.min(5000, Math.max(1000, remaining * 1000)));
      if (generation !== provisionRecoveryGeneration) return true;
      try {
        const status = await window.CloudBasePhoneAuth.getTeacherFaceOperationStatus({ operationId });
        const state = String(status?.status || "");
        if (state === "SUCCEEDED") {
          setMessage("老师创建操作已由后台确认成功，请返回老师管理查看；不要再次创建。");
          return true;
        }
        if (status?.cleanupComplete === true || (state === "CANCELLED" && status?.retryAllowed === true)) {
          teacherProvisionRequestId = "";
          provisionRecoveryPending = false;
          $("retakeTeacherFace").disabled = false;
          setMessage("先前不确定的登录账号操作已安全核对并清理。无需重新拍照，现在可以再次点击创建。");
          syncSubmit();
          return true;
        }
        remaining = Math.max(1, Number(status?.retryAfterSeconds) || 5);
      } catch (_) {
        remaining = Math.max(1, remaining - 5);
      }
    }
    if (generation === provisionRecoveryGeneration) {
      setMessage("后台确认尚未完成，已继续保持创建锁以避免重复账号。请稍后刷新页面，或在老师管理中确认结果。");
    }
    return true;
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
    } catch (error) {
      stopCamera();
      $("openTeacherFaceCamera").hidden = false;
      $("captureTeacherFace").disabled = true;
      $("teacherFaceCaptureStatus").textContent = "无法打开摄像头";
      setMessage(error?.message || "请检查浏览器的摄像头权限。");
    }
  }

  async function captureFace() {
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
    // Keep the captured crop and JPEG settings aligned with customer
    // enrollment so the same quality/liveness thresholds see the same input.
    const outputHeight = Math.round(Math.min(sourceHeight, 1024));
    const canvas = $("teacherFaceCanvas");
    canvas.height = outputHeight;
    canvas.width = Math.round(outputHeight * targetRatio);
    canvas.getContext("2d", { alpha: false }).drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
    capturedFaceImage = canvas.toDataURL("image/jpeg", 0.85);
    if (dataUrlBytes(capturedFaceImage) > 3 * 1024 * 1024) capturedFaceImage = resizeCanvasDataUrl(canvas, 1024, 0.86);
    if (dataUrlBytes(capturedFaceImage) > 3 * 1024 * 1024) capturedFaceImage = resizeCanvasDataUrl(canvas, 880, 0.8);
    const validatingImage = capturedFaceImage;
    const preview = $("teacherFacePreview");
    preview.src = capturedFaceImage;
    preview.hidden = false;
    video.hidden = true;
    stopCamera();
    $("captureTeacherFace").disabled = true;
    $("retakeTeacherFace").hidden = false;
    $("teacherFaceCaptureStatus").className = "capture-status pending";
    $("teacherFaceCaptureStatus").textContent = "正在检查人脸、清晰度、遮挡和拍摄角度…";
    $("teacherFaceQualityResult").textContent = "检测中…";
    $("teacherFaceLivenessResult").textContent = "等待质量检测";
    setMessage("");
    faceValidated = false;
    syncSubmit();
    try {
      const validation = await callFaceValidation(validatingImage);
      // A retake may have started while the asynchronous validation was in
      // flight; never let an old response validate a newer capture.
      if (capturedFaceImage !== validatingImage) return;
      const quality = validation.quality || {};
      const liveness = validation.liveness || {};
      if (!liveness.checked) {
        const error = new Error("活体检测服务尚未启用，当前不能创建老师账号。请联系管理员启用活体检测后重新拍照。");
        error.code = "LIVENESS_REQUIRED";
        throw error;
      }
      faceValidated = true;
      teacherProvisionRequestId ||= requestId();
      const score = Number(quality.qualityScore);
      const livenessScore = Number(liveness.score);
      const qualityThreshold = quality.qualityThreshold;
      $("teacherFaceQualityResult").textContent = Number.isFinite(score)
        ? `通过 · ${score} 分${qualityThreshold != null ? `（要求 ${qualityThreshold}）` : ""}`
        : "通过";
      $("teacherFaceLivenessResult").textContent = Number.isFinite(livenessScore)
        ? `通过 · ${livenessScore} 分${liveness.threshold != null ? `（要求 ${liveness.threshold}）` : ""}`
        : "通过";
      $("teacherFaceCaptureStatus").className = "capture-status complete";
      $("teacherFaceCaptureStatus").textContent = "照片质量与活体检测通过；现在可以创建并绑定老师人脸。";
      $("teacherFaceEnrollmentState").textContent = "待提交绑定";
    } catch (error) {
      if (capturedFaceImage !== validatingImage) return;
      capturedFaceImage = "";
      faceValidated = false;
      teacherProvisionRequestId = "";
      $("teacherFaceCanvas").width = 0;
      $("teacherFaceCanvas").height = 0;
      preview.hidden = true;
      preview.removeAttribute("src");
      $("teacherFacePlaceholder").hidden = false;
      $("openTeacherFaceCamera").hidden = false;
      $("retakeTeacherFace").hidden = true;
      const livenessFailed = error?.code === "LIVENESS_FAILED";
      const livenessRequired = error?.code === "LIVENESS_REQUIRED";
      const captureRejected = ["FACE_NOT_FOUND", "MULTIPLE_FACES", "FACE_TOO_SMALL", "FACE_QUALITY_LOW", "FACE_MASKED", "EYES_CLOSED", "FACE_POSE_INVALID"].includes(error?.code);
      $("teacherFaceCaptureStatus").className = "capture-status pending";
      $("teacherFaceCaptureStatus").textContent = livenessRequired
        ? "活体检测尚未启用，暂不能创建"
        : livenessFailed
        ? "活体检测未通过，请重新拍照"
        : captureRejected ? "照片质量未通过，请重新拍照" : "检测服务调用失败，请查看下方错误";
      $("teacherFaceQualityResult").textContent = (livenessRequired || livenessFailed) ? "通过" : captureRejected ? "未通过" : "检测失败";
      $("teacherFaceLivenessResult").textContent = livenessRequired ? "未启用" : livenessFailed ? "未通过" : captureRejected ? "未执行" : "检测失败";
      setMessage(error?.message || "老师人脸照片检测失败，请重新拍摄。");
    }
    syncSubmit();
  }

  async function submit(event) {
    event.preventDefault();
    if (submitting) return;
    const name = $("personCreateName").value.trim();
    const phone = $("personPhone").value.trim();
    const initialPassword = $("personInitialPassword").value;
    if (!name || !phone || !passwordIsValid(initialPassword)) {
      setMessage("请填写老师资料，并使用符合要求的初始密码。");
      syncSubmit();
      return;
    }
    if (!capturedFaceImage || !$("teacherFaceConsent").checked || !faceValidated) {
      setMessage("创建老师账号前，必须取得本人明确授权，并完成通过照片质量与活体检测的人脸拍摄。");
      syncSubmit();
      return;
    }
    if (!window.CloudBasePhoneAuth?.provisionTeacherWithFace) {
      setMessage("老师人脸建档服务尚未加载，请部署最新后台后重试。");
      return;
    }
    submitting = true;
    const submitButton = $("createTeacherSubmit");
    const submitIdleLabel = submitButton.textContent;
    submitButton.disabled = true;
    submitButton.setAttribute("aria-busy", "true");
    submitButton.textContent = "正在创建并绑定人脸…";
    setMessage("正在原子创建老师账号并安全绑定人脸，请勿关闭页面…");
    try {
      const result = await window.CloudBasePhoneAuth.provisionTeacherWithFace({
        staffName: name,
        phone,
        initialPassword,
        faceImageBase64: capturedFaceImage,
        clientRequestId: teacherProvisionRequestId || (teacherProvisionRequestId = requestId()),
        consent: true
      });
      const enrollmentStatus = String(
        result?.teacher?.faceEnrollmentStatus
        || result?.teacher?.face_enrollment_status
        || result?.profile?.faceEnrollmentStatus
        || result?.profile?.face_enrollment_status
        || ""
      ).toUpperCase();
      const facePhotoReady = result?.teacher?.facePhotoReady === true
        || result?.teacher?.face_photo_ready === true
        || result?.profile?.facePhotoReady === true
        || result?.profile?.face_photo_ready === true;
      const teacherStatus = String(
        result?.teacher?.teacherStatus
        || result?.teacher?.teacher_status
        || result?.profile?.teacherStatus
        || result?.profile?.teacher_status
        || ""
      ).toUpperCase();
      const accountStatus = String(
        result?.teacher?.accountStatus
        || result?.teacher?.account_status
        || result?.profile?.accountStatus
        || result?.profile?.account_status
        || ""
      ).toUpperCase();
      const credentialStatus = String(
        result?.teacher?.credentialStatus
        || result?.teacher?.credential_status
        || result?.profile?.credentialStatus
        || result?.profile?.credential_status
        || result?.credentialStatus
        || ""
      ).toUpperCase();
      const teacherId = String(result?.teacher?.teacherId || result?.profile?.teacherId || "").trim();
      const uid = String(result?.uid || result?.profile?.uid || "").trim();
      const readbackConfirmed = result?.readbackConfirmed === true
        && result?.verification?.complete === true;
      if (result?.ok !== true || enrollmentStatus !== "ENROLLED" || !facePhotoReady
          || teacherStatus !== "ACTIVE" || accountStatus !== "ACTIVE"
          || credentialStatus !== "ACTIVE"
          || !teacherId || !uid || !readbackConfirmed) {
        throw new Error("服务端尚未完整确认人脸库、原始照片、数据库引用及最终激活状态；本次不能视为创建成功。");
      }
      const code = String(result?.teacher?.teacherCode || result?.profile?.teacherCode || "");
      setMessage(`创建成功：${name}${code ? `（${code}）` : ""} 已创建并激活登录账号，人脸已绑定。请通过安全渠道单独告知初始密码。`);
      $("personCreateForm").reset();
      resetFaceCapture();
    } catch (error) {
      if (error?.code === "TEACHER_PROVISION_COMPENSATION_PENDING"
          && error?.stage === "AUTH_CREATE_OWNERSHIP"
          && error?.operationId) {
        void monitorTeacherProvisionRecovery(error);
      } else {
        setMessage(error?.message || "老师账号与人脸绑定创建失败；未确认成功前请勿重复提交。");
      }
    } finally {
      submitting = false;
      submitButton.textContent = submitIdleLabel;
      submitButton.removeAttribute("aria-busy");
      syncSubmit();
    }
  }

  ["personCreateName", "personPhone", "personInitialPassword", "teacherFaceConsent"].forEach((id) => {
    $(id).addEventListener(id === "teacherFaceConsent" ? "change" : "input", syncSubmit);
  });
  $("openTeacherFaceCamera").addEventListener("click", () => void openCamera());
  $("captureTeacherFace").addEventListener("click", () => void captureFace());
  $("retakeTeacherFace").addEventListener("click", () => void openCamera());
  $("personCreateForm").addEventListener("submit", submit);
  window.addEventListener("pagehide", () => {
    provisionRecoveryGeneration += 1;
    capturedFaceImage = "";
    teacherProvisionRequestId = "";
    $("teacherFaceCanvas").width = 0;
    $("teacherFaceCanvas").height = 0;
    stopCamera();
  }, { once: true });
  resetFaceCapture();
})();
