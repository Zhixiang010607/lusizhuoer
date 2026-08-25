function albumError(message, code = "ALBUM_PERMISSION_REQUIRED", cause) {
  const error = new Error(message);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function invoke(name, options = {}) {
  return new Promise((resolve, reject) => {
    if (!globalThis.wx || typeof wx[name] !== "function") {
      reject(albumError(`当前环境不支持 ${name}`, "ALBUM_API_UNAVAILABLE"));
      return;
    }
    wx[name]({ ...options, success: resolve, fail: reject });
  });
}

function isPermissionFailure(error) {
  return /auth|authorize|permission|scope\.writePhotosAlbum|用户拒绝|授权|权限/i
    .test(String(error?.errMsg || error?.message || ""));
}

async function currentPermission() {
  const setting = await invoke("getSetting");
  return setting?.authSetting?.["scope.writePhotosAlbum"];
}

async function askToOpenSettings() {
  const choice = await invoke("showModal", {
    title: "需要相册权限",
    content: "是否打开设置，允许露思卓儿把这张图片保存到系统相册？",
    confirmText: "打开设置",
    cancelText: "暂不"
  });
  if (!choice?.confirm) {
    throw albumError("未开启相册权限；下次点击保存时会再次询问。", "ALBUM_PERMISSION_DECLINED");
  }
  const opened = await invoke("openSetting");
  if (opened?.authSetting?.["scope.writePhotosAlbum"] !== true) {
    throw albumError("相册权限仍未开启；下次点击保存时会再次询问。", "ALBUM_PERMISSION_REQUIRED");
  }
}

async function ensureAlbumPermission({ forcePrompt = false } = {}) {
  let permission;
  try {
    permission = await currentPermission();
  } catch (error) {
    throw albumError(error?.errMsg || error?.message || "无法检查相册权限", "ALBUM_SETTING_READ_FAILED", error);
  }
  if (permission === true) return;
  if (permission === false || forcePrompt) await askToOpenSettings();
}

async function saveImageToAlbum(filePath) {
  const path = String(filePath || "").trim();
  if (!path) throw albumError("没有可保存的图片文件", "ALBUM_FILE_MISSING");

  await ensureAlbumPermission();
  try {
    await invoke("saveImageToPhotosAlbum", { filePath: path });
  } catch (error) {
    if (!isPermissionFailure(error)) throw error;
    await ensureAlbumPermission({ forcePrompt: true });
    await invoke("saveImageToPhotosAlbum", { filePath: path });
  }
  return { saved: true, filePath: path };
}

module.exports = { saveImageToAlbum, ensureAlbumPermission, isPermissionFailure };
