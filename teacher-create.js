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
  let provisionPayloadLocked = false;
  let provisionRecoveryGeneration = 0;
  let activeProvisionOperationId = "";
  const teacherProvisionWorkerDeliveryStates = new Map();
  let faceServiceApp = null;

  function setMessage(message = "") {
    $("personCreateMessage").textContent = message;
  }

  function setProvisionPayloadLocked(locked) {
    provisionPayloadLocked = locked === true;
    ["personCreateName", "personPhone", "personInitialPassword", "teacherFaceConsent"]
      .forEach((id) => { $(id).disabled = provisionPayloadLocked; });
    ["openTeacherFaceCamera", "captureTeacherFace", "retakeTeacherFace"]
      .forEach((id) => { if ($(id)) $(id).disabled = provisionPayloadLocked; });
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

  function safeProvisionRecoverySeconds(value, fallback = 2) {
    const seconds = Number(value);
    return Math.min(5, Math.max(1,
      Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : fallback
    ));
  }

  function transientTeacherProvisionTransport(error) {
    const signature = `${error?.code || ""} ${error?.message || ""}`.toUpperCase();
    return /CLIENT_REQUEST_TIMEOUT|TIMEOUT|TIMED OUT|NETWORK|CONNECTION|ECONNRESET|ETIMEDOUT|FUNCTIONS_(?:TIME_LIMIT|INVOCATION_FAILED|INTERNAL_ERROR|EXECUTE_FAIL)|HTTP[_ ]?5\d\d|BAD_GATEWAY|SERVICE_UNAVAILABLE/.test(signature);
  }

  function jpegBytesFromDataUrl(value) {
    const base64 = String(value || "").replace(/^data:image\/jpeg;base64,/i, "");
    const binary = window.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function teacherFaceImageMetadata(imageBase64) {
    if (!window.crypto?.subtle) throw new Error("当前浏览器无法生成老师照片安全摘要，请升级 Chrome 或 Edge 后重试。");
    const bytes = jpegBytesFromDataUrl(imageBase64);
    const digest = await window.crypto.subtle.digest("SHA-256", bytes);
    const faceImageSha256 = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
    return { faceImageSha256, faceImageBytes: bytes.byteLength };
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
    const validationRequest = faceServiceApp.callFunction({
      name: "faceRecognition",
      // Teacher provisioning is an HQ workflow rather than a store business
      // action, so it uses the dedicated no-store validation endpoint.
      data: { action: "validateTeacherFaceEnrollmentCapture", imageBase64 }
    });
    let watchdogTimer = null;
    const validationWatchdog = new Promise((_, reject) => {
      watchdogTimer = window.setTimeout(() => {
        const error = new Error("老师人脸照片预检等待超时，本次照片未保存；请重新拍照检测。");
        error.code = "FACE_VALIDATION_TIMEOUT";
        reject(error);
      }, 15 * 1000);
    });
    let raw;
    try {
      raw = await Promise.race([validationRequest, validationWatchdog]);
    } finally {
      window.clearTimeout(watchdogTimer);
    }
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
    setProvisionPayloadLocked(false);
    hideTeacherProvisionProgress();
    stopCamera();
    capturedFaceImage = "";
    faceValidated = false;
    if (teacherProvisionRequestId) teacherProvisionWorkerDeliveryStates.delete(teacherProvisionRequestId);
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

  function teacherProvisionProof(value) {
    const candidates = [
      value?.result,
      value?.provisionResult,
      value?.finalResult,
      value?.operation?.result,
      value
    ].filter((candidate) => candidate && typeof candidate === "object");
    for (const result of candidates) {
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
      const verification = result?.verification || {};
      const individualProofsComplete = [
        "personConfirmed",
        "privatePhotoConfirmed",
        "delegatedDatabaseConfirmed",
        "finalDatabaseConfirmed",
        "facePhotoReady",
        "teacherActive",
        "accountActive",
        "credentialActive"
      ].every((key) => verification[key] === true);
      if (result?.ok === true
          && result?.resultReadOnly === true
          && result?.readbackConfirmed === true
          && verification.complete === true
          && individualProofsComplete
          && enrollmentStatus === "ENROLLED"
          && facePhotoReady
          && teacherStatus === "ACTIVE"
          && accountStatus === "ACTIVE"
          && credentialStatus === "ACTIVE"
          && teacherId
          && uid) return result;
    }
    return null;
  }

  function showTeacherProvisionProgress(stage, operationId, message) {
    const normalizedStage = String(stage || "RUNNING").toUpperCase();
    const progress = $("teacherProvisionProgress");
    if (progress) {
      progress.hidden = false;
      progress.className = `capture-status ${normalizedStage === "SUCCEEDED" ? "complete" : "pending"}`;
    }
    if ($("teacherProvisionProgressStage")) {
      $("teacherProvisionProgressStage").textContent = ({
        READY: "已受理 · 准备后台创建",
        WORKER_STARTING: "后台任务正在启动",
        WORKER_RUNNING: "后台正在创建并执行安全回读",
        SUCCEEDED: "后台创建完成 · 正在取得最终证明",
        CLEANUP: "失败资料正在安全清理",
        CLEANUP_PENDING: "失败资料正在安全清理",
        CANCELLED: "创建已取消"
      })[normalizedStage] || "后台正在处理";
    }
    if ($("teacherProvisionProgressId")) {
      $("teacherProvisionProgressId").textContent = operationId ? `操作编号 ${operationId}` : "正在取得操作编号";
    }
    const submitButton = $("createTeacherSubmit");
    if (submitButton && submitting) {
      submitButton.textContent = normalizedStage === "SUCCEEDED" ? "正在核对最终证明…" : "已受理 · 后台创建中…";
    }
    $("teacherFaceEnrollmentState").textContent = normalizedStage === "SUCCEEDED" ? "最终核对中" : "后台创建中";
    if (message) setMessage(message);
  }

  function hideTeacherProvisionProgress() {
    const progress = $("teacherProvisionProgress");
    if (progress) progress.hidden = true;
    activeProvisionOperationId = "";
  }

  async function beginTeacherProvision(input, metadata) {
    const { faceImageBase64: _omittedFaceImage, ...withoutFaceImage } = input;
    const beginInput = { ...withoutFaceImage, ...metadata };
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await window.CloudBasePhoneAuth.beginTeacherProvisionWithFace(beginInput);
      } catch (error) {
        lastError = error;
        if (!transientTeacherProvisionTransport(error) || attempt >= 3) break;
        setMessage(`老师创建请求正在安全受理（${attempt}/3），照片尚未发送，请稍候…`);
        await wait(1000 * attempt);
      }
    }
    lastError ||= new Error("老师创建请求未能取得操作编号。");
    if (transientTeacherProvisionTransport(lastError)) {
      lastError.sameRequestResumeDeferred = true;
    }
    throw lastError;
  }

  async function provisionTeacherWithBackgroundPolling(input, metadata) {
    const generation = ++provisionRecoveryGeneration;
    // One page may deliver the immutable 3 MB worker payload at most three
    // times. A fresh READY state is necessary but never sufficient to bypass
    // these delivery fences: initial, then 15 s and 45 s after the prior try.
    const workerDeliveryDelaysMs = Object.freeze([0, 15 * 1000, 45 * 1000]);
    const workerDeliveryKey = String(input?.clientRequestId || "").trim();
    let workerDeliveryState = teacherProvisionWorkerDeliveryStates.get(workerDeliveryKey);
    if (!workerDeliveryState) {
      workerDeliveryState = { attempts: 0, lastStartedAt: 0 };
      teacherProvisionWorkerDeliveryStates.set(workerDeliveryKey, workerDeliveryState);
    }
    const started = await beginTeacherProvision(input, metadata);
    const operationId = String(started?.operationId || started?.operation?.id || "").trim();
    if (started?.ok !== true || !operationId) {
      const error = new Error("老师创建请求未返回有效操作编号；照片和请求编号已保留，不能视为创建成功。");
      error.sameRequestResumeDeferred = true;
      throw error;
    }
    activeProvisionOperationId = operationId;
    provisionRecoveryPending = true;
    setProvisionPayloadLocked(true);
    syncSubmit();

    let workerInFlight = false;
    let workerObserverToken = 0;
    let proofReplayInFlight = null;
    let proofReplayResult = null;
    let proofReplayError = null;
    const launchWorker = () => {
      if (workerInFlight || generation !== provisionRecoveryGeneration) return false;
      const requiredDelay = workerDeliveryDelaysMs[workerDeliveryState.attempts];
      if (!Number.isFinite(requiredDelay)
          || (workerDeliveryState.attempts > 0
            && Date.now() - workerDeliveryState.lastStartedAt < requiredDelay)) return false;
      const observerToken = ++workerObserverToken;
      workerDeliveryState.attempts += 1;
      workerDeliveryState.lastStartedAt = Date.now();
      workerInFlight = true;
      // Deliberately do not await this long invocation. The operation row is
      // already durable; only status READY may authorize another launch.
      Promise.resolve()
        .then(() => window.CloudBasePhoneAuth.provisionTeacherWithFace(input))
        .catch(() => null)
        .finally(() => {
          if (workerObserverToken === observerToken) workerInFlight = false;
        });
      return true;
    };
    const startProofReplay = () => {
      if (proofReplayInFlight || generation !== provisionRecoveryGeneration) return proofReplayInFlight;
      proofReplayResult = null;
      proofReplayError = null;
      proofReplayInFlight = Promise.resolve()
        .then(() => window.CloudBasePhoneAuth.readTeacherProvisionResult({
          ...input,
          operationId,
          readOnly: true
        }))
        .then((result) => { proofReplayResult = result; }, (error) => { proofReplayError = error; })
        .finally(() => { proofReplayInFlight = null; });
      return proofReplayInFlight;
    };

    let current = started;
    const deadline = Date.now() + 15 * 60 * 1000;
    while (generation === provisionRecoveryGeneration && Date.now() < deadline) {
      const status = String(current?.status || "RUNNING").toUpperCase();
      const stage = String(current?.stage || status || "RUNNING").toUpperCase();
      const ready = current?.workerReady === true || current?.retrySameRequest === true || stage === "READY";

      if (status === "SUCCEEDED" || stage === "SUCCEEDED") {
        showTeacherProvisionProgress("SUCCEEDED", operationId,
          "后台创建已完成，正在按操作编号纯读取人脸、原始照片、数据库引用和账号激活证明…");
        if (proofReplayResult) {
          const proof = teacherProvisionProof(proofReplayResult);
          if (proof) return proof;
          throw new Error("最终证明重放没有同时确认人脸、原始照片、数据库引用和全部激活状态；不能显示创建成功。");
        }
        if (proofReplayError) {
          const error = proofReplayError;
          proofReplayError = null;
          if (!transientTeacherProvisionTransport(error)) throw error;
        }
        const replayFlight = startProofReplay();
        // Observe only one local proof read at a time. If its browser watchdog
        // expires, the wrapper releases that stale pure-read flight so a later
        // loop can recover without allowing an old completion to erase it.
        await Promise.race([replayFlight, wait(12 * 1000)]);
        if (proofReplayResult) continue;
        if (proofReplayError && !transientTeacherProvisionTransport(proofReplayError)) {
          throw proofReplayError;
        }
        try {
          current = await window.CloudBasePhoneAuth.getTeacherFaceOperationStatus({ operationId, readOnly: true });
        } catch (error) {
          if (!transientTeacherProvisionTransport(error)) throw error;
        }
        continue;
      }

      if ((status === "CANCELLED" || status === "FAILED") && current?.cleanupComplete === true) {
        const error = new Error(current?.message || "老师创建失败，半成品已全部安全清理；可以使用当前照片重新提交。");
        error.code = "TEACHER_PROVISION_CLEANED";
        error.cleanupComplete = true;
        throw error;
      }

      const nextWorkerDelay = workerDeliveryDelaysMs[workerDeliveryState.attempts];
      const workerRetryDue = Number.isFinite(nextWorkerDelay)
        && (workerDeliveryState.attempts === 0
          || Date.now() - workerDeliveryState.lastStartedAt >= nextWorkerDelay);
      // READY is authoritative, but it may replace a never-settling browser
      // observer only after the next delivery fence opens. The attempt token
      // prevents a late old finally from clearing the newer local guard.
      if (ready && workerInFlight && workerRetryDue) workerInFlight = false;
      if (ready && workerRetryDue && launchWorker()) {
        // Consume this READY observation locally. A browser timeout must never
        // reuse stale authorization; only a later successful status read that
        // again says READY may start another worker request.
        current = { ...current, stage: "WORKER_STARTING", workerReady: false, retrySameRequest: false };
      }
      const workerDeliveryExhausted = workerDeliveryState.attempts >= workerDeliveryDelaysMs.length;
      showTeacherProvisionProgress(stage, operationId, ready
        ? workerDeliveryExhausted
          ? "后台任务已达到本页安全投递上限，正在继续查询最终状态；请保持本页打开。"
          : "创建请求已受理，后台任务正在按安全间隔投递；请保持本页打开。"
        : "后台正在创建并逐项安全回读；请保持本页打开，不会重复创建账号。");

      await wait(safeProvisionRecoverySeconds(current?.retryAfterSeconds, 2) * 1000);
      if (generation !== provisionRecoveryGeneration) break;
      try {
        current = await window.CloudBasePhoneAuth.getTeacherFaceOperationStatus({ operationId, readOnly: true });
      } catch (error) {
        if (!transientTeacherProvisionTransport(error)) throw error;
        showTeacherProvisionProgress(stage, operationId, "状态查询暂时超时，后台创建不受影响，正在继续查询…");
      }
    }
    const timeout = new Error("老师创建后台核对超过 15 分钟，仍未取得最终证明。照片与请求编号已保留，不能视为创建成功。");
    timeout.code = "TEACHER_PROVISION_STATUS_TIMEOUT";
    timeout.operationId = operationId;
    timeout.sameRequestResumeDeferred = true;
    throw timeout;
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
    if (!window.CloudBasePhoneAuth?.beginTeacherProvisionWithFace
        || !window.CloudBasePhoneAuth?.provisionTeacherWithFace
        || !window.CloudBasePhoneAuth?.getTeacherFaceOperationStatus
        || !window.CloudBasePhoneAuth?.readTeacherProvisionResult) {
      setMessage("老师人脸建档服务尚未加载，请部署最新后台后重试。");
      return;
    }
    submitting = true;
    provisionRecoveryPending = true;
    setProvisionPayloadLocked(true);
    const submitButton = $("createTeacherSubmit");
    const submitIdleLabel = submitButton.textContent;
    submitButton.disabled = true;
    submitButton.setAttribute("aria-busy", "true");
    submitButton.textContent = "正在安全受理…";
    setMessage("正在生成照片安全摘要并取得后台操作编号；此步骤不会上传原始照片…");
    try {
      const provisionInput = {
        staffName: name,
        phone,
        initialPassword,
        faceImageBase64: capturedFaceImage,
        clientRequestId: teacherProvisionRequestId || (teacherProvisionRequestId = requestId()),
        consent: true
      };
      const metadata = await teacherFaceImageMetadata(capturedFaceImage);
      const result = await provisionTeacherWithBackgroundPolling(Object.freeze(provisionInput), metadata);
      const proof = teacherProvisionProof(result);
      if (!proof) {
        throw new Error("服务端尚未完整确认人脸库、原始照片、数据库引用及最终激活状态；本次不能视为创建成功。");
      }
      const code = String(proof?.teacher?.teacherCode || proof?.profile?.teacherCode || "");
      provisionRecoveryPending = false;
      setMessage(`创建成功：${name}${code ? `（${code}）` : ""} 已创建并激活登录账号，人脸已绑定。请通过安全渠道单独告知初始密码。`);
      $("personCreateForm").reset();
      resetFaceCapture();
    } catch (error) {
      if (error?.cleanupComplete === true) {
        if (teacherProvisionRequestId) teacherProvisionWorkerDeliveryStates.delete(teacherProvisionRequestId);
        teacherProvisionRequestId = "";
        provisionRecoveryPending = false;
        setProvisionPayloadLocked(false);
        hideTeacherProvisionProgress();
        setMessage(error?.message || "老师创建失败，半成品已安全清理；可以使用当前照片重新提交。");
      } else if (error?.sameRequestResumeDeferred === true) {
        provisionRecoveryPending = false;
        setProvisionPayloadLocked(true);
        setMessage(`${error?.message || "同一创建请求仍未收到明确结果。"} 照片、资料和请求编号均已保留；请直接再次点击创建继续查询，不要重新拍照或更换手机号。`);
      } else {
        provisionRecoveryPending = false;
        setProvisionPayloadLocked(Boolean(activeProvisionOperationId));
        setMessage(error?.message || "老师账号与人脸绑定创建失败；未取得完整最终证明，不能视为成功。");
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
  window.addEventListener("beforeunload", (event) => {
    if (!activeProvisionOperationId) return;
    event.preventDefault();
    event.returnValue = "";
  });
  window.addEventListener("pagehide", () => {
    provisionRecoveryGeneration += 1;
    if (!activeProvisionOperationId) {
      capturedFaceImage = "";
      teacherProvisionRequestId = "";
      $("teacherFaceCanvas").width = 0;
      $("teacherFaceCanvas").height = 0;
    }
    stopCamera();
  }, { once: true });
  resetFaceCapture();
})();
