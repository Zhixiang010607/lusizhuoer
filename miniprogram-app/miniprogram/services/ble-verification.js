const { callFace } = require("./api");
const { readSession } = require("./session");

const STORAGE_PREFIX = "lusizhuoerMiniBleVerificationV1:";
const INFO_TIMEOUT_MS = 10000;
const AUTH_TIMEOUT_MS = 20000;
const DISCOVERY_TIMEOUT_MS = 15000;

function storageKey() {
  const session = readSession();
  if (!session || !session.uid) throw bleError("BLE_SESSION_EXPIRED", "登录状态已经失效，请重新登录后办理。");
  return `${STORAGE_PREFIX}${session.uid}`;
}

function readProgress() {
  const value = wx.getStorageSync(storageKey());
  return value && typeof value === "object" ? value : null;
}

function saveProgress(value) {
  wx.setStorageSync(storageKey(), { ...(value || {}), updatedAt: Date.now() });
  const saved = readProgress();
  if (!saved) throw bleError("BLE_PROGRESS_SAVE_FAILED", "无法保存设备办理进度，已禁止继续授权设备。");
  return saved;
}

function clearProgress() {
  wx.removeStorageSync(storageKey());
  return !readProgress();
}

function bleError(code, message, cause) {
  const error = new Error(message || "蓝牙设备操作失败");
  error.code = code || "BLE_UNKNOWN";
  error.cause = cause;
  return error;
}

function wxPromise(method, options = {}) {
  return new Promise((resolve, reject) => {
    if (typeof wx[method] !== "function") {
      reject(bleError("BLE_API_UNAVAILABLE", "当前微信版本不支持所需的蓝牙能力，请升级微信后重试。"));
      return;
    }
    wx[method]({
      ...options,
      success: resolve,
      fail: (cause) => reject(bleError(`WX_${method.toUpperCase()}_FAILED`, cause?.errMsg || `${method} 失败`, cause))
    });
  });
}

function normalizeQrText(value) {
  return String(value || "").trim().replace(/&amp;/gi, "&");
}

