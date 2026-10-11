(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const C = window.WebWorkCommon;
  const state = { month: "", serverToday: "", selectedDate: "", records: [], faceEnrolled: false, stage: "idle", preview: null, stream: null, loading: false, cameraStarting: false };
  const selected = () => ({
    clockIn: state.records.find((row) => row.attendanceDate === state.selectedDate && row.attendanceType === "CLOCK_IN") || null,
    clockOut: state.records.find((row) => row.attendanceDate === state.selectedDate && row.attendanceType === "CLOCK_OUT") || null
  });
  function requestId(type) {
    const key = `teacherAttendanceRequest:${state.serverToday}:${type}`;
    let value = localStorage.getItem(key);
    if (!value) { value = `attendance_${type.toLowerCase()}_${state.serverToday.replaceAll("-", "")}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`.slice(0, 80); localStorage.setItem(key, value); }
    return value;
  }
  function stopCamera() { state.stream?.getTracks().forEach((track) => track.stop()); state.stream = null; }
  function mapBlock(row) {
    if (!row) return "";
    return `<iframe class="map-frame" title="打卡位置地图" loading="lazy" referrerpolicy="no-referrer" src="${C.mapEmbed(row)}"></iframe><a class="button-link secondary-button" target="_blank" rel="noopener noreferrer" href="${C.mapLink(row)}">在地图中打开</a>`;
  }
  function recordCard(title, row) {
    if (!row) return `<article class="punch-record"><h3>${title}</h3><div class="empty-copy">未打卡</div></article>`;
    return `<article class="punch-record"><h3>${title}</h3><strong>${C.shanghaiDateTime(row.checkedInAt)}（北京时间）</strong>${row.placeName ? `<span>${C.escapeHtml(row.placeName)}</span>` : ""}${row.formattedAddress ? `<span>${C.escapeHtml(row.formattedAddress)}</span>` : ""}<span>经纬度 ${Number(row.latitude).toFixed(6)}, ${Number(row.longitude).toFixed(6)}</span><span>定位精度约 ${C.escapeHtml(row.accuracy)} 米</span>${mapBlock(row)}</article>`;
  }
  function renderRecords() {
    const current = selected();
    const complete = current.clockIn && current.clockOut;
    const duration = complete ? Math.max(0, (new Date(current.clockOut.checkedInAt) - new Date(current.clockIn.checkedInAt)) / 1000) : null;
    $("attendanceRecords").innerHTML = `<div class="panel-heading"><div><h2>${state.selectedDate}</h2><p>${complete ? "上下班均已打卡" : current.clockIn ? "已上班打卡，待下班打卡" : "尚未上班打卡"}</p></div><span class="badge">${complete ? C.duration(duration) : current.clockIn ? "进行中" : "未打卡"}</span></div><div class="work-detail-grid">${recordCard("上班打卡", current.clockIn)}${recordCard("下班打卡", current.clockOut)}</div>`;
    const canAct = state.selectedDate === state.serverToday && !complete;
    $("attendanceAction").hidden = !canAct;
    if (canAct) { state.stage = "idle"; state.preview = null; stopCamera(); renderStage(); }
  }
  function renderStage(message = "") {
    const current = selected();
    const type = current.clockIn ? "CLOCK_OUT" : "CLOCK_IN";
    const label = type === "CLOCK_OUT" ? "下班打卡" : "上班打卡";
    $("attendanceActionTitle").textContent = label;
    $("attendanceMessage").textContent = message;
    if (!state.faceEnrolled) {
      $("attendanceActionState").textContent = "不可办理";
      $("attendanceStage").innerHTML = '<div class="empty-copy">当前账号未录入考勤人脸，可以查看历史记录，但暂时不能打卡。请联系总部重新扫脸。</div>';
      return;
    }
    if (state.stage === "idle") {
      $("attendanceActionState").textContent = "第一步";
      $("attendanceStage").innerHTML = `<div class="attendance-step"><b>第一步</b><span>读取并确认本次${label}的当前时间和地点</span></div><button id="attendanceLocate" type="button">获取${label}时间地点</button>`;
      $("attendanceLocate").addEventListener("click", locate);
      return;
    }
    if (state.stage === "confirm") {
      const row = state.preview;
      $("attendanceActionState").textContent = "第二步";
      $("attendanceStage").innerHTML = `<div class="attendance-step"><b>第二步</b><span>确认无误后再打开前置摄像头</span></div><dl class="location-grid"><dt>打卡类型</dt><dd>${label}</dd><dt>手机当前时间</dt><dd>${C.escapeHtml(row.checkedTime)}</dd><dt>附近地点</dt><dd>${C.escapeHtml(row.placeName || "暂未解析")}</dd><dt>具体地址</dt><dd>${C.escapeHtml(row.formattedAddress || "暂无文字地址")}</dd><dt>经纬度</dt><dd>${row.latitude.toFixed(6)}, ${row.longitude.toFixed(6)}</dd><dt>坐标类型</dt><dd>WGS84</dd><dt>定位精度</dt><dd>约 ${row.accuracy.toFixed(1)} 米</dd></dl>${mapBlock(row)}<div class="attendance-actions"><button id="attendanceRelocate" class="secondary-button" type="button">重新定位</button><button id="attendanceConfirmLocation" type="button">确认时间地点</button></div>`;
      $("attendanceRelocate").addEventListener("click", locate);
      $("attendanceConfirmLocation").addEventListener("click", confirmLocation);
      return;
    }
    $("attendanceActionState").textContent = "第三步";
    $("attendanceStage").innerHTML = `<div class="attendance-step"><b>第三步</b><span>由老师本人面对前置摄像头，完成人脸识别并提交${label}</span></div><div class="camera-shell"><video id="attendanceVideo" autoplay playsinline muted></video><div class="camera-note"><strong>${label} · ${C.escapeHtml(state.preview.checkedTime)}</strong><span>${C.escapeHtml(state.preview.placeName || state.preview.formattedAddress || "当前位置")}</span><span>现场照片只发送给人脸验证接口，验证结束后不保存。</span></div></div><div class="attendance-actions"><button id="attendanceRestart" class="secondary-button" type="button">重新确认时间地点</button><button id="attendanceSubmit" type="button">拍照验证并提交${label}</button></div>`;
    $("attendanceRestart").addEventListener("click", () => { stopCamera(); state.stage = "idle"; renderStage(); });
    $("attendanceSubmit").addEventListener("click", submit);
    if (!state.stream && !state.cameraStarting) startCamera();
  }
  async function locate() {
    if (!navigator.geolocation) return renderStage("当前浏览器不支持实时定位，无法打卡。请使用最新版 Safari、Chrome 或 Edge。 ");
    $("attendanceMessage").textContent = "正在获取实时位置…";
    navigator.geolocation.getCurrentPosition(async (position) => {
      const latitude = Number(position.coords.latitude), longitude = Number(position.coords.longitude), accuracy = Number(position.coords.accuracy);
      if (!Number.isFinite(accuracy) || accuracy <= 0 || accuracy > 500) return renderStage("当前位置精度超过 500 米，请打开精确定位并重试。");
      let readable = {};
      try { readable = await C.call("faceRecognition", "resolveTeacherAttendanceLocation", { latitude, longitude, accuracy, coordinateType: "WGS84" }); }
      catch (_) { readable = { warning: "附近地点暂时未能匹配，经纬度仍会保存。" }; }
      state.preview = { latitude, longitude, accuracy, checkedTime: C.localDateTime(), capturedAt: Date.now(), placeName: String(readable.placeName || ""), formattedAddress: String(readable.formattedAddress || ""), locationToken: String(readable.locationToken || "") };
      state.stage = "confirm";
      renderStage(readable.warning || "请核对时间、文字地址和地图位置。最终时间以服务端为准。");
    }, (error) => renderStage(error.code === 1 ? "位置权限被拒绝。请在浏览器网站设置中允许精确位置后重试。" : "无法读取实时位置，请确认系统定位已开启并重试。"), { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  }
  async function confirmLocation() {
    if (!state.preview || Date.now() - state.preview.capturedAt > 120000) { state.stage = "idle"; return renderStage("时间地点确认已超过 2 分钟，请重新获取。"); }
    state.stage = "face";
    renderStage("时间地点已确认，正在打开前置摄像头…");
  }
  async function startCamera() {
    const video = $("attendanceVideo");
    if (!video || !navigator.mediaDevices?.getUserMedia) {
      state.stage = "idle";
      return renderStage("当前浏览器不支持实时前置摄像头，无法打卡。");
    }
    state.cameraStarting = true;
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 1280 } }, audio: false });
      const currentVideo = $("attendanceVideo");
      if (currentVideo) currentVideo.srcObject = state.stream;
    } catch (_) {
      state.stage = "idle";
      renderStage("摄像头权限被拒绝。请在浏览器网站设置中允许摄像头后重试。");
    } finally {
      state.cameraStarting = false;
    }
  }
  function capture() {
    const video = $("attendanceVideo");
    if (!video?.videoWidth || !video?.videoHeight) throw new Error("前置摄像头尚未准备好，请稍候重试。");
    const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = $("attendanceCanvas");
    canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext("2d", { alpha: false }).drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", .86).split(",")[1];
  }
  async function submit() {
    if (!state.preview || Date.now() - state.preview.capturedAt > 120000) { stopCamera(); state.stage = "idle"; return renderStage("时间地点确认已超过 2 分钟，请重新获取。"); }
    const button = $("attendanceSubmit");
    button.disabled = true;
    $("attendanceMessage").textContent = "正在进行质量、活体和人脸 1:1 验证…";
    const type = selected().clockIn ? "CLOCK_OUT" : "CLOCK_IN";
    try {
      const result = await C.call("faceRecognition", "clockInTeacherAttendance", { attendanceType: type, imageBase64: capture(), latitude: state.preview.latitude, longitude: state.preview.longitude, accuracy: state.preview.accuracy, coordinateType: "WGS84", locationToken: state.preview.locationToken, devicePlatform: `WEB_${navigator.platform || "UNKNOWN"}`.slice(0, 30), clientRequestId: requestId(type) });
      if (!result.attendance?.id) throw new Error("服务端没有返回可确认的打卡记录。");
      localStorage.removeItem(`teacherAttendanceRequest:${state.serverToday}:${type}`);
      stopCamera();
      await loadMonth(state.serverToday.slice(0, 7), state.serverToday);
      $("attendanceMessage").textContent = result.idempotentReplay ? "该次打卡已经完成，已显示原记录。" : "打卡成功；现场照片未保存。";
    } catch (error) { $("attendanceMessage").textContent = error.message || "打卡失败。"; button.disabled = false; }
  }
  async function loadMonth(month, date) {
    try {
      const result = await C.call("staffAccount", "getOwnAttendanceMonth", { month });
      state.month = result.month; state.serverToday = result.serverToday; state.records = result.records || []; state.faceEnrolled = Boolean(result.faceEnrolled); state.selectedDate = date || result.serverToday;
      $("attendanceDate").max = result.serverToday; $("attendanceDate").value = state.selectedDate; $("attendanceDate").syncChineseDate?.(); renderRecords();
    } catch (error) { $("attendanceRecords").innerHTML = `<p class="form-message error">${C.escapeHtml(error.message || "考勤记录读取失败。")}</p>`; }
  }
  $("attendanceConfirmDate").addEventListener("click", () => { const date = $("attendanceDate").value; if (!date || date > state.serverToday) return; loadMonth(date.slice(0, 7), date); });
  window.addEventListener("pagehide", stopCamera);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  loadMonth(today.slice(0, 7), today);
})();
