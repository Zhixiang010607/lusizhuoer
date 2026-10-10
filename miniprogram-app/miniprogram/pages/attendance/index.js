const { callFace, callStaff } = require("../../services/api");
const { waitForStartupSession, requireSession } = require("../../services/session");

function pad(value) { return String(value).padStart(2, "0"); }
function localShanghaiDate() { const d = new Date(Date.now() + 8 * 3600000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; }
function localDeviceTime() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
function monthShift(month, amount) { const [y, m] = month.split("-").map(Number); const d = new Date(Date.UTC(y, m - 1 + amount, 1)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`; }
function cells(month, selected, today, dates) {
  const [y, m] = month.split("-").map(Number), total = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const blanks = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7, done = new Set(dates);
  const rows = Array.from({ length: blanks }, (_, i) => ({ key: `b${i}`, blank: true }));
  for (let day = 1; day <= total; day += 1) { const date = `${month}-${pad(day)}`; rows.push({ key: date, date, day, selected: date === selected, today: date === today, future: date > today, completed: done.has(date) }); }
  return rows;
}
function recordView(row) {
  if (!row || !row.id) return null;
  const latitude = Number(row.latitude), longitude = Number(row.longitude);
  const attendanceType = String(row.attendanceType || "CLOCK_IN");
  return { ...row, attendanceType, latitude, longitude, accuracy: Number(row.accuracy || 0),
    checkedTime: String(row.checkedInAt || "").replace("T", " ").slice(0, 19),
    typeLabel: attendanceType === "CLOCK_OUT" ? "下班打卡" : "上班打卡",
    markers: [{ id: attendanceType === "CLOCK_OUT" ? 2 : 1, latitude, longitude,
      title: attendanceType === "CLOCK_OUT" ? "下班打卡位置" : "上班打卡位置", width: 28, height: 28 }] };
}
function durationText(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60), rest = minutes % 60;
  if (hours && rest) return `${hours}小时${rest}分钟`;
  if (hours) return `${hours}小时`;
  return `${rest}分钟`;
}
function dayView(date, records) {
  const clockIn = records.find((row) => row.attendanceDate === date && row.attendanceType === "CLOCK_IN") || null;
  const clockOut = records.find((row) => row.attendanceDate === date && row.attendanceType === "CLOCK_OUT") || null;
  let seconds = null;
  if (clockIn && clockOut) seconds = Math.max(0, Math.floor((new Date(clockOut.checkedInAt).getTime() - new Date(clockIn.checkedInAt).getTime()) / 1000));
  return { attendanceDate: date, clockIn, clockOut, started: Boolean(clockIn), completed: Boolean(clockIn && clockOut), workDurationText: durationText(seconds) };
}
function requestId(date, attendanceType) {
  const key = `teacherAttendanceRequest:${date}:${attendanceType}`;
  let value = wx.getStorageSync(key);
  if (!value) { value = `attendance_${attendanceType.toLowerCase()}_${date.replace(/-/g, "")}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`.slice(0, 80); wx.setStorageSync(key, value); }
  return value;
}
function currentPlatform() {
  const info = typeof wx.getDeviceInfo === "function" ? wx.getDeviceInfo() : wx.getSystemInfoSync();
  const platform = String(info.platform || "").toLowerCase();
  if (String(info.deviceType || "").toLowerCase() === "pad" || /ipad/.test(String(info.model || "").toLowerCase())) return "IPAD";
  if (platform === "ios") return "IOS";
  if (platform === "android") return "ANDROID";
  return "OTHER";
}
function locationError(message, code, permissionAction = "") {
  const error = new Error(message); error.code = code; error.permissionAction = permissionAction; return error;
}
function locationDetail(error) { return String(error?.errMsg || error?.message || error?.code || "").toLowerCase(); }
function locationBlocked(error) {
  return /auth deny|authorize.*fail|permission|scope\.userlocation|system.*denied|locationswitchoff|location.?service.*off|gps.*off/.test(locationDetail(error));
}
function getSetting() { return new Promise((resolve, reject) => wx.getSetting({ success: resolve, fail: reject })); }
function authorizeLocation() { return new Promise((resolve, reject) => wx.authorize({ scope: "scope.userLocation", success: resolve, fail: reject })); }
function requireLocationPrivacyAuthorization() {
  if (typeof wx.requirePrivacyAuthorize !== "function") return Promise.resolve();
  return new Promise((resolve, reject) => wx.requirePrivacyAuthorize({
    success: resolve,
    fail: (error) => reject(locationError(
      "需要先同意本小程序的隐私保护指引，才能读取打卡位置。请重新授权后继续。",
      "WECHAT_PRIVACY_AUTHORIZATION_REQUIRED",
      "privacy"
    ))
  }));
}
function requestLocation(type, highAccuracy) {
  return new Promise((resolve, reject) => wx.getLocation({ type, isHighAccuracy: highAccuracy, highAccuracyExpireTime: highAccuracy ? 8000 : 5000,
    success: (result) => resolve({ ...result, coordinateType: type }), fail: reject }));
}
async function ensureLocationPermission() {
  const system = typeof wx.getSystemSetting === "function" ? wx.getSystemSetting() : {};
  if (system?.locationEnabled === false) throw locationError("手机系统定位服务未开启。请先打开系统定位服务。", "LOCATION_SERVICE_OFF", "system");
  const app = typeof wx.getAppAuthorizeSetting === "function" ? wx.getAppAuthorizeSetting() : {};
  if (String(app?.locationAuthorized || "").toLowerCase() === "denied") {
    throw locationError("手机没有允许微信使用位置。请在手机设置中允许微信使用定位，并开启精确位置。", "SYSTEM_LOCATION_PERMISSION_DENIED", "system");
  }
  const setting = await getSetting();
  const granted = setting?.authSetting?.["scope.userLocation"];
  if (granted === false) throw locationError("微信小程序位置权限未开启。请允许本小程序使用位置。", "WECHAT_LOCATION_PERMISSION_DENIED", "wechat");
  if (granted !== true) {
    try { await authorizeLocation(); }
    catch (_) { throw locationError("微信小程序位置权限未开启。请允许本小程序使用位置。", "WECHAT_LOCATION_PERMISSION_DENIED", "wechat"); }
  }
}
async function locate() {
  await requireLocationPrivacyAuthorization();
  await ensureLocationPermission();
  try { return await requestLocation("gcj02", true); }
  catch (primary) {
    if (locationBlocked(primary)) throw primary;
    try { return await requestLocation("wgs84", false); }
    catch (fallback) { fallback.primaryLocationError = locationDetail(primary); throw fallback; }
  }
}
function locationProblem(error) {
  if (error?.permissionAction) return { message: error.message, code: error.code, action: error.permissionAction };
  const detail = locationDetail(error);
  if (/privacy|隐私/.test(detail)) return { message: "需要先同意本小程序的隐私保护指引，才能读取打卡位置。请重新授权后继续。", code: "WECHAT_PRIVACY_AUTHORIZATION_REQUIRED", action: "privacy" };
  if (/auth deny|authorize.*fail|scope\.userlocation/.test(detail)) return { message: "微信小程序位置权限未开启。请允许本小程序使用位置。", code: "WECHAT_LOCATION_PERMISSION_DENIED", action: "wechat" };
  if (/permission|system.*denied/.test(detail)) return { message: "手机没有允许微信使用位置。请到手机设置中允许微信定位，并开启精确位置。", code: "SYSTEM_LOCATION_PERMISSION_DENIED", action: "system" };
  if (/locationswitchoff|location.?service.*off|gps.*off|nocell.*wifi/.test(detail)) return { message: "手机定位服务不可用。请打开系统定位、Wi‑Fi 和精确位置后重试。", code: "LOCATION_SERVICE_OFF", action: "system" };
  if (/timeout/.test(detail)) return { message: "定位超时。请靠近窗边或室外，并确认手机定位和网络可用后重试。", code: "LOCATION_TIMEOUT", action: "" };
  if (/network|connect/.test(detail)) return { message: "定位网络暂时不可用，请检查网络后重试。", code: "LOCATION_NETWORK_ERROR", action: "" };
  return { message: "暂时无法取得当前位置。已尝试境外兼容定位，请确认手机定位、精确位置和网络均已开启后重试。", code: "LOCATION_UNAVAILABLE", action: "" };
}

Page({
  data: { authorized: false, loading: true, locating: false, clocking: false, captureReady: false, faceEnrolled: false,
    message: "", error: false, permissionDenied: false, permissionAction: "", locationErrorCode: "", serverToday: "", visibleMonth: "", selectedDate: "", pendingDate: "", canNextMonth: false,
    calendarCells: [], selectedAttendance: { clockIn: null, clockOut: null, started: false, completed: false, workDurationText: "—" },
    todayAttendance: { clockIn: null, clockOut: null, started: false, completed: false, workDurationText: "—" },
    pendingAttendanceType: "", pendingAttendanceLabel: "", checkInStage: "idle", locationPreview: null },
  async onLoad() {
    this._unloaded = false;
    const today = localShanghaiDate();
    this.setData({ serverToday: today, visibleMonth: today.slice(0, 7), selectedDate: today, pendingDate: today });
    await waitForStartupSession();
    if (this._unloaded || !requireSession(["teacher"])) return;
    this.setData({ authorized: true });
    await this.loadMonth(today.slice(0, 7), today);
  },
  onShow() {
    if (!this._resumeLocationAfterSettings) return;
    this._resumeLocationAfterSettings = false;
    setTimeout(() => {
      if (this.data.authorized && !this.data.loading && !this.data.locating && !this.data.clocking && !this.data.todayAttendance?.completed) this.prepareCheckIn();
    }, 250);
  },
  onUnload() { this._unloaded = true; this._epoch = (this._epoch || 0) + 1; },
  onPullDownRefresh() { this.loadMonth(this.data.visibleMonth, this.data.selectedDate).finally(() => wx.stopPullDownRefresh()); },
  back() { if (getCurrentPages().length > 1) wx.navigateBack(); else wx.reLaunch({ url: "/pages/home/index" }); },
  captureChanged(event) { this.setData({ captureReady: event.detail.ready === true, message: "", error: false }); },
  async loadMonth(month, preferredDate) {
    const epoch = this._epoch = (this._epoch || 0) + 1;
    this.setData({ loading: true, message: "正在读取考勤记录…", error: false });
    try {
      const result = await callStaff("getOwnAttendanceMonth", { month });
      if (this._unloaded || epoch !== this._epoch) return;
      const today = String(result.serverToday || localShanghaiDate()), visibleMonth = String(result.month || month);
      let selected = preferredDate && preferredDate.startsWith(visibleMonth) ? preferredDate : visibleMonth === today.slice(0, 7) ? today : `${visibleMonth}-01`;
      if (selected > today) selected = today;
      this._records = (result.records || []).map(recordView);
      const selectedAttendance = dayView(selected, this._records);
      const todayAttendance = dayView(today, this._records);
      this.setData({ serverToday: today, visibleMonth, selectedDate: selected, pendingDate: selected, faceEnrolled: result.faceEnrolled === true,
        selectedAttendance, todayAttendance, canNextMonth: monthShift(visibleMonth, 1) <= today.slice(0, 7),
        calendarCells: cells(visibleMonth, selected, today, this._records.map((row) => row.attendanceDate)),
        pendingAttendanceType: "", pendingAttendanceLabel: "", checkInStage: "idle", locationPreview: null, captureReady: false, message: "", error: false });
    } catch (error) { if (!this._unloaded && epoch === this._epoch) this.setData({ message: error.message || "考勤读取失败", error: true }); }
    finally { if (!this._unloaded && epoch === this._epoch) this.setData({ loading: false }); }
  },
  selectDate(event) { const date = String(event.currentTarget.dataset.date || ""); if (!date || date > this.data.serverToday || this.data.loading) return; this.setData({ selectedDate: date, selectedAttendance: dayView(date, this._records || []), calendarCells: cells(this.data.visibleMonth, date, this.data.serverToday, (this._records || []).map((row) => row.attendanceDate)) }); },
  previousMonth() { return !this.data.loading && this.loadMonth(monthShift(this.data.visibleMonth, -1), ""); },
  nextMonth() { const next = monthShift(this.data.visibleMonth, 1); if (!this.data.loading && next <= this.data.serverToday.slice(0, 7)) return this.loadMonth(next, ""); },
  chooseMonth(event) { const month = String(event.detail.value || "").slice(0, 7); if (/^\d{4}-\d{2}$/.test(month) && month <= this.data.serverToday.slice(0, 7)) return this.loadMonth(month, ""); },
  chooseDate(event) { const date = String(event.detail.value || ""); if (/^\d{4}-\d{2}-\d{2}$/.test(date) && date <= this.data.serverToday) this.setData({ pendingDate: date }); },
  confirmDate() { const date = String(this.data.pendingDate || ""); if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > this.data.serverToday || this.data.loading || this.data.clocking) return; if (date.slice(0, 7) !== this.data.visibleMonth) return this.loadMonth(date.slice(0, 7), date); this.setData({ selectedDate: date, selectedAttendance: dayView(date, this._records || []) }); },
  today() { return !this.data.loading && this.loadMonth(this.data.serverToday.slice(0, 7), this.data.serverToday); },
  openSettings() {
    if (this.data.permissionAction === "system" && typeof wx.openAppAuthorizeSetting === "function") {
      this._resumeLocationAfterSettings = true;
      wx.openAppAuthorizeSetting({
        success: () => this.setData({ message: "请在手机设置中允许微信使用位置并开启精确位置，返回后重新获取。", error: false }),
        fail: () => { this._resumeLocationAfterSettings = false; this.setData({ message: "请手动打开手机设置，允许微信使用位置并开启精确位置。", error: true }); }
      });
      return;
    }
    wx.showModal({ title: "开启位置权限", content: "请在微信显示的权限设置中打开“位置信息”。如果设置页仍没有这一项，请返回后点击“重新请求定位授权”。", confirmText: "去设置", success: (choice) => {
      if (!choice.confirm) return;
      this._resumeLocationAfterSettings = true;
      wx.openSetting({ success: (result) => {
        const granted = result?.authSetting?.["scope.userLocation"] === true;
        this._resumeLocationAfterSettings = false;
        this.setData({ permissionDenied: !granted, permissionAction: granted ? "" : "wechat", message: granted ? "位置权限已开启，正在重新定位…" : "当前权限设置里仍没有可用的“位置信息”。请返回后点击“重新请求定位授权”；若仍失败，需要管理员检查小程序隐私保护指引。", error: !granted });
        if (granted) setTimeout(() => this.prepareCheckIn(), 0);
      }, fail: () => { this._resumeLocationAfterSettings = false; this.setData({ message: "微信没有打开小程序权限设置。请先点击“重新请求定位授权”；若仍失败，需要管理员检查小程序隐私保护指引。", error: true }); } });
    } });
  },
  retryLocationAuthorization() { this.prepareCheckIn(); },
  retryPrivacyAuthorization() { this.prepareCheckIn(); },
  openPrivacyContract() {
    if (typeof wx.openPrivacyContract === "function") {
      wx.openPrivacyContract({
        fail: () => wx.showModal({ title: "隐私保护指引", content: "暂时无法打开隐私保护指引，请更新微信后再试。", showCancel: false })
      });
      return;
    }
    wx.showModal({ title: "隐私保护指引", content: "当前微信版本不支持直接打开隐私保护指引，请先更新微信后再试。", showCancel: false });
  },
  openSystemLocationSettings() {
    this._resumeLocationAfterSettings = true;
    if (typeof wx.openAppAuthorizeSetting === "function") {
      wx.openAppAuthorizeSetting({
        success: () => this.setData({ message: "请允许微信使用位置并打开精确位置；返回后会自动重新定位。", error: false }),
        fail: () => { this._resumeLocationAfterSettings = false; wx.showModal({ title: "打开系统定位", content: "iPhone：设置 → 隐私与安全性 → 定位服务 → 微信 → 使用 App 期间，并打开精确位置。\n\nAndroid：设置 → 应用 → 微信 → 权限 → 位置信息 → 仅使用期间允许，并允许精确位置。", showCancel: false }); }
      });
      return;
    }
    this._resumeLocationAfterSettings = false;
    wx.showModal({ title: "打开系统定位", content: "iPhone：设置 → 隐私与安全性 → 定位服务 → 微信 → 使用 App 期间，并打开精确位置。\n\nAndroid：设置 → 应用 → 微信 → 权限 → 位置信息 → 仅使用期间允许，并允许精确位置。", showCancel: false });
  },
  openLocation(event) { const kind = String(event.currentTarget.dataset.kind || "clockIn"), row = this.data.selectedAttendance?.[kind]; if (row) wx.openLocation({ latitude: row.latitude, longitude: row.longitude, scale: 18, name: row.typeLabel, address: `定位精度约 ${row.accuracy} 米` }); },
  openPreviewLocation() { const row = this.data.locationPreview; if (row) wx.openLocation({ latitude: row.latitude, longitude: row.longitude, scale: 18, name: "待确认打卡位置", address: `定位精度约 ${row.accuracy} 米` }); },
  async prepareCheckIn() {
    if (this.data.loading || this.data.locating || this.data.clocking || this.data.todayAttendance?.completed) return;
    if (!this.data.faceEnrolled) return this.setData({ message: "当前账号未录入考勤人脸，可以查看考勤记录，但暂时不能打卡。", error: true });
    const pendingAttendanceType = this.data.todayAttendance?.clockIn ? "CLOCK_OUT" : "CLOCK_IN";
    const pendingAttendanceLabel = pendingAttendanceType === "CLOCK_OUT" ? "下班打卡" : "上班打卡";
    this.setData({ locating: true, pendingAttendanceType, pendingAttendanceLabel, permissionDenied: false, permissionAction: "", locationErrorCode: "", message: `正在获取${pendingAttendanceLabel}的当前时间和位置…`, error: false, checkInStage: "idle", locationPreview: null, captureReady: false });
    try {
      const location = await locate();
      const latitude = Number(location.latitude), longitude = Number(location.longitude), accuracy = Number(location.accuracy || 0);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw Object.assign(new Error("微信没有返回有效位置，请打开精确定位后重试。"), { code: "LOCATION_INVALID" });
      if (!Number.isFinite(accuracy) || accuracy <= 0 || accuracy > 500) throw Object.assign(new Error("当前位置精度超过 500 米，请打开系统精确定位并靠近 Wi‑Fi 或室外后重试。"), { code: "LOCATION_INACCURATE" });
      const capturedAtMs = Date.now();
      this.setData({
        checkInStage: "confirm",
        locationPreview: {
          latitude, longitude, accuracy, capturedAtMs,
          checkedTime: localDeviceTime(),
          coordinateText: `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`,
          coordinateType: String(location.coordinateType || "gcj02").toUpperCase(),
          markers: [{ id: 1, latitude, longitude, title: `待确认${pendingAttendanceLabel}位置`, width: 28, height: 28 }]
        },
        message: "请确认时间和地图位置；最终打卡时间以服务端记录为准。", error: false
      });
    } catch (error) {
      const problem = locationProblem(error);
      this.setData({ permissionDenied: Boolean(problem.action), permissionAction: problem.action, locationErrorCode: problem.code, message: problem.message, error: true });
    } finally { if (!this._unloaded) this.setData({ locating: false }); }
  },
  confirmCheckInContext() {
    const preview = this.data.locationPreview;
    if (!preview || Date.now() - Number(preview.capturedAtMs || 0) > 120000) {
      return this.setData({ checkInStage: "idle", locationPreview: null, message: "时间地点确认已超过 2 分钟，请重新获取。", error: true });
    }
    this.setData({ checkInStage: "face", captureReady: false, message: "时间地点已确认，请由老师本人现场拍照并完成人脸识别。", error: false });
  },
  resetCheckInContext() { if (!this.data.clocking) this.setData({ checkInStage: "idle", locationPreview: null, captureReady: false, message: `请重新获取并确认${this.data.pendingAttendanceLabel || "打卡"}的当前时间地点。`, error: false }); },
  async clockIn() {
    if (this.data.clocking || this.data.todayAttendance?.completed) return;
    if (!this.data.faceEnrolled) {
      return this.setData({ message: "当前账号未录入考勤人脸，可以查看考勤记录，但暂时不能打卡。", error: true });
    }
    const preview = this.data.locationPreview;
    if (this.data.checkInStage !== "face" || !preview) return this.setData({ message: "请先获取并确认当前时间地点。", error: true });
    if (Date.now() - Number(preview.capturedAtMs || 0) > 120000) return this.setData({ checkInStage: "idle", locationPreview: null, captureReady: false, message: "时间地点确认已超过 2 分钟，请重新获取。", error: true });
    const camera = this.selectComponent("#attendanceCamera"), capture = camera && camera.getCapture();
    if (!capture) return this.setData({ message: "请先由老师本人使用前置摄像头现场拍照。", error: true });
    this.setData({ clocking: true, permissionDenied: false, message: "正在进行照片质量、活体和 1:1 人脸验证…", error: false });
    try {
      const attendanceType = this.data.pendingAttendanceType || (this.data.todayAttendance?.clockIn ? "CLOCK_OUT" : "CLOCK_IN");
      const attendanceLabel = attendanceType === "CLOCK_OUT" ? "下班打卡" : "上班打卡";
      const result = await callFace("clockInTeacherAttendance", { attendanceType, imageBase64: capture.imageBase64,
        latitude: preview.latitude, longitude: preview.longitude, accuracy: preview.accuracy,
        devicePlatform: currentPlatform(), clientRequestId: requestId(this.data.serverToday, attendanceType) });
      if (!result.attendance?.id) throw new Error("服务端没有返回可确认的打卡记录。");
      wx.removeStorageSync(`teacherAttendanceRequest:${this.data.serverToday}:${attendanceType}`);
      camera.reset();
      await this.loadMonth(this.data.serverToday.slice(0, 7), this.data.serverToday);
      this.setData({ message: result.idempotentReplay ? `${attendanceLabel}已经完成，已显示原记录。` : `${attendanceLabel}成功；现场照片未保存。`, error: false });
    } catch (error) {
      this.setData({ message: error.message || "打卡失败", error: true });
    } finally { if (!this._unloaded) this.setData({ clocking: false }); }
  }
});