function parseDeviceQr(value) {
  const text = normalizeQrText(value);
  let match = text.match(/^nc:\/\/bind\?([^#]+)$/i);
  if (match) {
    const params = {};
    match[1].split("&").forEach((part) => {
      const index = part.indexOf("=");
      if (index <= 0) return;
      params[decodeURIComponent(part.slice(0, index)).toLowerCase()] = decodeURIComponent(part.slice(index + 1));
    });
    const sn = String(params.sn || "").trim().toUpperCase();
    const code = String(params.code || "").trim();
    if (/^NCM[0-9A-F]{11}$/.test(sn) && /^\d{6}$/.test(code)) return { sn, code };
  }
  match = text.match(/^(NCM[0-9A-F]{11})[\s,;|]+(\d{6})$/i);
  if (match) return { sn: match[1].toUpperCase(), code: match[2] };
  throw bleError("BLE_QR_INVALID", "这不是有效的设备二维码。请扫描设备机身上的 nc://bind 二维码。");
}

function utf8Encode(text) {
  const source = unescape(encodeURIComponent(String(text)));
  const bytes = new Uint8Array(source.length);
  for (let index = 0; index < source.length; index += 1) bytes[index] = source.charCodeAt(index);
  return bytes.buffer;
}

function utf8Decode(buffer) {
  const bytes = new Uint8Array(buffer || new ArrayBuffer(0));
  let binary = "";
  for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
  try { return decodeURIComponent(escape(binary)); } catch (_) { return binary; }
}

function deviceName(device) {
  return String(device?.name || device?.localName || "").trim();
}

function localProtocolError(payload) {
  const code = Number(payload?.code || payload?.error_code || 0);
  const messages = {
    400: "设备无法识别请求，请确认设备固件协议为 V2.0。",
    403: "设备拒绝本次授权。",
    404: "设备不支持本次命令。",
    1001: "设备判定授权签名无效。",
    1002: "设备授权已过期，请重新读取设备后授权。",
    1003: "设备随机数不一致，请重新连接设备。",
    1004: "设备随机数已经使用，禁止重复开机。",
    1005: "设备正在服务中，不能再次授权。",
    1006: "设备编号与二维码不一致。",
    1007: "设备类型与所选项目不匹配。",
    1008: "设备不支持进入工作状态命令。",
    1009: "设备尚未完成出厂登记。",
    1011: "本次核销次数不符合设备要求。"
  };
  return messages[code] || String(payload?.message || payload?.error || "设备返回未知错误");
}

class BleVerificationSession {
  constructor({ qualification, clientRequestId, onState, onIrreversible }) {
    this.qualification = qualification || {};
    this.clientRequestId = String(clientRequestId || "");
    this.onState = typeof onState === "function" ? onState : () => {};
    this.onIrreversible = typeof onIrreversible === "function" ? onIrreversible : () => {};
    this.deviceId = "";
    this.serviceId = "";
    this.writeCharacteristicId = "";
    this.notifyCharacteristicId = "";
    this.receiveBuffer = "";
    this.waiters = [];
    this.cancelled = false;
    this.authorizationSent = false;
    this.discoveryFinish = null;
    this.valueHandler = this.handleValue.bind(this);
  }

  state(stage, message, extra = {}) {
    this.onState({ stage, message, ...extra });
  }

  async scanQr() {
    this.state("QR_SCANNING", "请扫描设备机身二维码");
    let result;
    try {
      result = await wxPromise("scanCode", { scanType: ["qrCode"], onlyFromCamera: false });
    } catch (error) {
      if (/cancel/i.test(String(error?.message || ""))) throw bleError("BLE_QR_CANCELLED", "已关闭扫码；90 秒内可重新打开继续。", error);
      throw bleError("BLE_QR_SCAN_FAILED", "无法读取设备二维码，请检查相机权限后重试。", error);
    }
    return parseDeviceQr(result.result);
  }

  async openAdapter() {
    this.state("ADAPTER_OPENING", "正在开启蓝牙");
    try {
      await wxPromise("openBluetoothAdapter", { mode: "central" });
    } catch (error) {
      const text = String(error?.message || "");
      if (/10001|not available/i.test(text)) throw bleError("BLE_SWITCH_OFF", "手机蓝牙尚未开启，请在系统设置中开启蓝牙后重试。", error);
      if (/10000|not init/i.test(text)) throw bleError("BLE_ADAPTER_INIT_FAILED", "蓝牙适配器初始化失败，请关闭微信后重新打开。", error);
      throw bleError("BLE_ADAPTER_OPEN_FAILED", "无法开启蓝牙，请检查微信蓝牙权限。", error);
    }
  }

  async discover(qr) {
    const expectedName = `NCM-${qr.sn.slice(-6)}`;
    this.state("DEVICE_DISCOVERING", `正在查找 ${expectedName}`);
    await wxPromise("startBluetoothDevicesDiscovery", { allowDuplicatesKey: false, powerLevel: "high" });
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, device) => {
        if (settled) return;
        settled = true;
        this.discoveryFinish = null;
        clearTimeout(timer);
        if (typeof wx.offBluetoothDeviceFound === "function") wx.offBluetoothDeviceFound(handler);
        wx.stopBluetoothDevicesDiscovery({ complete: () => {} });
        if (error) reject(error); else resolve(device);
      };
      const handler = (event) => {
        const devices = Array.isArray(event?.devices) ? event.devices : [];
        const found = devices.find((item) => deviceName(item) === expectedName);
        if (found) finish(null, found);
      };
      const timer = setTimeout(() => finish(bleError("BLE_DEVICE_NOT_FOUND", `15 秒内没有找到 ${expectedName}。请靠近设备并确认设备已开机。`)), DISCOVERY_TIMEOUT_MS);
      this.discoveryFinish = finish;
      wx.onBluetoothDeviceFound(handler);
      if (this.cancelled) finish(bleError("BLE_WINDOW_CLOSED", "二维码窗口已关闭；资格仍然保留。"));
    });
  }

  async connect(device) {
    this.deviceId = String(device.deviceId || "");
    if (!this.deviceId) throw bleError("BLE_DEVICE_ID_EMPTY", "微信没有返回蓝牙设备标识，请重新扫描。");
    this.state("DEVICE_CONNECTING", "正在连接设备");
    try {
      await wxPromise("createBLEConnection", { deviceId: this.deviceId, timeout: 12000 });
    } catch (error) {
      throw bleError("BLE_CONNECTION_FAILED", "设备连接失败。请靠近设备、确认未被其他手机连接后重试。", error);
    }
  }

  async discoverProtocol() {
    this.state("PROTOCOL_DISCOVERING", "正在识别设备通信通道");
    const serviceResult = await wxPromise("getBLEDeviceServices", { deviceId: this.deviceId });
    const services = (serviceResult.services || []).filter((service) => service.isPrimary !== false);
    const candidates = [];
    for (const service of services) {
      const result = await wxPromise("getBLEDeviceCharacteristics", { deviceId: this.deviceId, serviceId: service.uuid });
      const characteristics = result.characteristics || [];
      const writes = characteristics.filter((item) => item.properties?.write || item.properties?.writeNoResponse);
      const notifies = characteristics.filter((item) => item.properties?.notify || item.properties?.indicate);
      if (writes.length && notifies.length) candidates.push({ service, writes, notifies });
    }
    if (!candidates.length) throw bleError("BLE_PROTOCOL_CHANNEL_MISSING", "设备没有同时支持写入和通知的通信服务，请检查设备固件。");
    if (candidates.length > 1) throw bleError("BLE_PROTOCOL_CHANNEL_AMBIGUOUS", "设备存在多个可用通信服务，无法安全判断目标通道，请升级设备固件明确唯一通道。");
    const selected = candidates[0];
    this.serviceId = selected.service.uuid;
    this.writeCharacteristicId = (selected.writes.find((item) => item.properties?.write) || selected.writes[0]).uuid;
    this.notifyCharacteristicId = (selected.notifies.find((item) => item.properties?.notify) || selected.notifies[0]).uuid;
    if (typeof wx.onBLECharacteristicValueChange === "function") wx.onBLECharacteristicValueChange(this.valueHandler);
    await wxPromise("notifyBLECharacteristicValueChange", {
      deviceId: this.deviceId,
      serviceId: this.serviceId,
      characteristicId: this.notifyCharacteristicId,
      state: true
    });
  }

  handleValue(event) {
    if (String(event?.deviceId || "") !== this.deviceId) return;
    if (String(event?.characteristicId || "").toLowerCase() !== this.notifyCharacteristicId.toLowerCase()) return;
    this.receiveBuffer += utf8Decode(event.value);
    let newline = this.receiveBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.receiveBuffer.slice(0, newline).trim();
      this.receiveBuffer = this.receiveBuffer.slice(newline + 1);
      if (line) {
        try { this.dispatch(JSON.parse(line)); } catch (_) { this.state("PROTOCOL_WARNING", "设备返回了无法解析的数据，正在等待有效回执"); }
      }
      newline = this.receiveBuffer.indexOf("\n");
    }
  }

  dispatch(payload) {
    const index = this.waiters.findIndex((waiter) => waiter.predicate(payload));
    if (index < 0) return;
    const waiter = this.waiters.splice(index, 1)[0];
    clearTimeout(waiter.timer);
    waiter.resolve(payload);
  }

  waitFor(predicate, timeout, code, message) {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(bleError(code, message));
      }, timeout);
      this.waiters.push(waiter);
    });
  }

  async write(payload) {
    const value = utf8Encode(`${JSON.stringify(payload)}\n`);
    try {
      await wxPromise("writeBLECharacteristicValue", {
        deviceId: this.deviceId,
        serviceId: this.serviceId,
        characteristicId: this.writeCharacteristicId,
        value
      });
    } catch (error) {
      throw bleError("BLE_WRITE_FAILED", "向设备发送指令失败，请保持靠近设备后重试。", error);
    }
  }

  async readInfo() {
    this.state("DEVICE_READING", "正在读取设备状态");
    const waiting = this.waitFor(
      (payload) => ["info", "get_info_result"].includes(String(payload?.cmd || payload?.type || "").toLowerCase())
        && Number(payload?.seq) === 1,
      INFO_TIMEOUT_MS,
      "BLE_INFO_TIMEOUT",
      "设备在 10 秒内没有返回状态，请重新连接设备。"
    );
    await this.write({
      ver: "1.0",
      seq: 1,
      cmd: "get_info",
      ts: Math.floor(Date.now() / 1000)
    });
    const info = await waiting;
    if (info.ok === false || info.error || Number(info.code || 0) >= 400) throw bleError(`BLE_DEVICE_${info.code || "ERROR"}`, localProtocolError(info));
    return info;
  }

  validateInfo(qr, info) {
    const id = String(info.device_id || info.deviceId || "").trim().toUpperCase();
    const type = String(info.device_type || info.deviceType || "").trim().toLowerCase();
    const name = String(info.ble_name || info.bleName || "").trim();
    const nonce = String(info.nonce || "").trim();
    if (id !== qr.sn) throw bleError("BLE_DEVICE_ID_MISMATCH", "蓝牙设备编号与二维码编号不一致，禁止授权。");
    if (type !== String(this.qualification.expectedDeviceType || "").toLowerCase()) {
      throw bleError("BLE_DEVICE_TYPE_MISMATCH", `当前设备类型为 ${type || "未知"}，本次项目需要 ${this.qualification.expectedDeviceType}。`);
    }
    if (name !== `NCM-${qr.sn.slice(-6)}`) throw bleError("BLE_NAME_MISMATCH", "蓝牙设备名称与二维码编号不一致，禁止授权。");
    if (![1, 2].includes(Number(info.status))) throw bleError("BLE_DEVICE_NOT_READY", "设备未进入待机状态，请先在设备端完成复位。");
    if (!/^[0-9a-f]{32}$/i.test(nonce)) throw bleError("BLE_NONCE_INVALID", "设备没有返回有效的 32 位随机数，禁止授权。");
    return { device_id: id, device_type: type, ble_name: name, status: Number(info.status), nonce };
  }

  async queryWorking(fallbackInfo) {
    const waiting = this.waitFor(
      (payload) => String(payload?.cmd || payload?.type || "").toLowerCase() === "status"
        && Number(payload?.seq) === 3,
      5000,
      "BLE_STATUS_TIMEOUT",
      "无法确认设备是否已启动。"
    );
    await this.write({ ver: "1.0", seq: 3, cmd: "query_status" });
    const status = await waiting;
    return Number(status.status) === 2 ? { ...fallbackInfo, ...status, ok: true, status: 2 } : null;
  }

  async finalize(authorizationToken, deviceResult) {
    const receipt = {
      clientRequestId: this.clientRequestId,
      qualificationToken: this.qualification.qualificationToken,
      qualificationExpiresAt: this.qualification.expiresAt,
      authorizationToken,
      deviceResult,
      irreversible: true,
      state: "DEVICE_WORKING"
    };
    saveProgress(receipt);
    this.onIrreversible(receipt);
    this.state("FINALIZING", "设备已进入工作状态，正在生成核销工单；请勿重复扫码", { irreversible: true });
    const result = await callFace("confirmVerificationBleWorkStarted", { authorizationToken, deviceResult });
    saveProgress({ ...receipt, state: "FINALIZED", verificationId: result.verificationId, verificationCode: result.verificationCode });
    return result;
  }

  async run() {
    let qr;
    let info;
    let authorizationToken = "";
    try {
      qr = await this.scanQr();
      if (this.cancelled) throw bleError("BLE_WINDOW_CLOSED", "二维码窗口已关闭；资格仍然保留。");
      await this.openAdapter();
      const device = await this.discover(qr);
      await this.connect(device);
      await this.discoverProtocol();
      info = this.validateInfo(qr, await this.readInfo());

      const previous = readProgress();
      if (info.status === 2) {
        if (!previous?.authorizationToken || String(previous.deviceId || previous.deviceResult?.device_id || "").toUpperCase() !== info.device_id) {
          throw bleError("BLE_DEVICE_BUSY_OTHER_SESSION", "设备正在服务中，但本机没有对应授权记录，禁止生成核销工单。");
        }
        const receipt = { ...info, ...previous.deviceResult, ok: true, status: 2 };
        return await this.finalize(previous.authorizationToken, receipt);
      }

      const sameQualification = previous?.authorizationToken
        && String(previous.qualificationToken || "") === String(this.qualification.qualificationToken || "");
      if (sameQualification) {
        const previousDeviceId = String(previous.deviceId || previous.deviceResult?.device_id || "").toUpperCase();
        if (previousDeviceId && previousDeviceId !== info.device_id) {
          throw bleError("BLE_AUTHORIZATION_DEVICE_LOCKED", "这次人脸资格已经绑定另一台设备，禁止更换设备或重复开机。");
        }
        throw bleError("BLE_AUTHORIZATION_ALREADY_ISSUED", "一次性设备授权已经签发；设备仍为待机状态，不能再次发送开机授权。");
      }

      this.state("SERVER_AUTHORIZING", "正在向服务端申请一次性设备授权");
      const issued = await callFace("issueVerificationBleAuthorization", {
        qualificationToken: this.qualification.qualificationToken,
        qrSn: qr.sn,
        qrCode: qr.code,
        deviceInfo: info
      });
      authorizationToken = String(issued.authorizationToken || "");
      if (!authorizationToken || !issued.authCommand) throw bleError("BLE_AUTHORIZATION_INCOMPLETE", "服务端没有返回完整设备授权，禁止开机。");
      saveProgress({
        clientRequestId: this.clientRequestId,
        qualificationToken: this.qualification.qualificationToken,
        qualificationExpiresAt: this.qualification.expiresAt,
        authorizationToken,
        deviceId: info.device_id,
        deviceType: info.device_type,
        nonce: info.nonce,
        state: "AUTHORIZATION_ISSUED",
        irreversible: false
      });

      this.state("DEVICE_AUTHORIZING", "正在授权设备进入工作状态");
      const waiting = this.waitFor(
        (payload) => String(payload?.cmd || payload?.type || "").toLowerCase() === "auth_result"
          && Number(payload?.seq) === 2,
        AUTH_TIMEOUT_MS,
        "BLE_AUTH_RESULT_TIMEOUT",
        "设备在 20 秒内没有返回开机结果，正在核对设备实际状态。"
      );
      await this.write(issued.authCommand);
      this.authorizationSent = true;
      this.onIrreversible({ authorizationSent: true, permanent: false });
      let result;
      try {
        result = await waiting;
      } catch (error) {
        const recovered = await this.queryWorking(info).catch(() => null);
        if (!recovered) throw error;
        result = recovered;
      }
      if (result.ok !== true || Number(result.status) !== 2) {
        throw bleError(`BLE_DEVICE_${result.code || "REJECTED"}`, localProtocolError(result));
      }
      const receipt = {
        ...result,
        ok: true,
        status: 2,
        device_id: info.device_id,
        device_type: info.device_type,
        nonce: info.nonce
      };
      return await this.finalize(authorizationToken, receipt);
    } finally {
      await this.closeConnection();
    }
  }

  cancel() {
    this.cancelled = true;
    if (this.discoveryFinish) {
      this.discoveryFinish(bleError("BLE_WINDOW_CLOSED", "二维码窗口已关闭；90 秒资格仍然保留。"));
    }
    if (!this.authorizationSent) this.closeConnection();
  }

  async closeConnection() {
    this.waiters.splice(0).forEach((waiter) => {
      clearTimeout(waiter.timer);
      waiter.reject(bleError("BLE_CONNECTION_CLOSED", "蓝牙连接已关闭。"));
    });
    if (typeof wx.offBLECharacteristicValueChange === "function") wx.offBLECharacteristicValueChange(this.valueHandler);
    wx.stopBluetoothDevicesDiscovery({ complete: () => {} });
    if (this.deviceId) wx.closeBLEConnection({ deviceId: this.deviceId, complete: () => {} });
    wx.closeBluetoothAdapter({ complete: () => {} });
  }
}

