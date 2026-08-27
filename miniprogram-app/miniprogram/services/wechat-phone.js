function detailText(detail, key) {
  return String(detail && detail[key] !== undefined ? detail[key] : "").trim();
}

function diagnosticSuffix(detail) {
  const errno = detailText(detail, "errno");
  const errMsg = detailText(detail, "errMsg")
    .replace(/^getPhoneNumber:fail\s*/i, "")
    .replace(/^getPhoneNumber:\s*/i, "")
    .slice(0, 120);
  const parts = [];
  if (errno) parts.push(`错误码 ${errno}`);
  if (errMsg) parts.push(errMsg);
  return parts.length ? `（${parts.join("；")}）` : "";
}

function authorizationFailureMessage(detail) {
  const errMsg = detailText(detail, "errMsg");
  const errno = detailText(detail, "errno");
  const reason = `${errMsg} ${errno}`.toLowerCase();
  const suffix = diagnosticSuffix(detail);

  if (/user deny|user cancel|cancelled|canceled/.test(reason)) {
    return "你已取消微信手机号授权；同意后才能使用微信手机号登录";
  }
  if (/quota|balance|1400001|次数|额度/.test(reason)) {
    return `微信手机号验证额度不可用，请管理员检查公众平台“付费管理 → 手机号快速验证组件”${suffix}`;
  }
  if (/no permission|permission denied|api scope|not support|unsupported|not authorized|未认证|无权限/.test(reason)) {
    return `当前小程序尚未取得微信手机号验证权限，请管理员检查微信认证、隐私保护指引和手机号能力${suffix}`;
  }
  return `微信没有返回手机号授权码，请管理员根据下列信息检查微信平台配置${suffix}`;
}

function parseErrorMessage(error) {
  const raw = String(error && (error.message || error.error_description) || "").trim();
  if (!raw || raw[0] !== "{") return raw;
  try {
    const parsed = JSON.parse(raw);
    return String(parsed.message || parsed.msg || parsed.error_description || raw).trim();
  } catch (_) {
    return raw;
  }
}

function loginFailureMessage(error) {
  const message = parseErrorMessage(error) || "微信手机号登录失败";
  const code = String(error && (error.code || error.status || error.category) || "").trim();
  if (!code || message.includes(code)) return message;
  return `${message}（错误码 ${code.slice(0, 80)}）`;
}

module.exports = { authorizationFailureMessage, loginFailureMessage };
