(() => {
  "use strict";
  let app = null;
  const parsedObject = (value) => {
    if (value && typeof value === "object") return value;
    if (typeof value !== "string") return null;
    try { return JSON.parse(value); } catch (_) { return null; }
  };
  const responseData = (result) => [result?.result, result?.data?.result, result?.data, result]
    .map(parsedObject).find((item) => item && (Object.hasOwn(item, "ok") || Object.hasOwn(item, "code"))) || {};
  function register(registerFn, name) {
    if (typeof registerFn !== "function") return;
    try { registerFn(window.cloudbase); } catch (error) {
      const message = String(error?.message || error || "").toLowerCase();
      if (!(message.includes("duplicate component") && message.includes(name))) throw error;
    }
  }
  async function call(name, action, data = {}) {
    if (!window.cloudbase || !window.CloudBaseAuthConfig || !window.registerFunctions) throw new Error("服务尚未加载，请刷新后重试。");
    register(window.registerAuth, "auth");
    register(window.registerFunctions, "functions");
    app ||= window.cloudbase.init(window.CloudBaseAuthConfig);
    const result = responseData(await app.callFunction({ name, data: { action, ...data } }));
    if (!result.ok) throw Object.assign(new Error(result.message || "服务暂时不可用。"), { code: result.code || "REQUEST_FAILED" });
    return result;
  }
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const dateText = (date) => date.toISOString().slice(0, 10);
  const monthShift = (month, delta) => {
    const [year, value] = month.split("-").map(Number);
    return dateText(new Date(Date.UTC(year, value - 1 + delta, 1))).slice(0, 7);
  };
  const daysInMonth = (month) => {
    const [year, value] = month.split("-").map(Number);
    return new Date(Date.UTC(year, value, 0)).getUTCDate();
  };
  const monthBlankCount = (month) => {
    const [year, value] = month.split("-").map(Number);
    return (new Date(Date.UTC(year, value - 1, 1)).getUTCDay() + 6) % 7;
  };
  const shanghaiDateTime = (value) => {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "—";
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    }).format(date).replaceAll("/", "-");
  };
  const localDateTime = () => new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).format(new Date()).replaceAll("/", "-");
  const duration = (seconds) => {
    if (seconds === null || seconds === undefined || !Number.isFinite(Number(seconds))) return "—";
    const total = Math.max(0, Math.floor(Number(seconds)));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return `${hours}小时${minutes}分钟`;
  };
  const mapLink = (row) => `https://www.openstreetmap.org/?mlat=${encodeURIComponent(row.latitude)}&mlon=${encodeURIComponent(row.longitude)}#map=18/${encodeURIComponent(row.latitude)}/${encodeURIComponent(row.longitude)}`;
  const mapEmbed = (row) => {
    const lat = Number(row?.latitude), lon = Number(row?.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "";
    const bbox = `${lon - .004},${lat - .003},${lon + .004},${lat + .003}`;
    return `https://www.openstreetmap.org/export/embed.html?bbox=${encodeURIComponent(bbox)}&layer=mapnik&marker=${encodeURIComponent(`${lat},${lon}`)}`;
  };
  window.WebWorkCommon = { call, escapeHtml, monthShift, daysInMonth, monthBlankCount, shanghaiDateTime, localDateTime, duration, mapLink, mapEmbed };
})();