function errorFeedback(error) {
  const code = String(error?.code || "BLE_UNKNOWN");
  const message = String(error?.message || "设备操作失败");
  const catalog = {
    BLE_QR_CANCELLED: ["扫码已关闭", "90 秒资格仍然有效，可重新打开二维码窗口继续。", true],
    BLE_WINDOW_CLOSED: ["窗口已关闭", "关闭窗口不会扣次；90 秒内可重新打开。", true],
    BLE_QR_INVALID: ["二维码不正确", "请扫描设备机身上的 nc://bind 二维码，不要扫描产品或客户二维码。", true],
    BLE_QR_SCAN_FAILED: ["无法使用相机扫码", "请在系统设置中允许微信使用相机，然后重新扫码。", true],
    BLE_API_UNAVAILABLE: ["微信版本不支持", "请升级微信与手机系统后重试；设备未启动，不会扣次。", false],
    BLE_SWITCH_OFF: ["手机蓝牙未开启", "请打开系统蓝牙，并允许微信使用蓝牙后重试。", true],
    BLE_ADAPTER_INIT_FAILED: ["蓝牙初始化失败", "请完全退出微信后重新打开；仍失败时重启手机。", true],
    BLE_ADAPTER_OPEN_FAILED: ["没有蓝牙权限", "请在系统设置中允许微信使用蓝牙，并确认系统蓝牙已开启。", true],
    BLE_DEVICE_NOT_FOUND: ["没有找到设备", "请靠近设备，确认设备已通电且未连接其他手机，再重新扫码。", true],
    BLE_CONNECTION_FAILED: ["设备连接失败", "请靠近设备并断开其他手机连接；稍后可在资格有效期内重试。", true],
    BLE_CONNECTION_CLOSED: ["蓝牙连接已断开", "请保持手机靠近设备并重新打开窗口；若设备已启动，系统会先恢复原工单。", true],
    BLE_PROTOCOL_CHANNEL_MISSING: ["设备通信通道缺失", "设备固件未提供写入与通知通道，请停止办理并联系设备技术人员。", false],
    BLE_PROTOCOL_CHANNEL_AMBIGUOUS: ["设备通信通道不唯一", "为防止写错设备通道，已拒绝开机；请升级设备固件。", false],
    BLE_INFO_TIMEOUT: ["读取设备超时", "请保持手机靠近设备并确认设备处于待机界面，然后重试。", true],
    BLE_WRITE_FAILED: ["指令发送失败", "请保持手机靠近设备；设备未确认进入工作状态前不会扣次。", true],
    BLE_STATUS_TIMEOUT: ["设备状态无法确认", "请勿立即重复办理。页面会优先核对原授权和工单，确认未启动后才能重试。", false],
    BLE_AUTH_RESULT_TIMEOUT: ["开机结果未返回", "请勿重复扫码。系统会查询设备实际状态；若设备已启动，将恢复原工单。", false],
    BLE_DEVICE_ID_EMPTY: ["设备标识缺失", "微信未返回蓝牙标识，请重新扫码连接。", true],
    BLE_DEVICE_ID_MISMATCH: ["设备编号不一致", "二维码与蓝牙设备不是同一台设备，已禁止授权；请检查机身标签。", false],
    BLE_DEVICE_TYPE_MISMATCH: ["设备类型不匹配", "该设备不适用于当前项目，请扫描与项目名称对应的设备。", false],
    BLE_NAME_MISMATCH: ["设备名称不匹配", "蓝牙广播名与设备编号不一致，已禁止授权；请联系设备技术人员。", false],
    BLE_NONCE_INVALID: ["设备随机数无效", "设备没有产生符合协议的一次性随机数，已禁止授权；请重启设备或升级固件。", false],
    BLE_DEVICE_NOT_READY: ["设备未处于待机状态", "请在设备端结束旧服务并恢复待机，再重新扫码。", true],
    BLE_DEVICE_BUSY_OTHER_SESSION: ["设备正在其他服务中", "本手机没有对应授权记录，禁止接管或重复扣次；请先结束设备当前服务。", false],
    BLE_DEVICE_NOT_PROVISIONED: ["设备尚未登记", "请由总部先在数据库登记设备编号、类型与二维码校验信息。", false],
    BLE_PROGRESS_SAVE_FAILED: ["无法保存防重复进度", "为避免设备启动后重复扣次，已禁止继续；请清理微信存储空间后重试。", false],
    BLE_SESSION_EXPIRED: ["登录状态已失效", "请重新登录后从原工单恢复入口继续，切勿重复发起核销。", false],
    BLE_AUTHORIZATION_INCOMPLETE: ["服务端授权不完整", "设备尚未获得完整开机指令，本次不会扣次；请联系管理员检查云函数。", false],
    BLE_AUTHORIZATION_ALREADY_ISSUED: ["一次性授权已经签发", "不能重复发送开机授权。请重新连接原设备核对状态；若设备仍待机，请等待本次 90 秒资格结束后重新做人脸验证。", false],
    BLE_AUTHORIZATION_DEVICE_LOCKED: ["资格已绑定原设备", "不能更换设备或重复开机。请连接原设备核对状态，或等待本次 90 秒资格结束后重新验证。", false],
    BLE_AUTHORIZATION_NOT_ACTIVE: ["一次性授权已失效", "禁止继续核销或重复开机，请检查原设备与原工单状态。", false],
    BLE_AUTHORIZATION_EXPIRED: ["设备开机授权已过期", "设备没有在一次性授权有效期内确认进入工作状态，本次没有核销；请检查设备状态后重新做人脸验证。", false],
    BLE_SIGNING_KEY_INVALID: ["设备签名密钥配置错误", "请管理员检查云函数 BLE_AUTH_SIGNING_KEY，聊天和代码仓库中不得传递密钥。", false],
    BLE_SCHEMA_MISSING: ["BLE 数据表尚未部署", "请管理员执行 066 BLE 数据库脚本后再办理。", false],
    BLE_QUALIFICATION_EXPIRED: ["90 秒资格已过期", "本次没有扣次，请重新拍照做人脸验证。", false],
    BLE_QUALIFICATION_INVALID: ["设备资格无效", "资格与当前登录身份或业务参数不一致，请重新办理。", false],
    BLE_QUALIFICATION_NOT_FOUND: ["未找到设备资格", "本次没有扣次，请重新拍照建立 90 秒资格。", false],
    BLE_QUALIFICATION_RACE: ["资格已被其他请求使用", "已禁止重复授权；请先检查原设备和原工单状态。", false],
    BLE_AUTHORIZATION_INVALID: ["一次性授权无效", "禁止继续开机，请检查原办理记录并联系管理员。", false],
    BLE_AUTHORIZATION_NOT_FOUND: ["未找到一次性授权", "禁止重复扫码；请先检查原设备是否已经启动。", false],
    BLE_NONCE_REUSED: ["设备随机数已经使用", "该随机数不能再次开机。请先检查是否已有对应工单，再让设备生成新随机数。", false],
    BLE_DEVICE_NOT_WORKING: ["设备尚未进入工作状态", "服务端不会扣次；请保持连接并等待设备明确返回工作状态。", true],
    BLE_DEVICE_RECEIPT_MISMATCH: ["设备回执不一致", "设备回执与原授权不一致，已禁止生成工单；请联系管理员核查。", false],
    BLE_ALREADY_FINALIZED: ["核销已完成", "原核销工单已经生成，禁止再次扫码或重复扣次。", false],
    FORBIDDEN: ["当前账号无权办理", "请使用已分配该门店权限的老师或门店账号。", false]
  };
  const deviceCodes = {
    BLE_DEVICE_400: ["设备请求格式错误", "设备无法识别 V2.0 指令，请检查固件协议。", false],
    BLE_DEVICE_403: ["设备拒绝授权", "请检查设备状态和授权签名；禁止重复提交。", false],
    BLE_DEVICE_404: ["设备不支持命令", "请升级到支持 V2.0 get_info/auth/query_status 的固件。", false],
    BLE_DEVICE_1001: ["设备判定签名无效", "请核对云函数签名密钥与设备内置公钥/密钥配置。", false],
    BLE_DEVICE_1002: ["设备授权已过期", "本次一次性开机授权已经过期，不能重复发送；请检查设备状态后重新做人脸验证。", false],
    BLE_DEVICE_1003: ["设备随机数不一致", "请断开后重新连接，让设备返回当前随机数。", true],
    BLE_DEVICE_1004: ["设备随机数已使用", "禁止重复开机；请先检查原工单，确认结束后生成新随机数。", false],
    BLE_DEVICE_1005: ["设备正在工作", "请勿重复开机；如果是本次授权，系统会恢复原工单。", false],
    BLE_DEVICE_1006: ["设备编号不一致", "二维码设备编号与固件编号不一致，请停止使用该设备。", false],
    BLE_DEVICE_1007: ["设备类型不匹配", "请改扫当前项目对应类型的设备。", false],
    BLE_DEVICE_1008: ["设备不支持工作命令", "请升级设备固件后再办理。", false],
    BLE_DEVICE_1009: ["设备未完成出厂登记", "请由总部登记设备后再办理。", false],
    BLE_DEVICE_1011: ["设备不接受本次次数", "请核对本次次数与设备协议限制；不要擅自改成固定 1 次。", false]
  };
  const selected = catalog[code] || deviceCodes[code];
  if (selected) return { code, message, title: selected[0], advice: selected[1], retryable: selected[2] };
  const wxFailure = code.startsWith("WX_");
  return {
    code,
    message,
    retryable: wxFailure,
    title: wxFailure ? "微信蓝牙接口调用失败" : "未识别的设备错误",
    advice: wxFailure
      ? "请检查微信相机、蓝牙和定位权限并重试；仍失败时截图错误代码联系技术人员。"
      : "请勿盲目重复扫码。保留此错误代码和时间，先检查设备是否已启动及是否已有工单。"
  };
}

async function retryFinalization(progress) {
  if (!progress?.authorizationToken || !progress?.deviceResult || Number(progress.deviceResult.status) !== 2) return null;
  return callFace("confirmVerificationBleWorkStarted", {
    authorizationToken: progress.authorizationToken,
    deviceResult: progress.deviceResult
  });
}

module.exports = {
  BleVerificationSession,
  parseDeviceQr,
  readProgress,
  saveProgress,
  clearProgress,
  retryFinalization,
  errorFeedback
};
