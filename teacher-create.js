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
    const faceIsBeingAdded = Boolean(capturedFaceImage);
    const ready = !submitting
      && Boolean($("personCreateName").value.trim())
      && Boolean($("personPhone").value.trim())
      && passwordIsValid($("personInitialPassword").value)
      && (!faceIsBeingAdded || (Boolean($("teacherFaceConsent").checked) && faceValidated));
    const submit = $("createTeacherSubmit");
    submit.disabled = !ready;
    submit.setAttribute("aria-disabled", String(!ready));
  }

  function resetFaceCapture() {
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
    $("teacherFaceCaptureStatus").textContent = "可选 · 尚未拍摄";
    $("teacherFaceQualityResult").textContent = "未采集";
    $("teacherFaceLivenessResult").textContent = "未采集";
    $("teacherFaceEnrollmentState").textContent = "可后续补录";
    syncSubmit();
  }

  async function openCamera() {
    try {
      if (!$("teacherFaceConsent").checked) {
        throw new Error("请先确认已取得老师明确的人脸采集授权。未采集人脸也可以直接创建并激活老师账号。");
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
      setMessage("请先确认已取得老师明确的人脸采集授权。未采集人脸也可以直接创建并激活老师账号。");
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
    const outputHeight = Math.round(Math.min(sourceHeight, 1280));
    const canvas = $("teacherFaceCanvas");
    canvas.height = outputHeight;
    canvas.width = Math.round(outputHeight * targetRatio);
    canvas.getContext("2d", { alpha: false }).drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
    capturedFaceImage = canvas.toDataURL("image/jpeg", 0.9);
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
      faceValidated = true;
      teacherProvisionRequestId ||= requestId();
      const quality = validation.quality || {};
      const liveness = validation.liveness || {};
      const score = Number(quality.qualityScore);
      $("teacherFaceQualityResult").textContent = Number.isFinite(score) ? `通过 · ${score} 分` : "通过";
      $("teacherFaceLivenessResult").textContent = liveness.checked ? `通过 · ${liveness.score} 分` : "未启用";
      $("teacherFaceCaptureStatus").className = "capture-status complete";
      $("teacherFaceCaptureStatus").textContent = `${liveness.checked ? "照片质量与活体检测" : "照片质量检查"}通过；创建时可以一并绑定人脸。`;
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
      $("teacherFaceCaptureStatus").textContent = "照片质量或人脸检测未通过，请重新拍照。";
      $("teacherFaceQualityResult").textContent = "未通过";
      $("teacherFaceLivenessResult").textContent = error?.code === "LIVENESS_FAILED" ? "未通过" : "未执行";
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
    const includeFace = Boolean(capturedFaceImage);
    if (!name || !phone || !passwordIsValid(initialPassword)) {
      setMessage("请填写老师资料，并使用符合要求的初始密码。");
      syncSubmit();
      return;
    }
    if (includeFace && (!$("teacherFaceConsent").checked || !faceValidated)) {
      setMessage("如需现在绑定人脸，请先取得明确授权并完成通过检测的照片；也可重新拍照后再创建。");
      syncSubmit();
      return;
    }
    if (includeFace && !window.CloudBasePhoneAuth?.provisionTeacherWithFace) {
      setMessage("老师人脸建档服务尚未加载，请部署最新后台后重试。");
      return;
    }
    if (!includeFace && !window.CloudBasePhoneAuth?.provisionTeacher) {
      setMessage("老师账号创建服务尚未加载，请部署最新后台后重试。");
      return;
    }
    submitting = true;
    const submitButton = $("createTeacherSubmit");
    submitButton.disabled = true;
    setMessage(includeFace ? "正在创建老师账号并安全绑定人脸，请勿关闭页面…" : "正在创建并激活老师账号，请勿关闭页面…");
    try {
      const result = includeFace
        ? await window.CloudBasePhoneAuth.provisionTeacherWithFace({
          staffName: name,
          phone,
          initialPassword,
          faceImageBase64: capturedFaceImage,
          clientRequestId: teacherProvisionRequestId || (teacherProvisionRequestId = requestId()),
          consent: true
        })
        : await window.CloudBasePhoneAuth.provisionTeacher({ staffName: name, phone, initialPassword });
      if (includeFace && String(result?.teacher?.faceEnrollmentStatus || "").toUpperCase() !== "ENROLLED") {
        throw new Error("账号服务未确认老师人脸绑定，已停止显示创建成功。");
      }
      const code = String(result?.teacher?.teacherCode || result?.profile?.teacherCode || "");
      setMessage(includeFace
        ? `创建成功：${name}${code ? `（${code}）` : ""} 已创建并激活登录账号，人脸已绑定。请通过安全渠道单独告知初始密码。`
        : `创建成功：${name}${code ? `（${code}）` : ""} 已创建并激活登录账号；人脸可在老师主页中后续补录或更换。请通过安全渠道单独告知初始密码。`);
      $("personCreateForm").reset();
      resetFaceCapture();
      $("teacherFaceEnrollmentState").textContent = includeFace ? "已绑定" : "可后续补录";
    } catch (error) {
      setMessage(error?.message || (includeFace ? "老师账号与人脸绑定创建失败；未确认成功前请勿重复提交。" : "老师账号创建失败；未确认成功前请勿重复提交。"));
    } finally {
      submitting = false;
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
    capturedFaceImage = "";
    teacherProvisionRequestId = "";
    $("teacherFaceCanvas").width = 0;
    $("teacherFaceCanvas").height = 0;
    stopCamera();
  }, { once: true });
  resetFaceCapture();
})();
